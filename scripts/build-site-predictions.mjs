#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fitBasicModels, initialSeedIndex } from "./lib/forecast/baselines.mjs";
import {
  PLATFIGHT_2026_TOP16_TOP8_ROUTING,
  projectSeededBracket,
  RIPTIDE_TOP16_TOP8_ROUTING,
} from "./lib/forecast/bracket-projection.mjs";
import { fitDynamicBradleyTerryModel } from "./lib/forecast/dynamic-bradley-terry.mjs";
import { eventTimeBounds } from "./lib/forecast/evaluation.mjs";
import { fitGlicko2Model } from "./lib/forecast/glicko2.mjs";
import { fitRegularizedBradleyTerryModel } from "./lib/forecast/regularized-bradley-terry.mjs";
import { selectRootFullFieldSeedPhase } from "./lib/forecast/upcoming-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORECAST_ROOT = path.join(ROOT, ".forecast");
const OUTPUT = path.join(ROOT, "src/lib/tournamentPredictionData.ts");
const ASSUMED_ROUTING = {
  ...RIPTIDE_TOP16_TOP8_ROUTING,
  id: "assumed-top16-top8-v1",
  label: "Assumed Top-16 routing",
};
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

function safeArtifactPath(relative, pattern, label, forecastRoot) {
  if (typeof relative !== "string" || !pattern.test(relative)) throw new Error(`Invalid ${label} path`);
  return path.join(forecastRoot, relative);
}

export function validateEvaluationRun({ manifest, comparison, predictions, datasetSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(manifest.runHash)
      || manifest.report !== `reports/${manifest.runHash}/comparison.json`
      || manifest.predictions !== `reports/${manifest.runHash}/predictions.json`
      || manifest.sourceDatasetSha256 !== datasetSha256
      || comparison.sourceDatasetSha256 !== datasetSha256
      || digest(JSON.stringify({ report: comparison, predictions })) !== manifest.runHash) {
    throw new Error("Evaluation report, predictions, or dataset failed run-hash verification");
  }
}

async function readEvaluation(forecastRoot, manifest, datasetSha256) {
  const comparison = await verifiedJson(safeArtifactPath(manifest.report,
    /^reports\/[a-f0-9]{64}\/comparison\.json$/, "evaluation report", forecastRoot), null, "evaluation report");
  const predictions = await verifiedJson(safeArtifactPath(manifest.predictions,
    /^reports\/[a-f0-9]{64}\/predictions\.json$/, "evaluation predictions", forecastRoot), null, "evaluation predictions");
  validateEvaluationRun({ manifest, comparison, predictions, datasetSha256 });
  return comparison;
}

function parseArgs(argv) {
  const options = { root: FORECAST_ROOT, output: OUTPUT };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!["--root", "--output", "--bundle", "--event"].includes(key)) throw new Error(`Unknown option ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} needs a value`);
    options[key.slice(2)] = key === "--event" ? value : path.resolve(value);
  }
  return options;
}

/** Read the generated JSON literal without evaluating the TypeScript module. */
export function readGeneratedCatalog(source) {
  const marker = "export const TOURNAMENT_PREDICTIONS =";
  const declaration = source.indexOf(marker);
  const start = declaration < 0 ? -1 : source.indexOf("{", declaration + marker.length);
  if (start < 0) throw new Error("Generated prediction catalog is missing its JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      const catalog = JSON.parse(source.slice(start, index + 1));
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.tournaments)) {
        throw new Error("Unsupported existing prediction catalog");
      }
      return catalog;
    }
  }
  throw new Error("Generated prediction catalog JSON object is unterminated");
}

export function prependTournament(existing, tournament) {
  return {
    schemaVersion: 1,
    generatedAt: tournament.snapshot.fetchedAt,
    tournaments: [tournament, ...existing.tournaments.filter((item) => item.id !== tournament.id)],
  };
}

export function selectTrainingCorpus(dataset, bundle) {
  const fetchedAt = Date.parse(bundle.provenance?.fetchedAt) / 1000;
  const eventStart = bundle.event?.startAt;
  if (!Number.isFinite(fetchedAt)) throw new Error("Upcoming source snapshot needs a valid timestamp");
  if (!Number.isFinite(eventStart) || eventStart <= 0) throw new Error("Upcoming event needs a valid start time");
  const cutoff = Math.min(fetchedAt, eventStart);
  const targetId = `startgg:event:${bundle.event.id}`;
  const events = dataset.events.filter((event) => event.id !== targetId && event.eligible === true
    && eventTimeBounds(event).trainingEnd != null && eventTimeBounds(event).trainingEnd < cutoff);
  const eventIds = new Set(events.map((event) => event.id));
  const sets = dataset.sets.filter((set) => set.eligible === true && eventIds.has(set.eventId));
  if (!events.length || !sets.length) throw new Error("No historical training corpus exists before the snapshot and event start");
  return { events, sets, cutoff };
}

