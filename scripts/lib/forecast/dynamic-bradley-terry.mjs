import { eventTimeBounds } from "./evaluation.mjs";

const DAY = 86400;
const compare = (a, b) => String(a).localeCompare(String(b), "en");
const byId = (a, b) => compare(a.id, b.id);

export const DYNAMIC_BRADLEY_TERRY_OPTIONS = Object.freeze({
  halfLifeDays: 365,
  ridge: 1,
  maxIterations: 300,
  tolerance: 1e-9,
});

/**
 * Dynamic Bradley-Terry model with one latent skill per public player ID.
 *
 * Events are processed by reported completion time. Before event t, a returning
 * player's prior mean decays toward neutral:
 *
 *   m_i,t = 2^(-days_since_seen / halfLifeDays) * s_i,t-1
 *
 * All outcomes in that event are then fitted jointly by maximizing
 *
 *   sum_games [y*x - log(1 + exp(x))]
 *     - ridge/2 * sum_players (s_i,t - m_i,t)^2,
 *   where x = s_a,t - s_b,t.
 *
 * The joint event update deliberately does not use set timestamps or set order.
 * A fixed full-batch gradient step no larger than the objective's smoothness
 * bound makes the dependency-free optimizer deterministic. This is neither a
 * sequential Elo update nor one static Bradley-Terry fit over all history.
 */
export function fitDynamicBradleyTerryModel({ events, sets, cutoff, options = {} }) {
  if (!Array.isArray(events) || !Array.isArray(sets)) {
    throw new TypeError("Dynamic Bradley-Terry needs events and sets arrays");
  }
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    throw new Error("A finite forecast cutoff is required");
  }
  const config = { ...DYNAMIC_BRADLEY_TERRY_OPTIONS, ...options };
  validateOptions(config);

  const eventById = new Map();
  for (const event of events) {
    if (!event?.id) throw new Error("Training event needs an ID");
    if (eventById.has(event.id)) throw new Error("Duplicate training event");
    const bounds = eventTimeBounds(event);
    if (event.eligible !== true || bounds.trainingEnd == null || bounds.trainingEnd >= cutoff) {
      throw new Error("Training event does not finish strictly before cutoff");
    }
    eventById.set(event.id, { event, bounds });
  }

  const setsByEvent = new Map();
  const setIds = new Set();
  const seen = new Set();
  for (const set of [...sets].sort(byId)) {
    if (!set?.id) throw new Error("Training set needs an ID");
    if (setIds.has(set.id)) throw new Error("Duplicate training set");
    setIds.add(set.id);
    if (set.eligible !== true || !eventById.has(set.eventId)) {
      throw new Error("Training set is ineligible or outside the training events");
    }
    if (Number.isFinite(set.timestamps?.completedAt) && set.timestamps.completedAt >= cutoff) {
      throw new Error("Training outcome is not strictly before cutoff");
    }
    observation(set);
    if (!setsByEvent.has(set.eventId)) setsByEvent.set(set.eventId, []);
    setsByEvent.get(set.eventId).push(set);
    for (const playerId of set.playerIds) seen.add(playerId);
  }

  const states = new Map();
  const diagnostics = [];
  const orderedEvents = [...eventById.values()].sort((a, b) =>
    a.bounds.trainingEnd - b.bounds.trainingEnd || byId(a.event, b.event));

  for (const { event, bounds } of orderedEvents) {
    const eventSets = setsByEvent.get(event.id) ?? [];
    const participants = [...new Set(eventSets.flatMap((set) => set.playerIds))].sort(compare);
    if (!participants.length) {
      diagnostics.push({ eventId: event.id, observations: 0, participants: 0,
        iterations: 0, converged: true, maxDelta: 0, objective: 0 });
      continue;
    }

    const prior = new Map();
    const skills = new Map();
    const degrees = new Map(participants.map((playerId) => [playerId, 0]));
    for (const playerId of participants) {
      const state = states.get(playerId);
      const mean = state == null ? 0
        : state.skill * decay(bounds.trainingEnd - state.updatedAt, config.halfLifeDays);
      prior.set(playerId, mean);
      skills.set(playerId, mean);
    }
    for (const set of eventSets) {
      for (const playerId of set.playerIds) degrees.set(playerId, degrees.get(playerId) + 1);
    }

    // For logistic pair comparisons, lambda_max(X'WX) <= maxDegree / 2
    // because W <= 1/4. This step is therefore no larger than 1/L.
    const maxDegree = Math.max(...degrees.values());
    const step = 1 / (config.ridge + maxDegree / 2);
    let iterations = 0;
    let maxDelta = Infinity;
    for (; iterations < config.maxIterations && maxDelta > config.tolerance; iterations++) {
      const gradient = new Map(participants.map((playerId) => [
        playerId,
        -config.ridge * (skills.get(playerId) - prior.get(playerId)),
      ]));
      for (const set of eventSets) {
        const [a, b] = set.playerIds;
        const residual = observation(set) - logistic(skills.get(a) - skills.get(b));
        gradient.set(a, gradient.get(a) + residual);
        gradient.set(b, gradient.get(b) - residual);
      }
      maxDelta = 0;
      for (const playerId of participants) {
        const delta = step * gradient.get(playerId);
        skills.set(playerId, skills.get(playerId) + delta);
        maxDelta = Math.max(maxDelta, Math.abs(delta));
      }
    }

    for (const playerId of participants) {
      states.set(playerId, { skill: skills.get(playerId), updatedAt: bounds.trainingEnd });
    }
    diagnostics.push({
      eventId: event.id,
      observations: eventSets.length,
      participants: participants.length,
      iterations,
      converged: maxDelta <= config.tolerance,
      maxDelta,
      objective: eventObjective(eventSets, skills, prior, config.ridge),
    });
  }

  const forecastSkills = new Map();
  for (const [playerId, state] of states) {
    forecastSkills.set(playerId, state.skill * decay(cutoff - state.updatedAt, config.halfLifeDays));
  }
  const knownPlayers = (set) => predictionPlayers(set).filter((id) => seen.has(id)).length;

  return {
    id: "dynamic-bradley-terry",
    name: "Dynamic Bradley–Terry",
    methodology: {
      kind: "dynamic-event-state-bradley-terry",
      ...config,
      initialSkill: 0,
      trainedPlayers: seen.size,
      trainingEvents: orderedEvents.length,
      eventOrder: "reported completion, then ID",
      sameEventUpdates: false,
      decay: "prior skill multiplied by 2^(-elapsedDays / halfLifeDays)",
      objective: "event joint Bradley-Terry log likelihood minus ridge/2 * squared distance from decayed prior",
      optimizer: "deterministic full-batch gradient ascent with step 1 / (ridge + maxDegree / 2)",
      unknownFallback: "0.5 when either player has no training outcome",
      diagnostics,
    },
    predict(set) {
      const players = predictionPlayers(set);
      const known = knownPlayers(set);
      if (known !== 2) return { p: 0.5, covered: false, knownPlayers: known };
      return {
        p: logistic(forecastSkills.get(players[0]) - forecastSkills.get(players[1])),
        covered: true,
        knownPlayers: 2,
      };
    },
  };
}

