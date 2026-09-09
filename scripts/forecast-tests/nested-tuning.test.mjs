import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initialSeedIndex } from "../lib/forecast/baselines.mjs";
import {
  fitModelSuite,
  MODEL_IDS,
  validateModelOptionsById,
} from "../lib/forecast/comparison.mjs";
import {
  FROZEN_TUNING_SPEC_SEMANTIC_SHA256,
  nestedTuningImplementationIdentity,
  runNestedRollingTuning,
  semanticDatasetDigest,
  selectCandidateOneStandardError,
  serializeNestedTuningArtifact,
  validateTuningSpec,
} from "../lib/forecast/nested-tuning.mjs";
import { digest, readJson, writeJson } from "../lib/forecast/local.mjs";
import { ROOT } from "../lib/liquipedia-data.mjs";

const SPEC_BODY = await readFile(
  new URL("../data/forecast-tuning-spec.json", import.meta.url),
  "utf8",
);
const SPEC = JSON.parse(SPEC_BODY);
const SPEC_FILE_HASH = createHash("sha256").update(SPEC_BODY).digest("hex");

function fixture(eventCount = 18) {
  const events = [];
  const entrants = [];
  const seeds = [];
  const sets = [];
  for (let number = 1; number <= eventCount; number++) {
    const eventId = "event-" + number;
    const start = number * 1000;
    const end = start + 100;
    events.push({
      id: eventId,
      name: "Event " + number,
      eligible: true,
      exclusionReasons: [],
      chronology: {
        reportedEventStartAt: start,
        reportedTournamentStartAt: start,
        reportedEventEndAt: end,
        reportedTournamentEndAt: end,
      },
    });
    const leftEntrant = eventId + "-left";
    const rightEntrant = eventId + "-right";
    entrants.push(
      { id: leftEntrant, eventId, playerId: "player-left" },
      { id: rightEntrant, eventId, playerId: "player-right" },
    );
    seeds.push(
      {
        id: eventId + "-seed-1",
        eventId,
        entrantId: leftEntrant,
        seedNum: 1,
        phase: { id: eventId + "-phase" },
        phaseGroupId: eventId + "-group",
        isBye: false,
        progressionSeedId: null,
        usableAsPreEventFeature: null,
        exclusionReasons: [],
        source: { id: eventId + "-seed-1", provenanceIds: ["late-observation"] },
      },
      {
        id: eventId + "-seed-2",
        eventId,
        entrantId: rightEntrant,
        seedNum: 2,
        phase: { id: eventId + "-phase" },
        phaseGroupId: eventId + "-group",
        isBye: false,
        progressionSeedId: null,
        usableAsPreEventFeature: null,
        exclusionReasons: [],
        source: { id: eventId + "-seed-2", provenanceIds: ["late-observation"] },
      },
    );
    sets.push({
      id: eventId + "-set",
      eventId,
      eligible: true,
      exclusionReasons: [],
      entrantIds: [leftEntrant, rightEntrant],
      playerIds: ["player-left", "player-right"],
      winnerEntrantId: number % 4 === 0 ? rightEntrant : leftEntrant,
      winnerPlayerId: number % 4 === 0 ? "player-right" : "player-left",
      scores: number % 4 === 0 ? [1, 3] : [3, 1],
      timestamps: { completedAt: end },
    });
  }
  return {
    schemaVersion: 1,
    events,
    players: [{ id: "player-left" }, { id: "player-right" }],
    aliases: [],
    entrants,
    seeds,
    sets,
    standings: [],
    provenance: [{ id: "late-observation", fetchedAt: "2030-01-01T00:00:00.000Z" }],
  };
}

async function runWithCheckpoints(dataset, seedMode = "strict-seeds", checkpoints = new Map(), {
  checkpointForecast = null,
  onProgress = null,
} = {}) {
  const datasetBody = JSON.stringify(dataset) + "\n";
  const datasetSha256 = createHash("sha256").update(datasetBody).digest("hex");
  const reconciliationBody = JSON.stringify({
    schemaVersion: 1,
    kind: "forecast-historical-outcome-reconciliation-v1",
    datasetSha256,
    advisoryOnly: true,
    allReconciled: true,
  }) + "\n";
  const result = await runNestedRollingTuning(datasetBody, SPEC_BODY, {
    seedMode,
    outcomeReconciliationBody: reconciliationBody,
    loadCheckpoint: async ({ checkpointContextSha256 }) => {
      const saved = checkpoints.get(checkpointContextSha256);
      return saved ? {
        durable: true,
        expectedSha256: saved.sha256,
        body: saved.body,
      } : null;
    },
    checkpointForecast: checkpointForecast ?? (async ({ checkpointContextSha256, sha256, body }) => {
      checkpoints.set(checkpointContextSha256, { sha256, body });
      return { durable: true, sha256 };
    }),
    onProgress,
  });
  return { result, checkpoints };
}