export function siteRoutingForEvent(eventId) {
  if (eventId === "startgg:event:1661592") {
    return {
      routing: PLATFIGHT_2026_TOP16_TOP8_ROUTING,
      label: "Top-16 survival scenario",
      routingEvidence: "published",
      explanation: "Root seeds 1–16 are assumed to reach their projected Top 24 slots, and seeds 9–16 are assumed to win the first lower round. Model favorites then advance through Platfight's published Top 24 and Top 8 routing. Seeds 17–24 and earlier pool upsets are outside this conditional scenario.",
    };
  }
  if (eventId === "startgg:event:1503439") {
    return {
      routing: RIPTIDE_TOP16_TOP8_ROUTING,
      label: "Top-16 seed projection",
      routingEvidence: "published",
      explanation: "Current root seeds 1–16 are assumed to survive pools and occupy the matching Top-16 phase positions; model favorites then advance through the published Top-16 and Top-8 routing.",
    };
  }
  return {
    routing: ASSUMED_ROUTING,
    label: ASSUMED_ROUTING.label,
    routingEvidence: "assumed-template",
    explanation: "Current root seeds 1–16 are assumed to survive pools, with seeds 1–8 on the upper side and 9–16 on the lower side. Model favorites advance through an illustrative Top-16 and Top-8 template; this tournament's actual later-round routing has not been verified.",
  };
}

export function validatePublishedSeedMapping(bundle, rootPhase) {
  if (String(bundle.event.id) !== "1661592") return;
  const projected = bundle.seeds.filter((seed) => String(seed.phase?.id) === "2402255"
    && seed.seedNum >= 1 && seed.seedNum <= 16);
  const rootBySeed = new Map(rootPhase.seeds.map((seed) => [seed.seedNum, String(seed.entrantId)]));
  if (projected.length !== 16 || new Set(projected.map((seed) => seed.seedNum)).size !== 16
      || projected.some((seed) => String(seed.projectedEntrantId) !== rootBySeed.get(seed.seedNum))) {
    throw new Error("Platfight's root-to-Top-24 seed mapping changed or is unavailable; review the published routing before generating predictions");
  }
}

