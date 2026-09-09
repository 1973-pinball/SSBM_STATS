const seedSource = (seed) => ({ kind: "seed", seed });
const matchSource = (matchId, result) => ({ kind: "match", matchId, result });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The published Riptide path from sixteen remaining entrants into its Top 8,
 * followed by a conventional eight-player double-elimination bracket.
 */
export const RIPTIDE_TOP16_TOP8_ROUTING = deepFreeze({
  id: "riptide-published-top16-top8-v1",
  label: "Riptide published Top 16 → Top 8 routing",
  fieldSize: 16,
  matches: [
    { id: "A", label: "Winners quarterfinal A", phase: "top16", bracket: "upper",
      round: "winners-quarterfinal", sides: [seedSource(1), seedSource(8)] },
    { id: "B", label: "Winners quarterfinal B", phase: "top16", bracket: "upper",
      round: "winners-quarterfinal", sides: [seedSource(4), seedSource(5)] },
    { id: "C", label: "Winners quarterfinal C", phase: "top16", bracket: "upper",
      round: "winners-quarterfinal", sides: [seedSource(2), seedSource(7)] },
    { id: "D", label: "Winners quarterfinal D", phase: "top16", bracket: "upper",
      round: "winners-quarterfinal", sides: [seedSource(3), seedSource(6)] },
    { id: "J", label: "Lower initial J", phase: "top16", bracket: "lower",
      round: "lower-initial", sides: [seedSource(12), seedSource(15)], loserPlacement: 13 },
    { id: "K", label: "Lower initial K", phase: "top16", bracket: "lower",
      round: "lower-initial", sides: [seedSource(9), seedSource(14)], loserPlacement: 13 },
    { id: "L", label: "Lower initial L", phase: "top16", bracket: "lower",
      round: "lower-initial", sides: [seedSource(11), seedSource(16)], loserPlacement: 13 },
    { id: "M", label: "Lower initial M", phase: "top16", bracket: "lower",
      round: "lower-initial", sides: [seedSource(10), seedSource(13)], loserPlacement: 13 },
    { id: "N", label: "Lower round 2 N", phase: "top16", bracket: "lower",
      round: "lower-round-2", sides: [matchSource("D", "loser"), matchSource("J", "winner")],
      loserPlacement: 9 },
    { id: "O", label: "Lower round 2 O", phase: "top16", bracket: "lower",
      round: "lower-round-2", sides: [matchSource("C", "loser"), matchSource("K", "winner")],
      loserPlacement: 9 },
    { id: "P", label: "Lower round 2 P", phase: "top16", bracket: "lower",
      round: "lower-round-2", sides: [matchSource("B", "loser"), matchSource("L", "winner")],
      loserPlacement: 9 },
    { id: "Q", label: "Lower round 2 Q", phase: "top16", bracket: "lower",
      round: "lower-round-2", sides: [matchSource("A", "loser"), matchSource("M", "winner")],
      loserPlacement: 9 },
    { id: "WSF-A", label: "Winners semifinal A", phase: "top8", bracket: "upper",
      round: "winners-semifinal", sides: [matchSource("A", "winner"), matchSource("B", "winner")] },
    { id: "WSF-B", label: "Winners semifinal B", phase: "top8", bracket: "upper",
      round: "winners-semifinal", sides: [matchSource("C", "winner"), matchSource("D", "winner")] },
    { id: "LR1-A", label: "Lower round 1 A", phase: "top8", bracket: "lower",
      round: "lower-round-1", sides: [matchSource("Q", "winner"), matchSource("P", "winner")],
      loserPlacement: 7 },
    { id: "LR1-B", label: "Lower round 1 B", phase: "top8", bracket: "lower",
      round: "lower-round-1", sides: [matchSource("O", "winner"), matchSource("N", "winner")],
      loserPlacement: 7 },
    { id: "LQF-A", label: "Lower quarterfinal A", phase: "top8", bracket: "lower",
      round: "lower-quarterfinal", sides: [matchSource("WSF-B", "loser"), matchSource("LR1-A", "winner")],
      loserPlacement: 5 },
    { id: "LQF-B", label: "Lower quarterfinal B", phase: "top8", bracket: "lower",
      round: "lower-quarterfinal", sides: [matchSource("WSF-A", "loser"), matchSource("LR1-B", "winner")],
      loserPlacement: 5 },
    { id: "LSF", label: "Lower semifinal", phase: "top8", bracket: "lower",
      round: "lower-semifinal", sides: [matchSource("LQF-A", "winner"), matchSource("LQF-B", "winner")],
      loserPlacement: 4 },
    { id: "WF", label: "Winners final", phase: "top8", bracket: "upper",
      round: "winners-final", sides: [matchSource("WSF-A", "winner"), matchSource("WSF-B", "winner")] },
    { id: "LF", label: "Lower final", phase: "top8", bracket: "lower",
      round: "lower-final", sides: [matchSource("WF", "loser"), matchSource("LSF", "winner")],
      loserPlacement: 3 },
    { id: "GF", label: "Grand final", phase: "top8", bracket: "final",
      round: "grand-final", sides: [matchSource("WF", "winner"), matchSource("LF", "winner")] },
  ],
  top8Qualifiers: [
    { top8Seed: 1, source: matchSource("A", "winner") },
    { top8Seed: 2, source: matchSource("C", "winner") },
    { top8Seed: 3, source: matchSource("D", "winner") },
    { top8Seed: 4, source: matchSource("B", "winner") },
    { top8Seed: 5, source: matchSource("P", "winner") },
    { top8Seed: 6, source: matchSource("N", "winner") },
    { top8Seed: 7, source: matchSource("O", "winner") },
    { top8Seed: 8, source: matchSource("Q", "winner") },
  ],
  championship: {
    grandFinalId: "GF",
    lowerSide: 1,
    reset: { id: "GF-RESET", label: "Grand final reset", phase: "top8", bracket: "final",
      round: "grand-final-reset" },
  },
});

