import { createHash } from "node:crypto";
import { initialSeedIndex } from "./baselines.mjs";
import { MODEL_IDS, fitModelSuite } from "./comparison.mjs";
import { eventTimeBounds } from "./evaluation.mjs";
import { compileReviewedDoubleElimination, simulateDoubleElimination } from "./historical-bracket.mjs";

const LOG_LOSS_EPSILON = 1e-15;
const compare = (a, b) => String(a).localeCompare(String(b), "en");
const byEvent = (a, b) => compare(a.eventId, b.eventId);

export const DEFAULT_HISTORICAL_SIMULATIONS = 20_000;
export const HISTORICAL_RANDOM_SEED = 0x5c0ffeed;

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

function requireId(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} needs a non-empty string ID`);
}

function validateContract(contract) {
  if (contract?.schemaVersion !== 1 || typeof contract.id !== "string" || !contract.id
      || !Array.isArray(contract.events) || !contract.events.length) {
    throw new Error("Historical backtest needs a non-empty route contract schemaVersion 1");
  }
  const topLevelFields = new Set(["schemaVersion", "id", "scope", "events"]);
  const unknownTopLevel = Object.keys(contract).filter((field) => !topLevelFields.has(field));
  if (unknownTopLevel.length) throw new Error(`Unknown historical route contract fields: ${unknownTopLevel.join(", ")}`);
  const seen = new Set();
  for (const review of contract.events) {
    const routeFields = new Set(["eventId", "disposition", "fieldSize", "initialPhaseId",
      "phaseGroupId", "grandFinalSetId", "resetRule", "structuralSha256"]);
    const unknownRouteFields = Object.keys(review ?? {}).filter((field) => !routeFields.has(field));
    if (unknownRouteFields.length) {
      throw new Error(`Unknown historical route fields for ${review?.eventId ?? "unknown event"}: ${unknownRouteFields.join(", ")}`);
    }
    for (const field of ["eventId", "initialPhaseId", "phaseGroupId", "grandFinalSetId"]) {
      requireId(review?.[field], `Route contract ${field}`);
    }
    if (review.disposition !== "included") throw new Error(`Unsupported route disposition for ${review.eventId}`);
    if (!Number.isSafeInteger(review.fieldSize) || review.fieldSize < 2) {
      throw new Error(`Route ${review.eventId} needs a fieldSize of at least two`);
    }
    if (review.resetRule !== "if-lower-side-wins-grand-final") {
      throw new Error(`Route ${review.eventId} needs the reviewed conditional reset rule`);
    }
    if (!/^[a-f0-9]{64}$/.test(review.structuralSha256 ?? "")) {
      throw new Error(`Route ${review.eventId} needs a 64-character structuralSha256`);
    }
    if (seen.has(review.eventId)) throw new Error(`Duplicate route event: ${review.eventId}`);
    seen.add(review.eventId);
  }
  return [...contract.events].sort(byEvent);
}

function simulationCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new RangeError("simulations must be an integer from 1 through 1,000,000");
  }
  return value;
}

function assertModelSuite(models) {
  const ids = models.map((model) => model.id);
  if (ids.length !== MODEL_IDS.length || ids.some((id, index) => id !== MODEL_IDS[index])) {
    throw new Error(`Historical backtest model suite differs from the shared comparison suite: ${ids.join(", ")}`);
  }
}

function coherentSourceSnapshot(rows, provenance, cutoff) {
  const observations = rows.map((row) => {
    const provenanceIds = [...new Set(row.source?.provenanceIds ?? [])].sort(compare);
    const sourceObservations = provenanceIds.map((provenanceId) => {
      const observedAt = Date.parse(provenance.get(provenanceId)?.fetchedAt) / 1000;
      return { provenanceId, observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null };
    });
    return {
      id: row.id,
      provenanceIds,
      allObservedBeforeCutoff: provenanceIds.length > 0
        && sourceObservations.every((source) => source.observedAt != null && source.observedAt < cutoff),
      disqualifyingProvenance: sourceObservations
        .filter((source) => source.observedAt == null || source.observedAt >= cutoff),
    };
  });
  const coherentPreCutoffProvenanceIds = observations.length
    ? observations[0].provenanceIds.filter((id) => observations.every((row) => row.provenanceIds.includes(id)))
    : [];
  const unverifiedRows = observations.filter((row) => !row.allObservedBeforeCutoff);
  const coherent = unverifiedRows.length === 0 && coherentPreCutoffProvenanceIds.length > 0;
  return { coherent, coherentPreCutoffProvenanceIds, rows: observations.length, unverifiedRows };
}

function historicalTrainingFold(dataset, targetEvent, minTrainingEvents, allowUnverifiedHistoricalFeatures) {
  const targetBounds = eventTimeBounds(targetEvent);
  if (targetBounds.cutoff == null) {
    return { fold: null, reasons: ["missing_reported_start"], trainingEvents: 0 };
  }
  const setsByEvent = new Map();
  for (const set of dataset.sets) {
    // Target rows are outcome-only and must not decide whether a forecast can
    // be constructed. This guard occurs before reading eligibility/results.
    if (set.eventId === targetEvent.id) continue;
    if (!setsByEvent.has(set.eventId)) setsByEvent.set(set.eventId, []);
    setsByEvent.get(set.eventId).push(set);
  }
  const trainingEvents = [];
  const trainingSets = [];
  const exclusions = [];
  const provenance = new Map((dataset.provenance ?? []).map((row) => [row.id, row]));
  const availability = [];
  for (const event of [...dataset.events].sort((a, b) => compare(a.id, b.id))) {
    if (event.id === targetEvent.id) continue;
    const reasons = [];
    const bounds = eventTimeBounds(event);
    // Non-prior events cannot enter this fold. Stop before consulting any of
    // their set rows or outcome-derived eligibility.
    if (bounds.trainingEnd == null || bounds.trainingEnd >= targetBounds.cutoff) continue;
    const eventSets = setsByEvent.get(event.id) ?? [];
    const eligibleSets = eventSets.filter((set) => set.eligible === true);
    const sourceAvailability = coherentSourceSnapshot([event, ...eventSets], provenance, targetBounds.cutoff);
    availability.push({ eventId: event.id, ...sourceAvailability });
    if (event.eligible !== true) reasons.push("ineligible_event");
    if (bounds.cutoff != null && bounds.trainingEnd != null && bounds.trainingEnd < bounds.cutoff) {
      reasons.push("invalid_reported_interval");
    }
    if (!eligibleSets.length) reasons.push("no_eligible_sets");
    if (!allowUnverifiedHistoricalFeatures && !sourceAvailability.coherent) {
      reasons.push("training_snapshot_not_observed_before_target_cutoff");
    }
    const lateSet = eligibleSets
      .filter((set) => Number.isFinite(set.timestamps?.completedAt)
        && set.timestamps.completedAt >= targetBounds.cutoff)
      .sort((a, b) => b.timestamps.completedAt - a.timestamps.completedAt || compare(a.id, b.id))[0];
    if (lateSet) reasons.push("eligible_set_completed_at_or_after_cutoff");
    if (reasons.length) {
      exclusions.push({ eventId: event.id, reasons,
        sourceAvailability,
        ...(lateSet ? { latestEligibleCompletedAt: lateSet.timestamps.completedAt,
          latestEligibleCompletedSetId: lateSet.id } : {}) });
      continue;
    }
    trainingEvents.push(event);
    trainingSets.push(...eligibleSets);
  }
  if (trainingEvents.length < minTrainingEvents) {
    return {
      fold: null,
      reasons: ["insufficient_training_events"],
      trainingEvents: trainingEvents.length,
      trainingSourceAvailability: {
        allowUnverifiedHistoricalFeatures,
        events: availability,
      },
    };
  }
  return {
    fold: {
      targetEvent,
      cutoff: targetBounds.cutoff,
      cutoffSources: targetBounds.cutoffSources,
      trainingEvents,
      trainingSets,
      trainingSourceAvailability: {
        policy: "Every training event row and all of its set rows must share a source observation before the target cutoff, and all contributing provenance must predate that cutoff unless the exploratory opt-in is active.",
        allowUnverifiedHistoricalFeatures,
        events: availability,
      },
      exclusions: { trainingEvents: exclusions },
    },
  };
}

const CHRONOLOGY_POLICY = Object.freeze({
  minimumTrainingEvents: "configured per run",
  cutoff: "minimum valid reported event/tournament start",
  trainingBoundary: "maximum valid reported event/tournament end strictly before target cutoff",
  lateCompletionGuard: "exclude a training event if any eligible training set completed at/after cutoff",
  targetHoldout: "target event ID is excluded before any target set eligibility, winner, score or timestamp is read",
  sourceAvailability: "target and training features require coherent pre-cutoff source snapshots unless the explicit exploratory opt-in is active",
  eventOrder: "event ID serialization; fitting modules apply their documented chronological order",
});

function featureAvailability(dataset, graph, cutoff) {
  const provenance = new Map((dataset.provenance ?? []).map((row) => [row.id, row]));
  const events = new Map(dataset.events.map((row) => [row.id, row]));
  const entrants = new Map(dataset.entrants.map((row) => [row.id, row]));
  const seeds = new Map(dataset.seeds.map((row) => [row.id, row]));
  const sets = new Map(dataset.sets.map((row) => [row.id, row]));
  const features = [
    { kind: "event-phase-and-group", id: graph.eventId, row: events.get(graph.eventId) },
    ...graph.field.map((row) => ({ kind: "field-entrant", id: row.entrantId, row: entrants.get(row.entrantId) })),
    ...graph.field.map((row) => ({ kind: "initial-seed", id: row.seedId, row: seeds.get(row.seedId) })),
    ...graph.matches.map((row) => ({ kind: "bracket-set", id: row.id, row: sets.get(row.id) })),
  ];
  const observations = features.map(({ kind, id, row }) => {
    const provenanceIds = [...new Set(row?.source?.provenanceIds ?? [])].sort(compare);
    const sourceObservations = provenanceIds.map((provenanceId) => {
      const timestamp = Date.parse(provenance.get(provenanceId)?.fetchedAt) / 1000;
      return { provenanceId, observedAt: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null };
    });
    const observedAt = sourceObservations.map((source) => source.observedAt)
      .filter((value) => value != null).sort((a, b) => a - b);
    const allSourceObservationsKnown = provenanceIds.length > 0 && observedAt.length === provenanceIds.length;
    const allObservedBeforeCutoff = allSourceObservationsKnown
      && observedAt.every((value) => value < cutoff);
    return {
      kind,
      id,
      provenanceIds,
      earliestObservedAt: observedAt[0] ?? null,
      latestObservedAt: observedAt.at(-1) ?? null,
      allSourceObservationsKnown,
      allObservedBeforeCutoff,
      disqualifyingProvenance: sourceObservations
        .filter((source) => source.observedAt == null || source.observedAt >= cutoff),
    };
  });
  const unverified = observations.filter((row) => !row.allObservedBeforeCutoff);
  const coherentPreCutoffProvenanceIds = observations.length
    ? observations[0].provenanceIds.filter((provenanceId) => observations.every((row) =>
      row.provenanceIds.includes(provenanceId)
      && (provenance.get(provenanceId) == null
        ? false : Date.parse(provenance.get(provenanceId).fetchedAt) / 1000 < cutoff)))
    : [];
  const coherentSnapshot = unverified.length === 0 && coherentPreCutoffProvenanceIds.length > 0;
  return {
    status: coherentSnapshot ? "observed-before-cutoff" : "unverified-historical",
    cutoff,
    requiredRows: observations.length,
    observedBeforeCutoffRows: observations.length - unverified.length,
    unverifiedRows: unverified,
    coherentPreCutoffProvenanceIds,
    coherentSnapshot,
    allObservedBeforeCutoff: coherentSnapshot,
    policy: "Every provenance observation contributing to each selected initial seed, field entrant/player mapping, phase/group event row and championship-graph set must be known and strictly before the conservative target cutoff, and at least one pre-cutoff source observation must cover every selected row. Mixed or incoherent snapshots fail closed.",
  };
}

/**
 * Build pre-event tournament forecasts. Training events end strictly before
 * the target cutoff; the target compiler selects a redacted structural view
 * and never consumes target eligibility, winners, scores or standings.
 */
export function buildHistoricalTournamentForecasts(dataset, contract, {
  minTrainingEvents = 1,
  allowUnverifiedHistoricalFeatures = false,
  simulations = DEFAULT_HISTORICAL_SIMULATIONS,
  randomSeed = HISTORICAL_RANDOM_SEED,
  modelOptions = {},
  sourceDatasetSha256 = null,
  routeContractSha256 = null,
} = {}) {
  const reviews = validateContract(contract);
  const count = simulationCount(simulations);
  if (!Number.isSafeInteger(minTrainingEvents) || minTrainingEvents < 0) {
    throw new RangeError("minTrainingEvents must be a nonnegative integer");
  }
  const seedIndex = initialSeedIndex(dataset, { allowHistorical: allowUnverifiedHistoricalFeatures });
  const reviewedIds = new Set(reviews.map((review) => review.eventId));
  const datasetEvents = new Map(dataset.events.map((event) => [event.id, event]));
  const exclusions = dataset.events
    .filter((event) => event.eligible === true && !reviewedIds.has(event.id))
    .map((event) => ({ eventId: event.id, reasons: ["unreviewed_route"] }));
  const forecasts = [];

  for (const review of reviews) {
    if (!datasetEvents.has(review.eventId)) throw new Error(`Reviewed route event is absent from the dataset: ${review.eventId}`);
    const graph = compileReviewedDoubleElimination(dataset, review);
    if (graph.structuralSha256 !== review.structuralSha256) {
      throw new Error(`Reviewed route structure changed for ${review.eventId}: expected ${review.structuralSha256}, got ${graph.structuralSha256}`);
    }
    const targetEvent = datasetEvents.get(review.eventId);
    const targetBounds = eventTimeBounds(targetEvent);
    if (targetBounds.cutoff == null) {
      exclusions.push({ eventId: review.eventId, reasons: ["missing_reported_start"] });
      continue;
    }
    const availability = featureAvailability(dataset, graph, targetBounds.cutoff);
    const unavailableSeeds = graph.field.filter((row) => seedIndex.seeds.get(row.entrantId) !== row.seed);
    if ((!allowUnverifiedHistoricalFeatures && (!availability.allObservedBeforeCutoff || unavailableSeeds.length))
        || (allowUnverifiedHistoricalFeatures && unavailableSeeds.length)) {
      exclusions.push({
        eventId: review.eventId,
        reasons: [allowUnverifiedHistoricalFeatures
          ? "initial_seed_index_mismatch" : "historical_features_not_observed_before_cutoff"],
        unavailableSeeds: unavailableSeeds.length,
        fieldSize: graph.fieldSize,
        featureAvailability: availability,
      });
      continue;
    }
    const planned = historicalTrainingFold(dataset, targetEvent, minTrainingEvents,
      allowUnverifiedHistoricalFeatures);
    const fold = planned.fold;
    if (!fold) {
      exclusions.push({ eventId: review.eventId, reasons: planned.reasons ?? ["no_chronological_fold"],
        trainingEvents: planned.trainingEvents ?? null,
        ...(planned.trainingSourceAvailability
          ? { trainingSourceAvailability: planned.trainingSourceAvailability } : {}) });
      continue;
    }
    if (fold.trainingEvents.some((event) => event.id === review.eventId)
        || fold.trainingSets.some((set) => set.eventId === review.eventId)) {
      throw new Error(`Target event leaked into its own training fold: ${review.eventId}`);
    }
    const models = fitModelSuite({
      events: fold.trainingEvents,
      sets: fold.trainingSets,
      cutoff: fold.cutoff,
      seedIndex,
      basicOptions: modelOptions,
    });
    assertModelSuite(models);
    const simulation = simulateDoubleElimination({ graph, models, simulations: count, randomSeed });
    const simulationById = new Map(simulation.models.map((model) => [model.id, model]));
    const orderedSimulationModels = MODEL_IDS.map((id) => simulationById.get(id));
    if (orderedSimulationModels.some((model) => !model)) {
      throw new Error(`Historical simulation omitted a shared model for ${review.eventId}`);
    }
    forecasts.push({
      eventId: review.eventId,
      cutoff: fold.cutoff,
      cutoffSources: [...fold.cutoffSources],
      trainingEventIds: fold.trainingEvents.map((event) => event.id),
      trainingSetCount: fold.trainingSets.length,
      trainingSourceAvailability: fold.trainingSourceAvailability,
      featureAvailability: availability,
      seedAvailability: allowUnverifiedHistoricalFeatures
        ? "unverified-historical-assumption" : "observed-before-cutoff-only",
      route: graph,
      models: orderedSimulationModels,
    });
  }

  exclusions.sort(byEvent);
  const contractHash = routeContractSha256 ?? objectDigest(contract);
  const status = forecasts.length === 0 ? "no-eligible-events"
    : allowUnverifiedHistoricalFeatures ? "exploratory-pipeline-validation" : "pipeline-validation";
  return {
    schemaVersion: 1,
    kind: "historical-major-tournament-forecasts-v1",
    status,
    sourceDatasetSha256,
    routeContract: { id: contract.id, sha256: contractHash },
    modelIds: [...MODEL_IDS],
    completeModelSuite: true,
    simulations: {
      count,
      randomSeed,
      commonRandomNumbers: true,
      fixedForCli: count === DEFAULT_HISTORICAL_SIMULATIONS && randomSeed === HISTORICAL_RANDOM_SEED,
    },
    featureAvailabilityPolicy: {
      allowUnverifiedHistoricalFeatures,
      default: "exclude unless coherent source snapshots prove every selected target seed, field/player mapping and bracket row—and every consumed training row—predates the conservative target cutoff",
      limitation: allowUnverifiedHistoricalFeatures
        ? "EXPLORATORY OPT-IN: post-event historical feature snapshots are allowed. This is not an unbiased historical backtest."
        : "Only target features whose complete source-provenance set predates the conservative event cutoff are accepted; mixed pre/post-cutoff provenance is rejected.",
    },
    chronologyPolicy: { ...CHRONOLOGY_POLICY, minTrainingEvents },
    coverage: {
      datasetEvents: dataset.events.length,
      reviewedRoutes: reviews.length,
      forecastEvents: forecasts.length,
      excludedEvents: exclusions.length,
    },
    warnings: [
      "Pipeline validation on one manually reviewed historical route; it is not an all-major backtest or model-selection result.",
      allowUnverifiedHistoricalFeatures
        ? "EXPLORATORY OPT-IN uses unverified post-event field, seed and bracket snapshots; results must not be described as an unbiased backtest."
        : "Default fail-closed policy excludes a target unless the complete provenance of its field/player mappings, seeds and bracket snapshot predates cutoff.",
      "The entire target event is held out and every fitted model is frozen before bracket simulation.",
      "Target winners, scores, standings, downstream slot entrants and observed reset result are excluded from forecast construction.",
      allowUnverifiedHistoricalFeatures
        ? "This run may consume source values first observed after the target cutoff; it is retrospective pipeline exploration, not an unbiased backtest."
        : "Every consumed target feature must be supported only by source observations strictly before the target cutoff.",
      "No model is selected or approved for product use from this pilot.",
    ],
    events: forecasts.sort(byEvent),
    exclusions,
    selectedModel: null,
    productize: false,
    uploads: false,
  };
}

/** Read outcome-only standings after forecasts have already been materialized. */
export function extractHistoricalTournamentOutcomes(dataset, forecasts, {
  outcomeReconciliation = null,
  forecastSha256 = null,
} = {}) {
  if (forecasts?.kind !== "historical-major-tournament-forecasts-v1" || !Array.isArray(forecasts.events)) {
    throw new Error("Expected historical tournament forecasts");
  }
  const entrantsById = new Map(dataset.entrants.map((entrant) => [entrant.id, entrant]));
  const standingsByEvent = new Map();
  for (const standing of dataset.standings) {
    if (!standingsByEvent.has(standing.eventId)) standingsByEvent.set(standing.eventId, []);
    standingsByEvent.get(standing.eventId).push(standing);
  }
  const events = forecasts.events.map((forecast) => {
    const field = new Map(forecast.route.field.map((row) => [row.entrantId, row]));
    const expected = Math.min(8, forecast.route.fieldSize);
    const top = (standingsByEvent.get(forecast.eventId) ?? [])
      .filter((standing) => Number.isSafeInteger(standing.placement) && standing.placement >= 1
        && standing.placement <= expected && Array.isArray(standing.exclusionReasons)
        && standing.exclusionReasons.length === 0)
      .sort((a, b) => a.placement - b.placement || compare(a.entrantId, b.entrantId));
    if (top.length !== expected || new Set(top.map((row) => row.entrantId)).size !== expected) {
      throw new Error(`Outcome standings for ${forecast.eventId} do not identify exactly ${expected} distinct top finishers`);
    }
    const championRows = top.filter((row) => row.placement === 1);
    if (championRows.length !== 1) throw new Error(`Outcome standings for ${forecast.eventId} need exactly one champion`);
    const resultRows = top.map((standing) => {
      const fieldRow = field.get(standing.entrantId);
      const entrant = entrantsById.get(standing.entrantId);
      if (!fieldRow || !entrant || entrant.eventId !== forecast.eventId
          || entrant.playerId !== fieldRow.playerId || entrant.identityConflict === true) {
        throw new Error(`Outcome standing references an invalid forecast entrant in ${forecast.eventId}`);
      }
      return { entrantId: fieldRow.entrantId, playerId: fieldRow.playerId, placement: standing.placement };
    });
    const champion = resultRows.find((row) => row.placement === 1);
    return { eventId: forecast.eventId, champion, top8: resultRows };
  });
  return {
    schemaVersion: 1,
    kind: "historical-major-tournament-outcomes-v1",
    sourceDatasetSha256: forecasts.sourceDatasetSha256,
    forecastRouteContract: forecasts.routeContract,
    forecastSha256,
    source: "canonical-final-standings",
    outcomeReconciliation,
    events,
    productize: false,
    uploads: false,
  };
}

function probability(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite probability in [0, 1]`);
  }
  return value;
}

