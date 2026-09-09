import { actualResult, seedPair } from "./baselines.mjs";
import { eventTimeBounds } from "./evaluation.mjs";

const DAY = 86400;
const compare = (a, b) => String(a).localeCompare(String(b), "en");
const byId = (a, b) => compare(a.id, b.id);

export const REGULARIZED_BT_OPTIONS = Object.freeze({
  abilityL2: 2,
  featureL2: 2,
  maxIterations: 300,
  tolerance: 1e-7,
  formHalfLifeDays: 180,
  formPrior: 6,
  formRatingK: 24,
  formRatingScale: 400,
});

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logSigmoid(value) {
  return value >= 0 ? -Math.log1p(Math.exp(-value)) : value - Math.log1p(Math.exp(value));
}

function rawSeedDifference(set, seedIndex) {
  const pair = seedPair(set, seedIndex);
  return pair ? Math.log(pair[1] / pair[0]) : 0;
}

function rootMeanSquare(values) {
  if (!values.length) return 1;
  const scale = Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function validateOptions(options) {
  const config = { ...REGULARIZED_BT_OPTIONS, ...options };
  for (const key of ["abilityL2", "featureL2", "tolerance", "formHalfLifeDays", "formPrior", "formRatingK", "formRatingScale"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive finite number`);
  }
  if (!Number.isSafeInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 10000) {
    throw new Error("maxIterations must be an integer from 1 to 10000");
  }
  return config;
}

/**
 * Build a pre-event form feature without trusting within-event set order.
 *
 * A player's form is a recency-decayed average of prior event residuals
 * (actual result minus the probability implied by opening opponent-adjusted
 * ratings). Every set in an event sees the same opening state; ratings and form
 * are updated only after all of that event's observations have been created.
 */
function rollingFormFeatures(orderedEvents, setsByEvent, cutoff, config) {
  const ratings = new Map();
  const formStates = new Map();
  const trainingDifferences = new Map();

  const formAt = (playerId, time) => {
    const state = formStates.get(playerId);
    if (!state) return 0;
    const decay = 2 ** (-(time - state.time) / (DAY * config.formHalfLifeDays));
    return (state.sum * decay) / (state.weight * decay + config.formPrior);
  };
  const ratingProbability = (a, b) => 1 / (1 + 10 ** (((ratings.get(b) ?? 0) - (ratings.get(a) ?? 0)) / config.formRatingScale));

  for (let eventIndex = 0; eventIndex < orderedEvents.length;) {
    const trainingEnd = orderedEvents[eventIndex].trainingEnd;
    const simultaneousEvents = [];
    while (eventIndex < orderedEvents.length && orderedEvents[eventIndex].trainingEnd === trainingEnd) {
      simultaneousEvents.push(orderedEvents[eventIndex].event);
      eventIndex++;
    }
    const formUpdates = new Map();
    const formWeights = new Map();
    const ratingUpdates = new Map();
    for (const event of simultaneousEvents) {
      for (const set of setsByEvent.get(event.id) ?? []) {
        const [a, b] = set.playerIds;
        trainingDifferences.set(set.id, formAt(a, trainingEnd) - formAt(b, trainingEnd));
        const residual = actualResult(set) - ratingProbability(a, b);
        formUpdates.set(a, (formUpdates.get(a) ?? 0) + residual);
        formUpdates.set(b, (formUpdates.get(b) ?? 0) - residual);
        formWeights.set(a, (formWeights.get(a) ?? 0) + 1);
        formWeights.set(b, (formWeights.get(b) ?? 0) + 1);
        ratingUpdates.set(a, (ratingUpdates.get(a) ?? 0) + config.formRatingK * residual);
        ratingUpdates.set(b, (ratingUpdates.get(b) ?? 0) - config.formRatingK * residual);
      }
    }
    for (const [playerId, residualSum] of formUpdates) {
      const prior = formStates.get(playerId);
      const decay = prior ? 2 ** (-(trainingEnd - prior.time) / (DAY * config.formHalfLifeDays)) : 0;
      formStates.set(playerId, {
        sum: (prior?.sum ?? 0) * decay + residualSum,
        weight: (prior?.weight ?? 0) * decay + formWeights.get(playerId),
        time: trainingEnd,
      });
    }
    for (const [playerId, update] of ratingUpdates) ratings.set(playerId, (ratings.get(playerId) ?? 0) + update);
  }

  const targetForm = new Map();
  for (const playerId of formStates.keys()) targetForm.set(playerId, formAt(playerId, cutoff));
  return { trainingDifferences, targetForm };
}

function fitCoefficients(observations, players, config) {
  const playerIndex = new Map(players.map((playerId, index) => [playerId, index]));
  let abilities = new Float64Array(players.length);
  let coefficients = new Float64Array(2);

  const objective = (candidateAbilities, candidateCoefficients) => {
    let value = 0;
    for (const row of observations) {
      const linear = candidateAbilities[playerIndex.get(row.a)] - candidateAbilities[playerIndex.get(row.b)]
        + candidateCoefficients[0] * row.seed + candidateCoefficients[1] * row.form;
      value += row.actual ? logSigmoid(linear) : logSigmoid(-linear);
    }
    for (const ability of candidateAbilities) value -= config.abilityL2 * ability ** 2 / 2;
    for (const coefficient of candidateCoefficients) value -= config.featureL2 * coefficient ** 2 / 2;
    return value;
  };

  let currentObjective = objective(abilities, coefficients);
  let iterations = 0;
  let converged = observations.length === 0;
  let lastLargestDirection = 0;
  let lastGradientMax = 0;
  for (; iterations < config.maxIterations && observations.length; iterations++) {
    const gradients = new Float64Array(players.length);
    const diagonals = new Float64Array(players.length);
    const featureGradients = new Float64Array(2);
    const featureDiagonals = new Float64Array(2);
    for (const row of observations) {
      const aIndex = playerIndex.get(row.a);
      const bIndex = playerIndex.get(row.b);
      const linear = abilities[aIndex] - abilities[bIndex]
        + coefficients[0] * row.seed + coefficients[1] * row.form;
      const probability = sigmoid(linear);
      const residual = row.actual - probability;
      const variance = probability * (1 - probability);
      gradients[aIndex] += residual;
      gradients[bIndex] -= residual;
      diagonals[aIndex] += variance;
      diagonals[bIndex] += variance;
      featureGradients[0] += residual * row.seed;
      featureGradients[1] += residual * row.form;
      featureDiagonals[0] += variance * row.seed ** 2;
      featureDiagonals[1] += variance * row.form ** 2;
    }
    for (let index = 0; index < abilities.length; index++) {
      gradients[index] -= config.abilityL2 * abilities[index];
      diagonals[index] += config.abilityL2;
    }
    for (let index = 0; index < coefficients.length; index++) {
      featureGradients[index] -= config.featureL2 * coefficients[index];
      featureDiagonals[index] += config.featureL2;
    }

    const abilityDirection = abilities.map((_, index) => gradients[index] / diagonals[index]);
    const coefficientDirection = coefficients.map((_, index) => featureGradients[index] / featureDiagonals[index]);
    lastLargestDirection = 0;
    lastGradientMax = 0;
    for (let index = 0; index < abilityDirection.length; index++) {
      lastLargestDirection = Math.max(lastLargestDirection, Math.abs(abilityDirection[index]));
      lastGradientMax = Math.max(lastGradientMax, Math.abs(gradients[index]));
    }
    for (let index = 0; index < coefficientDirection.length; index++) {
      lastLargestDirection = Math.max(lastLargestDirection, Math.abs(coefficientDirection[index]));
      lastGradientMax = Math.max(lastGradientMax, Math.abs(featureGradients[index]));
    }
    let step = 1;
    let accepted = false;
    let nextAbilities;
    let nextCoefficients;
    let nextObjective;
    while (step >= 2 ** -20) {
      nextAbilities = abilities.map((value, index) => value + step * abilityDirection[index]);
      nextCoefficients = coefficients.map((value, index) => value + step * coefficientDirection[index]);
      nextObjective = objective(nextAbilities, nextCoefficients);
      if (nextObjective >= currentObjective - 1e-12) { accepted = true; break; }
      step /= 2;
    }
    if (!accepted) break;
    abilities = nextAbilities;
    coefficients = nextCoefficients;
    currentObjective = nextObjective;
    let largestChange = 0;
    for (const value of abilityDirection) largestChange = Math.max(largestChange, Math.abs(step * value));
    for (const value of coefficientDirection) largestChange = Math.max(largestChange, Math.abs(step * value));
    if (largestChange < config.tolerance) { converged = true; iterations++; break; }
  }

  return {
    abilities: new Map(players.map((playerId, index) => [playerId, abilities[index]])),
    coefficients: { seed: coefficients[0], form: coefficients[1] },
    fit: { iterations, converged, objective: currentObjective, lastLargestDirection, lastGradientMax },
  };
}

/**
 * Regularized Bradley-Terry model with categorical player abilities, initial
 * seed difference, and strictly pre-event recent form. The numeric value of a
 * player ID is never a feature: IDs are Map keys for learned ability effects.
 */
export function fitRegularizedBradleyTerryModel({ events, sets, cutoff, seedIndex, options = {} }) {
  const config = validateOptions(options);
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error("A finite forecast cutoff is required");
  if (!seedIndex?.seeds || !(seedIndex.seeds instanceof Map)) throw new Error("A seed index with a seeds Map is required");

  const eventById = new Map();
  for (const event of events) {
    if (eventById.has(event.id)) throw new Error("Duplicate training event");
    const bounds = eventTimeBounds(event);
    if (!event.eligible || bounds.trainingEnd == null || bounds.trainingEnd >= cutoff) {
      throw new Error("Training event does not finish strictly before cutoff");
    }
    eventById.set(event.id, { event, trainingEnd: bounds.trainingEnd });
  }
  const setsByEvent = new Map();
  const setIds = new Set();
  const players = new Set();
  for (const set of [...sets].sort(byId)) {
    if (setIds.has(set.id)) throw new Error("Duplicate training set");
    setIds.add(set.id);
    if (!set.eligible || !eventById.has(set.eventId)) throw new Error("Training set is ineligible or outside the training events");
    if (Number.isFinite(set.timestamps?.completedAt) && set.timestamps.completedAt >= cutoff) {
      throw new Error("Training outcome is not strictly before cutoff");
    }
    actualResult(set);
    if (!setsByEvent.has(set.eventId)) setsByEvent.set(set.eventId, []);
    setsByEvent.get(set.eventId).push(set);
    for (const playerId of set.playerIds) players.add(playerId);
  }
  for (const eventSets of setsByEvent.values()) eventSets.sort(byId);
  const orderedEvents = [...eventById.values()].sort(
    (a, b) => a.trainingEnd - b.trainingEnd || byId(a.event, b.event),
  );
  const { trainingDifferences, targetForm } = rollingFormFeatures(orderedEvents, setsByEvent, cutoff, config);
  const orderedSets = [...sets].sort(byId);
  const seedValues = orderedSets.map((set) => rawSeedDifference(set, seedIndex)).filter((value) => value !== 0);
  const formValues = orderedSets.map((set) => trainingDifferences.get(set.id) ?? 0).filter((value) => value !== 0);
  const scales = { seed: rootMeanSquare(seedValues), form: rootMeanSquare(formValues) };
  const observations = orderedSets.map((set) => ({
    a: set.playerIds[0],
    b: set.playerIds[1],
    actual: actualResult(set),
    seed: rawSeedDifference(set, seedIndex) / scales.seed,
    form: (trainingDifferences.get(set.id) ?? 0) / scales.form,
  }));
  const orderedPlayers = [...players].sort(compare);
  const fitted = fitCoefficients(observations, orderedPlayers, config);

  const predict = (set) => {
    const [a, b] = set.playerIds ?? [];
    if (!a || !b || a === b) throw new Error("A prediction needs two distinct players");
    const knownPlayers = Number(fitted.abilities.has(a)) + Number(fitted.abilities.has(b));
    const pair = seedPair(set, seedIndex);
    const seed = pair ? rawSeedDifference(set, seedIndex) / scales.seed : 0;
    const aHasForm = targetForm.has(a);
    const bHasForm = targetForm.has(b);
    const form = ((targetForm.get(a) ?? 0) - (targetForm.get(b) ?? 0)) / scales.form;
    const linear = (fitted.abilities.get(a) ?? 0) - (fitted.abilities.get(b) ?? 0)
      + fitted.coefficients.seed * seed + fitted.coefficients.form * form;
    return {
      p: sigmoid(linear),
      covered: knownPlayers === 2,
      knownPlayers,
      seedCovered: pair !== null,
      formKnownPlayers: Number(aHasForm) + Number(bHasForm),
    };
  };

  return {
    id: "regularized-bt-recent-form",
    name: "Regularized Bradley-Terry + seed + recent form",
    methodology: {
      kind: "l2-regularized-bradley-terry",
      playerEffects: "categorical public player IDs; ID numbers are never numeric features",
      features: ["initial-seed log ratio", "pre-event recency-decayed opponent-adjusted form difference"],
      ...config,
      trainingEvents: events.length,
      trainingSets: sets.length,
      trainedPlayers: orderedPlayers.length,
      coefficients: fitted.coefficients,
      featureScales: scales,
      fit: fitted.fit,
      chronology: "reported event completion; all same-event and equal-completion-time observations use one opening state",
      targetState: "training state decayed to forecast cutoff",
      missingSeed: "zero feature contribution unless both initial seeds are available and distinct",
      missingPlayerAbility: "zero ability effect",
      missingForm: "zero form value for each player without prior outcomes",
      seedAvailability: seedIndex.allowHistorical ? "historical availability assumed" : "observed before cutoff only",
      characterFeature: "not included",
    },
    predict,
  };
}