function validatePlayers(players, fieldSize) {
  if (!Array.isArray(players) || players.length !== fieldSize) {
    throw new Error(`Bracket projection requires exactly ${fieldSize} players`);
  }
  const bySeed = new Map();
  for (const player of players) {
    if (!player || typeof player !== "object" || !Number.isInteger(player.seed)
      || player.seed < 1 || player.seed > fieldSize) {
      throw new Error(`Every player needs an integer seed from 1 through ${fieldSize}`);
    }
    if (bySeed.has(player.seed)) throw new Error(`Duplicate player seed ${player.seed}`);
    bySeed.set(player.seed, player);
  }
  for (let seed = 1; seed <= fieldSize; seed++) {
    if (!bySeed.has(seed)) throw new Error(`Missing player seed ${seed}`);
  }
  return bySeed;
}

function routingLabel(routing) {
  if (!routing || typeof routing !== "object" || !Number.isInteger(routing.fieldSize)
    || typeof routing.id !== "string" || !routing.id || typeof routing.label !== "string" || !routing.label
    || !Array.isArray(routing.matches) || !routing.matches.length) {
    throw new Error("A labeled declarative bracket routing is required");
  }
  return { id: routing.id, label: routing.label };
}

function resolveSource(source, playersBySeed, results) {
  if (source?.kind === "seed") {
    const player = playersBySeed.get(source.seed);
    if (!player) throw new Error(`Routing references unavailable seed ${source.seed}`);
    return player;
  }
  if (source?.kind === "match" && (source.result === "winner" || source.result === "loser")) {
    const result = results.get(source.matchId);
    if (!result) throw new Error(`Routing references unresolved match ${source.matchId}`);
    return result[source.result];
  }
  throw new Error("Routing contains an invalid entrant source");
}

/**
 * Project a declarative seeded bracket. `predict(a, b, context)` must return
 * the probability that `a` wins. Exact 0.5 predictions advance the player
 * with the lower numerical seed.
 */
