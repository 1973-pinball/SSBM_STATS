import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { actualResult, fitBasicModels, initialSeedIndex } from "./baselines.mjs";
import {
  MODEL_IDS,
  swapReportingSides,
  validateModelOptionsById,
} from "./comparison.mjs";
import { fitDynamicBradleyTerryModel } from "./dynamic-bradley-terry.mjs";
import { chronologicalFolds, eventTimeBounds, scorePredictions } from "./evaluation.mjs";
import { fitGlicko2Model } from "./glicko2.mjs";
import { markdownCodeSpan, markdownText } from "./markdown.mjs";
import { fitRegularizedBradleyTerryModel } from "./regularized-bradley-terry.mjs";

const OUTER_BOOTSTRAP_REPLICATES = 10_000;
const MIN_OUTER_INTERVAL_EVENTS = 5;
const INVALID_FIT_FALLBACK = "neutral-0.5-invalid-fit";
export const FROZEN_TUNING_SPEC_SEMANTIC_SHA256 = "30d52b2a2471c2db0aa2e3bda56e7098f2d7e7807f570c27af3f3c208311ce6a";
const IMPLEMENTATION_MODULES = Object.freeze([
  "baselines.mjs",
  "comparison.mjs",
  "dynamic-bradley-terry.mjs",
  "evaluation.mjs",
  "glicko2.mjs",
  "nested-tuning.mjs",
  "regularized-bradley-terry.mjs",
]);
const compare = (a, b) => String(a).localeCompare(String(b), "en");
const mean = (values) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length
  : null;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function objectDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// Canonical datasets are hundreds of megabytes. Hash each top-level row, sort
// those fixed-size digests, and stream them into one semantic identity rather
// than constructing a second canonical copy of the entire dataset in memory.
export function semanticDatasetDigest(dataset) {
  requirePlainObject(dataset, "Canonical dataset");
  const hash = createHash("sha256");
  hash.update("forecast-dataset-semantic-v1\0");
  for (const key of Object.keys(dataset).sort(compare)) {
    hash.update(String(Buffer.byteLength(key)) + ":" + key + "\0");
    const value = dataset[key];
    if (Array.isArray(value)) {
      const rowDigests = value.map(objectDigest).sort(compare);
      hash.update("array:" + rowDigests.length + "\0");
      for (const rowDigest of rowDigests) hash.update(rowDigest);
    } else {
      hash.update("value:" + objectDigest(value) + "\0");
    }
  }
  return hash.digest("hex");
}

export function serializeNestedTuningArtifact(value) {
  return JSON.stringify(canonical(value)) + "\n";
}

function artifactDigest(value) {
  return createHash("sha256").update(serializeNestedTuningArtifact(value)).digest("hex");
}

export async function nestedTuningImplementationIdentity() {
  const files = await Promise.all(IMPLEMENTATION_MODULES.map(async (name) => {
    const body = await readFile(new URL(name, import.meta.url));
    return {
      path: "scripts/lib/forecast/" + name,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.byteLength,
    };
  }));
  const recipe = {
    schemaVersion: 1,
    kind: "nested-tuning-implementation-recipe-v1",
    hashRecipe: "SHA-256 of canonical-json-utf8-lf-v1 over this recipe without sha256",
    files,
  };
  return deepFreeze({ ...recipe, sha256: artifactDigest(recipe) });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(label + " must be a lowercase 64-character SHA-256");
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + " must be a positive integer");
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value;
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateTuningSpec(input) {
  const spec = structuredClone(requirePlainObject(input, "Tuning spec"));
  const semanticSha256 = objectDigest(spec);
  if (semanticSha256 !== FROZEN_TUNING_SPEC_SEMANTIC_SHA256) {
    throw new Error("Tuning spec semantic hash differs from the frozen 24-candidate protocol");
  }
  if (spec.schemaVersion !== 1 || typeof spec.id !== "string" || !spec.id
      || spec.status !== "frozen-exploratory") {
    throw new Error("Tuning spec must be a named frozen-exploratory schemaVersion 1 document");
  }
  const policy = requirePlainObject(spec.policy, "Tuning policy");
  requirePositiveInteger(policy.outerMinTrainingEvents, "outerMinTrainingEvents");
  requirePositiveInteger(policy.innerMinTrainingEvents, "innerMinTrainingEvents");
  requirePositiveInteger(policy.innerMinCompletedFolds, "innerMinCompletedFolds");
  if (policy.outerMinTrainingEvents !== 1
      || policy.innerMinTrainingEvents !== 5 || policy.innerMinCompletedFolds !== 12
      || policy.primaryObjective !== "event-macro-log-loss"
      || policy.secondaryObjective !== "event-macro-brier"
      || policy.selectionRule !== "paired-one-standard-error-default-nearest"
      || policy.finalTieBreak !== "candidate-id"
      || policy.warmup !== "model-default"
      || policy.targetHoldout !== "whole-event"
      || policy.outcomeRelease !== "reported-event-end-and-latest-eligible-set-completion-strictly-before-next-cutoff"
      || policy.reportingOrientation !== "forecast-side-v1"
      || policy.familySelection !== false || policy.productize !== false) {
    throw new Error("Tuning spec does not match the frozen nested rolling-origin policy");
  }
  if (!Array.isArray(spec.models) || !sameValues(spec.models.map((model) => model.id), MODEL_IDS)) {
    throw new Error("Tuning spec models must exactly match the shared six-model suite order");
  }
  const candidateIds = new Set();
  let candidateCount = 0;
  for (const model of spec.models) {
    if (!Array.isArray(model.candidates) || !model.candidates.length
        || typeof model.defaultCandidateId !== "string") {
      throw new Error("Every tuning model needs candidates and a defaultCandidateId");
    }
    let defaults = 0;
    for (const candidate of model.candidates) {
      if (!candidate || typeof candidate.id !== "string" || !candidate.id
          || !Number.isSafeInteger(candidate.defaultDistance) || candidate.defaultDistance < 0) {
        throw new Error("Every tuning candidate needs an ID and nonnegative integer defaultDistance");
      }
      requirePlainObject(candidate.options, "Candidate options");
      if (candidateIds.has(candidate.id)) throw new Error("Duplicate tuning candidate ID: " + candidate.id);
      candidateIds.add(candidate.id);
      if (candidate.id === model.defaultCandidateId) {
        defaults++;
        if (candidate.defaultDistance !== 0) throw new Error("Default candidate distance must be zero");
      }
      if (model.id === "neutral" || model.id === "higher-seed") {
        if (Object.keys(candidate.options).length) throw new Error(model.id + " is a fixed baseline");
      } else {
        validateModelOptionsById({ [model.id]: candidate.options });
      }
      candidateCount++;
    }
    if (defaults !== 1) throw new Error("Model " + model.id + " needs exactly one default candidate");
  }
  if (candidateCount !== 24 || spec.candidateCount !== candidateCount) {
    throw new Error("Frozen tuning spec must contain exactly 24 candidates");
  }
  if (!Array.isArray(spec.evidenceModes) || spec.evidenceModes.length !== 2
      || new Set(spec.evidenceModes.map((mode) => mode?.id)).size !== 2) {
    throw new Error("Tuning spec needs exactly two unique evidence modes");
  }
  const evidenceModes = new Map(spec.evidenceModes.map((mode) => [mode?.id, mode]));
  if (evidenceModes.get("strict-seeds")?.allowHistoricalSeeds !== false
      || evidenceModes.get("availability-assumed")?.allowHistoricalSeeds !== true) {
    throw new Error("Tuning spec needs strict-seeds and availability-assumed evidence modes");
  }
  return deepFreeze(spec);
}

