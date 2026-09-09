#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fitBasicModels, initialSeedIndex } from "./lib/forecast/baselines.mjs";
import { projectRiptideTop16Top8 } from "./lib/forecast/bracket-projection.mjs";
import { fitDynamicBradleyTerryModel } from "./lib/forecast/dynamic-bradley-terry.mjs";
import { eventTimeBounds } from "./lib/forecast/evaluation.mjs";
import { fitGlicko2Model } from "./lib/forecast/glicko2.mjs";
import { fitRegularizedBradleyTerryModel } from "./lib/forecast/regularized-bradley-terry.mjs";
import { selectRootFullFieldSeedPhase } from "./lib/forecast/upcoming-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORECAST_ROOT = path.join(ROOT, ".forecast");
const OUTPUT = path.join(ROOT, "src/lib/tournamentPredictionData.ts");
const MODEL_ORDER = [
  "regularized-bt-recent-form",
  "higher-seed",
  "glicko2",
  "recency-elo",
  "dynamic-bradley-terry",
  "neutral",
];
const MODEL_COPY = {
  "regularized-bt-recent-form": {
    shortName: "Regularized BT + seed + form",
    explanation: "Uses categorical player IDs, initial seeds, and pre-event recent form. Historical seed value is shown only in the separate seed sensitivity; character is not included and optimizer reliability still needs work.",
    recommended: true,
  },
  "higher-seed": {
    shortName: "Higher seed",
    explanation: "Always favors the better initial seed at one training-calibrated rate. It ignores player history, recent form, and character.",
    recommended: false,
  },
  glicko2: {
    shortName: "Glicko-2",
    explanation: "Rates players with both estimated strength and rating uncertainty, updating once per event. Unseen players begin at the shared default.",
    recommended: false,
  },
  "recency-elo": {
    shortName: "Recency Elo",
    explanation: "Builds player ratings from prior sets, downweights older events, and updates every event as one batch.",
    recommended: false,
  },
  "dynamic-bradley-terry": {
    shortName: "Dynamic Bradley–Terry",
    explanation: "Fits player strength jointly within each event, then decays and shrinks that strength between events. It does not use seed.",
    recommended: false,
  },
  neutral: {
    shortName: "Neutral 50/50",
    explanation: "Gives both players 50%. Better seed is used only as a display tie-break so the path can continue; that is not model evidence.",
    recommended: false,
  },
};

const digest = (value) => createHash("sha256").update(value).digest("hex");
const round = (value) => Number(value.toFixed(6));

async function verifiedJson(file, expectedHash, label) {
  const body = await readFile(file, "utf8");
  if (expectedHash && digest(body) !== expectedHash) throw new Error(`${label} hash mismatch`);
  return JSON.parse(body);
}

function safeArtifactPath(relative, pattern, label) {
  if (typeof relative !== "string" || !pattern.test(relative)) throw new Error(`Invalid ${label} path`);
  return path.join(FORECAST_ROOT, relative);
}

function currentPlayers(bundle, rootPhase) {
  const entrants = new Map(bundle.entrants.map((entrant) => [String(entrant.id), entrant]));
  return rootPhase.seeds.filter((seed) => seed.seedNum <= 16).map((seed) => {
    const entrant = entrants.get(seed.entrantId);
    const participants = Array.isArray(entrant?.participants) ? entrant.participants : [];
    const participant = participants[0];
    if (participants.length !== 1 || !participant?.gamerTag || !participant.player?.id) {
      throw new Error(`Top-16 seed ${seed.seedNum} has no unique public player identity`);
    }
    return {
      id: `startgg:player:${participant.player.id}`,
      name: participant.gamerTag,
      seed: seed.seedNum,
      entrantId: `startgg:entrant:${seed.entrantId}`,
    };
  }).sort((a, b) => a.seed - b.seed);
}