async function saveModelSnapshot({ model, forecastRoot, datasetSha256, cutoff, eventId, sourceSha256 }) {
  if (!model?.snapshot) return null;
  const artifact = {
    schemaVersion: 1,
    modelId: model.id,
    sourceDatasetSha256: datasetSha256,
    forecastEventId: eventId,
    sourceSnapshotSha256: sourceSha256,
    cutoff: new Date(cutoff * 1000).toISOString(),
    reuse: "Restores the fitted parameters and recent-form state at this cutoff. Refit when incorporating newer results or advancing recent form.",
    snapshot: model.snapshot,
  };
  const body = `${JSON.stringify(artifact, null, 2)}\n`;
  const sha256 = digest(body);
  const relativePath = `models/${sha256}.json`;
  const modelPath = path.join(forecastRoot, relativePath);
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeFile(modelPath, body, "utf8");
  const manifest = {
    schemaVersion: 1,
    modelId: artifact.modelId,
    model: relativePath,
    sha256,
    sourceDatasetSha256: datasetSha256,
    forecastEventId: eventId,
    cutoff: artifact.cutoff,
  };
  await writeFile(path.join(forecastRoot, "latest-model.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
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
    ...(model.methodology.fit ? { fit: {
      converged: model.methodology.fit.converged,
      iterations: model.methodology.fit.iterations,
    } } : {}),
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

async function main(options) {
  const latest = await verifiedJson(path.join(options.root, "latest.json"), null, "dataset manifest");
  const bracketManifest = options.bundle ? null
    : await verifiedJson(path.join(options.root, "latest-bracket-report.json"), null, "bracket manifest");
  const evaluationManifest = await verifiedJson(path.join(options.root, "latest-evaluation.json"), null, "evaluation manifest");
  const datasetPath = safeArtifactPath(latest.dataset, /^datasets\/[a-f0-9]{64}\/dataset\.json$/, "dataset", options.root);
  const dataset = await verifiedJson(datasetPath, latest.sha256, "historical dataset");
  if ((bracketManifest && bracketManifest.sourceDatasetSha256 !== latest.sha256)
      || evaluationManifest.sourceDatasetSha256 !== latest.sha256) {
    throw new Error("Bracket, evaluation, and historical dataset manifests do not share one dataset hash");
  }
  const bundlePath = options.bundle ?? safeArtifactPath(`raw/${bracketManifest.sourceSha256}.json`,
    /^raw\/[a-f0-9]{64}\.json$/, "source bundle", options.root);
  const bundleBody = await readFile(bundlePath, "utf8");
  const sourceSha256 = digest(bundleBody);
  if (bracketManifest && sourceSha256 !== bracketManifest.sourceSha256) throw new Error("Upcoming source bundle hash mismatch");
  const bundle = JSON.parse(bundleBody);
  const eventId = `startgg:event:${bundle.event.id}`;
  if (options.event && ![String(bundle.event.id), eventId, bundle.event.slug].includes(options.event)) {
    throw new Error(`Requested event ${options.event} does not match source bundle ${eventId}`);
  }
  const comparison = await readEvaluation(options.root, evaluationManifest, latest.sha256);

  const { events, sets, cutoff } = selectTrainingCorpus(dataset, bundle);

  const rootPhase = selectRootFullFieldSeedPhase(bundle);
  validatePublishedSeedMapping(bundle, rootPhase);
  const players = currentPlayers(bundle, rootPhase);
  const historicalSeeds = initialSeedIndex(dataset, { allowHistorical: true });
  const combinedSeedIndex = { ...historicalSeeds, seeds: new Map(historicalSeeds.seeds) };
  for (const seed of rootPhase.seeds) {
    combinedSeedIndex.seeds.set(`startgg:entrant:${seed.entrantId}`, seed.seedNum);
  }
  const fittedModels = modelSuite({ events, sets, cutoff, seedIndex: combinedSeedIndex });
  const fittedById = new Map(fittedModels.map((model) => [model.id, model]));
  const scenario = siteRoutingForEvent(eventId);
  const evaluation = new Map(comparison.outOfSample.models.map((row) => [row.id, {
    ...row.scores,
    events: comparison.outOfSample.folds.length,
  }]));
  const projections = MODEL_ORDER.map((modelId) => {
    const model = fittedById.get(modelId);
    if (!model) throw new Error(`Fitted model suite is missing ${modelId}`);
    const projection = projectSeededBracket({
      players,
      routing: scenario.routing,
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
    sourceSha256,
    snapshot: {
      fetchedAt: new Date(bundle.provenance.fetchedAt).toISOString(),
      state: bundle.event.state,
      entrantCount: bundle.entrants.length,
    },
    scenario: {
      kind: "seed-projected-top-16",
      label: scenario.label,
      routingEvidence: scenario.routingEvidence,
      explanation: scenario.explanation,
      ...missing,
    },
    training: {
      events: events.length,
      sets: sets.length,
      throughDate: new Date(Math.max(...events.map((event) => eventTimeBounds(event).trainingEnd)) * 1000).toISOString().slice(0, 10),
      datasetSha256: latest.sha256,
      evaluationRunHash: evaluationManifest.runHash,
    },
    defaultModelId: "regularized-bt-recent-form",
    players: players.map(({ entrantId: _entrantId, ...player }) => player),
    models: projections,
    caveats: [
      "Experimental seed projection, not a confirmed later-round Start.gg bracket or full-field simulation.",
      "Later opponents are inferred by advancing each model's local favorite; percentages are raw conditional set estimates, not title odds or confidence intervals.",
      `The source labels this event ${bundle.event.state}; entrants or routing can change after the snapshot.`,
      `${events.length} prior events and ${sets.length} eligible sets supply the training data; historical seed availability is assumed.`,
      "Character is not a feature, and historical seed value is supported only by the separately labeled sensitivity.",
    ],
  };
  let existing = { schemaVersion: 1, tournaments: [] };
  try {
    existing = readGeneratedCatalog(await readFile(options.output, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const catalog = prependTournament(existing, tournament);
  const savedModel = await saveModelSnapshot({
    model: fittedById.get(tournament.defaultModelId),
    forecastRoot: options.root,
    datasetSha256: latest.sha256,
    cutoff,
    eventId,
    sourceSha256,
  });
  const body = "// Generated by scripts/build-site-predictions.mjs; do not edit by hand.\n"
    + "import type { TournamentPredictionCatalog } from \"./tournamentPredictionData.types\";\n\n"
    + `export const TOURNAMENT_PREDICTIONS = ${JSON.stringify(catalog, null, 2)} satisfies TournamentPredictionCatalog;\n`;
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, body, "utf8");
  console.log(JSON.stringify({ output: path.relative(ROOT, options.output), tournament: tournament.name,
    catalogTournaments: catalog.tournaments.length,
    routing: scenario.routing.id,
    savedModel: savedModel?.model ?? null,
    models: projections.length, matches: projections.reduce((sum, model) => sum + model.matches.length, 0),
    champion: players.find((player) => player.id === projections[0].championId)?.name,
    missingPools: missing.missingPoolNames, missingEntrants: missing.missingEntrantCount }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(parseArgs(process.argv.slice(2)));
}