async function run(dataset, seedMode = "strict-seeds") {
  return (await runWithCheckpoints(dataset, seedMode)).result;
}

test("frozen spec contains the practical 24-candidate six-model grid", () => {
  const spec = validateTuningSpec(SPEC);
  assert.equal(spec.candidateCount, 24);
  assert.deepEqual(spec.models.map((model) => model.id), MODEL_IDS);
  assert.equal(spec.models.flatMap((model) => model.candidates).length, 24);
  assert.equal(spec.policy.innerMinTrainingEvents, 5);
  assert.equal(spec.policy.innerMinCompletedFolds, 12);
  assert.equal(FROZEN_TUNING_SPEC_SEMANTIC_SHA256,
    "30d52b2a2471c2db0aa2e3bda56e7098f2d7e7807f570c27af3f3c208311ce6a");
  const changed = structuredClone(SPEC);
  changed.models.at(-1).candidates.pop();
  assert.throws(() => validateTuningSpec(changed), /semantic hash differs/);
  const duplicateMode = structuredClone(SPEC);
  duplicateMode.evidenceModes[0].id = "availability-assumed";
  assert.throws(() => validateTuningSpec(duplicateMode), /semantic hash differs/);
});

test("paired one-standard-error rule prefers the default-nearest eligible candidate", () => {
  const modelSpec = {
    id: "fixture-model",
    candidates: [
      { id: "default", defaultDistance: 0 },
      { id: "near", defaultDistance: 1 },
      { id: "far-best", defaultDistance: 2 },
    ],
  };
  const events = Array.from({ length: 12 }, (_, index) => ({
    eventId: "inner-" + index,
    models: [{
      id: modelSpec.id,
      candidates: [
        {
          candidateId: "default",
          status: "valid",
          scores: { logLoss: 0.4 + (index % 2 === 0 ? 0.1 : -0.08), brier: 0.25 },
        },
        { candidateId: "near", status: "valid", scores: { logLoss: 0.405, brier: 0.15 } },
        { candidateId: "far-best", status: "valid", scores: { logLoss: 0.4, brier: 0.18 } },
      ],
    }],
  }));
  const selection = selectCandidateOneStandardError(modelSpec, events);
  assert.equal(selection.bestCandidateId, "far-best");
  assert.equal(selection.selectedCandidateId, "default");
  assert.equal(selection.innerEvents, 12);
  assert.equal(selection.candidates.find((row) => row.candidateId === "default")
    .withinOneStandardError, true);
  assert.equal(selection.candidates.find((row) => row.candidateId === "near")
    .withinOneStandardError, false);
});

test("model-suite option plumbing is per-family, validated, and keeps fixed baselines fixed", () => {
  const data = fixture(2);
  const events = [data.events[0]];
  const sets = [data.sets[0]];
  const models = fitModelSuite({
    events,
    sets,
    cutoff: data.events[1].chronology.reportedEventStartAt,
    seedIndex: initialSeedIndex(data),
    modelOptionsById: {
      "recency-elo": { k: 16, halfLifeDays: 365 },
      glicko2: { initialRd: 200 },
      "dynamic-bradley-terry": { ridge: 2 },
      "regularized-bt-recent-form": { abilityL2: 4 },
    },
  });
  assert.deepEqual(models.map((model) => model.id), MODEL_IDS);
  assert.equal(models.find((model) => model.id === "recency-elo").methodology.k, 16);
  assert.equal(models.find((model) => model.id === "glicko2").methodology.initialRd, 200);
  assert.equal(models.find((model) => model.id === "dynamic-bradley-terry").methodology.ridge, 2);
  assert.equal(models.find((model) => model.id === "regularized-bt-recent-form")
    .methodology.abilityL2, 4);
  assert.throws(() => validateModelOptionsById({ neutral: { p: 0.6 } }), /fixed model/);
  assert.throws(() => validateModelOptionsById({ glicko2: { surprise: 1 } }), /Unknown glicko2 option/);
  assert.throws(() => fitModelSuite({
    events,
    sets,
    cutoff: data.events[1].chronology.reportedEventStartAt,
    seedIndex: initialSeedIndex(data),
    basicOptions: { k: 32 },
    modelOptionsById: { "recency-elo": { k: 16 } },
  }), /either basicOptions/);
});