function binaryLogLoss(p, actual) {
  const clipped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, p));
  return actual ? -Math.log(clipped) : -Math.log1p(-clipped);
}

function titleScoringProbability(row, simulations, fieldSize, label) {
  if (Number.isSafeInteger(row.titleWins) && row.titleWins >= 0 && row.titleWins <= simulations) {
    return (row.titleWins + 0.5) / (simulations + 0.5 * fieldSize);
  }
  return probability(row.titleProbability, label);
}

function top8ScoringProbability(row, simulations, label) {
  if (Number.isSafeInteger(row.top8Finishes) && row.top8Finishes >= 0 && row.top8Finishes <= simulations) {
    return (row.top8Finishes + 0.5) / (simulations + 1);
  }
  return probability(row.top8Probability, label);
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function scoreHistoricalTournamentForecasts(forecasts, outcomes, {
  dataset = null,
  forecastSha256 = null,
} = {}) {
  if (forecasts?.kind !== "historical-major-tournament-forecasts-v1"
      || outcomes?.kind !== "historical-major-tournament-outcomes-v1") {
    throw new Error("Historical tournament scoring needs forecast and outcome artifacts");
  }
  if (forecasts.completeModelSuite !== true || !Array.isArray(forecasts.modelIds)
      || forecasts.modelIds.length !== MODEL_IDS.length
      || forecasts.modelIds.some((id, index) => id !== MODEL_IDS[index])) {
    throw new Error("Historical forecast does not contain the exact shared model suite");
  }
  if (forecasts.sourceDatasetSha256 !== outcomes.sourceDatasetSha256
      || JSON.stringify(canonical(forecasts.routeContract)) !== JSON.stringify(canonical(outcomes.forecastRouteContract))) {
    throw new Error("Historical forecast and outcome artifacts do not have matching source/route provenance");
  }
  if (forecasts.events.length > 0 && !/^[a-f0-9]{64}$/.test(forecastSha256 ?? "")) {
    throw new Error("Historical scoring requires the expected 64-character forecast SHA-256");
  }
  if (forecastSha256 != null && (!/^[a-f0-9]{64}$/.test(forecastSha256)
      || outcomes.forecastSha256 !== forecastSha256)) {
    throw new Error("Historical outcome artifact is not paired to the scored forecast hash");
  }
  if (forecastSha256 != null
      && createHash("sha256").update(JSON.stringify(forecasts) + "\n").digest("hex") !== forecastSha256) {
    throw new Error("Expected forecast hash does not match the scored forecast artifact");
  }
  if (forecasts.events.length > 0 && (outcomes.outcomeReconciliation?.allReconciled !== true
      || !/^[a-f0-9]{64}$/.test(outcomes.outcomeReconciliation.sha256 ?? ""))) {
    throw new Error("Historical tournament scoring requires a verified all-reconciled outcome audit");
  }
  const simulations = forecasts.simulations?.count;
  if (!Number.isSafeInteger(simulations) || simulations < 1) {
    throw new Error("Historical tournament scoring needs the forecast simulation count");
  }
  const outcomesByEvent = new Map(outcomes.events.map((event) => [event.eventId, event]));
  if (outcomesByEvent.size !== outcomes.events.length || outcomesByEvent.size !== forecasts.events.length
      || forecasts.events.some((event) => !outcomesByEvent.has(event.eventId))) {
    throw new Error("Forecast and outcome event membership differs");
  }
  const eventLabels = new Map((dataset?.events ?? []).map((event) => [event.id,
    event.major?.name ?? event.tournament?.name ?? event.name ?? null]));
  const entrantLabels = new Map((dataset?.entrants ?? []).map((entrant) => [entrant.id, entrant.name ?? null]));
  const aggregate = new Map(forecasts.modelIds.map((id) => [id, []]));
  const eventScores = [];
  for (const event of forecasts.events) {
    const actual = outcomesByEvent.get(event.eventId);
    if (!actual) throw new Error(`Missing tournament outcome for ${event.eventId}`);
    const actualTop = new Set(actual.top8.map((row) => row.entrantId));
    const scores = [];
    if (event.models.length !== forecasts.modelIds.length
        || event.models.some((model, index) => model.id !== forecasts.modelIds[index])) {
      throw new Error(`Forecast model membership differs from the declared suite for ${event.eventId}`);
    }
    for (const model of event.models) {
      const rows = model.entrants;
      if (!Array.isArray(rows) || rows.length !== event.route.fieldSize) {
        throw new Error(`Model ${model.id} has an incomplete field forecast for ${event.eventId}`);
      }
      const byEntrant = new Map(rows.map((row) => [row.entrantId, row]));
      const routeEntrants = new Set(event.route.field.map((row) => row.entrantId));
      if (byEntrant.size !== rows.length || rows.some((row) => !routeEntrants.has(row.entrantId))
          || !byEntrant.has(actual.champion.entrantId)) {
        throw new Error(`Model ${model.id} cannot identify the actual champion for ${event.eventId}`);
      }
      const targetCount = Math.min(8, rows.length);
      if (rows.some((row) => !Number.isSafeInteger(row.titleWins) || row.titleWins < 0
        || !Number.isSafeInteger(row.top8Finishes) || row.top8Finishes < 0)
        || rows.reduce((sum, row) => sum + row.titleWins, 0) !== simulations
        || rows.reduce((sum, row) => sum + row.top8Finishes, 0) !== simulations * targetCount
        || rows.some((row) => Math.abs(row.titleProbability - row.titleWins / simulations) > 1e-15
          || Math.abs(row.top8Probability - row.top8Finishes / simulations) > 1e-15)) {
        throw new Error(`Model ${model.id} has inconsistent Monte Carlo counts for ${event.eventId}`);
      }
      const championRow = byEntrant.get(actual.champion.entrantId);
      const rawChampionProbability = probability(championRow.titleProbability, `${model.id} raw champion probability`);
      const championProbability = titleScoringProbability(championRow, simulations, event.route.fieldSize,
        `${model.id} champion probability`);
      const titleProbabilities = rows.map((row) => titleScoringProbability(row, simulations,
        event.route.fieldSize, `${model.id} title probability`));
      const top8Rows = rows.map((row) => ({
        row,
        p: top8ScoringProbability(row, simulations, `${model.id} top-eight probability`),
        actual: actualTop.has(row.entrantId) ? 1 : 0,
      }));
      const greater = titleProbabilities.filter((p) => p > championProbability).length;
      const equal = titleProbabilities.filter((p) => p === championProbability).length;
      const topTitle = [...rows].sort((a, b) => b.titleProbability - a.titleProbability
        || a.seed - b.seed || compare(a.entrantId, b.entrantId))[0];
      const predictedTop = [...top8Rows]
        .sort((a, b) => b.p - a.p || a.row.seed - b.row.seed || compare(a.row.entrantId, b.row.entrantId))
        .slice(0, targetCount);
      const overlap = predictedTop.filter(({ row }) => actualTop.has(row.entrantId)).length;
      const score = {
        id: model.id,
        name: model.name,
        titleLogLoss: binaryLogLoss(championProbability, 1),
        titleBrier: rows.reduce((sum, row) => sum
          + (titleScoringProbability(row, simulations, event.route.fieldSize,
            `${model.id} title probability`) - Number(row.entrantId === actual.champion.entrantId)) ** 2, 0),
        championProbability,
        rawChampionProbability,
        championRankMin: greater + 1,
        championRankMax: greater + equal,
        top1Credit: greater === 0 ? 1 / equal : 0,
        topTitleEntrantId: topTitle.entrantId,
        topTitlePlayerId: topTitle.playerId,
        topTitleLabel: entrantLabels.get(topTitle.entrantId) ?? null,
        topTitleProbability: topTitle.titleProbability,
        top8Brier: mean(top8Rows.map((row) => (row.p - row.actual) ** 2)),
        top8LogLoss: mean(top8Rows.map((row) => binaryLogLoss(row.p, row.actual))),
        predictedTop8Overlap: overlap,
        top8Count: targetCount,
        precisionAt8: overlap / targetCount,
        pairwiseCoverage: model.pairwiseCoverage,
      };
      scores.push(score);
      aggregate.get(model.id)?.push(score);
    }
    eventScores.push({
      eventId: event.eventId,
      eventLabel: eventLabels.get(event.eventId) ?? null,
      actualChampionEntrantId: actual.champion.entrantId,
      actualChampionPlayerId: actual.champion.playerId,
      actualChampionLabel: entrantLabels.get(actual.champion.entrantId) ?? null,
      models: scores,
    });
  }
  const metricKeys = ["titleLogLoss", "titleBrier", "championProbability", "top1Credit",
    "top8Brier", "top8LogLoss", "predictedTop8Overlap", "top8Count", "precisionAt8"];
  const models = forecasts.modelIds.map((id) => {
    const rows = aggregate.get(id) ?? [];
    const first = eventScores.flatMap((event) => event.models).find((model) => model.id === id);
    return {
      id,
      name: first?.name ?? id,
      events: rows.length,
      metrics: Object.fromEntries(metricKeys.map((key) => [key, mean(rows.map((row) => row[key]))])),
    };
  });
  return {
    schemaVersion: 1,
    kind: "historical-major-tournament-backtest-v1",
    status: forecasts.status,
    sourceDatasetSha256: forecasts.sourceDatasetSha256,
    routeContract: forecasts.routeContract,
    forecastSha256: outcomes.forecastSha256,
    forecastEvents: forecasts.events.length,
    modelIds: [...forecasts.modelIds],
    metrics: {
      aggregation: "macro average over held-out target events",
      titlePrimary: "negative log probability assigned to the actual champion",
      titleBrier: "sum over the event field of squared multiclass probability error",
      top8: "mean entrant-level binary Brier and log loss plus overlap among the eight largest marginals",
      monteCarloScoring: "Title probabilities use a symmetric Dirichlet(1/2) simulation-count estimator; Top-8 probabilities use a Beta(1/2,1/2) estimator. This prevents zero/one Monte Carlo frequencies from producing arbitrary epsilon-clipped scores.",
      interpretation: "One-event pipeline validation only; no uncertainty interval, model selection or superiority claim.",
    },
    labelPolicy: "Human-readable report labels are joined after forecasting by exact canonical event/entrant ID only; aliases and tags are never matched.",
    featureAvailabilityPolicy: forecasts.featureAvailabilityPolicy,
    outcomeReconciliation: outcomes.outcomeReconciliation,
    models,
    events: eventScores,
    exclusions: forecasts.exclusions,
    warnings: [...forecasts.warnings],
    selectedModel: null,
    productize: false,
    uploads: false,
  };
}

const number = (value, digits = 4) => value == null ? "—" : value.toFixed(digits);
const percent = (value) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const safe = (value) => String(value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");

export function historicalBacktestMarkdown(report) {
  const labeledId = (label, id) => label ? `${safe(label)} (${safe(id)})` : safe(id);
  const eventRows = report.events.flatMap((event) => event.models.map((model) => {
    const rank = model.championRankMin === model.championRankMax
      ? String(model.championRankMin) : `${model.championRankMin}–${model.championRankMax}`;
    return `| ${labeledId(event.eventLabel, event.eventId)} | ${safe(model.name)} | ${labeledId(model.topTitleLabel, model.topTitleEntrantId)} — ${percent(model.topTitleProbability)} | ${labeledId(event.actualChampionLabel, event.actualChampionEntrantId)} | ${percent(model.championProbability)} / ${rank} | ${model.predictedTop8Overlap} / ${model.top8Count} |`;
  }));
  return [
    `# Historical major tournament backtest — ${safe(report.status)}`,
    "",
    report.status === "no-eligible-events"
      ? "No tournament was scored: the default fail-closed feature-availability policy found no eligible target. This is not a completed backtest and does not select a model."
      : report.status === "exploratory-pipeline-validation"
        ? "EXPLORATORY ONLY: this one-event run permits unverified post-cutoff historical features. It validates software plumbing, is not an unbiased backtest, and does not select a model."
        : "One manually reviewed event only. This validates the leakage boundary and simulation pipeline; it does not select a model for product use.",
    "",
    "| Model | Events | Champion p | Title log loss ↓ | Title Brier ↓ | Top-8 Brier ↓ | Top-8 overlap |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.models.map((model) => `| ${safe(model.name)} | ${model.events} | ${percent(model.metrics.championProbability)} | ${number(model.metrics.titleLogLoss)} | ${number(model.metrics.titleBrier)} | ${number(model.metrics.top8Brier)} | ${number(model.metrics.predictedTop8Overlap, 1)} / ${number(model.metrics.top8Count, 1)} |`),
    "",
    "## Per-event picks and outcomes",
    "",
    "Entrants are joined by canonical entrant ID; no tag or name matching is used. Exact title-probability ties use lower initial seed only for this display pick.",
    "",
    "| Event | Model | Top title pick | Actual champion | Actual champion p / rank | Predicted Top-8 overlap |",
    "|---|---|---|---|---:|---:|",
    ...eventRows,
    "",
    `Reviewed forecasts: ${report.forecastEvents}. Excluded target events: ${report.exclusions.length}.`,
    "",
    "## Method limits",
    "",
    ...report.warnings.map((warning) => `- ${warning}`),
    "",
  ].join("\n");
}