function missingRootPools(bundle, rootPhase) {
  const groups = bundle.phaseGroups.filter((group) => String(group.phase?.id) === rootPhase.phaseId);
  const groupsWithSets = new Set(bundle.sets.map((set) => String(set.phaseGroup?.id)));
  const missingPoolNames = groups.filter((group) => !groupsWithSets.has(String(group.id)))
    .map((group) => String(group.displayIdentifier ?? group.id)).sort((a, b) => a.localeCompare(b, "en"));
  const referencedSeedIds = new Set(bundle.sets
    .filter((set) => String(set.phaseGroup?.phase?.id ?? set.phaseGroup?.phaseId ?? "") === rootPhase.phaseId
      || groups.some((group) => String(group.id) === String(set.phaseGroup?.id)))
    .flatMap((set) => set.slots ?? [])
    .filter((slot) => slot?.prereqType === "seed" && slot.prereqId != null)
    .map((slot) => String(slot.prereqId)));
  const missingEntrantCount = rootPhase.seeds.filter((seed) => !referencedSeedIds.has(seed.id)).length;
  return { missingPoolNames, missingEntrantCount };
}

function modelSuite({ events, sets, cutoff, seedIndex }) {
  return [
    ...fitBasicModels({ events, sets, cutoff, seedIndex }),
    fitGlicko2Model({ events, sets, cutoff }),
    fitDynamicBradleyTerryModel({ events, sets, cutoff }),
    fitRegularizedBradleyTerryModel({ events, sets, cutoff, seedIndex }),
  ];
}

function cleanProjection(model, projection, evaluation, eventId) {
  const copy = MODEL_COPY[model.id];
  const scores = evaluation.get(model.id);
  if (!copy || !scores) throw new Error(`No site metadata for model ${model.id}`);
  const playerId = (player) => player.id;
  return {
    id: model.id,
    name: model.name,
    ...copy,
    heldOut: {
      predictions: scores.n,
      events: scores.events,
      brier: round(scores.brier),
      logLoss: round(scores.logLoss),
    },
    championId: playerId(projection.champion),
    top8PlayerIds: projection.top8Qualifiers.map(({ player }) => playerId(player)),
    matches: projection.matches.map((match) => ({
      id: match.id,
      label: match.label,
      phase: match.phase,
      bracket: match.bracket,
      round: match.round,
      playerIds: match.entrants.map(playerId),
      probabilities: [round(match.probabilityA), round(1 - match.probabilityA)],
      predictedWinnerId: playerId(match.winner),
      decision: match.decision,
      isReset: match.isReset,
    })),
    placements: projection.predictedPlacements.map(({ placement, player }) => ({
      placement,
      playerId: playerId(player),
    })),
    eventId,
  };
}