test("nested chronology waits for 12 completed inner event folds and freezes forecasts before scoring", async () => {
  const data = fixture();
  const { result, checkpoints } = await runWithCheckpoints(data);
  assert.equal(result.manifest.status, "exploratory-not-confirmatory");
  assert.equal(result.manifest.productize, false);
  assert.equal(result.manifest.selectedModel, null);
  assert.equal(result.manifest.completeModelSuite, true);
  assert.match(result.manifest.runSha256, /^[a-f0-9]{64}$/);
  assert.match(result.manifest.forecastSha256, /^[a-f0-9]{64}$/);
  assert.match(result.manifest.evaluationSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.tuningSpec.fileSha256, SPEC_FILE_HASH);
  assert.equal(result.manifest.tuningSpec.semanticSha256,
    FROZEN_TUNING_SPEC_SEMANTIC_SHA256);
  assert.equal(result.manifest.sourceDatasetSemanticSha256, semanticDatasetDigest(data));
  assert.equal(result.manifest.implementation.sha256,
    (await nestedTuningImplementationIdentity()).sha256);
  assert.equal(result.evaluation.forecastSha256, result.manifest.forecastSha256);
  assert.equal(createHash("sha256").update(serializeNestedTuningArtifact(result.forecasts)).digest("hex"),
    result.manifest.forecastSha256);
  assert.equal(createHash("sha256").update(serializeNestedTuningArtifact(result.evaluation)).digest("hex"),
    result.manifest.evaluationSha256);
  assert.equal(result.manifest.artifactSeparation.awaitedPerEventCandidateCheckpointBeforeTargetScoring,
    true);
  assert.equal(result.evaluation.coverage.outerEvents, 17);
  assert.equal(result.evaluation.coverage.candidateScoreEvents, 13);
  const event17 = result.forecasts.events.find((event) => event.eventId === "event-17");
  const event18 = result.forecasts.events.find((event) => event.eventId === "event-18");
  assert.equal(event17.selections.find((row) => row.modelId === "recency-elo").mode,
    "warmup-default");
  assert.equal(event17.selections.find((row) => row.modelId === "recency-elo")
    .innerEventsAvailable, 11);
  for (const modelId of MODEL_IDS.slice(2, -1)) {
    const selection = event18.selections.find((row) => row.modelId === modelId);
    assert.equal(selection.mode, "inner-selected");
    assert.equal(selection.innerEventsAvailable, 12);
    assert.equal(selection.evidence.innerEventIds.includes("event-18"), false);
  }
  const regularizedSelection = event18.selections.find((row) =>
    row.modelId === "regularized-bt-recent-form");
  assert.equal(regularizedSelection.mode, "inner-unavailable-default");
  assert.equal(regularizedSelection.evidence.status, "no-fully-valid-candidate");
  const event18Checkpoint = [...checkpoints.values()]
    .map((entry) => JSON.parse(entry.body))
    .find((entry) => entry.context.eventId === "event-18");
  const invalidCandidates = event18Checkpoint.candidateForecasts
    .flatMap((model) => model.candidates)
    .filter((candidate) => candidate.fit.valid === false);
  assert.ok(invalidCandidates.length > 0);
  assert.ok(invalidCandidates.every((candidate) => candidate.predictions.every((prediction) =>
    prediction.p === 0.5 && prediction.covered === false
    && prediction.fallback === "neutral-0.5-invalid-fit")));
  const selectedInvalid = event18Checkpoint.candidateForecasts
    .find((model) => model.modelId === regularizedSelection.modelId).candidates
    .find((candidate) => candidate.candidateId === regularizedSelection.selectedCandidateId);
  assert.deepEqual(event18.predictions[0].models[regularizedSelection.modelId], {
    candidateId: regularizedSelection.selectedCandidateId,
    fitStatus: selectedInvalid.fit.status,
    ...selectedInvalid.predictions[0],
  });
  assert.equal(event18.tuningHistoryEventIds.length, 12);
  assert.equal(event18.trainingEventIds.includes("event-18"), false);
  assert.ok(result.manifest.leakageAudit.folds.every((fold) =>
    fold.violations.length === 0
    && fold.selectedConfigsFrozenBeforeOuterScoring
    && fold.targetAbsentFromTraining
    && fold.allCandidateForecastsDurablyCheckpointedBeforeTargetScoring
    && checkpoints.has(fold.checkpointContextSha256)));
  const forecastText = JSON.stringify(result.forecasts);
  assert.doesNotMatch(forecastText, /"winnerPlayerId"|"winnerEntrantId"|"scores"|"standings"|"actual"/);
  assert.equal(result.manifest.leakageAudit.sourceSnapshotsVerified, false);
  assert.equal(result.evaluation.familySelection, false);
  assert.ok(result.evaluation.outerFolds.every((fold) =>
    fold.models.every((model) => model.scores.n === 1)));
  assert.ok(result.evaluation.candidateEventScores.every((event) =>
    event.eventForecastSha256 === result.forecasts.events
      .find((forecast) => forecast.eventId === event.eventId).eventForecastSha256));
});

