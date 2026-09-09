import { eventTimeBounds } from "./evaluation.mjs";

const compare = (a, b) => String(a).localeCompare(String(b), "en");
const byId = (a, b) => compare(a.id, b.id);
const PI_SQUARED = Math.PI ** 2;

export const GLICKO2_OPTIONS = Object.freeze({
  initialRating: 1500,
  initialRd: 350,
  initialVolatility: 0.06,
  ratingScale: 173.7178,
  tau: 0.5,
  convergenceTolerance: 1e-6,
  maxIterations: 100,
});

/**
 * Apply one canonical Glicko-2 rating period to one player. Ratings and rating
 * deviations use the familiar Glicko scale; matches are
 * `{ rating, rd, score }`, where score is numeric 0 or 1. An empty period only
 * increases uncertainty. This small public primitive makes the implementation
 * testable against the numerical example in Glickman's paper.
 */
export function updateGlicko2Rating(player, matches, options = {}) {
  const config = modelOptions(options);
  const state = ratingState(player, "Player");
  if (!Array.isArray(matches)) throw new TypeError("Glicko-2 matches must be an array");
  const observations = matches.map((match, index) => {
    if (!match || typeof match !== "object") throw new TypeError(`Match ${index} must be an object`);
    const opponent = ratingState({
      rating: match.rating,
      rd: match.rd,
      volatility: config.initialVolatility,
    }, `Match ${index} opponent`);
    if (match.score !== 0 && match.score !== 1) throw new TypeError(`Match ${index} score must be numeric 0 or 1`);
    return { opponent, score: match.score };
  });
  return updatePeriod(state, observations, config);
}

/**
 * Fit Glicko-2 using one simultaneous rating period per completed event.
 * Training events are ordered by their reported completion boundary, then ID;
 * every set in an event sees the same opening ratings. Consequently unreliable
 * set timestamps and input order cannot create within-event leakage. `predict`
 * is a frozen target-time view: it never consumes the set winner or mutates the
 * learned ratings.
 *
 * The returned probability uses a symmetric uncertainty attenuation based on
 * both players' RDs. Rating updates themselves follow canonical Glicko-2.
 */
