#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FORECAST_ROOT = path.join(ROOT, ".forecast");
const DEFAULT_OUTPUT = path.join(ROOT, "src/lib/tournamentPredictionBacktestData.ts");

const MODEL_ORDER = Object.freeze([
  "regularized-bt-recent-form",
  "higher-seed",
  "glicko2",
  "recency-elo",
  "dynamic-bradley-terry",
  "neutral",
]);

const MODEL_NAMES = Object.freeze({
  neutral: "Neutral 50/50",
  "higher-seed": "Higher seed",
  "recency-elo": "Recency-weighted Elo",
  glicko2: "Event-period Glicko-2",
  "dynamic-bradley-terry": "Dynamic Bradley-Terry",
  "regularized-bt-recent-form": "Regularized Bradley-Terry + seed + recent form",
});

const EVIDENCE_MODES = Object.freeze([
  {
    id: "strict-seeds",
    pointer: "latest-tuning-strict-seeds.json",
    label: "Strict seeds",
    allowHistoricalSeeds: false,
  },
  {
    id: "availability-assumed",
    pointer: "latest-tuning-availability-assumed.json",
    label: "Seed availability assumed",
    allowHistoricalSeeds: true,
  },
]);

const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "candidateEventScores",
  "cutoff",
  "eventId",
  "eventLabel",
  "outerFolds",
  "predictions",
]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => a.localeCompare(b, "en");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compare)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function artifactDigest(value) {
  return digest(JSON.stringify(canonical(value)) + "\n");
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function unitInterval(value, label) {
  finite(value, label);
  if (value < 0 || value > 1) throw new Error(`${label} must be between zero and one`);
  return value;
}

function nonNegative(value, label) {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readJson(file, label) {
  const body = await readFile(file, "utf8");
  return { body, value: parseJson(body, label) };
}

async function readVerified(file, expectedSha256, label, json = true) {
  const body = await readFile(file, "utf8");
  if (digest(body) !== expectedSha256) throw new Error(`${label} hash mismatch`);
  return json ? { body, value: parseJson(body, label) } : { body, value: body };
}

function safeArtifactPath(forecastRoot, relative, expected, label) {
  if (typeof relative !== "string" || relative !== expected) {
    throw new Error(`Invalid ${label} path`);
  }
  const resolvedRoot = path.resolve(forecastRoot);
  const resolved = path.resolve(resolvedRoot, relative);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Invalid ${label} path`);
  return resolved;
}

function expectedRunHash(pointer) {
  return digest(JSON.stringify({
    forecastSha256: pointer.forecastSha256,
    evaluationSha256: pointer.evaluationSha256,
    reportSha256: pointer.reportSha256,
    engineManifestSha256: pointer.engineManifestSha256,
  }));
}

function sameEvidenceMode(value, expected, label) {
  const mode = plainObject(value, `${label} evidence mode`);
  if (mode.id !== expected.id || mode.allowHistoricalSeeds !== expected.allowHistoricalSeeds
      || mode.snapshotVerified !== false || typeof mode.label !== "string" || !mode.label) {
    throw new Error(`${label} evidence mode mismatch`);
  }
  return mode;
}

function validatePointer(pointer, mode) {
  plainObject(pointer, `${mode.id} pointer`);
  if (pointer.schemaVersion !== 1 || pointer.kind !== "nested-rolling-origin-tuning-pointer-v1") {
    throw new Error(`${mode.id} pointer has an unsupported schema`);
  }
  if (pointer.status !== "exploratory-not-confirmatory"
      || pointer.selectedModel !== null || pointer.productize !== false || pointer.uploads !== false) {
    throw new Error(`${mode.id} pointer cannot be published as exploratory evidence`);
  }
  sameEvidenceMode(pointer.evidenceMode, mode, `${mode.id} pointer`);
  for (const key of [
    "runHash", "runSha256", "sourceDatasetSha256", "sourceDatasetSemanticSha256",
    "forecastSha256", "evaluationSha256", "reportSha256", "engineManifestSha256",
  ]) sha256(pointer[key], `${mode.id} pointer ${key}`);
  sha256(pointer.implementation?.sha256, `${mode.id} implementation hash`);
  sha256(pointer.tuningSpec?.fileSha256, `${mode.id} tuning spec file hash`);
  sha256(pointer.tuningSpec?.semanticSha256, `${mode.id} tuning spec semantic hash`);
  sha256(pointer.outcomeReconciliation?.sha256, `${mode.id} outcome reconciliation hash`);
  if (pointer.runHash !== expectedRunHash(pointer)) throw new Error(`${mode.id} pointer run hash mismatch`);
}

function validateArtifactLinks(pointer, forecasts, evaluation, engineManifest, mode) {
  if (forecasts.kind !== "nested-rolling-origin-set-forecasts-v1") {
    throw new Error(`${mode.id} forecast artifact has an unsupported schema`);
  }
  if (evaluation.kind !== "nested-rolling-origin-tuning-evaluation-v1") {
    throw new Error(`${mode.id} evaluation artifact has an unsupported schema`);
  }
  if (engineManifest.kind !== "nested-rolling-origin-model-tuning-manifest-v1") {
    throw new Error(`${mode.id} engine manifest has an unsupported schema`);
  }
  sameEvidenceMode(forecasts.evidenceMode, mode, `${mode.id} forecast`);
  sameEvidenceMode(engineManifest.evidenceMode, mode, `${mode.id} engine manifest`);
  if (forecasts.evidenceMode.label !== pointer.evidenceMode.label
      || engineManifest.evidenceMode.label !== pointer.evidenceMode.label) {
    throw new Error(`${mode.id} evidence description mismatch`);
  }
  if (forecasts.selectedModel !== null || forecasts.productize !== false || forecasts.uploads !== false
      || forecasts.sourceIdentity?.targetOutcomesIncluded !== false) {
    throw new Error(`${mode.id} forecast artifact is not safe held-out evidence`);
  }
  if (evaluation.forecastSha256 !== pointer.forecastSha256
      || engineManifest.forecastSha256 !== pointer.forecastSha256
      || engineManifest.evaluationSha256 !== pointer.evaluationSha256) {
    throw new Error(`${mode.id} forecast/evaluation cross-reference mismatch`);
  }
  for (const artifact of [evaluation, engineManifest]) {
    if (artifact.sourceDatasetSha256 !== pointer.sourceDatasetSha256
        || artifact.sourceDatasetSemanticSha256 !== pointer.sourceDatasetSemanticSha256) {
      throw new Error(`${mode.id} source dataset hash mismatch`);
    }
  }
  for (const artifact of [forecasts, evaluation, engineManifest]) {
    if (artifact.implementation?.sha256 !== pointer.implementation.sha256
        || artifact.tuningSpec?.fileSha256 !== pointer.tuningSpec.fileSha256
        || artifact.tuningSpec?.semanticSha256 !== pointer.tuningSpec.semanticSha256) {
      throw new Error(`${mode.id} implementation or tuning-spec hash mismatch`);
    }
  }
  for (const artifact of [evaluation, engineManifest]) {
    if (artifact.outcomeReconciliation?.sha256 !== pointer.outcomeReconciliation.sha256
        || artifact.outcomeReconciliation?.datasetSha256 !== pointer.sourceDatasetSha256
        || artifact.outcomeReconciliation?.allReconciled !== true) {
      throw new Error(`${mode.id} outcome-reconciliation hash mismatch`);
    }
  }
  if (engineManifest.runSha256 !== pointer.runSha256) {
    throw new Error(`${mode.id} engine run hash mismatch`);
  }
  const { runSha256: _runSha256, ...manifestBase } = engineManifest;
  if (artifactDigest(manifestBase) !== pointer.runSha256) {
    throw new Error(`${mode.id} engine manifest content hash mismatch`);
  }
  if (engineManifest.status !== "exploratory-not-confirmatory"
      || engineManifest.selectedModel !== null || engineManifest.productize !== false
      || engineManifest.uploads !== false || evaluation.selectedModel !== null
      || evaluation.productize !== false || evaluation.uploads !== false) {
    throw new Error(`${mode.id} artifacts select or productize a model`);
  }
}

function validateOptions(value, label) {
  const options = plainObject(value, label);
  const result = {};
  for (const key of Object.keys(options).sort(compare)) {
    const setting = options[key];
    if (setting !== null && !["string", "number", "boolean"].includes(typeof setting)) {
      throw new Error(`${label}.${key} is not a public scalar setting`);
    }
    if (typeof setting === "number") finite(setting, `${label}.${key}`);
    result[key] = setting;
  }
  return result;
}

function candidateSelections(forecasts, modelId, outerEvents, defaultCandidateId) {
  if (!Array.isArray(forecasts.events) || forecasts.events.length !== outerEvents) {
    throw new Error(`${modelId} forecast event coverage mismatch`);
  }
  const selected = new Map();
  for (const [eventIndex, event] of forecasts.events.entries()) {
    if (!Array.isArray(event.selections) || event.selections.length !== MODEL_ORDER.length) {
      throw new Error(`Forecast event ${eventIndex} does not contain the six-model suite`);
    }
    const rows = event.selections.filter((row) => row?.modelId === modelId);
    if (rows.length !== 1) throw new Error(`Forecast event ${eventIndex} must select ${modelId} exactly once`);
    const row = rows[0];
    if (typeof row.selectedCandidateId !== "string" || !row.selectedCandidateId) {
      throw new Error(`${modelId} has an invalid selected candidate`);
    }
    const options = validateOptions(row.options, `${modelId}/${row.selectedCandidateId} options`);
    const prior = selected.get(row.selectedCandidateId);
    if (prior && JSON.stringify(prior.options) !== JSON.stringify(options)) {
      throw new Error(`${modelId}/${row.selectedCandidateId} changes options across folds`);
    }
    selected.set(row.selectedCandidateId, {
      candidateId: row.selectedCandidateId,
      isDefault: row.selectedCandidateId === defaultCandidateId,
      options,
      count: (prior?.count ?? 0) + 1,
    });
  }
  return [...selected.values()]
    .sort((a, b) => b.count - a.count || compare(a.candidateId, b.candidateId))
    .map((row) => ({ ...row, frequency: row.count / outerEvents }));
}

function defaultCandidate(evaluation, modelId) {
  if (!Array.isArray(evaluation.outerFolds) || !evaluation.outerFolds.length) {
    throw new Error(`${modelId} evaluation has no outer folds`);
  }
  const ids = new Set();
  for (const [foldIndex, fold] of evaluation.outerFolds.entries()) {
    if (!Array.isArray(fold.models) || fold.models.length !== MODEL_ORDER.length) {
      throw new Error(`Evaluation fold ${foldIndex} does not contain the six-model suite`);
    }
    const rows = fold.models.filter((row) => row?.id === modelId);
    if (rows.length !== 1 || typeof rows[0].defaultCandidateId !== "string") {
      throw new Error(`Evaluation fold ${foldIndex} must contain one ${modelId} default`);
    }
    ids.add(rows[0].defaultCandidateId);
  }
  if (ids.size !== 1) throw new Error(`${modelId} default candidate changes across folds`);
  return [...ids][0];
}

function interval(value, label) {
  const summary = plainObject(value, label);
  if (!["descriptive-paired-event-bootstrap", "not-available"].includes(summary.status)) {
    throw new Error(`${label} has an unsupported status`);
  }
  if (summary.status === "not-available") {
    if (summary.estimate !== null || summary.interval95 !== null) {
      throw new Error(`${label} unavailable interval must be null`);
    }
    return { estimate: null, interval95: null, status: "not-available" };
  }
  const bounds = plainObject(summary.interval95, `${label} 95% interval`);
  return {
    estimate: finite(summary.estimate, `${label} estimate`),
    interval95: {
      lower: finite(bounds.lower, `${label} lower bound`),
      upper: finite(bounds.upper, `${label} upper bound`),
    },
    status: "descriptive-paired-event-bootstrap",
  };
}

function publicModels(forecasts, evaluation) {
  if (!Array.isArray(evaluation.models)) throw new Error("Evaluation has no model summaries");
  const sourceById = new Map(evaluation.models.map((model) => [model?.id, model]));
  if (evaluation.models.length !== MODEL_ORDER.length || sourceById.size !== MODEL_ORDER.length
      || MODEL_ORDER.some((modelId) => !sourceById.has(modelId))) {
    throw new Error("Evaluation does not contain the complete six-model suite");
  }
  return MODEL_ORDER.map((modelId) => {
    const model = plainObject(sourceById.get(modelId), `${modelId} summary`);
    const eventMacro = plainObject(model.eventMacro, `${modelId} event-macro metrics`);
    const pooled = plainObject(model.pooled, `${modelId} pooled metrics`);
    const tuning = plainObject(model.innerSelectedVersusDefault, `${modelId} tuning diagnostics`);
    const bootstrap = plainObject(tuning.pairedEventBootstrap95, `${modelId} tuning intervals`);
    const selectionModes = plainObject(model.selectionModes, `${modelId} selection modes`);
    const outerEvents = nonNegativeInteger(model.outerEvents, `${modelId} outer events`);
    const scoredOuterEvents = nonNegativeInteger(model.scoredOuterEvents, `${modelId} scored events`);
    const outerSets = nonNegativeInteger(model.outerSets, `${modelId} outer sets`);
    const matureEvents = nonNegativeInteger(tuning.events, `${modelId} mature events`);
    const fallbackEvents = Array.isArray(model.fallbackOuterEvents)
      ? model.fallbackOuterEvents.length : NaN;
    nonNegativeInteger(fallbackEvents, `${modelId} fallback events`);
    if (scoredOuterEvents > outerEvents || fallbackEvents > outerEvents) {
      throw new Error(`${modelId} scored/fallback coverage exceeds its outer events`);
    }
    const modes = {
      fixed: nonNegativeInteger(selectionModes.fixed, `${modelId} fixed folds`),
      warmupDefault: nonNegativeInteger(selectionModes.warmupDefault, `${modelId} warmup folds`),
      innerUnavailableDefault: nonNegativeInteger(selectionModes.innerUnavailableDefault,
        `${modelId} unavailable-inner folds`),
      innerSelected: nonNegativeInteger(selectionModes.innerSelected, `${modelId} selected folds`),
    };
    if (Object.values(modes).reduce((sum, count) => sum + count, 0) !== outerEvents
        || matureEvents !== modes.innerSelected) {
      throw new Error(`${modelId} selection-mode counts do not match outer coverage`);
    }
    const defaultCandidateId = defaultCandidate(evaluation, modelId);
    return {
      id: modelId,
      name: MODEL_NAMES[modelId],
      outerEvents,
      scoredOuterEvents,
      outerSets,
      eventMacro: {
        logLoss: nonNegative(eventMacro.logLoss, `${modelId} event-macro log loss`),
        brier: unitInterval(eventMacro.brier, `${modelId} event-macro Brier`),
        accuracy: unitInterval(eventMacro.accuracy, `${modelId} event-macro accuracy`),
        auc: unitInterval(eventMacro.auc, `${modelId} event-macro AUC`),
      },
      pooledCoverage: unitInterval(pooled.coverage, `${modelId} pooled coverage`),
      tuning: {
        matureEvents,
        fallbackEvents,
        selectionModes: modes,
        versusDefault: {
          betterWhen: "negative",
          logLoss: interval(bootstrap.logLoss, `${modelId} log-loss delta`),
          brier: interval(bootstrap.brier, `${modelId} Brier delta`),
        },
        selectedSettings: candidateSelections(forecasts, modelId, outerEvents, defaultCandidateId),
      },
    };
  });
}

function assertAggregateOnly(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAggregateOnly(entry, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
      throw new Error(`Public bundle contains non-aggregate field ${[...pathParts, key].join(".")}`);
    }
    assertAggregateOnly(child, [...pathParts, key]);
  }
}

async function buildMode(forecastRoot, mode) {
  const pointerFile = path.join(forecastRoot, mode.pointer);
  const { body: pointerBody, value: pointer } = await readJson(pointerFile, `${mode.id} pointer`);
  validatePointer(pointer, mode);

  const runDirectory = `tuning/runs/${pointer.forecastSha256}`;
  const forecastsFile = safeArtifactPath(forecastRoot, pointer.forecasts,
    `${runDirectory}/forecasts.json`, `${mode.id} forecast`);
  const evaluationFile = safeArtifactPath(forecastRoot, pointer.evaluation,
    `${runDirectory}/evaluation-${pointer.evaluationSha256}.json`, `${mode.id} evaluation`);
  const reportFile = safeArtifactPath(forecastRoot, pointer.report,
    `${runDirectory}/report-${pointer.reportSha256}.md`, `${mode.id} report`);
  const engineManifestFile = safeArtifactPath(forecastRoot, pointer.engineManifest,
    `${runDirectory}/manifest-${pointer.engineManifestSha256}.json`, `${mode.id} engine manifest`);

  const [forecastsResult, evaluationResult, reportResult, engineManifestResult] = await Promise.all([
    readVerified(forecastsFile, pointer.forecastSha256, `${mode.id} forecast`),
    readVerified(evaluationFile, pointer.evaluationSha256, `${mode.id} evaluation`),
    readVerified(reportFile, pointer.reportSha256, `${mode.id} report`, false),
    readVerified(engineManifestFile, pointer.engineManifestSha256, `${mode.id} engine manifest`),
  ]);
  const forecasts = forecastsResult.value;
  const evaluation = evaluationResult.value;
  const engineManifest = engineManifestResult.value;
  validateArtifactLinks(pointer, forecasts, evaluation, engineManifest, mode);
  if (!reportResult.body.includes(`Evidence mode: **${mode.id}**`)
      || !reportResult.body.includes(`Forecast SHA-256: \`${pointer.forecastSha256}\``)
      || !reportResult.body.includes(`Evaluation SHA-256: \`${pointer.evaluationSha256}\``)) {
    throw new Error(`${mode.id} report does not identify its verified artifacts`);
  }

  const coverage = plainObject(evaluation.coverage, `${mode.id} coverage`);
  const objective = plainObject(evaluation.objective, `${mode.id} objective`);
  if (objective.scoringUnit !== "eligible realized target set") {
    throw new Error(`${mode.id} uses an unsupported scoring unit`);
  }
  const models = publicModels(forecasts, evaluation);
  const outerEvents = nonNegativeInteger(coverage.outerEvents, `${mode.id} outer events`);
  const outerSets = nonNegativeInteger(coverage.outerSets, `${mode.id} outer sets`);
  if (models.some((model) => model.outerEvents !== outerEvents || model.outerSets !== outerSets)) {
    throw new Error(`${mode.id} model coverage does not match run coverage`);
  }
  if (!Array.isArray(engineManifest.warnings)
      || engineManifest.warnings.some((warning) => typeof warning !== "string" || !warning)) {
    throw new Error(`${mode.id} engine manifest has invalid caveats`);
  }
  return {
    coverage: { events: outerEvents, sets: outerSets, scoringUnit: objective.scoringUnit },
    mode: {
      id: mode.id,
      label: mode.label,
      description: pointer.evidenceMode.label,
      allowHistoricalSeeds: mode.allowHistoricalSeeds,
      snapshotVerified: false,
      selectedModel: null,
      productize: false,
      models,
      caveats: [...engineManifest.warnings],
      sourceHashes: {
        pointerSha256: digest(pointerBody),
        runHash: pointer.runHash,
        runSha256: pointer.runSha256,
        forecastSha256: pointer.forecastSha256,
        evaluationSha256: pointer.evaluationSha256,
        reportSha256: pointer.reportSha256,
        engineManifestSha256: pointer.engineManifestSha256,
        datasetSha256: pointer.sourceDatasetSha256,
        datasetSemanticSha256: pointer.sourceDatasetSemanticSha256,
        implementationSha256: pointer.implementation.sha256,
        tuningSpecFileSha256: pointer.tuningSpec.fileSha256,
        tuningSpecSemanticSha256: pointer.tuningSpec.semanticSha256,
        outcomeReconciliationSha256: pointer.outcomeReconciliation.sha256,
      },
    },
  };
}