test("target scoring cannot start unless exact candidate forecasts are durably checkpointed", async () => {
  const data = fixture(2);
  const datasetBody = JSON.stringify(data) + "\n";
  const datasetSha256 = createHash("sha256").update(datasetBody).digest("hex");
  const reconciliationBody = JSON.stringify({
    kind: "forecast-historical-outcome-reconciliation-v1",
    datasetSha256,
    allReconciled: true,
  }) + "\n";
  await assert.rejects(runNestedRollingTuning(datasetBody, SPEC_BODY, {
    outcomeReconciliationBody: reconciliationBody,
  }), /requires an awaited durable checkpointForecast/);
  let checkpointCalls = 0;
  await assert.rejects(runNestedRollingTuning(datasetBody, SPEC_BODY, {
    outcomeReconciliationBody: reconciliationBody,
    checkpointForecast: async ({ body }) => {
      checkpointCalls++;
      assert.doesNotMatch(body,
        /winnerPlayerId|winnerEntrantId|"scores"|"standings"|"actual"/);
      return { durable: false, sha256: "0".repeat(64) };
    },
  }), /not durably committed before scoring/);
  assert.equal(checkpointCalls, 1);
});

test("verified event checkpoints resume every completed fold without refitting", async () => {
  const data = fixture();
  const first = await runWithCheckpoints(data);
  const progress = [];
  const second = await runWithCheckpoints(data, "strict-seeds", first.checkpoints, {
    checkpointForecast: async () => {
      throw new Error("resume unexpectedly attempted a model fit");
    },
    onProgress: (entry) => progress.push(entry),
  });
  assert.deepEqual(second.result, first.result);
  const completed = progress.filter((entry) => entry.phase === "outer-fold-complete");
  assert.equal(completed.length, first.result.forecasts.events.length);
  assert.ok(completed.every((entry) => entry.resumed === true));
  assert.equal(progress[0].execution, "single-threaded-sequential");
});