function candidateScore(eventRow, modelId, candidateId) {
  const model = eventRow.models.find((row) => row.id === modelId);
  const candidate = model?.candidates.find((row) => row.candidateId === candidateId);
  if (!candidate) throw new Error("Missing candidate " + candidateId + " for inner event " + eventRow.eventId);
  if (candidate.status !== "valid" || !Number.isFinite(candidate.scores?.logLoss)
      || !Number.isFinite(candidate.scores?.brier)) return null;
  return candidate.scores;
}

function standardError(values) {
  if (values.length < 2) return Infinity;
  const center = mean(values);
  const variance = values.reduce((total, value) => total + (value - center) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

/**
 * Select one configuration from already-held-out earlier event scores.
 * The primary metric is an unweighted mean over event-level log losses.
 */
export function selectCandidateOneStandardError(modelSpec, eventScores) {
  if (!modelSpec || !Array.isArray(modelSpec.candidates) || !modelSpec.candidates.length) {
    throw new Error("Candidate selection needs a model specification");
  }
  if (!Array.isArray(eventScores) || !eventScores.length) {
    throw new Error("Candidate selection needs completed inner event scores");
  }
  const eventIds = eventScores.map((row) => row.eventId);
  if (new Set(eventIds).size !== eventIds.length) throw new Error("Inner event scores contain duplicate events");
  const summaries = modelSpec.candidates.map((candidate) => {
    const rows = eventScores.map((row) => ({
      eventId: row.eventId,
      score: candidateScore(row, modelSpec.id, candidate.id),
    }));
    const invalidEventIds = rows.filter((row) => row.score == null).map((row) => row.eventId);
    const scores = rows.map((row) => row.score).filter(Boolean);
    return {
      candidateId: candidate.id,
      defaultDistance: candidate.defaultDistance,
      eligible: invalidEventIds.length === 0,
      invalidEventIds,
      meanEventLogLoss: invalidEventIds.length ? null : mean(scores.map((score) => score.logLoss)),
      meanEventBrier: invalidEventIds.length ? null : mean(scores.map((score) => score.brier)),
    };
  });
  const eligible = summaries.filter((summary) => summary.eligible);
  if (!eligible.length) {
    return {
      status: "no-fully-valid-candidate",
      rule: "paired-one-standard-error-default-nearest",
      primaryObjective: "event-macro-log-loss",
      secondaryObjective: "event-macro-brier",
      innerEventIds: [...eventIds],
      innerEvents: eventIds.length,
      bestCandidateId: null,
      selectedCandidateId: modelSpec.defaultCandidateId,
      fallbackNotPerformanceSelected: true,
      candidates: summaries.map((summary) => ({
        ...summary,
        pairedMeanDifference: null,
        pairedStandardError: null,
        withinOneStandardError: false,
      })),
    };
  }
  const best = [...eligible].sort((a, b) =>
    a.meanEventLogLoss - b.meanEventLogLoss
    || a.meanEventBrier - b.meanEventBrier
    || compare(a.candidateId, b.candidateId))[0];
  const evidence = summaries.map((summary) => {
    if (!summary.eligible) {
      return {
        ...summary,
        pairedMeanDifference: null,
        pairedStandardError: null,
        withinOneStandardError: false,
      };
    }
    const differences = eventScores.map((row) =>
      candidateScore(row, modelSpec.id, summary.candidateId).logLoss
      - candidateScore(row, modelSpec.id, best.candidateId).logLoss);
    const pairedMeanDifference = mean(differences);
    const pairedStandardError = standardError(differences);
    return {
      ...summary,
      pairedMeanDifference,
      pairedStandardError,
      withinOneStandardError: pairedMeanDifference <= pairedStandardError + Number.EPSILON,
    };
  });
  const selected = [...evidence].filter((row) => row.withinOneStandardError).sort((a, b) =>
    a.defaultDistance - b.defaultDistance
    || a.meanEventBrier - b.meanEventBrier
    || compare(a.candidateId, b.candidateId))[0];
  if (!selected) throw new Error("One-standard-error selection produced no candidate");
  return {
    status: "selected",
    rule: "paired-one-standard-error-default-nearest",
    primaryObjective: "event-macro-log-loss",
    secondaryObjective: "event-macro-brier",
    innerEventIds: [...eventIds],
    innerEvents: eventIds.length,
    bestCandidateId: best.candidateId,
    selectedCandidateId: selected.candidateId,
    candidates: evidence,
  };
}

function modelCandidate(modelSpec, candidateId) {
  const candidate = modelSpec.candidates.find((row) => row.id === candidateId);
  if (!candidate) throw new Error("Unknown candidate " + candidateId + " for " + modelSpec.id);
  return candidate;
}

function fitCandidateModel(modelId, candidate, fold, seedIndex, prefitted = new Map()) {
  if (prefitted.has(candidate.id)) return prefitted.get(candidate.id);
  const input = { events: fold.trainingEvents, sets: fold.trainingSets, cutoff: fold.cutoff };
  let model;
  if (modelId === "neutral" || modelId === "higher-seed" || modelId === "recency-elo") {
    const options = modelId === "recency-elo" ? candidate.options : {};
    model = fitBasicModels({ ...input, seedIndex, options }).find((row) => row.id === modelId);
  } else if (modelId === "glicko2") {
    model = fitGlicko2Model({ ...input, options: candidate.options });
  } else if (modelId === "dynamic-bradley-terry") {
    model = fitDynamicBradleyTerryModel({ ...input, options: candidate.options });
  } else if (modelId === "regularized-bt-recent-form") {
    model = fitRegularizedBradleyTerryModel({ ...input, seedIndex, options: candidate.options });
  }
  if (!model || model.id !== modelId || typeof model.predict !== "function") {
    throw new Error("Candidate fit did not produce model " + modelId);
  }
  return model;
}

function compactFitAudit(model) {
  if (model.id === "regularized-bt-recent-form") {
    const fit = model.methodology?.fit;
    const valid = fit?.converged === true;
    return {
      status: valid ? "valid" : "invalid-nonconverged",
      valid,
      optimizer: "regularized-bradley-terry",
      converged: fit?.converged === true,
      iterations: Number.isSafeInteger(fit?.iterations) ? fit.iterations : null,
      lastLargestDirection: Number.isFinite(fit?.lastLargestDirection)
        ? fit.lastLargestDirection : null,
      lastGradientMax: Number.isFinite(fit?.lastGradientMax) ? fit.lastGradientMax : null,
    };
  }
  if (model.id === "dynamic-bradley-terry") {
    const rows = Array.isArray(model.methodology?.diagnostics) ? model.methodology.diagnostics : [];
    const invalid = rows.filter((row) => row.converged !== true);
    const maxDelta = maximum(rows.map((row) => row.maxDelta));
    return {
      status: invalid.length ? "invalid-nonconverged" : "valid",
      valid: invalid.length === 0,
      optimizer: "dynamic-bradley-terry-event-updates",
      converged: invalid.length === 0,
      eventUpdates: rows.length,
      nonconvergedEventCount: invalid.length,
      nonconvergedEventIds: invalid.map((row) => row.eventId),
      maximumIterations: maximum(rows.map((row) => row.iterations)),
      maxDelta,
    };
  }
  return {
    status: "valid",
    valid: true,
    optimizer: model.id === "glicko2" ? "throws-on-iteration-failure" : "not-iterative",
    converged: true,
  };
}

function matchupOnly(set) {
  if (!set || typeof set.id !== "string" || !Array.isArray(set.playerIds)
      || set.playerIds.length !== 2 || !Array.isArray(set.entrantIds)
      || set.entrantIds.length !== 2) {
    throw new Error("Tuning target needs a set ID and two player/entrant IDs");
  }
  return deepFreeze({
    id: set.id,
    eventId: set.eventId,
    playerIds: [...set.playerIds],
    entrantIds: [...set.entrantIds],
  });
}

function cleanPrediction(prediction, swapped) {
  if (!prediction || !Number.isFinite(prediction.p) || prediction.p < 0 || prediction.p > 1) {
    throw new Error("Candidate returned an invalid probability");
  }
  const row = {
    p: swapped ? 1 - prediction.p : prediction.p,
    covered: prediction.covered === true,
  };
  for (const key of ["knownPlayers", "formKnownPlayers"]) {
    if (prediction[key] != null) {
      if (!Number.isSafeInteger(prediction[key]) || prediction[key] < 0 || prediction[key] > 2) {
        throw new Error("Candidate returned invalid " + key);
      }
      row[key] = prediction[key];
    }
  }
  if (prediction.seedCovered != null) {
    if (typeof prediction.seedCovered !== "boolean") {
      throw new Error("Candidate returned invalid seedCovered");
    }
    row.seedCovered = prediction.seedCovered;
  }
  return row;
}

function forecastCandidate(model, targetMatchups) {
  return targetMatchups.map((target) => {
    const swapped = swapReportingSides(target.id);
    return cleanPrediction(model.predict(target), swapped);
  });
}

function invalidFitFallbackForecast(targetMatchups) {
  return targetMatchups.map(() => ({
    p: 0.5,
    covered: false,
    fallback: INVALID_FIT_FALLBACK,
  }));
}

function cleanOperationalPrediction(prediction, fitValid) {
  const row = cleanPrediction(prediction, false);
  if (fitValid) {
    if (prediction.fallback != null) {
      throw new Error("Valid candidate forecast cannot claim an invalid-fit fallback");
    }
  } else {
    if (prediction.fallback !== INVALID_FIT_FALLBACK
        || prediction.p !== 0.5 || prediction.covered !== false) {
      throw new Error("Invalid candidate fit must checkpoint its exact neutral fallback forecast");
    }
    row.fallback = INVALID_FIT_FALLBACK;
  }
  return row;
}

function scoreForecast(predictions, targetSets) {
  if (predictions.length !== targetSets.length || !predictions.length) {
    throw new Error("Candidate forecast and target-set counts differ or are empty");
  }
  const rows = [];
  let covered = 0;
  for (let index = 0; index < predictions.length; index++) {
    const prediction = predictions[index];
    const target = targetSets[index];
    const swapped = swapReportingSides(target.id);
    const actual = swapped ? 1 - actualResult(target) : actualResult(target);
    rows.push({ p: prediction.p, actual });
    covered += Number(prediction.covered);
  }
  const scores = scorePredictions(rows);
  return {
    n: scores.n,
    logLoss: scores.logLoss,
    brier: scores.brier,
    accuracy: scores.accuracy,
    auc: scores.auc,
    logLossEpsilon: scores.logLossEpsilon,
    covered,
    coverage: covered / predictions.length,
    sums: {
      logLoss: scores.logLoss * scores.n,
      brier: scores.brier * scores.n,
      correct: scores.accuracy * scores.n,
    },
  };
}

function targetOutcomeAvailability(fold) {
  const bounds = eventTimeBounds(fold.targetEvent);
  if (bounds.trainingEnd == null) {
    return { outcomeAvailableAt: null, reason: "missing-reported-end", completionGuardSetId: null };
  }
  let outcomeAvailableAt = bounds.trainingEnd;
  let completionGuardSetId = null;
  for (const set of fold.targetSets) {
    const completedAt = set.timestamps?.completedAt;
    if (Number.isFinite(completedAt) && completedAt > outcomeAvailableAt) {
      outcomeAvailableAt = completedAt;
      completionGuardSetId = set.id;
    }
  }
  return { outcomeAvailableAt, reason: null, completionGuardSetId };
}

function eventLabel(event) {
  return event.major?.name ?? event.tournament?.name ?? event.name ?? event.id;
}

function selectionFor(modelSpec, availableScores, minimumInnerFolds) {
  const defaultCandidate = modelCandidate(modelSpec, modelSpec.defaultCandidateId);
  if (modelSpec.candidates.length === 1) {
    return {
      modelId: modelSpec.id,
      mode: "fixed",
      selectedCandidateId: defaultCandidate.id,
      options: structuredClone(defaultCandidate.options),
      innerEventsAvailable: availableScores.length,
      evidence: null,
    };
  }
  if (availableScores.length < minimumInnerFolds) {
    return {
      modelId: modelSpec.id,
      mode: "warmup-default",
      selectedCandidateId: defaultCandidate.id,
      options: structuredClone(defaultCandidate.options),
      innerEventsAvailable: availableScores.length,
      evidence: {
        requiredInnerEvents: minimumInnerFolds,
        reason: "insufficient-completed-inner-event-folds",
      },
    };
  }
  const evidence = selectCandidateOneStandardError(modelSpec, availableScores);
  const selected = modelCandidate(modelSpec, evidence.selectedCandidateId);
  return {
    modelId: modelSpec.id,
    mode: evidence.status === "selected" ? "inner-selected" : "inner-unavailable-default",
    selectedCandidateId: selected.id,
    options: structuredClone(selected.options),
    innerEventsAvailable: availableScores.length,
    evidence,
  };
}

function maximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function fixedRandom(key) {
  let state = createHash("sha256").update("nested-tuning-outer-bootstrap-v1:" + key)
    .digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(values, probability) {
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return ordered[lowerIndex];
  return ordered[lowerIndex]
    + (ordered[upperIndex] - ordered[lowerIndex]) * (position - lowerIndex);
}

function pairedOuterSummary(rows, modelId, metric) {
  const values = rows.map((row) => row.versusDefault?.[metric]);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Every mature outer fold must retain its operational tuned-versus-default "
      + metric + " difference");
  }
  const estimate = mean(values);
  if (values.length < MIN_OUTER_INTERVAL_EVENTS) {
    return {
      estimate,
      interval95: null,
      status: values.length ? "insufficient-events-for-interval" : "not-available",
    };
  }
  const random = fixedRandom(modelId + ":" + metric);
  const samples = new Float64Array(OUTER_BOOTSTRAP_REPLICATES);
  for (let replicate = 0; replicate < OUTER_BOOTSTRAP_REPLICATES; replicate++) {
    let total = 0;
    for (let draw = 0; draw < values.length; draw++) {
      total += values[Math.floor(random() * values.length)];
    }
    samples[replicate] = total / values.length;
  }
  return {
    estimate,
    interval95: {
      lower: quantile(samples, 0.025),
      upper: quantile(samples, 0.975),
    },
    status: "descriptive-paired-event-bootstrap",
  };
}

function auditFold(fold, availableScores, selections) {
  const targetId = fold.targetEvent.id;
  const trainingEnds = fold.trainingEvents.map((event) => eventTimeBounds(event).trainingEnd);
  const validTrainingCompletions = fold.trainingSets.map((set) => set.timestamps?.completedAt)
    .filter((value) => Number.isFinite(value) && value > 0);
  const violations = [];
  if (fold.trainingEvents.some((event) => event.id === targetId)
      || fold.trainingSets.some((set) => set.eventId === targetId)) {
    violations.push("target-event-in-training");
  }
  if (trainingEnds.some((value) => value == null || value >= fold.cutoff)) {
    violations.push("training-event-not-strictly-before-cutoff");
  }
  if (validTrainingCompletions.some((value) => value >= fold.cutoff)) {
    violations.push("training-set-completion-not-strictly-before-cutoff");
  }
  if (availableScores.some((row) => row.outcomeAvailableAt == null
      || row.outcomeAvailableAt >= fold.cutoff || row.eventId === targetId)) {
    violations.push("inner-score-not-available-before-cutoff");
  }
  if (!Object.isFrozen(selections)) violations.push("selection-not-frozen-before-scoring");
  if (violations.length) {
    throw new Error("Nested tuning leakage audit failed for " + targetId + ": " + violations.join(", "));
  }
  return {
    targetEventId: targetId,
    cutoff: fold.cutoff,
    targetAbsentFromTraining: true,
    trainingEventCount: fold.trainingEvents.length,
    trainingSetCount: fold.trainingSets.length,
    maximumTrainingEnd: maximum(trainingEnds),
    maximumReportedTrainingSetCompletion: maximum(validTrainingCompletions),
    missingTrainingSetCompletionTimes: fold.trainingSets.filter((set) =>
      !Number.isFinite(set.timestamps?.completedAt) || set.timestamps.completedAt <= 0).length,
    tuningHistoryEventIds: availableScores.map((row) => row.eventId),
    maximumTuningOutcomeAvailableAt: maximum(availableScores.map((row) => row.outcomeAvailableAt)),
    selectedConfigsFrozenBeforeOuterScoring: true,
    candidateForecastsBuiltFromMatchupOnlyRows: true,
    violations: [],
  };
}

function aggregateModels(scoreEvents, modelSpecs) {
  return modelSpecs.map((modelSpec) => {
    const rows = scoreEvents.map((event) => event.models.find((model) => model.id === modelSpec.id));
    const scored = rows.filter((row) => row.scores != null);
    const n = scored.reduce((total, row) => total + row.scores.n, 0);
    const totals = scored.reduce((result, row) => {
      result.logLoss += row.scores.sums.logLoss;
      result.brier += row.scores.sums.brier;
      result.correct += row.scores.sums.correct;
      result.covered += row.scores.covered;
      return result;
    }, { logLoss: 0, brier: 0, correct: 0, covered: 0 });
    const mature = scored.filter((row) => row.selectionMode === "inner-selected");
    if (mature.some((row) => !Number.isFinite(row.versusDefault?.logLoss)
        || !Number.isFinite(row.versusDefault?.brier))) {
      throw new Error("Mature tuned-versus-default diagnostics must include every operational fold");
    }
    return {
      id: modelSpec.id,
      outerEvents: rows.length,
      scoredOuterEvents: scored.length,
      fallbackOuterEvents: rows.filter((row) => row.status !== "scored")
        .map((row) => ({ eventId: row.eventId, status: row.status })),
      outerSets: n,
      selectionModes: {
        fixed: rows.filter((row) => row.selectionMode === "fixed").length,
        warmupDefault: rows.filter((row) => row.selectionMode === "warmup-default").length,
        innerUnavailableDefault: rows.filter((row) => row.selectionMode === "inner-unavailable-default").length,
        innerSelected: mature.length,
      },
      eventMacro: {
        logLoss: mean(scored.map((row) => row.scores.logLoss)),
        brier: mean(scored.map((row) => row.scores.brier)),
        accuracy: mean(scored.map((row) => row.scores.accuracy)),
        auc: mean(scored.map((row) => row.scores.auc).filter(Number.isFinite)),
      },
      pooled: {
        logLoss: n ? totals.logLoss / n : null,
        brier: n ? totals.brier / n : null,
        accuracy: n ? totals.correct / n : null,
        coverage: n ? totals.covered / n : null,
      },
      innerSelectedVersusDefault: {
        events: mature.length,
        meanEventLogLossDifference: mean(mature.map((row) => row.versusDefault?.logLoss)
          .filter(Number.isFinite)),
        meanEventBrierDifference: mean(mature.map((row) => row.versusDefault?.brier)
          .filter(Number.isFinite)),
        pairedEventBootstrap95: {
          minimumEvents: MIN_OUTER_INTERVAL_EVENTS,
          replicates: OUTER_BOOTSTRAP_REPLICATES,
          estimand: "unweighted mean outer-event tuned-policy minus fixed-default score",
          betterWhen: "negative",
          logLoss: pairedOuterSummary(mature, modelSpec.id, "logLoss"),
          brier: pairedOuterSummary(mature, modelSpec.id, "brier"),
        },
      },
    };
  });
}

function parseJsonBody(body, label) {
  if (typeof body !== "string") throw new TypeError(label + " must be supplied as exact UTF-8 text");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(label + " is not valid JSON");
  }
}

