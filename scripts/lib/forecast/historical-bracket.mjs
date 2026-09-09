import { createHash } from "node:crypto";

const compare = (a, b) => String(a).localeCompare(String(b), "en");
const canonicalId = (value) => typeof value === "string" || typeof value === "number" ? String(value) : null;
const eventId = (value) => {
  const id = canonicalId(value);
  return id == null ? null : id.startsWith("startgg:event:") ? id : `startgg:event:${id}`;
};
const setId = (value) => {
  const id = canonicalId(value);
  return id == null ? null : id.startsWith("startgg:set:") ? id : `startgg:set:${id}`;
};
const seedId = (value) => {
  const id = canonicalId(value);
  return id == null ? null : id.startsWith("startgg:seed:") ? id : `startgg:seed:${id}`;
};
const isDoubleElimination = (value) => String(value).toUpperCase() === "DOUBLE_ELIMINATION";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Historical bracket needs dataset ${label}`);
  return value;
}

function exactlyOne(rows, label) {
  if (rows.length !== 1) throw new Error(`Historical bracket needs exactly one ${label}; found ${rows.length}`);
  return rows[0];
}

function sourceKey(source) {
  if (source.kind === "seed") return `seed:${source.seedId}`;
  if (source.kind === "match") return `match:${source.matchId}:${source.result}`;
  return "bye";
}

function topologicalMatches(nodes, terminalIds) {
  const required = new Set();
  const visitRequired = (id) => {
    if (required.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error(`Bracket route references missing match ${id}`);
    required.add(id);
    for (const source of node.sources) if (source.kind === "match") visitRequired(source.matchId);
  };
  for (const id of terminalIds) visitRequired(id);

  const ordered = [];
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) throw new Error(`Bracket route contains a prerequisite cycle at ${id}`);
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const node = nodes.get(id);
    for (const source of node.sources) {
      if (source.kind === "match") {
        if (!required.has(source.matchId)) throw new Error(`Bracket route has an unresolved feeder ${source.matchId}`);
        visit(source.matchId);
      }
    }
    state.set(id, 2);
    ordered.push(node);
  };
  for (const id of [...required].sort(compare)) visit(id);
  return ordered;
}

function structuralView(graph) {
  return {
    schemaVersion: graph.schemaVersion,
    kind: graph.kind,
    eventId: graph.eventId,
    fieldSize: graph.fieldSize,
    initialPhaseId: graph.initialPhaseId,
    phaseGroupId: graph.phaseGroupId,
    field: graph.field.map(({ seed, seedId, entrantId, playerId }) => ({
      seed, seedId, entrantId, playerId,
    })),
    matches: graph.matches,
    grandFinalId: graph.grandFinalId,
    reset: graph.reset,
  };
}

/**
 * Compile one manually reviewed, single-group double-elimination event. Target
 * outcomes are deliberately absent from the returned graph: set winners,
 * scores, standings, realized slot entrants and downstream slot seed objects
 * are never read while constructing a feeder.
 */
export function compileReviewedDoubleElimination(dataset, review) {
  const events = requireArray(dataset?.events, "events");
  const entrants = requireArray(dataset?.entrants, "entrants");
  const seeds = requireArray(dataset?.seeds, "seeds");
  const sets = requireArray(dataset?.sets, "sets");
  if (!review || typeof review.eventId !== "string" || !review.eventId
      || !Number.isSafeInteger(review.fieldSize) || review.fieldSize < 2) {
    throw new Error("Historical bracket needs a reviewed eventId and fieldSize");
  }
  const reviewedEventId = eventId(review.eventId);
  const initialPhaseId = canonicalId(review.initialPhaseId);
  const phaseGroupId = canonicalId(review.phaseGroupId);
  const grandFinalId = setId(review.grandFinalSetId);
  if (review.resetRule !== "if-lower-side-wins-grand-final") {
    throw new Error(`Unsupported reset rule: ${review.resetRule}`);
  }
  if (!reviewedEventId || !initialPhaseId || !phaseGroupId || !grandFinalId) {
    throw new Error("Historical bracket review is missing its phase, group or final IDs");
  }
  const event = exactlyOne(events.filter((row) => row?.id === reviewedEventId), `event ${reviewedEventId}`);
  const phase = exactlyOne((event.phases ?? []).filter((row) => canonicalId(row?.id) === initialPhaseId),
    `reviewed phase ${initialPhaseId}`);
  const group = exactlyOne((event.phaseGroups ?? []).filter((row) => canonicalId(row?.id) === phaseGroupId),
    `reviewed phase group ${phaseGroupId}`);
  if (canonicalId(group.phase?.id) !== initialPhaseId || !isDoubleElimination(phase.bracketType)
      || !isDoubleElimination(group.bracketType)
      || (group.phase?.bracketType != null && !isDoubleElimination(group.phase.bracketType))) {
    throw new Error("Reviewed route is not double elimination in one matching phase and group");
  }
  const otherGroups = (event.phaseGroups ?? []).filter((row) => canonicalId(row?.phase?.id) === initialPhaseId
    && canonicalId(row?.id) !== phaseGroupId);
  if (otherGroups.length) throw new Error("Reviewed route phase contains multiple phase groups");

  const entrantsById = new Map();
  for (const entrant of entrants.filter((row) => row?.eventId === reviewedEventId)) {
    if (entrantsById.has(entrant.id)) throw new Error(`Duplicate event entrant ${entrant.id}`);
    entrantsById.set(entrant.id, entrant);
  }
  if (entrantsById.size !== review.fieldSize) {
    throw new Error(`Reviewed route expected ${review.fieldSize} entrants; found ${entrantsById.size}`);
  }
  const seedRows = seeds.filter((row) => row?.eventId === reviewedEventId
    && canonicalId(row.phase?.id) === initialPhaseId && canonicalId(row.phaseGroupId) === phaseGroupId);
  if (seedRows.length !== review.fieldSize) {
    throw new Error(`Reviewed route expected ${review.fieldSize} initial seeds; found ${seedRows.length}`);
  }
  const sourceSeeds = new Map();
  const seedNumbers = new Set();
  const seededEntrants = new Set();
  const seededPlayers = new Set();
  const field = [];
  for (const row of seedRows) {
    const id = seedId(row.id ?? row.source?.id);
    const sourceId = seedId(row.source?.id ?? row.id);
    if (!id || !sourceId || sourceSeeds.has(sourceId) || sourceSeeds.has(id)) {
      throw new Error("Reviewed route has a missing or duplicate initial seed ID");
    }
    if (!Number.isSafeInteger(row.seedNum) || row.seedNum < 1 || row.seedNum > review.fieldSize
        || seedNumbers.has(row.seedNum) || seededEntrants.has(row.entrantId)
        || row.isBye === true || row.progressionSeedId != null || row.exclusionReasons?.length) {
      throw new Error("Reviewed route has invalid, duplicate or progressed initial seeds");
    }
    const entrant = entrantsById.get(row.entrantId);
    if (!entrant || entrant.identityConflict === true || typeof entrant.playerId !== "string" || !entrant.playerId
        || (Array.isArray(entrant.playerIds) && (entrant.playerIds.length !== 1 || entrant.playerIds[0] !== entrant.playerId))) {
      throw new Error(`Reviewed route has unresolved entrant identity ${row.entrantId}`);
    }
    if (seededPlayers.has(entrant.playerId)) {
      throw new Error(`Reviewed route has the same player on multiple entrants: ${entrant.playerId}`);
    }
    seedNumbers.add(row.seedNum);
    seededEntrants.add(row.entrantId);
    seededPlayers.add(entrant.playerId);
    const item = { seed: row.seedNum, seedId: id, entrantId: row.entrantId, playerId: entrant.playerId };
    sourceSeeds.set(sourceId, item);
    if (sourceId !== id) sourceSeeds.set(id, item);
    field.push(item);
  }
  field.sort((a, b) => a.seed - b.seed || compare(a.seedId, b.seedId));
  for (let value = 1; value <= review.fieldSize; value++) {
    if (!seedNumbers.has(value)) throw new Error(`Reviewed route is missing initial seed ${value}`);
  }

  const eventSets = sets.filter((row) => row?.eventId === reviewedEventId);
  const finalRow = eventSets.find((candidate) => setId(candidate.id ?? candidate.source?.id) === grandFinalId);
  if (finalRow && canonicalId(finalRow.bracket?.phaseGroup?.id) !== phaseGroupId) {
    throw new Error("Reviewed grand final is in the wrong group");
  }
  const groupSets = eventSets.filter((row) => canonicalId(row.bracket?.phaseGroup?.id) === phaseGroupId);
  const sourceSets = new Map();
  const rowsById = new Map();
  for (const row of groupSets) {
    const id = setId(row.id ?? row.source?.id);
    const sourceId = setId(row.source?.id ?? row.id);
    if (!id || !sourceId || sourceSets.has(sourceId) || sourceSets.has(id)) {
      throw new Error("Reviewed route has a missing or duplicate set ID");
    }
    sourceSets.set(sourceId, id);
    if (sourceId !== id) sourceSets.set(id, id);
    rowsById.set(id, row);
  }
  const nodes = new Map();
  const parsing = new Set();
  const parseNode = (id) => {
    if (parsing.has(id)) throw new Error(`Bracket route contains a prerequisite cycle at ${id}`);
    if (nodes.has(id)) return nodes.get(id);
    const row = rowsById.get(id);
    if (!row) throw new Error(`Bracket route references missing match ${id}`);
    parsing.add(id);
    if (!Number.isSafeInteger(row.bracket?.round) || !Array.isArray(row.bracket?.slots)
        || row.bracket.slots.length !== 2 || !isDoubleElimination(row.bracket.phaseGroup?.bracketType)) {
      throw new Error(`Reviewed match ${id} has invalid double-elimination structure`);
    }
    const orderedSlots = row.bracket.slots.map((slot, arrayIndex) => ({
      ...slot,
      slotIndex: Number.isSafeInteger(slot?.slotIndex) ? slot.slotIndex : arrayIndex,
    })).sort((a, b) => a.slotIndex - b.slotIndex);
    if (orderedSlots.some((slot, index) => slot?.slotIndex !== index)) {
      throw new Error(`Reviewed match ${id} needs unique slot indices 0 and 1`);
    }
    const sources = orderedSlots.map((slot) => {
      if (slot.prereqType === "bye") return { kind: "bye" };
      if (slot.prereqType === "seed") {
        const source = seedId(slot.prereqId);
        const initial = sourceSeeds.get(source);
        if (!initial) throw new Error(`Reviewed match ${id} references unavailable initial seed ${source}`);
        return { kind: "seed", seedId: initial.seedId };
      }
      if (slot.prereqType === "set") {
        const source = sourceSets.get(setId(slot.prereqId));
        if (!source) throw new Error(`Reviewed match ${id} has a dangling set prerequisite ${slot.prereqId}`);
        if (slot.prereqPlacement !== 1 && slot.prereqPlacement !== 2) {
          throw new Error(`Reviewed match ${id} has an invalid prerequisite placement`);
        }
        return { kind: "match", matchId: source, result: slot.prereqPlacement === 1 ? "winner" : "loser" };
      }
      throw new Error(`Reviewed match ${id} has unsupported prerequisite type ${slot.prereqType}`);
    });
    const keys = sources.filter((source) => source.kind !== "bye").map(sourceKey);
    if (new Set(keys).size !== keys.length) throw new Error(`Reviewed match ${id} contains duplicate entrant sources`);
    nodes.set(id, {
      id,
      round: row.bracket.round,
      fullRoundText: typeof row.bracket.fullRoundText === "string" ? row.bracket.fullRoundText : "",
      loserPlacement: row.bracket.round < 0 && Number.isSafeInteger(row.bracket.lPlacement)
        ? row.bracket.lPlacement : null,
      winnerPlacement: Number.isSafeInteger(row.bracket.wPlacement) ? row.bracket.wPlacement : null,
      sourceLoserPlacement: Number.isSafeInteger(row.bracket.lPlacement) ? row.bracket.lPlacement : null,
      sources,
    });
    for (const source of sources) if (source.kind === "match") parseNode(source.matchId);
    parsing.delete(id);
    return nodes.get(id);
  };
  const grandFinal = parseNode(grandFinalId);
  if (!grandFinal || !/^Grand Final$/i.test(grandFinal.fullRoundText)
      || grandFinal.winnerPlacement !== 1 || grandFinal.sourceLoserPlacement !== 2) {
    throw new Error("Reviewed route needs a valid championship structure");
  }
  const ordered = topologicalMatches(nodes, [grandFinalId]);
  const matchIndex = new Map(ordered.map((row) => [row.id, row]));
  const lowerSides = grandFinal.sources.map((source, index) => {
    if (source.kind !== "match" || source.result !== "winner") return null;
    return matchIndex.get(source.matchId)?.round < 0 ? index : null;
  }).filter((value) => value != null);
  if (lowerSides.length !== 1 || grandFinal.sources.some((source) => source.kind !== "match" || source.result !== "winner")) {
    throw new Error("Reviewed grand final needs one winners-side and one losers-side winner feeder");
  }
  const outgoing = new Map();
  for (const node of ordered) {
    for (const source of node.sources) {
      if (source.kind === "bye") continue;
      const key = sourceKey(source);
      if (outgoing.has(key)) throw new Error(`Bracket feeder is consumed more than once: ${key}`);
      outgoing.set(key, node.id);
    }
  }
  const routeMatches = ordered.map((row) => ({
    id: row.id,
    round: row.round,
    fullRoundText: row.fullRoundText,
    loserPlacement: row.loserPlacement,
    sources: row.sources,
  }));
  const usedSeeds = new Set(routeMatches.flatMap((row) => row.sources)
    .filter((source) => source.kind === "seed").map((source) => source.seedId));
  if (usedSeeds.size !== field.length || field.some((row) => !usedSeeds.has(row.seedId))) {
    throw new Error("Reviewed route does not connect every initial seed to the championship graph");
  }
  const graph = {
    schemaVersion: 1,
    kind: "reviewed-double-elimination",
    eventId: reviewedEventId,
    fieldSize: review.fieldSize,
    initialPhaseId,
    phaseGroupId,
    field,
    matches: routeMatches,
    grandFinalId,
    reset: { rule: "if-lower-side-wins-grand-final", lowerSide: lowerSides[0] },
  };
  graph.structuralSha256 = digest(structuralView(graph));
  return graph;
}

function counterRandom(seed, simulation, ordinal) {
  let value = (seed ^ Math.imul(simulation + 1, 0x9e3779b1)
    ^ Math.imul(ordinal + 1, 0x85ebca6b)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function pairKey(a, b) {
  return a.seed < b.seed ? `${a.seed}:${b.seed}` : `${b.seed}:${a.seed}`;
}

function matchProbability(matrix, a, b) {
  const row = matrix.get(pairKey(a, b));
  if (!row) throw new Error(`Missing precomputed matchup for seeds ${a.seed} and ${b.seed}`);
  return a.seed < b.seed ? row.p : 1 - row.p;
}

function validProbability(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} returned an invalid pairwise probability; expected a finite value in [0, 1]`);
  }
  return value;
}