test("resumed checkpoints reject outcome fields even when their bytes are re-hashed", async () => {
  const data = fixture(2);
  const first = await runWithCheckpoints(data);
  const [contextSha256, saved] = first.checkpoints.entries().next().value;
  const checkpoint = JSON.parse(saved.body);
  checkpoint.candidateForecasts[0].candidates[0].predictions[0].actual = 1;
  const body = serializeNestedTuningArtifact(checkpoint);
  first.checkpoints.set(contextSha256, {
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  await assert.rejects(runWithCheckpoints(data, "strict-seeds", first.checkpoints),
    /forbidden fields/);
});

test("mature tuned-versus-default diagnostics retain checkpointed operational fit failures", async () => {
  const data = fixture();
  const first = await runWithCheckpoints(data);
  const event18 = first.result.forecasts.events.find((event) => event.eventId === "event-18");
  const selection = event18.selections.find((row) => row.modelId === "dynamic-bradley-terry");
  assert.equal(selection.mode, "inner-selected");
  const entry = [...first.checkpoints.entries()]
    .find(([, saved]) => JSON.parse(saved.body).context.eventId === "event-18");
  const checkpoint = JSON.parse(entry[1].body);
  const candidate = checkpoint.candidateForecasts
    .find((model) => model.modelId === selection.modelId).candidates
    .find((row) => row.candidateId === selection.selectedCandidateId);
  candidate.fit.status = "invalid-nonconverged";
  candidate.fit.valid = false;
  candidate.fit.converged = false;
  candidate.predictions = candidate.predictions.map(() => ({
    covered: false,
    fallback: "neutral-0.5-invalid-fit",
    p: 0.5,
  }));
  const body = serializeNestedTuningArtifact(checkpoint);
  first.checkpoints.set(entry[0], { body, sha256: createHash("sha256").update(body).digest("hex") });
  const second = await runWithCheckpoints(data, "strict-seeds", first.checkpoints, {
    checkpointForecast: async () => {
      throw new Error("all fixture folds should resume");
    },
  });
  const outer = second.result.evaluation.outerFolds.find((event) => event.eventId === "event-18")
    .models.find((model) => model.id === selection.modelId);
  assert.equal(outer.status, "scored-neutral-fallback-invalid-fit");
  assert.ok(Number.isFinite(outer.versusDefault.logLoss));
  assert.ok(Number.isFinite(outer.versusDefault.brier));
  const aggregate = second.result.evaluation.models.find((model) => model.id === selection.modelId);
  assert.equal(aggregate.selectionModes.innerSelected, 1);
  assert.equal(aggregate.innerSelectedVersusDefault.events, 1);
  assert.equal(aggregate.fallbackOuterEvents.some((row) => row.eventId === "event-18"), true);
  assert.equal(second.result.forecasts.events.find((event) => event.eventId === "event-18")
    .predictions[0].models[selection.modelId].fallback, "neutral-0.5-invalid-fit");
});

test("changing a later outer target outcome changes scores but not it or any earlier forecast", async () => {
  const data = fixture();
  const firstRun = await runWithCheckpoints(data);
  const first = firstRun.result;
  const changed = structuredClone(data);
  const target = changed.sets.find((set) => set.eventId === "event-18");
  target.winnerPlayerId = target.winnerPlayerId === "player-left" ? "player-right" : "player-left";
  target.winnerEntrantId = target.winnerPlayerId === "player-left"
    ? "event-18-left" : "event-18-right";
  target.scores = target.winnerPlayerId === "player-left" ? [3, 1] : [1, 3];
  const secondRun = await runWithCheckpoints(changed);
  const second = secondRun.result;
  assert.deepEqual(second.forecasts, first.forecasts);
  assert.equal(second.manifest.forecastSha256, first.manifest.forecastSha256);
  assert.deepEqual([...secondRun.checkpoints.values()], [...firstRun.checkpoints.values()]);
  assert.deepEqual(
    second.forecasts.events.filter((event) => event.eventId !== "event-18"),
    first.forecasts.events.filter((event) => event.eventId !== "event-18"),
  );
  assert.notDeepEqual(
    second.evaluation.outerFolds.find((event) => event.eventId === "event-18"),
    first.evaluation.outerFolds.find((event) => event.eventId === "event-18"),
  );
});

test("changing a held-out target's post-event end metadata cannot change its forecast identity", async () => {
  const data = fixture();
  const firstRun = await runWithCheckpoints(data);
  const changed = structuredClone(data);
  const target = changed.events.find((event) => event.id === "event-18");
  target.chronology.reportedEventEndAt += 50;
  target.chronology.reportedTournamentEndAt += 50;
  const secondRun = await runWithCheckpoints(changed);
  assert.deepEqual(secondRun.result.forecasts, firstRun.result.forecasts);
  assert.equal(secondRun.result.manifest.forecastSha256,
    firstRun.result.manifest.forecastSha256);
  assert.deepEqual([...secondRun.checkpoints.values()], [...firstRun.checkpoints.values()]);
  assert.notDeepEqual(
    secondRun.result.evaluation.candidateEventScores.find((event) =>
      event.eventId === "event-18"),
    firstRun.result.evaluation.candidateEventScores.find((event) =>
      event.eventId === "event-18"),
  );
});

test("a mature target without release metadata still checkpoints its fixed-default counterfactual", async () => {
  const data = fixture();
  const target = data.events.find((event) => event.id === "event-18");
  target.chronology.reportedEventEndAt = null;
  target.chronology.reportedTournamentEndAt = null;
  const { result, checkpoints } = await runWithCheckpoints(data);
  const checkpoint = [...checkpoints.values()]
    .map((entry) => JSON.parse(entry.body))
    .find((entry) => entry.context.eventId === "event-18");
  const defaults = new Map(SPEC.models.map((model) => [model.id, model.defaultCandidateId]));
  for (const modelPlan of checkpoint.context.candidatePlan) {
    assert.equal(modelPlan.candidateIds.includes(defaults.get(modelPlan.modelId)), true);
  }
  const scored = result.evaluation.outerFolds.find((event) => event.eventId === "event-18");
  assert.ok(scored.models.every((model) => model.defaultScores.n === 1));
  assert.equal(result.evaluation.candidateEventScores.some((event) =>
    event.eventId === "event-18"), false);
});

test("input row order cannot change forecast semantics or the order-insensitive dataset digest", async () => {
  const data = fixture();
  const first = await run(data);
  const reordered = {
    ...data,
    events: [...data.events].reverse(),
    entrants: [...data.entrants].reverse(),
    seeds: [...data.seeds].reverse(),
    sets: [...data.sets].reverse(),
    provenance: [...data.provenance].reverse(),
  };
  const second = await run(reordered);
  assert.deepEqual(second.forecasts, first.forecasts);
  assert.equal(second.manifest.forecastSha256, first.manifest.forecastSha256);
  assert.equal(second.manifest.sourceDatasetSemanticSha256,
    first.manifest.sourceDatasetSemanticSha256);
  assert.deepEqual(second.evaluation.models, first.evaluation.models);
  assert.notEqual(second.manifest.sourceDatasetSha256, first.manifest.sourceDatasetSha256,
    "Exact file hashes intentionally remain byte-order-sensitive");
});

test("an overlapping event outcome is not released to the next cutoff", async () => {
  const data = fixture();
  const nextCutoff = data.events.find((event) => event.id === "event-18")
    .chronology.reportedEventStartAt;
  data.sets.find((set) => set.eventId === "event-17").timestamps.completedAt = nextCutoff;
  const result = await run(data);
  const event18 = result.forecasts.events.find((event) => event.eventId === "event-18");
  assert.equal(event18.tuningHistoryEventIds.includes("event-17"), false);
  assert.equal(event18.tuningHistoryEventIds.length, 11);
  for (const modelId of MODEL_IDS.slice(2)) {
    assert.equal(event18.selections.find((selection) => selection.modelId === modelId).mode,
      "warmup-default");
  }
  const audit = result.manifest.leakageAudit.folds.find((fold) =>
    fold.targetEventId === "event-18");
  assert.ok(audit.maximumTuningOutcomeAvailableAt < nextCutoff);
  assert.equal(audit.violations.length, 0);
});

test("strict-seed and availability-assumed runs are explicit and never claim snapshot verification", async () => {
  const data = fixture(3);
  const strict = await run(data, "strict-seeds");
  const assumed = await run(data, "availability-assumed");
  assert.equal(strict.manifest.evidenceMode.id, "strict-seeds");
  assert.equal(strict.manifest.evidenceMode.allowHistoricalSeeds, false);
  assert.equal(strict.manifest.evidenceMode.snapshotVerified, false);
  assert.match(strict.manifest.warnings.join(" "), /Seeds without observation provenance/);
  assert.equal(assumed.manifest.evidenceMode.id, "availability-assumed");
  assert.equal(assumed.manifest.evidenceMode.allowHistoricalSeeds, true);
  assert.equal(assumed.manifest.evidenceMode.snapshotVerified, false);
  assert.match(assumed.manifest.warnings.join(" "), /not snapshot-safe/);
  const strictSeedP = strict.forecasts.events[0].predictions[0].models["higher-seed"].p;
  const assumedSeedP = assumed.forecasts.events[0].predictions[0].models["higher-seed"].p;
  assert.equal(strictSeedP, 0.5);
  assert.notEqual(assumedSeedP, 0.5);
  assert.equal(assumed.manifest.productize, false);
  assert.equal(assumed.manifest.selectedModel, null);
});

test("CLI writes resumable content-addressed tuning artifacts with strict seeds by default", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ssbm-nested-tuning-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = fixture();
  const datasetBody = JSON.stringify(dataset) + "\n";
  const datasetSha256 = digest(datasetBody);
  const datasetFile = `datasets/${datasetSha256}/dataset.json`;
  const audit = {
    schemaVersion: 1,
    kind: "forecast-historical-outcome-reconciliation-v1",
    datasetSha256,
    advisoryOnly: true,
    allReconciled: true,
  };
  const auditBody = JSON.stringify(audit) + "\n";
  const auditSha256 = digest(auditBody);
  const auditFile = `datasets/${datasetSha256}/outcome-reconciliation-${auditSha256}.json`;
  await writeJson(path.join(root, datasetFile), dataset);
  await writeJson(path.join(root, auditFile), audit);
  await writeJson(path.join(root, "latest.json"), {
    dataset: datasetFile,
    sha256: datasetSha256,
    outcomeReconciliation: {
      report: auditFile,
      sha256: auditSha256,
      allReconciled: true,
    },
  });
  const cli = (...extra) => spawnSync(process.execPath, [
    path.join(ROOT, "scripts/forecast.mjs"), "tune", "--root", root, ...extra,
  ], {
    encoding: "utf8",
    env: { ...process.env, STARTGG_TOKEN: "" },
    maxBuffer: 10 * 1024 * 1024,
  });

  const first = cli();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /single-threaded nested tuning/);
  assert.match(first.stderr, /Tuning fold 17\/17/);
  const manifest = await readJson(path.join(root, "latest-tuning.json"));
  assert.deepEqual(
    await readJson(path.join(root, "latest-tuning-strict-seeds.json")),
    manifest,
  );
  assert.equal(manifest.evidenceMode.id, "strict-seeds");
  assert.equal(manifest.productize, false);
  assert.equal(manifest.selectedModel, null);
  assert.equal(manifest.uploads, false);
  assert.equal(manifest.tuningSpec.fileSha256, SPEC_FILE_HASH);
  assert.equal(manifest.tuningSpec.semanticSha256,
    FROZEN_TUNING_SPEC_SEMANTIC_SHA256);
  assert.match(manifest.forecasts,
    /^tuning\/runs\/[a-f0-9]{64}\/forecasts\.json$/);
  assert.match(manifest.evaluation,
    /^tuning\/runs\/[a-f0-9]{64}\/evaluation-[a-f0-9]{64}\.json$/);
  assert.match(manifest.report,
    /^tuning\/runs\/[a-f0-9]{64}\/report-[a-f0-9]{64}\.md$/);
  const forecastsBody = await readFile(path.join(root, manifest.forecasts), "utf8");
  const evaluationBody = await readFile(path.join(root, manifest.evaluation), "utf8");
  const reportBody = await readFile(path.join(root, manifest.report), "utf8");
  assert.equal(digest(forecastsBody), manifest.forecastSha256);
  assert.equal(digest(evaluationBody), manifest.evaluationSha256);
  assert.equal(digest(reportBody), manifest.reportSha256);
  assert.doesNotMatch(forecastsBody,
    /winnerPlayerId|winnerEntrantId|"scores"|"standings"|"actual"/);
  assert.match(reportBody, /Out-of-sample family summary/);
  assert.match(reportBody, /Frozen candidate grid/);
  const engineManifest = await readJson(path.join(root, manifest.engineManifest));
  assert.equal(engineManifest.forecastSha256, manifest.forecastSha256);
  assert.equal(engineManifest.evaluationSha256, manifest.evaluationSha256);
  for (const fold of engineManifest.leakageAudit.folds) {
    const checkpointFile = path.join(root, manifest.eventForecastDirectory,
      fold.eventForecastSha256 + ".json");
    const checkpointBody = await readFile(checkpointFile, "utf8");
    assert.equal(digest(checkpointBody), fold.eventForecastSha256);
    assert.doesNotMatch(checkpointBody,
      /winnerPlayerId|winnerEntrantId|"scores"|"standings"|"actual"/);
  }

  const second = cli();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await readJson(path.join(root, "latest-tuning.json")), manifest);
  assert.match(second.stderr, /\(resumed\)/);

  const assumed = cli("--allow-unverified-historical-seeds");
  assert.equal(assumed.status, 0, assumed.stderr);
  const assumedManifest = await readJson(path.join(root, "latest-tuning.json"));
  assert.deepEqual(
    await readJson(path.join(root, "latest-tuning-availability-assumed.json")),
    assumedManifest,
  );
  assert.equal(assumedManifest.evidenceMode.id, "availability-assumed");
  assert.notEqual(assumedManifest.forecastSha256, manifest.forecastSha256);
  assert.match(cli("--strict-seeds", "--allow-unverified-historical-seeds").stderr,
    /mutually exclusive/);
});