function validateOutcomeReconciliation(body, sourceDatasetSha256, report) {
  const input = requirePlainObject(parseJsonBody(body, "Outcome-reconciliation body"),
    "Outcome-reconciliation report");
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (input.kind !== "forecast-historical-outcome-reconciliation-v1"
      || input.datasetSha256 !== sourceDatasetSha256 || input.allReconciled !== true) {
    throw new Error("Outcome reconciliation must be all-reconciled and match the exact source dataset");
  }
  return deepFreeze({
    sha256,
    datasetSha256: input.datasetSha256,
    allReconciled: true,
    advisoryOnly: input.advisoryOnly === true,
    ...(typeof report === "string" ? { report } : {}),
  });
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(label + " has forbidden fields: " + unknown.sort(compare).join(", "));
}

function validateFitAudit(fit) {
  if (!["valid", "invalid-nonconverged"].includes(fit.status)
      || typeof fit.valid !== "boolean" || typeof fit.optimizer !== "string"
      || typeof fit.converged !== "boolean" || fit.valid !== fit.converged
      || fit.valid !== (fit.status === "valid")) {
    throw new Error("Candidate fit audit has invalid convergence fields");
  }
  for (const key of [
    "iterations", "lastLargestDirection", "lastGradientMax", "eventUpdates",
    "nonconvergedEventCount", "maximumIterations", "maxDelta",
  ]) {
    if (fit[key] != null && (!Number.isFinite(fit[key]) || fit[key] < 0)) {
      throw new Error("Candidate fit audit has invalid " + key);
    }
  }
  if (fit.nonconvergedEventIds != null
      && (!Array.isArray(fit.nonconvergedEventIds)
        || !fit.nonconvergedEventIds.every((value) => typeof value === "string"))) {
    throw new Error("Candidate fit audit has invalid nonconvergedEventIds");
  }
}