function resolvedRandomSeed(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value >>> 0;
  if (typeof value === "string" && value.length) {
    return Number.parseInt(createHash("sha256").update(`historical-bracket-rng-v1:${value}`).digest("hex").slice(0, 8), 16);
  }
  throw new RangeError("randomSeed must be an unsigned 32-bit integer or non-empty string");
}

function eventRandomSeed(baseSeed, id) {
  return Number.parseInt(createHash("sha256")
    .update(`historical-bracket-event-rng-v1:${baseSeed}:${id}`)
    .digest("hex").slice(0, 8), 16);
}

/** Simulate a compiled graph with fixed counter-based common random numbers. */
export function simulateDoubleElimination({ graph, models, simulations = 20_000, randomSeed = 0x5c0ffeed } = {}) {
  if (graph?.kind !== "reviewed-double-elimination" || !Array.isArray(graph.field)
      || !Array.isArray(graph.matches)) {
    throw new Error("Historical simulation needs a compiled graph");
  }
  if (!Array.isArray(models) || !models.length) throw new Error("At least one fitted model is required");
  if (!Number.isSafeInteger(simulations) || simulations < 1 || simulations > 1_000_000) {
    throw new RangeError("simulations must be an integer from 1 through 1,000,000");
  }
  if (digest(structuralView(graph)) !== graph.structuralSha256) {
    throw new Error("Compiled bracket structural hash does not match its contents");
  }
  const baseSeedValue = resolvedRandomSeed(randomSeed);
  const seedValue = eventRandomSeed(baseSeedValue, graph.eventId);
  const field = [...graph.field].sort((a, b) => a.seed - b.seed);
  const seedMap = new Map(field.map((row) => [row.seedId, row]));
  if (field.length !== graph.fieldSize || seedMap.size !== field.length) throw new Error("Compiled graph field is invalid");
  const modelResults = [];
  const orderedModels = [...models].sort((a, b) => compare(a?.id ?? "", b?.id ?? ""));
  if (new Set(orderedModels.map((model) => model?.id)).size !== orderedModels.length) {
    throw new Error("Historical simulation model IDs must be unique");
  }
  for (const model of orderedModels) {
    if (!model || typeof model.id !== "string" || typeof model.name !== "string" || typeof model.predict !== "function") {
      throw new Error("Every historical simulation model needs id, name and predict");
    }
    const matrix = new Map();
    let covered = 0;
    for (let left = 0; left < field.length; left++) {
      for (let right = left + 1; right < field.length; right++) {
        const a = field[left];
        const b = field[right];
        const prediction = model.predict({
          id: `historical-simulation:${graph.eventId}:${a.seed}:${b.seed}`,
          eventId: graph.eventId,
          entrantIds: [a.entrantId, b.entrantId],
          playerIds: [a.playerId, b.playerId],
        });
        const p = validProbability(prediction?.p, `Prediction from ${model.id}`);
        if (prediction.covered === true) covered++;
        matrix.set(pairKey(a, b), { p });
      }
    }
    const titleCounts = new Uint32Array(field.length);
    const top8Counts = new Uint32Array(field.length);
    const indexBySeed = new Map(field.map((row, index) => [row.seed, index]));
    for (let simulation = 0; simulation < simulations; simulation++) {
      const results = new Map();
      const placements = new Map();
      const place = (player, placement, matchId) => {
        if (!player || !Number.isSafeInteger(placement) || placement < 1 || placement > graph.fieldSize) {
          throw new Error(`Simulation produced invalid placement at ${matchId}`);
        }
        if (placements.has(player.seed)) throw new Error(`Simulation eliminated seed ${player.seed} twice`);
        placements.set(player.seed, placement);
      };
      const resolve = (source) => {
        if (source.kind === "bye") return null;
        if (source.kind === "seed") return seedMap.get(source.seedId) ?? null;
        const result = results.get(source.matchId);
        if (!result) throw new Error(`Simulation reached unresolved match ${source.matchId}`);
        return result[source.result];
      };
      for (let ordinal = 0; ordinal < graph.matches.length; ordinal++) {
        const match = graph.matches[ordinal];
        const entrants = match.sources.map(resolve);
        let winner;
        let loser = null;
        if (entrants[0] == null && entrants[1] == null) {
          throw new Error(`Championship graph contains an empty reachable match ${match.id}`);
        } else if (entrants[0] == null || entrants[1] == null) {
          winner = entrants[0] ?? entrants[1];
        } else {
          if (entrants[0].seed === entrants[1].seed) throw new Error(`Match ${match.id} has the same entrant twice`);
          const p = matchProbability(matrix, entrants[0], entrants[1]);
          const firstWins = counterRandom(seedValue, simulation, ordinal) < p;
          winner = entrants[firstWins ? 0 : 1];
          loser = entrants[firstWins ? 1 : 0];
          if (match.round < 0) place(loser, match.loserPlacement, match.id);
        }
        results.set(match.id, { winner, loser, entrants });
      }
      const final = results.get(graph.grandFinalId);
      if (!final || final.entrants.some((entrant) => !entrant) || !final.loser) {
        throw new Error("Simulation did not produce a playable grand final");
      }
      const lowerPlayer = final.entrants[graph.reset.lowerSide];
      let deciding = final;
      if (final.winner.seed === lowerPlayer.seed) {
        const p = matchProbability(matrix, final.entrants[0], final.entrants[1]);
        const firstWins = counterRandom(seedValue, simulation, graph.matches.length) < p;
        deciding = {
          entrants: final.entrants,
          winner: final.entrants[firstWins ? 0 : 1],
          loser: final.entrants[firstWins ? 1 : 0],
        };
      }
      place(deciding.loser, 2, `${graph.grandFinalId}:deciding`);
      place(deciding.winner, 1, `${graph.grandFinalId}:deciding`);
      if (placements.size !== graph.fieldSize) {
        throw new Error(`Simulation placed ${placements.size} of ${graph.fieldSize} entrants`);
      }
      const topSeeds = [...placements].filter(([, placement]) => placement <= Math.min(8, graph.fieldSize));
      if (topSeeds.length !== Math.min(8, graph.fieldSize)) throw new Error("Simulation did not produce the required top-eight field");
      titleCounts[indexBySeed.get(deciding.winner.seed)]++;
      for (const [seed] of topSeeds) top8Counts[indexBySeed.get(seed)]++;
    }
    const entrantForecasts = field.map((row, index) => {
      const titleProbability = titleCounts[index] / simulations;
      const top8Probability = top8Counts[index] / simulations;
      return {
        ...row,
        titleWins: titleCounts[index],
        top8Finishes: top8Counts[index],
        titleProbability,
        top8Probability,
        titleMonteCarloSe: Math.sqrt(titleProbability * (1 - titleProbability) / simulations),
        top8MonteCarloSe: Math.sqrt(top8Probability * (1 - top8Probability) / simulations),
      };
    });
    const titleProbabilitySum = entrantForecasts.reduce((sum, row) => sum + row.titleProbability, 0);
    const top8ProbabilitySum = entrantForecasts.reduce((sum, row) => sum + row.top8Probability, 0);
    if (Math.abs(titleProbabilitySum - 1) > 1e-12
        || Math.abs(top8ProbabilitySum - Math.min(8, graph.fieldSize)) > 1e-12) {
      throw new Error("Simulation probability conservation failed");
    }
    modelResults.push({
      id: model.id,
      name: model.name,
      methodology: model.methodology,
      pairwiseCoverage: { pairs: matrix.size, covered },
      entrants: entrantForecasts,
      conservation: { titleProbabilitySum, top8ProbabilitySum },
    });
  }
  return {
    schemaVersion: 1,
    kind: "historical-double-elimination-simulation-v1",
    eventId: graph.eventId,
    simulations,
    randomPolicy: {
      algorithm: "counter-hash32-v1",
      seed: randomSeed,
      baseResolvedSeed: baseSeedValue,
      resolvedSeed: seedValue,
      eventScoped: true,
      outcomeIndependent: true,
      commonRandomNumbersAcrossModels: true,
      branchIndependentOrdinal: true,
    },
    models: modelResults,
  };
}
