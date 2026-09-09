import { eventTimeBounds } from "./evaluation.mjs";

const compare = (a, b) => String(a).localeCompare(String(b), "en");
const byId = (a, b) => compare(a.id, b.id);
const DAY = 86400;
export const BASIC_MODEL_OPTIONS = Object.freeze({ k: 32, scale: 400, halfLifeDays: 730 });

export function actualResult(set) {
  const players = set.playerIds;
  if (!Array.isArray(players) || players.length !== 2 || !players.every(Boolean)
    || players[0] === players[1] || !players.includes(set.winnerPlayerId)) {
    throw new Error("A model observation needs two distinct players and a valid winner");
  }
  return set.winnerPlayerId === players[0] ? 1 : 0;
}

/**
 * Select only a unique full-field seed phase: every event entrant, once, with
 * unique ranks 1..N, and no known progression from another phase into it.
 * Never use phaseOrder, final placement, current tag, or most recent phase.
 * A historical snapshot still cannot prove when these seeds were announced.
 */
export function initialSeedIndex(dataset, { allowHistorical = true } = {}) {
  const provenance = new Map((dataset.provenance ?? []).map((row) => [row.id, row]));
  const entrantGroups = new Map();
  const phaseGroups = new Map();
  const sourceSeeds = new Map();
  for (const entrant of dataset.entrants) {
    if (!entrantGroups.has(entrant.eventId)) entrantGroups.set(entrant.eventId, new Set());
    entrantGroups.get(entrant.eventId).add(entrant.id);
  }
  for (const seed of dataset.seeds) {
    const phaseId = seed.phase?.id == null ? null : String(seed.phase.id);
    if (!phaseId) continue;
    const key = JSON.stringify([seed.eventId, phaseId]);
    if (!phaseGroups.has(key)) phaseGroups.set(key, { eventId: seed.eventId, phaseId, rows: [] });
    phaseGroups.get(key).rows.push(seed);
    if (seed.source?.id) sourceSeeds.set(String(seed.source.id), seed);
  }
  const incomingPhases = new Set();
  for (const seed of dataset.seeds) {
    const destination = sourceSeeds.get(String(seed.progressionSeedId));
    if (destination && destination.eventId === seed.eventId
      && String(destination.phase?.id) !== String(seed.phase?.id)) {
      incomingPhases.add(JSON.stringify([destination.eventId, String(destination.phase.id)]));
    }
  }
  const candidates = new Map();
  for (const [key, group] of phaseGroups) {
    const entrants = entrantGroups.get(group.eventId) ?? new Set();
    if (!entrants.size || group.rows.length !== entrants.size || incomingPhases.has(key)) continue;
    const entrantIds = new Set();
    const ranks = new Set();
    const valid = group.rows.every((seed) => {
      entrantIds.add(seed.entrantId); ranks.add(seed.seedNum);
      return entrants.has(seed.entrantId) && Number.isInteger(seed.seedNum)
        && seed.seedNum >= 1 && seed.seedNum <= entrants.size && seed.isBye !== true
        && seed.usableAsPreEventFeature !== false && seed.exclusionReasons?.length === 0;
    });
    if (!valid || entrantIds.size !== entrants.size || ranks.size !== entrants.size) continue;
    if (!candidates.has(group.eventId)) candidates.set(group.eventId, []);
    candidates.get(group.eventId).push(group);
  }
  const seeds = new Map();
  const reports = [];
  for (const event of [...dataset.events].sort(byId)) {
    const groups = candidates.get(event.id) ?? [];
    if (groups.length !== 1) {
      reports.push({ eventId: event.id, phaseId: null, available: 0, historical: 0,
        reason: groups.length ? "ambiguous_full_field_seed_phases" : "no_complete_unique_field_seed_phase" });
      continue;
    }
    const group = groups[0];
    const cutoff = eventTimeBounds(event).cutoff;
    let historical = 0;
    let available = 0;
    for (const seed of [...group.rows].sort(byId)) {
      // The normalized flag uses nominal event start. Our conservative folds
      // may begin earlier, so verify observation provenance against OUR cutoff.
      const observedBeforeCutoff = cutoff != null && (seed.source?.provenanceIds ?? []).some((id) => {
        const observedAt = Date.parse(provenance.get(id)?.fetchedAt) / 1000;
        return Number.isFinite(observedAt) && observedAt < cutoff;
      });
      const isHistorical = !observedBeforeCutoff;
      if (isHistorical) historical++;
      if (!allowHistorical && isHistorical) continue;
      seeds.set(seed.entrantId, seed.seedNum); available++;
    }
    reports.push({ eventId: event.id, phaseId: group.phaseId, available, historical,
      reason: historical ? "historical_availability_assumption" : null });
  }
  return { seeds, reports, allowHistorical };
}