function trainingEventInputDigest(event, sets, seedIndex) {
  const hash = createHash("sha256");
  hash.update("nested-tuning-training-event-input-v1\0");
  hash.update(objectDigest({
    id: event.id,
    eligible: event.eligible,
    chronology: event.chronology,
  }));
  const entrantIds = new Set();
  for (const set of [...sets].sort((a, b) => compare(a.id, b.id))) {
    hash.update(objectDigest({
      id: set.id,
      eventId: set.eventId,
      eligible: set.eligible,
      playerIds: set.playerIds,
      entrantIds: set.entrantIds,
      winnerPlayerId: set.winnerPlayerId,
      completedAt: set.timestamps?.completedAt ?? null,
    }));
    for (const entrantId of set.entrantIds ?? []) entrantIds.add(entrantId);
  }
  for (const entrantId of [...entrantIds].sort(compare)) {
    hash.update(objectDigest({ entrantId, seed: seedIndex.seeds.get(entrantId) ?? null }));
  }
  return hash.digest("hex");
}

function foldTrainingInputDigest(fold, seedIndex, cache) {
  const setsByEvent = new Map();
  for (const set of fold.trainingSets) {
    if (!setsByEvent.has(set.eventId)) setsByEvent.set(set.eventId, []);
    setsByEvent.get(set.eventId).push(set);
  }
  const entries = fold.trainingEvents.map((event) => {
    if (!cache.has(event.id)) {
      cache.set(event.id, trainingEventInputDigest(event, setsByEvent.get(event.id) ?? [], seedIndex));
    }
    return { eventId: event.id, sha256: cache.get(event.id) };
  }).sort((a, b) => compare(a.eventId, b.eventId));
  return objectDigest(entries);
}