export async function buildTournamentPredictionBacktestBundle({
  forecastRoot = DEFAULT_FORECAST_ROOT,
} = {}) {
  const builtModes = [];
  for (const mode of EVIDENCE_MODES) builtModes.push(await buildMode(forecastRoot, mode));
  const [first, ...rest] = builtModes;
  if (!first || rest.some((entry) => JSON.stringify(entry.coverage) !== JSON.stringify(first.coverage))) {
    throw new Error("Strict and seed-assumed runs do not share identical out-of-sample coverage");
  }
  const datasetHash = first.mode.sourceHashes.datasetSha256;
  if (rest.some((entry) => entry.mode.sourceHashes.datasetSha256 !== datasetHash)) {
    throw new Error("Strict and seed-assumed runs do not share one source dataset");
  }
  const bundle = {
    schemaVersion: 1,
    kind: "tournament-prediction-public-backtest-v1",
    status: "exploratory-not-confirmatory",
    coverage: first.coverage,
    modes: builtModes.map((entry) => entry.mode),
  };
  assertAggregateOnly(bundle);
  return bundle;
}

export function serializeTournamentPredictionBacktestModule(bundle) {
  assertAggregateOnly(bundle);
  return "// Generated by scripts/build-tournament-backtest-data.mjs; do not edit by hand.\n"
    + "import type { TournamentPredictionBacktestBundle } from \"./tournamentPredictionBacktestData.types\";\n\n"
    + `export const TOURNAMENT_PREDICTION_BACKTEST = ${JSON.stringify(bundle, null, 2)} satisfies TournamentPredictionBacktestBundle;\n`;
}

export async function writeTournamentPredictionBacktestModule({
  forecastRoot = DEFAULT_FORECAST_ROOT,
  output = DEFAULT_OUTPUT,
} = {}) {
  const bundle = await buildTournamentPredictionBacktestBundle({ forecastRoot });
  const body = serializeTournamentPredictionBacktestModule(bundle);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, body, "utf8");
  return { body, bundle, output };
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await writeTournamentPredictionBacktestModule();
  console.log(JSON.stringify({
    output: path.relative(ROOT, result.output),
    events: result.bundle.coverage.events,
    sets: result.bundle.coverage.sets,
    modes: result.bundle.modes.map((mode) => mode.id),
    modelsPerMode: result.bundle.modes.map((mode) => mode.models.length),
  }, null, 2));
}