export function seedPair(set, seedIndex) {
  const [a, b] = (set.entrantIds ?? []).map((id) => seedIndex.seeds.get(id));
  return Number.isInteger(a) && Number.isInteger(b) && a !== b ? [a, b] : null;
}

/**
 * Event-batch Elo variant: all sets in one event are predicted from its opening
 * ratings, then their deltas are applied together. This removes dependence on
 * unreliable reporting timestamps/phase order, but is deliberately NOT standard
 * sequential per-set Elo. Events are processed when their reported ends occur.
 * Update weight is 2^(-age / halfLife) relative to the forecast cutoff.
 */
export function fitBasicModels({ events, sets, cutoff, seedIndex, options = {} }) {
  const config = { ...BASIC_MODEL_OPTIONS, ...options };
  for (const value of Object.values(config)) if (!Number.isFinite(value) || value <= 0) throw new Error("Model parameters must be positive finite numbers");
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error("A finite forecast cutoff is required");
  const eventById = new Map();
  for (const event of events) {
    if (eventById.has(event.id)) throw new Error("Duplicate training event");
    const bounds = eventTimeBounds(event);
    if (!event.eligible || bounds.trainingEnd == null || bounds.trainingEnd >= cutoff) throw new Error("Training event does not finish strictly before cutoff");
    eventById.set(event.id, { event, bounds });
  }
  const setsByEvent = new Map();
  const seen = new Set();
  const setIds = new Set();
  let seedComparisons = 0;
  let higherSeedWins = 0;
  for (const set of [...sets].sort(byId)) {
    if (setIds.has(set.id)) throw new Error("Duplicate training set");
    setIds.add(set.id);
    if (!set.eligible || !eventById.has(set.eventId)) throw new Error("Training set is ineligible or outside the training events");
    if (Number.isFinite(set.timestamps?.completedAt) && set.timestamps.completedAt >= cutoff) throw new Error("Training outcome is not strictly before cutoff");
    const actual = actualResult(set);
    if (!setsByEvent.has(set.eventId)) setsByEvent.set(set.eventId, []);
    setsByEvent.get(set.eventId).push(set);
    for (const player of set.playerIds) seen.add(player);
    const pair = seedPair(set, seedIndex);
    if (pair) {
      seedComparisons++;
      if ((pair[0] < pair[1] && actual === 1) || (pair[1] < pair[0] && actual === 0)) higherSeedWins++;
    }
  }
  const ratings = new Map();
  const probability = (a, b) => 1 / (1 + 10 ** (((ratings.get(b) ?? 0) - (ratings.get(a) ?? 0)) / config.scale));
  const ordered = [...eventById.values()].sort((a, b) => a.bounds.trainingEnd - b.bounds.trainingEnd || byId(a.event, b.event));
  for (const { event, bounds } of ordered) {
    const weight = 2 ** (-(cutoff - bounds.trainingEnd) / (DAY * config.halfLifeDays));
    const deltas = new Map();
    for (const set of setsByEvent.get(event.id) ?? []) {
      const [a, b] = set.playerIds;
      const change = config.k * weight * (actualResult(set) - probability(a, b));
      deltas.set(a, (deltas.get(a) ?? 0) + change);
      deltas.set(b, (deltas.get(b) ?? 0) - change);
    }
    for (const [player, change] of deltas) ratings.set(player, (ratings.get(player) ?? 0) + change);
  }
  // Beta(1,1) smoothing, calibrated on TRAINING events only, not target results.
  const seedConfidence = Math.max(0.5, (higherSeedWins + 1) / (seedComparisons + 2));
  const knownPlayers = (set) => set.playerIds.filter((id) => seen.has(id)).length;
  return [
    {
      id: "neutral", name: "Neutral 50/50",
      methodology: { kind: "constant", p: 0.5 },
      predict: () => ({ p: 0.5, covered: true }),
    },
    {
      id: "higher-seed", name: seedIndex.allowHistorical ? "Higher seed (historical availability assumed)" : "Higher seed (observed before cutoff only)",
      methodology: { kind: "training-calibrated-higher-seed", calibration: "Beta(1,1), lower bound 0.5",
        seedComparisons, higherSeedWins, seedConfidence, allowHistorical: seedIndex.allowHistorical,
        fallback: "0.5 when either initial-phase seed is unavailable" },
      predict: (set) => {
        const pair = seedPair(set, seedIndex);
        return { p: pair ? pair[0] < pair[1] ? seedConfidence : 1 - seedConfidence : 0.5, covered: pair !== null };
      },
    },
    {
      id: "recency-elo", name: "Recency-weighted event-batch Elo",
      methodology: { kind: "event-batch-elo", ...config, initialRating: 0, trainedPlayers: seen.size,
        eventOrder: "reported completion, then ID", sameEventUpdates: false },
      predict: (set) => ({ p: probability(...set.playerIds), covered: knownPlayers(set) === 2, knownPlayers: knownPlayers(set) }),
    },
  ];
}