export function fitGlicko2Model({ events, sets, cutoff, options = {} }) {
  if (!Array.isArray(events) || !Array.isArray(sets)) throw new TypeError("Training events and sets must be arrays");
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new TypeError("A positive finite forecast cutoff is required");
  const config = modelOptions(options);
  const eventById = new Map();
  for (const event of events) {
    requireId(event?.id, "Training event");
    if (eventById.has(event.id)) throw new Error("Duplicate training event");
    const bounds = eventTimeBounds(event);
    if (event.eligible !== true || bounds.trainingEnd == null || bounds.trainingEnd >= cutoff) {
      throw new Error("Training event does not finish strictly before cutoff");
    }
    eventById.set(event.id, { event, bounds });
  }

  const setsByEvent = new Map();
  const setIds = new Set();
  for (const set of sets) {
    requireId(set?.id, "Training set");
    if (setIds.has(set.id)) throw new Error("Duplicate training set");
    setIds.add(set.id);
    if (set.eligible !== true || !eventById.has(set.eventId)) {
      throw new Error("Training set is ineligible or outside the training events");
    }
    const completedAt = set.timestamps?.completedAt;
    if (completedAt != null && (!Number.isFinite(completedAt) || completedAt <= 0)) {
      throw new Error("Training outcome has an invalid completion timestamp");
    }
    if (completedAt != null && completedAt >= cutoff) {
      throw new Error("Training outcome is not strictly before cutoff");
    }
    matchup(set, true);
    if (!setsByEvent.has(set.eventId)) setsByEvent.set(set.eventId, []);
    setsByEvent.get(set.eventId).push(set);
  }
  for (const rows of setsByEvent.values()) rows.sort(byId);

  const states = new Map();
  const orderedEvents = [...eventById.values()]
    .sort((a, b) => a.bounds.trainingEnd - b.bounds.trainingEnd || byId(a.event, b.event));
  for (const { event } of orderedEvents) {
    const eventSets = setsByEvent.get(event.id) ?? [];
    const activePlayers = new Set();
    for (const set of eventSets) for (const playerId of set.playerIds) activePlayers.add(playerId);
    for (const playerId of activePlayers) if (!states.has(playerId)) states.set(playerId, initialState(config));

    // Snapshot before any event result is applied. All players active in this
    // period are updated from these same opening values.
    const opening = new Map([...states].map(([id, state]) => [id, { ...state }]));
    const observations = new Map([...activePlayers].map((id) => [id, []]));
    for (const set of eventSets) {
      const [a, b, scoreA] = matchup(set, true);
      observations.get(a).push({ opponent: opening.get(b), score: scoreA });
      observations.get(b).push({ opponent: opening.get(a), score: 1 - scoreA });
    }

    const next = new Map();
    for (const [playerId, state] of opening) {
      next.set(playerId, updatePeriod(state, observations.get(playerId) ?? [], config));
    }
    for (const [playerId, state] of next) states.set(playerId, state);
  }

  const frozenRatings = new Map([...states].map(([id, state]) => [id, Object.freeze({ ...state })]));
  const predictionState = (id) => frozenRatings.get(id) ?? initialState(config);
  return {
    id: "glicko2",
    name: "Glicko-2 (event rating periods)",
    methodology: {
      kind: "glicko-2",
      initialRating: config.initialRating,
      initialRd: config.initialRd,
      initialVolatility: config.initialVolatility,
      ratingScale: config.ratingScale,
      tau: config.tau,
      convergenceTolerance: config.convergenceTolerance,
      trainedPlayers: frozenRatings.size,
      ratingPeriods: orderedEvents.length,
      eventOrder: "reported completion, then ID",
      sameEventUpdates: false,
      probability: "symmetric logistic rating difference attenuated by both rating deviations",
      unknownPlayerFallback: "initial Glicko-2 state",
    },
    predict(set) {
      const [a, b] = matchup(set, false);
      const knownPlayers = Number(frozenRatings.has(a)) + Number(frozenRatings.has(b));
      const left = predictionState(a);
      const right = predictionState(b);
      const combinedPhi = Math.hypot(left.rd, right.rd) / config.ratingScale;
      const logit = g(combinedPhi) * (left.rating - right.rating) / config.ratingScale;
      return { p: sigmoid(logit), covered: knownPlayers === 2, knownPlayers };
    },
  };
}

function updatePeriod(state, observations, config) {
  const mu = (state.rating - config.initialRating) / config.ratingScale;
  const phi = state.rd / config.ratingScale;
  if (!observations.length) {
    return {
      rating: state.rating,
      rd: config.ratingScale * Math.hypot(phi, state.volatility),
      volatility: state.volatility,
    };
  }

  let information = 0;
  let residual = 0;
  for (const { opponent, score } of observations) {
    const opponentMu = (opponent.rating - config.initialRating) / config.ratingScale;
    const opponentPhi = opponent.rd / config.ratingScale;
    const weight = g(opponentPhi);
    const expected = sigmoid(weight * (mu - opponentMu));
    information += weight ** 2 * expected * (1 - expected);
    residual += weight * (score - expected);
  }
  if (!(information > 0) || !Number.isFinite(information) || !Number.isFinite(residual)) {
    throw new Error("Glicko-2 period produced invalid information");
  }
  const variance = 1 / information;
  const improvement = variance * residual;
  const volatility = solveVolatility(phi, state.volatility, variance, improvement, config);
  const preRatingPhi = Math.hypot(phi, volatility);
  const nextPhi = 1 / Math.sqrt(1 / preRatingPhi ** 2 + 1 / variance);
  const nextMu = mu + nextPhi ** 2 * residual;
  return {
    rating: config.initialRating + config.ratingScale * nextMu,
    rd: config.ratingScale * nextPhi,
    volatility,
  };
}