async function main() {
  const latest = await verifiedJson(path.join(FORECAST_ROOT, "latest.json"), null, "dataset manifest");
  const bracketManifest = await verifiedJson(path.join(FORECAST_ROOT, "latest-bracket-report.json"), null, "bracket manifest");
  const evaluationManifest = await verifiedJson(path.join(FORECAST_ROOT, "latest-evaluation.json"), null, "evaluation manifest");
  const datasetPath = safeArtifactPath(latest.dataset, /^datasets\/[a-f0-9]{64}\/dataset\.json$/, "dataset");
  const dataset = await verifiedJson(datasetPath, latest.sha256, "historical dataset");
  if (bracketManifest.sourceDatasetSha256 !== latest.sha256
      || evaluationManifest.sourceDatasetSha256 !== latest.sha256) {
    throw new Error("Bracket, evaluation, and historical dataset manifests do not share one dataset hash");
  }
  const bundlePath = safeArtifactPath(`raw/${bracketManifest.sourceSha256}.json`, /^raw\/[a-f0-9]{64}\.json$/, "source bundle");
  const bundle = await verifiedJson(bundlePath, bracketManifest.sourceSha256, "upcoming source bundle");
  const comparisonPath = safeArtifactPath(evaluationManifest.report,
    /^reports\/[a-f0-9]{64}\/comparison\.json$/, "evaluation report");
  const comparison = await verifiedJson(comparisonPath, null, "evaluation report");
  if (comparison.sourceDatasetSha256 !== latest.sha256) throw new Error("Evaluation report dataset hash mismatch");

  const cutoff = Date.parse(bundle.provenance?.fetchedAt) / 1000;
  if (!Number.isFinite(cutoff)) throw new Error("Upcoming source snapshot needs a valid timestamp");
  const events = dataset.events.filter((event) => event.eligible === true
    && eventTimeBounds(event).trainingEnd != null && eventTimeBounds(event).trainingEnd < cutoff);
  const eventIds = new Set(events.map((event) => event.id));
  const sets = dataset.sets.filter((set) => set.eligible === true && eventIds.has(set.eventId));
  if (!events.length || !sets.length) throw new Error("No historical training corpus exists before the snapshot");

  const rootPhase = selectRootFullFieldSeedPhase(bundle);
  const players = currentPlayers(bundle, rootPhase);
  const historicalSeeds = initialSeedIndex(dataset, { allowHistorical: true });
  const combinedSeedIndex = { ...historicalSeeds, seeds: new Map(historicalSeeds.seeds) };
  for (const seed of rootPhase.seeds) {
    combinedSeedIndex.seeds.set(`startgg:entrant:${seed.entrantId}`, seed.seedNum);
  }
  const fittedModels = modelSuite({ events, sets, cutoff, seedIndex: combinedSeedIndex });
  const fittedById = new Map(fittedModels.map((model) => [model.id, model]));
  const evaluation = new Map(comparison.outOfSample.models.map((row) => [row.id, {
    ...row.scores,
    events: comparison.outOfSample.folds.length,
  }]));
  const eventId = `startgg:event:${bundle.event.id}`;
  const projections = MODEL_ORDER.map((modelId) => {
    const model = fittedById.get(modelId);
    if (!model) throw new Error(`Fitted model suite is missing ${modelId}`);
    const projection = projectRiptideTop16Top8({
      players,
      predict(a, b, context) {
        return model.predict({
          id: `site:${model.id}:${context.matchId}`,
          eventId,
          entrantIds: [a.entrantId, b.entrantId],
          playerIds: [a.id, b.id],
        }).p;
      },
    });
    return cleanProjection(model, projection, evaluation, eventId);
  }).map(({ eventId: _eventId, ...projection }) => projection);
  const missing = missingRootPools(bundle, rootPhase);
  const tournament = {
    id: eventId,
    name: bundle.event.tournament?.name ?? bundle.event.name,
    eventName: bundle.event.name,
    startDate: new Date(bundle.event.startAt * 1000).toISOString().slice(0, 10),
    sourceUrl: `https://www.start.gg/${bundle.event.slug}`,
    sourceSha256: bracketManifest.sourceSha256,
    snapshot: {
      fetchedAt: new Date(bundle.provenance.fetchedAt).toISOString(),
      state: bundle.event.state,
      entrantCount: bundle.entrants.length,
    },
    scenario: {
      kind: "seed-projected-top-16",
      label: "Top-16 seed projection",
      explanation: "Current root seeds 1–16 are assumed to survive pools and occupy the matching Top-16 phase positions; model favorites then advance through the published Top-16 and Top-8 routing.",
      ...missing,
    },
    training: {
      events: events.length,
      sets: sets.length,
      datasetSha256: latest.sha256,
      evaluationRunHash: evaluationManifest.runHash,
    },
    defaultModelId: "regularized-bt-recent-form",
    players: players.map(({ entrantId: _entrantId, ...player }) => player),
    models: projections,
    caveats: [
      "Experimental seed projection, not a confirmed later-round Start.gg bracket or full-field simulation.",
      "Later opponents are inferred by advancing each model's local favorite; percentages are raw conditional set estimates, not title odds or confidence intervals.",
      "Start.gg still labels this event CREATED, and entrants or routing can change after the snapshot.",
      "Five selected 2025 majors supply the training data; historical seed availability is assumed.",
      "Character is not a feature, and historical seed value is supported only by the separately labeled sensitivity.",
    ],
  };
  const catalog = {
    schemaVersion: 1,
    generatedAt: tournament.snapshot.fetchedAt,
    tournaments: [tournament],
  };
  const body = "// Generated by scripts/build-site-predictions.mjs; do not edit by hand.\n"
    + "import type { TournamentPredictionCatalog } from \"./tournamentPredictionData.types\";\n\n"
    + `export const TOURNAMENT_PREDICTIONS = ${JSON.stringify(catalog, null, 2)} satisfies TournamentPredictionCatalog;\n`;
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, body, "utf8");
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), tournament: tournament.name,
    models: projections.length, matches: projections.reduce((sum, model) => sum + model.matches.length, 0),
    champion: players.find((player) => player.id === projections[0].championId)?.name,
    missingPools: missing.missingPoolNames, missingEntrants: missing.missingEntrantCount }, null, 2));
}

await main();