export function projectSeededBracket({ players, predict, routing = RIPTIDE_TOP16_TOP8_ROUTING } = {}) {
  const route = routingLabel(routing);
  if (routing.fieldSize !== 16) throw new Error("This projection engine currently requires a 16-player routing");
  if (typeof predict !== "function") throw new Error("Bracket projection requires a predict callback");
  const playersBySeed = validatePlayers(players, routing.fieldSize);
  const results = new Map();
  const matches = [];
  const placements = new Map();

  const place = (player, placement, matchId) => {
    if (!Number.isInteger(placement) || placement < 1 || placement > routing.fieldSize) {
      throw new Error(`Invalid placement ${placement} on match ${matchId}`);
    }
    if (placements.has(player.seed)) throw new Error(`Routing eliminates seed ${player.seed} more than once`);
    placements.set(player.seed, { placement, player, eliminatedAt: matchId });
  };

  const play = (definition, entrants, isReset = false) => {
    if (!definition || typeof definition.id !== "string" || !definition.id || results.has(definition.id)) {
      throw new Error("Routing contains a missing or duplicate match id");
    }
    if (!Array.isArray(entrants) || entrants.length !== 2 || entrants[0].seed === entrants[1].seed) {
      throw new Error(`Routing produced invalid entrants for match ${definition.id}`);
    }
    const context = Object.freeze({
      routingId: route.id,
      routingLabel: route.label,
      matchId: definition.id,
      label: definition.label,
      phase: definition.phase,
      bracket: definition.bracket,
      round: definition.round,
      isReset,
    });
    const probabilityA = predict(entrants[0], entrants[1], context);
    if (typeof probabilityA !== "number" || !Number.isFinite(probabilityA)
      || probabilityA < 0 || probabilityA > 1) {
      throw new Error(`Prediction for match ${definition.id} must be a finite probability from 0 through 1`);
    }
    const winnerIndex = probabilityA > 0.5 ? 0 : probabilityA < 0.5 ? 1
      : entrants[0].seed < entrants[1].seed ? 0 : 1;
    const result = {
      id: definition.id,
      label: definition.label,
      phase: definition.phase,
      bracket: definition.bracket,
      round: definition.round,
      entrants: [...entrants],
      probabilityA,
      winner: entrants[winnerIndex],
      loser: entrants[1 - winnerIndex],
      decision: probabilityA === 0.5 ? "lower-seed-number" : "model",
      isReset,
    };
    results.set(result.id, result);
    matches.push(result);
    if (definition.loserPlacement != null) place(result.loser, definition.loserPlacement, result.id);
    return result;
  };

  for (const definition of routing.matches) {
    if (!Array.isArray(definition.sides) || definition.sides.length !== 2) {
      throw new Error(`Routing match ${definition.id ?? "(missing id)"} needs two sides`);
    }
    play(definition, definition.sides.map((source) => resolveSource(source, playersBySeed, results)));
  }

  const qualifierSeeds = new Set();
  const qualifierPlayers = new Set();
  const top8Qualifiers = (routing.top8Qualifiers ?? []).map(({ top8Seed, source }) => {
    if (!Number.isInteger(top8Seed) || top8Seed < 1 || top8Seed > 8 || qualifierSeeds.has(top8Seed)) {
      throw new Error("Routing needs unique Top 8 seeds 1 through 8");
    }
    qualifierSeeds.add(top8Seed);
    const player = resolveSource(source, playersBySeed, results);
    if (qualifierPlayers.has(player.seed)) throw new Error("Routing produced a duplicate Top 8 qualifier");
    qualifierPlayers.add(player.seed);
    return { top8Seed, player, sourceMatchId: source.matchId };
  }).sort((a, b) => a.top8Seed - b.top8Seed);
  if (top8Qualifiers.length !== 8 || qualifierSeeds.size !== 8) {
    throw new Error("Routing needs exactly eight Top 8 qualifiers");
  }

  const championship = routing.championship;
  const grandFinal = results.get(championship?.grandFinalId);
  if (!grandFinal || (championship.lowerSide !== 0 && championship.lowerSide !== 1)
    || !championship.reset || typeof championship.reset.id !== "string") {
    throw new Error("Routing needs a valid grand-final and reset definition");
  }
  let decidingFinal = grandFinal;
  const lowerSidePlayer = grandFinal.entrants[championship.lowerSide];
  if (grandFinal.winner.seed === lowerSidePlayer.seed) {
    decidingFinal = play(championship.reset, grandFinal.entrants, true);
  }
  place(decidingFinal.loser, 2, decidingFinal.id);
  if (placements.has(decidingFinal.winner.seed)) {
    throw new Error("Routing eliminated the projected champion before the final");
  }
  placements.set(decidingFinal.winner.seed, { placement: 1, player: decidingFinal.winner, eliminatedAt: null });
  if (placements.size !== routing.fieldSize) {
    throw new Error(`Routing assigned placements to ${placements.size} of ${routing.fieldSize} players`);
  }

  return {
    routing: route,
    matches,
    top8Qualifiers,
    champion: decidingFinal.winner,
    predictedPlacements: [...placements.values()]
      .sort((a, b) => a.placement - b.placement || a.player.seed - b.player.seed),
  };
}

export function projectRiptideTop16Top8({ players, predict } = {}) {
  return projectSeededBracket({ players, predict, routing: RIPTIDE_TOP16_TOP8_ROUTING });
}