function solveVolatility(phi, volatility, variance, improvement, config) {
  const a = Math.log(volatility ** 2);
  const f = (x) => {
    const exp = Math.exp(x);
    const denominator = phi ** 2 + variance + exp;
    return exp * (improvement ** 2 - phi ** 2 - variance - exp) / (2 * denominator ** 2)
      - (x - a) / config.tau ** 2;
  };
  let left = a;
  let right;
  if (improvement ** 2 > phi ** 2 + variance) {
    right = Math.log(improvement ** 2 - phi ** 2 - variance);
  } else {
    let k = 1;
    while (k <= config.maxIterations && f(a - k * config.tau) < 0) k++;
    if (k > config.maxIterations) throw new Error("Glicko-2 volatility bracketing did not converge");
    right = a - k * config.tau;
  }
  let fLeft = f(left);
  let fRight = f(right);
  let iterations = 0;
  while (Math.abs(right - left) > config.convergenceTolerance) {
    if (++iterations > config.maxIterations) throw new Error("Glicko-2 volatility iteration did not converge");
    const divisor = fRight - fLeft;
    if (divisor === 0 || !Number.isFinite(divisor)) throw new Error("Glicko-2 volatility iteration became unstable");
    const candidate = left + (left - right) * fLeft / divisor;
    const fCandidate = f(candidate);
    if (!Number.isFinite(candidate) || !Number.isFinite(fCandidate)) throw new Error("Glicko-2 volatility iteration became unstable");
    if (fCandidate * fRight <= 0) {
      left = right;
      fLeft = fRight;
    } else {
      fLeft /= 2;
    }
    right = candidate;
    fRight = fCandidate;
  }
  return Math.exp(left / 2);
}

function matchup(set, requireWinner) {
  if (!set || !Array.isArray(set.playerIds) || set.playerIds.length !== 2) {
    throw new TypeError("A Glicko-2 matchup needs exactly two players");
  }
  const [a, b] = set.playerIds;
  requireId(a, "Matchup player");
  requireId(b, "Matchup player");
  if (a === b) throw new Error("A Glicko-2 matchup needs two distinct players");
  if (!requireWinner) return [a, b];
  if (set.winnerPlayerId !== a && set.winnerPlayerId !== b) {
    throw new Error("A training matchup needs a valid winner");
  }
  return [a, b, set.winnerPlayerId === a ? 1 : 0];
}

function initialState(config) {
  return { rating: config.initialRating, rd: config.initialRd, volatility: config.initialVolatility };
}

function ratingState(value, label) {
  if (!value || !Number.isFinite(value.rating)) throw new TypeError(`${label} rating must be finite`);
  if (!Number.isFinite(value.rd) || value.rd <= 0) throw new TypeError(`${label} RD must be positive and finite`);
  if (!Number.isFinite(value.volatility) || value.volatility <= 0) throw new TypeError(`${label} volatility must be positive and finite`);
  return { rating: value.rating, rd: value.rd, volatility: value.volatility };
}

function modelOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Glicko-2 options must be an object");
  const unknown = Object.keys(options).filter((key) => !(key in GLICKO2_OPTIONS));
  if (unknown.length) throw new TypeError(`Unknown Glicko-2 option: ${unknown.sort(compare).join(", ")}`);
  const config = { ...GLICKO2_OPTIONS, ...options };
  if (!Number.isFinite(config.initialRating)) throw new TypeError("initialRating must be finite");
  for (const key of ["initialRd", "initialVolatility", "ratingScale", "tau", "convergenceTolerance"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new TypeError(`${key} must be positive and finite`);
  }
  if (!Number.isSafeInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 100000) {
    throw new TypeError("maxIterations must be a positive safe integer no greater than 100000");
  }
  return config;
}

function requireId(value, label) {
  if (typeof value !== "string" || !value.length) throw new TypeError(`${label} ID must be a non-empty string`);
}

function g(phi) {
  return 1 / Math.sqrt(1 + 3 * phi ** 2 / PI_SQUARED);
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}