function targetFeatureInputDigest(fold, targetMatchups, seedIndex) {
  const entrantIds = [...new Set(targetMatchups.flatMap((set) => set.entrantIds))].sort(compare);
  return objectDigest({
    event: {
      id: fold.targetEvent.id,
      eligible: fold.targetEvent.eligible,
      label: eventLabel(fold.targetEvent),
      cutoff: fold.cutoff,
      cutoffSources: fold.cutoffSources,
    },
    matchups: targetMatchups,
    seeds: entrantIds.map((entrantId) => ({
      entrantId,
      seed: seedIndex.seeds.get(entrantId) ?? null,
    })),
  });
}

function validateCandidateCheckpoint(checkpoint, expectedContext) {
  requirePlainObject(checkpoint, "Candidate forecast checkpoint");
  exactKeys(checkpoint, ["schemaVersion", "kind", "contextSha256", "context", "candidateForecasts"],
    "Candidate forecast checkpoint");
  if (checkpoint.schemaVersion !== 1
      || checkpoint.kind !== "nested-rolling-origin-candidate-event-forecast-v1"
      || checkpoint.contextSha256 !== artifactDigest(expectedContext)
      || serializeNestedTuningArtifact(checkpoint.context)
        !== serializeNestedTuningArtifact(expectedContext)) {
    throw new Error("Candidate forecast checkpoint context does not match this outer fold");
  }
  if (!Array.isArray(checkpoint.candidateForecasts)
      || checkpoint.candidateForecasts.length !== expectedContext.candidatePlan.length) {
    throw new Error("Candidate forecast checkpoint has incomplete model membership");
  }
  const records = new Map();
  for (let modelIndex = 0; modelIndex < expectedContext.candidatePlan.length; modelIndex++) {
    const expectedModel = expectedContext.candidatePlan[modelIndex];
    const actualModel = checkpoint.candidateForecasts[modelIndex];
    if (actualModel && typeof actualModel === "object") {
      exactKeys(actualModel, ["modelId", "candidates"], "Candidate forecast model");
    }
    if (actualModel?.modelId !== expectedModel.modelId || !Array.isArray(actualModel.candidates)
        || !sameValues(actualModel.candidates.map((row) => row.candidateId), expectedModel.candidateIds)) {
      throw new Error("Candidate forecast checkpoint candidate membership differs from the frozen plan");
    }
    for (const row of actualModel.candidates) {
      requirePlainObject(row, "Candidate forecast row");
      exactKeys(row, ["candidateId", "fit", "predictions"], "Candidate forecast row");
      requirePlainObject(row.fit, "Candidate fit audit");
      exactKeys(row.fit, [
        "status", "valid", "optimizer", "converged", "iterations",
        "lastLargestDirection", "lastGradientMax", "eventUpdates",
        "nonconvergedEventCount", "nonconvergedEventIds", "maximumIterations", "maxDelta",
      ], "Candidate fit audit");
      validateFitAudit(row.fit);
      if (!Array.isArray(row.predictions)
          || row.predictions.length !== expectedContext.matchups.length) {
        throw new Error("Candidate forecast has incomplete target predictions");
      }
      for (const prediction of row.predictions) {
        const cleaned = cleanOperationalPrediction(prediction, row.fit.valid);
        if (serializeNestedTuningArtifact(cleaned) !== serializeNestedTuningArtifact(prediction)) {
          throw new Error("Candidate prediction has forbidden fields");
        }
      }
      records.set(row.candidateId, deepFreeze({
        fit: structuredClone(row.fit),
        predictions: row.predictions.map((prediction) =>
          cleanOperationalPrediction(prediction, row.fit.valid)),
      }));
    }
  }
  return records;
}

function selectedForecastRows(targetMatchups, selections, records) {
  return targetMatchups.map((target, index) => ({
    setId: target.id,
    sourcePlayerIds: [...target.playerIds],
    sourceEntrantIds: [...target.entrantIds],
    sourceSidesSwapped: swapReportingSides(target.id),
    playerIds: swapReportingSides(target.id) ? [...target.playerIds].reverse() : [...target.playerIds],
    entrantIds: swapReportingSides(target.id) ? [...target.entrantIds].reverse() : [...target.entrantIds],
    models: Object.fromEntries(selections.map((selection) => {
      const record = records.get(selection.selectedCandidateId);
      return [selection.modelId, {
        candidateId: selection.selectedCandidateId,
        fitStatus: record.fit.status,
        ...record.predictions[index],
      }];
    })),
  }));
}

/**
 * Run the frozen six-family tuning policy. This is set-level, conditional on
 * realized target matchups; it is deliberately separate from bracket routing.
 * Exact source bodies are hashed here, and every candidate forecast must be
 * durably checkpointed by the caller before this function reads that target's
 * winner for scoring. All fitting and callbacks are awaited sequentially.
 */