function validateOptions(config) {
  if (!Number.isFinite(config.halfLifeDays) || config.halfLifeDays <= 0
    || !Number.isFinite(config.ridge) || config.ridge <= 0
    || !Number.isFinite(config.tolerance) || config.tolerance <= 0) {
    throw new Error("Dynamic Bradley-Terry parameters must be positive finite numbers");
  }
  if (!Number.isSafeInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 10000) {
    throw new Error("maxIterations must be an integer from 1 to 10000");
  }
}

function predictionPlayers(set) {
  const players = set?.playerIds;
  if (!Array.isArray(players) || players.length !== 2 || !players[0] || !players[1]
    || players[0] === players[1]) {
    throw new Error("A prediction needs two distinct players");
  }
  return players;
}

function observation(set) {
  const players = predictionPlayers(set);
  if (!players.includes(set.winnerPlayerId)) {
    throw new Error("A model observation needs a valid winner");
  }
  return set.winnerPlayerId === players[0] ? 1 : 0;
}

function decay(elapsedSeconds, halfLifeDays) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new Error("Dynamic model chronology must be nondecreasing");
  }
  return 2 ** (-elapsedSeconds / (DAY * halfLifeDays));
}

function logistic(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function logLogistic(value) {
  return value >= 0 ? -Math.log1p(Math.exp(-value)) : value - Math.log1p(Math.exp(value));
}

function eventObjective(sets, skills, prior, ridge) {
  let value = 0;
  for (const set of sets) {
    const [a, b] = set.playerIds;
    const margin = skills.get(a) - skills.get(b);
    value += logLogistic(observation(set) ? margin : -margin);
  }
  for (const [playerId, skill] of skills) value -= ridge * (skill - prior.get(playerId)) ** 2 / 2;
  return value;
}