export async function runNestedRollingTuning(datasetBody, tuningSpecBody, {
  seedMode = "strict-seeds",
  outcomeReconciliationBody,
  outcomeReconciliationReport,
  checkpointForecast,
  loadCheckpoint = null,
  onProgress = null,
} = {}) {
  if (typeof checkpointForecast !== "function") {
    throw new Error("Nested tuning requires an awaited durable checkpointForecast callback");
  }
  if (loadCheckpoint != null && typeof loadCheckpoint !== "function") {
    throw new TypeError("loadCheckpoint must be a function when supplied");
  }
  if (onProgress != null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function when supplied");
  }
  const dataset = requirePlainObject(parseJsonBody(datasetBody, "Canonical dataset body"), "Canonical dataset");
  for (const key of ["events", "sets", "entrants", "seeds"]) {
    if (!Array.isArray(dataset[key])) throw new Error("Canonical dataset needs a " + key + " array");
  }
  const sourceDatasetSha256 = createHash("sha256").update(datasetBody).digest("hex");
  const reconciliation = validateOutcomeReconciliation(
    outcomeReconciliationBody, sourceDatasetSha256, outcomeReconciliationReport,
  );
  const rawSpec = parseJsonBody(tuningSpecBody, "Tuning spec body");
  const spec = validateTuningSpec(rawSpec);
  const tuningSpecIdentity = {
    id: spec.id,
    fileSha256: createHash("sha256").update(tuningSpecBody).digest("hex"),
    semanticSha256: objectDigest(spec),
    identityAuthority: "exact raw file SHA-256 plus frozen canonical semantic SHA-256",
    candidateCount: spec.candidateCount,
  };
  const implementation = await nestedTuningImplementationIdentity();
  const evidenceMode = spec.evidenceModes.find((mode) => mode.id === seedMode);
  if (!evidenceMode) throw new Error("Unknown tuning seed mode: " + seedMode);
  const evidenceIdentity = deepFreeze({
    id: evidenceMode.id,
    label: evidenceMode.label,
    allowHistoricalSeeds: evidenceMode.allowHistoricalSeeds,
    snapshotVerified: false,
  });
  const plan = chronologicalFolds(dataset, { minTrainingEvents: spec.policy.outerMinTrainingEvents });
  if (!plan.folds.length) throw new Error("Nested tuning needs chronological outer folds");
  const foldPlans = plan.folds.map((fold) => {
    const availability = targetOutcomeAvailability(fold);
    const eligibleAsInner = fold.trainingEvents.length >= spec.policy.innerMinTrainingEvents
      && availability.outcomeAvailableAt != null;
    return { fold, availability, eligibleAsInner };
  });
  const candidateConfigurationsUpperBound = foldPlans.reduce((total, row) => total
    + (row.eligibleAsInner ? 24 : 10), 0);
  const modelFitPassesUpperBound = foldPlans.reduce((total, row) => total
    + (row.eligibleAsInner ? 22 : 8), 0);
  const emitProgress = async (value) => {
    if (onProgress) await onProgress(deepFreeze(structuredClone(value)));
  };
  await emitProgress({
    phase: "start",
    outerFolds: plan.folds.length,
    candidateConfigurationsUpperBound,
    modelFitPassesUpperBound,
    execution: "single-threaded-sequential",
  });

  const seedIndex = initialSeedIndex(dataset, { allowHistorical: evidenceMode.allowHistoricalSeeds });
  const completedCandidateScores = [];
  const candidateEventScores = [];
  const forecastEvents = [];
  const scoreEvents = [];
  const auditFolds = [];
  const trainingInputDigestCache = new Map();
  let candidateConfigurations = 0;
  let modelFitPassesWithoutResume = 0;

  for (let foldIndex = 0; foldIndex < foldPlans.length; foldIndex++) {
    const { fold, availability, eligibleAsInner } = foldPlans[foldIndex];
    const availableScores = completedCandidateScores.filter((row) =>
      row.outcomeAvailableAt != null && row.outcomeAvailableAt < fold.cutoff);
    const selections = deepFreeze(spec.models.map((modelSpec) =>
      selectionFor(modelSpec, availableScores, spec.policy.innerMinCompletedFolds)));
    const foldAudit = auditFold(fold, availableScores, selections);
    const targetMatchups = fold.targetSets.map(matchupOnly);
    const candidatePlan = spec.models.map((modelSpec) => {
      const selected = selections.find((row) => row.modelId === modelSpec.id);
      return {
        modelId: modelSpec.id,
        candidateIds: eligibleAsInner
          ? modelSpec.candidates.map((candidate) => candidate.id)
          : [...new Set([selected.selectedCandidateId, modelSpec.defaultCandidateId])],
      };
    });
    candidateConfigurations += candidatePlan.reduce((total, row) => total + row.candidateIds.length, 0);
    const recencyPlan = candidatePlan.find((row) => row.modelId === "recency-elo");
    const recencyDefaultId = spec.models.find((row) => row.id === "recency-elo").defaultCandidateId;
    modelFitPassesWithoutResume += 1
      + recencyPlan.candidateIds.filter((candidateId) => candidateId !== recencyDefaultId).length
      + candidatePlan.filter((row) => !["neutral", "higher-seed", "recency-elo"].includes(row.modelId))
        .reduce((total, row) => total + row.candidateIds.length, 0);
    const checkpointContext = deepFreeze({
      schemaVersion: 1,
      kind: "nested-rolling-origin-candidate-event-context-v1",
      implementationSha256: implementation.sha256,
      tuningSpec: tuningSpecIdentity,
      evidenceMode: evidenceIdentity,
      eventId: fold.targetEvent.id,
      eventLabel: eventLabel(fold.targetEvent),
      cutoff: fold.cutoff,
      cutoffSources: [...fold.cutoffSources],
      trainingEventIds: fold.trainingEvents.map((event) => event.id),
      trainingSetCount: fold.trainingSets.length,
      trainingInputSemanticSha256: foldTrainingInputDigest(
        fold, seedIndex, trainingInputDigestCache,
      ),
      targetFeatureInputSemanticSha256: targetFeatureInputDigest(
        fold, targetMatchups, seedIndex,
      ),
      tuningHistoryEventIds: availableScores.map((row) => row.eventId),
      selections: selections.map((selection) => structuredClone(selection)),
      matchups: targetMatchups.map((target) => ({
        setId: target.id,
        eventId: target.eventId,
        playerIds: [...target.playerIds],
        entrantIds: [...target.entrantIds],
      })),
      candidatePlan,
    });
    const checkpointContextSha256 = artifactDigest(checkpointContext);
    await emitProgress({
      phase: "outer-fold-start",
      fold: foldIndex + 1,
      outerFolds: foldPlans.length,
      eventId: fold.targetEvent.id,
      candidateConfigurations: candidatePlan.reduce((total, row) => total + row.candidateIds.length, 0),
    });

    let checkpoint;
    let eventForecastSha256;
    let candidateRecords;
    let resumed = false;
    const restored = loadCheckpoint ? await loadCheckpoint({
      eventId: fold.targetEvent.id,
      checkpointContextSha256,
    }) : null;
    if (restored != null) {
      if (!restored || restored.durable !== true || typeof restored.body !== "string") {
        throw new Error("Loaded candidate forecast checkpoint lacks durable exact bytes");
      }
      eventForecastSha256 = requireHash(restored.expectedSha256,
        "loaded checkpoint index expectedSha256");
      if (createHash("sha256").update(restored.body).digest("hex") !== eventForecastSha256) {
        throw new Error("Loaded candidate forecast checkpoint hash mismatch");
      }
      checkpoint = parseJsonBody(restored.body, "Candidate forecast checkpoint");
      if (serializeNestedTuningArtifact(checkpoint) !== restored.body) {
        throw new Error("Loaded candidate forecast checkpoint is not canonical exact bytes");
      }
      candidateRecords = validateCandidateCheckpoint(checkpoint, checkpointContext);
      resumed = true;
    } else {
      const prefitted = new Map();
      const recencySpec = spec.models.find((model) => model.id === "recency-elo");
      const defaultRecency = modelCandidate(recencySpec, recencySpec.defaultCandidateId);
      const input = { events: fold.trainingEvents, sets: fold.trainingSets, cutoff: fold.cutoff };
      for (const model of fitBasicModels({ ...input, seedIndex, options: defaultRecency.options })) {
        const candidateId = model.id === "recency-elo"
          ? defaultRecency.id
          : spec.models.find((row) => row.id === model.id).defaultCandidateId;
        prefitted.set(candidateId, model);
      }
      const candidateForecasts = [];
      candidateRecords = new Map();
      for (const modelPlan of candidatePlan) {
        const modelSpec = spec.models.find((row) => row.id === modelPlan.modelId);
        const candidates = [];
        for (const candidateId of modelPlan.candidateIds) {
          const candidate = modelCandidate(modelSpec, candidateId);
          const model = fitCandidateModel(modelSpec.id, candidate, fold, seedIndex, prefitted);
          const fit = compactFitAudit(model);
          const predictions = fit.valid
            ? forecastCandidate(model, targetMatchups)
            : invalidFitFallbackForecast(targetMatchups);
          const record = deepFreeze({ fit, predictions });
          candidateRecords.set(candidateId, record);
          candidates.push({ candidateId, fit, predictions });
        }
        candidateForecasts.push({ modelId: modelPlan.modelId, candidates });
      }
      checkpoint = deepFreeze({
        schemaVersion: 1,
        kind: "nested-rolling-origin-candidate-event-forecast-v1",
        contextSha256: checkpointContextSha256,
        context: checkpointContext,
        candidateForecasts,
      });
      const checkpointBody = serializeNestedTuningArtifact(checkpoint);
      eventForecastSha256 = createHash("sha256").update(checkpointBody).digest("hex");
      const receipt = await checkpointForecast({
        eventId: fold.targetEvent.id,
        checkpointContextSha256,
        sha256: eventForecastSha256,
        body: checkpointBody,
      });
      if (!receipt || receipt.durable !== true || receipt.sha256 !== eventForecastSha256) {
        throw new Error("Candidate forecast checkpoint was not durably committed before scoring");
      }
      if (createHash("sha256").update(checkpointBody).digest("hex") !== eventForecastSha256) {
        throw new Error("Candidate forecast changed during persistence");
      }
    }

    const selectedPredictions = selectedForecastRows(targetMatchups, selections, candidateRecords);
    forecastEvents.push({
      eventId: checkpointContext.eventId,
      eventLabel: checkpointContext.eventLabel,
      cutoff: checkpointContext.cutoff,
      cutoffSources: checkpointContext.cutoffSources,
      trainingEventIds: checkpointContext.trainingEventIds,
      trainingSetCount: checkpointContext.trainingSetCount,
      tuningHistoryEventIds: checkpointContext.tuningHistoryEventIds,
      selections: checkpointContext.selections,
      predictions: selectedPredictions,
      eventForecastSha256,
      checkpointContextSha256,
    });
    auditFolds.push({
      ...foldAudit,
      eventForecastSha256,
      checkpointContextSha256,
      allCandidateForecastsDurablyCheckpointedBeforeTargetScoring: true,
    });

    // This is the first point at which the target winner may be read.
    let candidateScoreEvent = null;
    if (eligibleAsInner) {
      candidateScoreEvent = {
        eventId: fold.targetEvent.id,
        cutoff: fold.cutoff,
        eventForecastSha256,
        outcomeAvailableAt: availability.outcomeAvailableAt,
        outcomeAvailabilityReason: availability.reason,
        completionGuardSetId: availability.completionGuardSetId,
        trainingEventCount: fold.trainingEvents.length,
        models: spec.models.map((modelSpec) => ({
          id: modelSpec.id,
          candidates: modelSpec.candidates.map((candidate) => {
            const record = candidateRecords.get(candidate.id);
            return {
              candidateId: candidate.id,
              status: record.fit.status,
              fit: record.fit,
              scores: record.fit.valid ? scoreForecast(record.predictions, fold.targetSets) : null,
            };
          }),
        })),
      };
      candidateEventScores.push(candidateScoreEvent);
      completedCandidateScores.push(candidateScoreEvent);
    }

    const eventModelScores = selections.map((selection) => {
      const record = candidateRecords.get(selection.selectedCandidateId);
      const modelSpec = spec.models.find((row) => row.id === selection.modelId);
      const defaultRecord = candidateRecords.get(modelSpec.defaultCandidateId);
      if (!record || !defaultRecord) {
        throw new Error("Selected and fixed-default operational forecasts must both be checkpointed");
      }
      const scores = scoreForecast(record.predictions, fold.targetSets);
      const defaultScores = scoreForecast(defaultRecord.predictions, fold.targetSets);
      return {
        eventId: fold.targetEvent.id,
        id: selection.modelId,
        status: record.fit.valid ? "scored" : "scored-neutral-fallback-invalid-fit",
        fit: record.fit,
        defaultFitStatus: defaultRecord?.fit.status ?? "missing",
        selectionMode: selection.mode,
        selectedCandidateId: selection.selectedCandidateId,
        defaultCandidateId: modelSpec.defaultCandidateId,
        scores,
        defaultScores,
        versusDefault: {
          logLoss: scores.logLoss - defaultScores.logLoss,
          brier: scores.brier - defaultScores.brier,
        },
      };
    });
    if (eventModelScores.some((row) => row.scores?.n !== fold.targetSets.length)) {
      throw new Error("All six model families must retain identical outer target support");
    }
    scoreEvents.push({
      eventId: fold.targetEvent.id,
      eventLabel: eventLabel(fold.targetEvent),
      cutoff: fold.cutoff,
      eventForecastSha256,
      models: eventModelScores,
    });
    await emitProgress({
      phase: "outer-fold-complete",
      fold: foldIndex + 1,
      outerFolds: foldPlans.length,
      eventId: fold.targetEvent.id,
      resumed,
      eventForecastSha256,
    });
  }

  const sourceDatasetSemanticSha256 = semanticDatasetDigest(dataset);
  const forecasts = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-set-forecasts-v1",
    sourceIdentity: {
      policy: "Per-event training-input and target-feature semantic hashes; full outcome-bearing dataset identity is held only by the paired evaluation.",
      targetOutcomesIncluded: false,
    },
    implementation,
    tuningSpec: tuningSpecIdentity,
    evidenceMode: evidenceIdentity,
    modelIds: [...MODEL_IDS],
    events: forecastEvents,
    selectedModel: null,
    productize: false,
    uploads: false,
  };
  const forecastSha256 = artifactDigest(forecasts);
  const evaluation = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-tuning-evaluation-v1",
    sourceDatasetSha256,
    sourceDatasetSemanticSha256,
    implementation,
    tuningSpec: tuningSpecIdentity,
    outcomeReconciliation: reconciliation,
    forecastSha256,
    objective: {
      primary: spec.policy.primaryObjective,
      secondary: spec.policy.secondaryObjective,
      reportingOnly: "AUC and accuracy never participate in configuration selection.",
      selectionRule: spec.policy.selectionRule,
      scoringUnit: "eligible realized target set",
      aggregation: "Each inner target event contributes one equally weighted mean score.",
    },
    coverage: {
      sourceEvents: plan.coverage.sourceEvents,
      outerEvents: forecastEvents.length,
      outerSets: plan.folds.reduce((total, fold) => total + fold.targetSets.length, 0),
      candidateScoreEvents: candidateEventScores.length,
      innerMinimumTrainingEvents: spec.policy.innerMinTrainingEvents,
      innerMinimumCompletedFolds: spec.policy.innerMinCompletedFolds,
    },
    executionPlan: {
      candidateConfigurations,
      modelFitPassesWithoutResume,
      candidateConfigurationsUpperBound,
      modelFitPassesUpperBound,
      execution: "single-threaded-sequential",
      resume: "verified content-addressed event checkpoints may skip completed folds",
    },
    outerUncertainty: {
      method: "fixed-seed paired outer-event percentile bootstrap",
      replicates: OUTER_BOOTSTRAP_REPLICATES,
      minimumEvents: MIN_OUTER_INTERVAL_EVENTS,
      estimand: "unweighted mean outer-event tuned-policy minus fixed-default score",
      purpose: "descriptive within-family tuning diagnostic only; never family selection",
    },
    models: aggregateModels(scoreEvents, spec.models),
    outerFolds: scoreEvents,
    candidateEventScores,
    familySelection: false,
    selectedModel: null,
    productize: false,
    uploads: false,
  };
  const warnings = [
    "This is algorithmically chronology-isolated retrospective set evaluation, not snapshot-verified historical evidence.",
    evidenceMode.allowHistoricalSeeds
      ? "Historical initial-seed availability is assumed. This mode is not snapshot-safe and is not an unbiased historical backtest."
      : "Seeds without observation provenance before their own conservative event cutoff are excluded.",
    "Historical outcome source versions were fetched after the events; reported completion chronology cannot rule out later corrections.",
    "Target rows condition on realized matchups. They do not test pre-event bracket paths, title odds or top-eight odds.",
    "The grid and model families were designed after earlier 2018-2025 diagnostics, so this run is exploratory rather than confirmatory.",
    "Non-converged optimizer fits cannot enter configuration selection; an outer selected non-converged fit is explicitly scored as a neutral 0.5 fallback so all families retain identical target support.",
    "Hyperparameters are selected independently within each model family. No family is selected or productized.",
  ];
  const evaluationSha256 = artifactDigest(evaluation);
  const manifestBase = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-model-tuning-manifest-v1",
    status: "exploratory-not-confirmatory",
    sourceDatasetSha256,
    sourceDatasetSemanticSha256,
    implementation,
    tuningSpec: tuningSpecIdentity,
    outcomeReconciliation: reconciliation,
    evidenceMode: forecasts.evidenceMode,
    forecastSha256,
    evaluationSha256,
    artifactSerialization: "canonical-json-utf8-lf-v1",
    artifactSeparation: {
      forecastsContainTargetOutcomes: false,
      evaluationReferencesForecastSha256: true,
      evaluationContainsTargetOutcomes: true,
      aggregateForecastAndEvaluationMustBeSeparateFiles: true,
      awaitedPerEventCandidateCheckpointBeforeTargetScoring: true,
    },
    leakageAudit: {
      wholeEventOuterHoldout: true,
      strictTrainingBoundary: true,
      strictInnerOutcomeReleaseBoundary: true,
      targetForecastsContainOutcomes: false,
      selectedConfigsFrozenBeforeOuterScoring: true,
      sourceSnapshotsVerified: false,
      reportingOrientation: spec.policy.reportingOrientation,
      folds: auditFolds,
      violations: [],
    },
    warnings,
    completeModelSuite: true,
    selectedModel: null,
    productize: false,
    uploads: false,
  };
  const manifest = { ...manifestBase, runSha256: artifactDigest(manifestBase) };
  return { manifest, forecasts, evaluation };
}

const MODEL_NAMES = Object.freeze({
  neutral: "Neutral 50/50",
  "higher-seed": "Higher seed",
  "recency-elo": "Recency-weighted Elo",
  glicko2: "Event-period Glicko-2",
  "dynamic-bradley-terry": "Dynamic Bradley-Terry",
  "regularized-bt-recent-form": "Regularized Bradley-Terry + seed + recent form",
});

const markdownNumber = (value) => Number.isFinite(value) ? value.toFixed(4) : "—";
function markdownInterval(summary) {
  if (!summary || !summary.interval95) return markdownNumber(summary?.estimate) + " [—]";
  return markdownNumber(summary.estimate) + " [" + markdownNumber(summary.interval95.lower)
    + ", " + markdownNumber(summary.interval95.upper) + "]";
}

export function nestedTuningMarkdown({ manifest, forecasts, evaluation }, tuningSpec) {
  if (manifest?.kind !== "nested-rolling-origin-model-tuning-manifest-v1"
      || forecasts?.kind !== "nested-rolling-origin-set-forecasts-v1"
      || evaluation?.kind !== "nested-rolling-origin-tuning-evaluation-v1"
      || evaluation.forecastSha256 !== manifest.forecastSha256) {
    throw new Error("Nested tuning Markdown needs a paired forecast/evaluation result");
  }
  const spec = validateTuningSpec(tuningSpec);
  const selectionRows = spec.models.map((model) => {
    const counts = new Map();
    for (const event of forecasts.events) {
      const selection = event.selections.find((row) => row.modelId === model.id);
      counts.set(selection.selectedCandidateId, (counts.get(selection.selectedCandidateId) ?? 0) + 1);
    }
    return {
      id: model.id,
      frequencies: [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
        .map(([id, count]) => id + " ×" + count).join(", "),
    };
  });
  const modelRows = evaluation.models.map((model) => {
    const paired = model.innerSelectedVersusDefault.pairedEventBootstrap95;
    return "| " + markdownText(MODEL_NAMES[model.id] ?? model.id)
      + " | " + markdownText(manifest.evidenceMode.id)
      + " | " + model.scoredOuterEvents + "/" + model.outerEvents
      + " | " + model.fallbackOuterEvents.length
      + " | " + markdownNumber(model.eventMacro.logLoss)
      + " | " + markdownNumber(model.eventMacro.brier)
      + " | " + markdownNumber(model.eventMacro.accuracy)
      + " | " + markdownNumber(model.eventMacro.auc)
      + " | " + model.innerSelectedVersusDefault.events
      + " | " + markdownInterval(paired.logLoss)
      + " | " + markdownInterval(paired.brier) + " |";
  });
  const gridRows = spec.models.flatMap((model) => model.candidates.map((candidate) =>
    "| " + markdownText(MODEL_NAMES[model.id] ?? model.id)
      + " | " + markdownCodeSpan(candidate.id)
      + " | " + (candidate.id === model.defaultCandidateId ? "yes" : "")
      + " | " + markdownCodeSpan(JSON.stringify(candidate.options)) + " |"));
  return [
    "# Nested rolling-origin model tuning — exploratory",
    "",
    "Evidence mode: **" + markdownText(manifest.evidenceMode.id) + "** — "
      + markdownText(manifest.evidenceMode.label) + ".",
    "This is the " + (manifest.evidenceMode.allowHistoricalSeeds ? "availability-assumed" : "strict")
      + " run. The other evidence mode is a separate content-addressed run; do not merge them or interpret their difference as a confirmatory test.",
    "No model family is selected, promoted, or productized by this report.",
    "",
    "## Out-of-sample family summary",
    "",
    "Event-macro metrics weight each held-out tournament equally. Lower log loss/Brier is better. Δ columns are tuned policy minus that family's frozen default on mature outer folds; negative is better. Brackets are descriptive paired-event bootstrap 95% intervals when at least five mature folds exist.",
    "",
    "| Model family | Seed evidence | Scored events | Neutral fit fallbacks | Log loss | Brier | Accuracy | AUC | Mature tuned folds | Δ log loss [95%] | Δ Brier [95%] |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...modelRows,
    "",
    "Coverage: **" + evaluation.coverage.outerEvents + " outer events / "
      + evaluation.coverage.outerSets.toLocaleString("en-US") + " realized-matchup sets**. Candidate tuning scores begin after "
      + evaluation.coverage.innerMinimumTrainingEvents + " training events; selection requires "
      + evaluation.coverage.innerMinimumCompletedFolds + " completed earlier event folds.",
    "Planned work: " + evaluation.executionPlan.candidateConfigurations.toLocaleString("en-US")
      + " candidate configurations and " + evaluation.executionPlan.modelFitPassesWithoutResume.toLocaleString("en-US")
      + " single-threaded model-fit passes without resume.",
    "",
    "## Selected-config frequency",
    "",
    ...selectionRows.map((row) => "- " + markdownText(MODEL_NAMES[row.id] ?? row.id) + ": "
      + (row.frequencies || "none")),
    "",
    "## Frozen candidate grid",
    "",
    "Spec file SHA-256: `" + manifest.tuningSpec.fileSha256 + "`  ",
    "Canonical semantic SHA-256: `" + manifest.tuningSpec.semanticSha256 + "`",
    "",
    "| Model family | Candidate | Default | Options |",
    "|---|---|---:|---|",
    ...gridRows,
    "",
    "## Evidence and limitations",
    "",
    ...manifest.warnings.map((warning) => "- " + markdownText(warning)),
    "",
    "Forecast SHA-256: `" + manifest.forecastSha256 + "`  ",
    "Evaluation SHA-256: `" + manifest.evaluationSha256 + "`  ",
    "Dataset file SHA-256: `" + manifest.sourceDatasetSha256 + "`  ",
    "Dataset semantic SHA-256: `" + manifest.sourceDatasetSemanticSha256 + "`  ",
    "Implementation SHA-256: `" + manifest.implementation.sha256 + "`",
    "",
  ].join("\n");
}
