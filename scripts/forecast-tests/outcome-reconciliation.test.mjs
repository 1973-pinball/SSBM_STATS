import test from "node:test";
import assert from "node:assert/strict";
import { auditHistoricalOutcomes } from "../lib/forecast/outcome-reconciliation.mjs";

const registryEvent = (id, name, year, winner, runnerUp) => ({
  id,
  name,
  year,
  historicalOutcome: { winner, runnerUp },
});

const event = (number, major) => ({
  id: `startgg:event:${number}`,
  name: `${major.name} singles`,
  major: { id: major.id, name: major.name, year: major.year },
  source: { system: "start.gg", id: String(number), provenanceIds: [`startgg:observation:${number}`] },
  phases: [],
  phaseGroups: [],
});

const entrant = (eventId, number, playerId, identityConflict = false) => ({
  id: `startgg:entrant:${number}`,
  eventId,
  playerId,
  identityConflict,
});

const standing = (eventId, number, entrantId, placement, exclusionReasons = []) => ({
  id: `startgg:standing:${number}`,
  eventId,
  entrantId,
  placement,
  exclusionReasons,
});

const alias = (number, playerId, entrantId, eventId, tag) => ({
  id: `startgg:alias:${number}`,
  playerId,
  tag,
  // Deliberately not trusted by the audit; canonical normalization is shared
  // with dataset construction and derived from the literal tag.
  comparisonTag: "do-not-trust-test-fixture",
  entrantIds: [entrantId],
  eventIds: [eventId],
  source: { system: "start.gg", provenanceIds: [`startgg:observation:${eventId.split(":").at(-1)}`] },
});

function addChampionshipPhase(sourceEvent, { phaseName = "Final Bracket", groupId = 900 } = {}) {
  const phase = {
    id: groupId - 1,
    name: phaseName,
    bracketType: "DOUBLE_ELIMINATION",
    state: "COMPLETED",
  };
  sourceEvent.phases = [phase];
  sourceEvent.phaseGroups = [{
    id: groupId,
    bracketType: "DOUBLE_ELIMINATION",
    state: 3,
    phase: { ...phase },
  }];
  return { phase, groupId };
}

function bracketSet({ id, sourceEvent, groupId, entrantIds, winnerEntrantId, winnerPlayerId,
  fullRoundText, wPlacement = null, lPlacement = null, prereqIds = [], progression = false }) {
  return {
    id: `startgg:set:${id}`,
    eventId: sourceEvent.id,
    eligible: true,
    entrantIds,
    winnerEntrantId,
    winnerPlayerId,
    scores: [3, 0],
    bracket: {
      fullRoundText,
      wPlacement,
      lPlacement,
      winnerProgressionSeed: progression ? { id: 1 } : null,
      loserProgressionSeed: null,
      phaseGroup: { id: groupId, bracketType: "DOUBLE_ELIMINATION", state: 3 },
      slots: prereqIds.map((prereqId) => ({ prereqType: "set", prereqId: String(prereqId) })),
    },
    source: {
      system: "start.gg",
      id: String(id),
      provenanceIds: [...sourceEvent.source.provenanceIds],
    },
  };
}

function reverseDataset(dataset) {
  return {
    ...dataset,
    events: [...dataset.events].reverse(),
    entrants: [...dataset.entrants].reverse(),
    standings: [...dataset.standings].reverse(),
    aliases: [...dataset.aliases].reverse().map((row) => ({
      ...row,
      entrantIds: [...row.entrantIds].reverse(),
      eventIds: [...row.eventIds].reverse(),
    })),
    ...(Array.isArray(dataset.sets) ? { sets: [...dataset.sets].reverse() } : {}),
  };
}

test("reconciles exact and conservative normalized aliases while surfacing ambiguity and mismatches", () => {
  const majors = [
    registryEvent("major:exact", "Exact", 2018, "Alpha", "Beta"),
    registryEvent("major:normalized", "Normalized", 2019, " ＭｏＫｙ ", "HungryBox"),
    registryEvent("major:ambiguous", "Ambiguous", 2020, "Dup", "Solo"),
    registryEvent("major:mismatch", "Mismatch", 2021, "Other", "Loser"),
  ];
  const events = majors.map((major, index) => event(index + 1, major));
  const entrants = events.flatMap((row, index) => [
    entrant(row.id, index * 2 + 1, `player:${index * 2 + 1}`),
    entrant(row.id, index * 2 + 2, `player:${index * 2 + 2}`),
  ]);
  const standings = events.flatMap((row, index) => [
    standing(row.id, index * 2 + 1, entrants[index * 2].id, 1),
    standing(row.id, index * 2 + 2, entrants[index * 2 + 1].id, 2),
  ]);
  const aliases = [
    alias(1, "player:1", entrants[0].id, events[0].id, "Alpha"),
    alias(2, "player:2", entrants[1].id, events[0].id, "Beta"),
    alias(3, "player:3", entrants[2].id, events[1].id, "moky"),
    alias(4, "player:4", entrants[3].id, events[1].id, "hungrybox"),
    alias(5, "player:5", entrants[4].id, events[2].id, "dup"),
    alias(6, "player:6", entrants[5].id, events[2].id, "DUP"),
    alias(7, "player:6", entrants[5].id, events[2].id, "Solo"),
    alias(8, "player:7", entrants[6].id, events[3].id, "Winner"),
    alias(9, "player:8", entrants[7].id, events[3].id, "Other"),
    alias(10, "player:8", entrants[7].id, events[3].id, "Loser"),
    // The same alias in another event never makes an event-local exact match ambiguous.
    alias(11, "player:3", entrants[2].id, events[1].id, "Alpha"),
  ];
  const dataset = { schemaVersion: 1, events, entrants, standings, aliases };
  const registry = { schemaVersion: 1, snapshotAsOf: "2026-01-01", events: majors };
  const frozen = structuredClone(dataset);
  const report = auditHistoricalOutcomes(registry, dataset, { datasetSha256: "abc" });

  assert.deepEqual(report.counts, {
    datasetEvents: 4,
    matchedEvents: 2,
    reviewEvents: 2,
    roleComparisons: 8,
    exactAliasMatches: 4,
    normalizedAliasMatches: 2,
    ambiguousAliases: 1,
    mismatches: 1,
    missingTopTwoData: 0,
    missingHistoricalOutcomes: 0,
    missingRegistryEvents: 0,
  });
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.allMatched, false);
  assert.equal(report.events.find((row) => row.name === "Exact").results.winner.status, "exact_alias_match");
  assert.equal(report.events.find((row) => row.name === "Normalized").results.winner.status, "normalized_alias_match");
  assert.deepEqual(report.events.find((row) => row.name === "Ambiguous").results.winner.aliasCandidates
    .map((row) => row.playerId), ["player:5", "player:6"]);
  const mismatch = report.events.find((row) => row.name === "Mismatch").results.winner;
  assert.equal(mismatch.status, "alias_mismatch");
  assert.deepEqual(mismatch.aliasCandidates, [{
    playerId: "player:8",
    entrantIds: [entrants[7].id],
    resolvedEntrantIds: [entrants[7].id],
    placements: [2],
    tags: ["Other"],
  }]);
  assert.deepEqual(dataset, frozen, "the advisory audit must not mutate training data");
  assert.deepEqual(report, auditHistoricalOutcomes(
    { ...registry, events: [...registry.events].reverse() },
    reverseDataset(dataset),
    { datasetSha256: "abc" },
  ));
});

test("reports unusable winner and runner-up observations without inventing identities", () => {
  const majors = [
    registryEvent("major:missing", "Missing", 2018, "A", "B"),
    registryEvent("major:multiple", "Multiple", 2019, "C", "D"),
    registryEvent("major:invalid", "Invalid", 2020, "E", "F"),
    registryEvent("major:unresolved", "Unresolved", 2021, "G", "H"),
    registryEvent("major:no-label", "No label", 2022, "I", null),
  ];
  const events = majors.map((major, index) => event(index + 20, major));
  const entrants = events.flatMap((row, index) => [
    entrant(row.id, index * 2 + 20, index === 3 ? null : `player:${index * 2 + 20}`, index === 3),
    entrant(row.id, index * 2 + 21, `player:${index * 2 + 21}`),
  ]);
  const standings = [
    standing(events[0].id, 20, entrants[0].id, 1),
    // No second-place row for Missing.
    standing(events[1].id, 22, entrants[2].id, 1),
    standing(events[1].id, 23, entrants[3].id, 1),
    standing(events[1].id, 24, entrants[3].id, 2),
    standing(events[2].id, 25, entrants[4].id, 1, ["source_conflict"]),
    standing(events[2].id, 26, entrants[5].id, 2),
    standing(events[3].id, 27, entrants[6].id, 1),
    standing(events[3].id, 28, entrants[7].id, 2),
    standing(events[4].id, 29, entrants[8].id, 1),
    standing(events[4].id, 30, entrants[9].id, 2),
  ];
  const tags = [["A", "B"], ["C", "D"], ["E", "F"], ["G", "H"], ["I", "J"]];
  const aliases = entrants.flatMap((row, index) => row.playerId == null ? [] : [
    alias(index + 20, row.playerId, row.id, row.eventId, tags[Math.floor(index / 2)][index % 2]),
  ]);
  const unknown = {
    id: "startgg:event:unknown",
    name: "Unknown",
    major: { id: "major:unknown", name: "Unknown", year: 2023 },
  };
  const unknownEntrants = [
    entrant(unknown.id, 100, "player:100"),
    entrant(unknown.id, 101, "player:101"),
  ];
  entrants.push(...unknownEntrants);
  standings.push(
    standing(unknown.id, 100, unknownEntrants[0].id, 1),
    standing(unknown.id, 101, unknownEntrants[1].id, 2),
  );
  aliases.push(
    alias(100, "player:100", unknownEntrants[0].id, unknown.id, "Unknown 1"),
    alias(101, "player:101", unknownEntrants[1].id, unknown.id, "Unknown 2"),
  );
  const report = auditHistoricalOutcomes(
    { schemaVersion: 1, events: majors },
    { schemaVersion: 1, events: [...events, unknown], entrants, standings, aliases },
  );

  const result = (name, role) => report.events.find((row) => row.name === name).results[role].status;
  assert.equal(result("Missing", "runnerUp"), "missing_standing");
  assert.equal(result("Multiple", "winner"), "multiple_standings");
  assert.equal(result("Invalid", "winner"), "invalid_standing");
  assert.equal(result("Unresolved", "winner"), "unresolved_entrant_identity");
  assert.equal(result("No label", "runnerUp"), "missing_historical_outcome");
  assert.equal(report.events.find((row) => row.name === "Unknown").reviewSignals.includes("registry_event_missing"), true);
  assert.deepEqual(report.counts, {
    datasetEvents: 6,
    matchedEvents: 0,
    reviewEvents: 6,
    roleComparisons: 12,
    exactAliasMatches: 5,
    normalizedAliasMatches: 0,
    ambiguousAliases: 0,
    mismatches: 0,
    missingTopTwoData: 4,
    missingHistoricalOutcomes: 3,
    missingRegistryEvents: 1,
  });
});

test("an unresolved event-local alias remains ambiguity evidence instead of being guessed away", () => {
  const major = registryEvent("major:collision", "Collision", 2024, "ＤＵＰ", "Runner");
  const sourceEvent = event(200, major);
  const entrants = [
    entrant(sourceEvent.id, 200, "player:winner"),
    entrant(sourceEvent.id, 201, "player:runner"),
    entrant(sourceEvent.id, 202, null, true),
  ];
  const dataset = {
    schemaVersion: 1,
    events: [sourceEvent],
    entrants,
    standings: [
      standing(sourceEvent.id, 200, entrants[0].id, 1),
      standing(sourceEvent.id, 201, entrants[1].id, 2),
      standing(sourceEvent.id, 202, entrants[2].id, 3),
    ],
    aliases: [
      alias(200, "player:winner", entrants[0].id, sourceEvent.id, "dup"),
      alias(201, "player:runner", entrants[1].id, sourceEvent.id, "Runner"),
      alias(202, "player:unresolved-observation", entrants[2].id, sourceEvent.id, "Dup"),
    ],
  };
  const report = auditHistoricalOutcomes({ schemaVersion: 1, events: [major] }, dataset);
  const winner = report.events[0].results.winner;
  assert.equal(winner.status, "ambiguous_alias");
  assert.deepEqual(winner.aliasCandidates.map((candidate) => ({
    playerId: candidate.playerId,
    resolvedEntrantIds: candidate.resolvedEntrantIds,
  })), [
    { playerId: "player:unresolved-observation", resolvedEntrantIds: [] },
    { playerId: "player:winner", resolvedEntrantIds: [entrants[0].id] },
  ]);
  assert.equal(report.counts.ambiguousAliases, 1);
  assert.equal(report.counts.mismatches, 0);
});

test("corroborates malformed top-two standings only through a unique terminal set and authoritative alias history", () => {
  const targetMajor = registryEvent("major:target", "Malformed standings", 2022, "Winner", "Cody Schwab");
  const historyMajor = registryEvent("major:history", "Later alias observation", 2024, "Cody Schwab", "Other");
  const target = event(300, targetMajor);
  const history = event(301, historyMajor);
  const { groupId } = addChampionshipPhase(target);
  const targetEntrants = [
    entrant(target.id, 300, "startgg:player:1000"),
    entrant(target.id, 301, "startgg:player:19554"),
    entrant(target.id, 302, "startgg:player:3000"),
  ];
  const historyEntrants = [
    entrant(history.id, 303, "startgg:player:19554"),
    entrant(history.id, 304, "startgg:player:4000"),
  ];
  const dataset = {
    schemaVersion: 1,
    events: [target, history],
    entrants: [...targetEntrants, ...historyEntrants],
    standings: [
      standing(target.id, 300, targetEntrants[0].id, 1),
      standing(target.id, 301, targetEntrants[2].id, 1),
      standing(history.id, 303, historyEntrants[0].id, 1),
      standing(history.id, 304, historyEntrants[1].id, 2),
    ],
    aliases: [
      alias(300, "startgg:player:1000", targetEntrants[0].id, target.id, "Winner"),
      alias(301, "startgg:player:19554", targetEntrants[1].id, target.id, "iBDW"),
      alias(302, "startgg:player:3000", targetEntrants[2].id, target.id, "Pool winner"),
      alias(303, "startgg:player:19554", historyEntrants[0].id, history.id, "Cody Schwab"),
      alias(304, "startgg:player:4000", historyEntrants[1].id, history.id, "Other"),
    ],
    sets: [
      bracketSet({
        id: 298, sourceEvent: target, groupId, entrantIds: [targetEntrants[0].id, targetEntrants[2].id],
        winnerEntrantId: targetEntrants[0].id, winnerPlayerId: "startgg:player:1000", fullRoundText: "Winners Final",
      }),
      bracketSet({
        id: 299, sourceEvent: target, groupId, entrantIds: [targetEntrants[1].id, targetEntrants[2].id],
        winnerEntrantId: targetEntrants[1].id, winnerPlayerId: "startgg:player:19554", fullRoundText: "Losers Final",
      }),
      bracketSet({
        id: 300, sourceEvent: target, groupId, entrantIds: [targetEntrants[0].id, targetEntrants[1].id],
        winnerEntrantId: targetEntrants[0].id, winnerPlayerId: "startgg:player:1000",
        fullRoundText: "Grand Final", wPlacement: 1, lPlacement: 2, prereqIds: [298, 299],
      }),
    ],
  };
  const report = auditHistoricalOutcomes({ schemaVersion: 1, events: [targetMajor, historyMajor] }, dataset);
  const targetReport = report.events.find((row) => row.name === targetMajor.name);
  assert.equal(targetReport.status, "review", "malformed source warnings remain visible");
  assert.equal(targetReport.reconciliationStatus, "corroborated");
  assert.deepEqual(targetReport.reviewSignals, ["runnerUp:missing_standing", "winner:multiple_standings"]);
  assert.equal(targetReport.results.winner.corroboration.kind, "validated_terminal_championship_placement");
  assert.equal(targetReport.results.winner.corroboration.aliasMatch.kind, "reported_entrant_alias");
  assert.equal(targetReport.results.runnerUp.corroboration.kind, "validated_terminal_championship_placement");
  assert.equal(targetReport.results.runnerUp.corroboration.aliasMatch.kind, "authoritative_player_alias_history");
  assert.deepEqual(targetReport.results.runnerUp.corroboration.aliasMatch.eventIds, [history.id]);
  assert.equal(report.allMatched, false);
  assert.equal(report.allReconciled, true);
  assert.deepEqual(report.corroborationCounts, {
    reconciledEvents: 2,
    corroboratedReviewEvents: 1,
    unresolvedReviewEvents: 0,
    corroboratedRoles: 2,
    reportedEntrantAliases: 1,
    authoritativePlayerAliasHistories: 1,
    validatedTerminalChampionshipPlacements: 2,
  });

  const ambiguousTerminal = auditHistoricalOutcomes(
    { schemaVersion: 1, events: [targetMajor, historyMajor] },
    { ...dataset, sets: [...dataset.sets, {
      ...dataset.sets.at(-1),
      id: "startgg:set:301",
      source: { ...dataset.sets.at(-1).source, id: "301" },
    }] },
  );
  const ambiguousTarget = ambiguousTerminal.events.find((row) => row.name === targetMajor.name);
  assert.equal(ambiguousTarget.reconciliationStatus, "unresolved");
  assert.equal(ambiguousTarget.results.winner.corroboration, null);
  assert.equal(ambiguousTarget.results.runnerUp.corroboration, null);
});

test("terminal fallback fails closed for a pool final and for a set with onward progression", () => {
  const major = registryEvent("major:terminal-negative", "Terminal negative", 2022, "Winner", "Runner");
  const sourceEvent = event(400, major);
  const { groupId } = addChampionshipPhase(sourceEvent, { phaseName: "Pools" });
  const entrants = [
    entrant(sourceEvent.id, 400, "startgg:player:400"),
    entrant(sourceEvent.id, 401, "startgg:player:401"),
  ];
  const base = {
    schemaVersion: 1,
    events: [sourceEvent],
    entrants,
    standings: [],
    aliases: [
      alias(400, entrants[0].playerId, entrants[0].id, sourceEvent.id, "Winner"),
      alias(401, entrants[1].playerId, entrants[1].id, sourceEvent.id, "Runner"),
    ],
    sets: [
      bracketSet({ id: 398, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
        winnerEntrantId: entrants[0].id, winnerPlayerId: entrants[0].playerId, fullRoundText: "Winners Final" }),
      bracketSet({ id: 399, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
        winnerEntrantId: entrants[1].id, winnerPlayerId: entrants[1].playerId, fullRoundText: "Losers Final" }),
      bracketSet({ id: 400, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
        winnerEntrantId: entrants[0].id, winnerPlayerId: entrants[0].playerId,
        fullRoundText: "Grand Final", wPlacement: 1, lPlacement: 2, prereqIds: [398, 399] }),
    ],
  };
  const registry = { schemaVersion: 1, events: [major] };
  const pool = auditHistoricalOutcomes(registry, base).events[0];
  assert.equal(pool.reconciliationStatus, "unresolved");
  assert.equal(pool.results.winner.corroboration, null);

  sourceEvent.phases[0].name = "Final Bracket";
  sourceEvent.phaseGroups[0].phase.name = "Final Bracket";
  const progressing = structuredClone(base);
  progressing.sets.at(-1).bracket.winnerProgressionSeed = { id: 999 };
  const progression = auditHistoricalOutcomes(registry, progressing).events[0];
  assert.equal(progression.reconciliationStatus, "unresolved");
  assert.equal(progression.results.winner.corroboration, null);
});

test("a completed Grand Final Reset is the sole deciding terminal set", () => {
  const major = registryEvent("major:reset", "Reset", 2022, "Winner", "Runner");
  const sourceEvent = event(500, major);
  const { groupId } = addChampionshipPhase(sourceEvent);
  const entrants = [
    entrant(sourceEvent.id, 500, "startgg:player:500"),
    entrant(sourceEvent.id, 501, "startgg:player:501"),
  ];
  const initial = bracketSet({
    id: 500, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
    winnerEntrantId: entrants[1].id, winnerPlayerId: entrants[1].playerId,
    fullRoundText: "Grand Final", wPlacement: 1, lPlacement: 2, prereqIds: [498, 499],
  });
  const reset = bracketSet({
    id: 501, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
    winnerEntrantId: entrants[0].id, winnerPlayerId: entrants[0].playerId,
    fullRoundText: "Grand Final Reset", wPlacement: 1, lPlacement: 2, prereqIds: [500],
  });
  const sets = [
    bracketSet({ id: 498, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
      winnerEntrantId: entrants[0].id, winnerPlayerId: entrants[0].playerId, fullRoundText: "Winners Final" }),
    bracketSet({ id: 499, sourceEvent, groupId, entrantIds: entrants.map((row) => row.id),
      winnerEntrantId: entrants[1].id, winnerPlayerId: entrants[1].playerId, fullRoundText: "Losers Final" }),
    initial,
    reset,
  ];
  const report = auditHistoricalOutcomes({ schemaVersion: 1, events: [major] }, {
    schemaVersion: 1,
    events: [sourceEvent],
    entrants,
    standings: [],
    aliases: [
      alias(500, entrants[0].playerId, entrants[0].id, sourceEvent.id, "Winner"),
      alias(501, entrants[1].playerId, entrants[1].id, sourceEvent.id, "Runner"),
    ],
    sets,
  });
  assert.equal(report.events[0].reconciliationStatus, "corroborated");
  assert.equal(report.events[0].results.winner.corroboration.setId, reset.id);
  assert.equal(report.events[0].results.runnerUp.corroboration.setId, reset.id);
});

test("a corpus alias collision disables authoritative player alias-history corroboration", () => {
  const targetMajor = registryEvent("major:alias-target", "Alias target", 2021, "Cody Schwab", "Runner");
  const historyMajor = registryEvent("major:alias-history", "Alias history", 2024, "Cody Schwab", "Other");
  const collisionMajor = registryEvent("major:alias-collision", "Alias collision", 2025, "Cody Schwab", "Else");
  const target = event(600, targetMajor);
  const history = event(601, historyMajor);
  const collision = event(602, collisionMajor);
  const entrants = [
    entrant(target.id, 600, "startgg:player:19554"), entrant(target.id, 601, "startgg:player:2"),
    entrant(history.id, 602, "startgg:player:19554"), entrant(history.id, 603, "startgg:player:3"),
    entrant(collision.id, 604, "startgg:player:999"), entrant(collision.id, 605, "startgg:player:4"),
  ];
  const standings = [
    standing(target.id, 600, entrants[0].id, 1), standing(target.id, 601, entrants[1].id, 2),
    standing(history.id, 602, entrants[2].id, 1), standing(history.id, 603, entrants[3].id, 2),
    standing(collision.id, 604, entrants[4].id, 1), standing(collision.id, 605, entrants[5].id, 2),
  ];
  const aliases = [
    alias(600, entrants[0].playerId, entrants[0].id, target.id, "iBDW"),
    alias(601, entrants[1].playerId, entrants[1].id, target.id, "Runner"),
    alias(602, entrants[2].playerId, entrants[2].id, history.id, "Cody Schwab"),
    alias(603, entrants[3].playerId, entrants[3].id, history.id, "Other"),
    alias(604, entrants[4].playerId, entrants[4].id, collision.id, "Cody Schwab"),
    alias(605, entrants[5].playerId, entrants[5].id, collision.id, "Else"),
  ];
  const report = auditHistoricalOutcomes({ schemaVersion: 1, events: [targetMajor, historyMajor, collisionMajor] }, {
    schemaVersion: 1, events: [target, history, collision], entrants, standings, aliases,
  });
  const result = report.events.find((row) => row.name === targetMajor.name).results.winner;
  assert.equal(result.status, "alias_mismatch");
  assert.equal(result.corroboration, null);
  assert.equal(result.reconciled, false);
});

test("fails closed on malformed or duplicate canonical inputs", () => {
  const empty = { schemaVersion: 1, events: [], entrants: [], standings: [], aliases: [] };
  assert.throws(() => auditHistoricalOutcomes({ schemaVersion: 99, events: [] }, empty), /registry schemaVersion/);
  assert.throws(() => auditHistoricalOutcomes({ schemaVersion: 1, events: [] }, { ...empty, aliases: null }), /dataset aliases/);
  assert.throws(() => auditHistoricalOutcomes({ schemaVersion: 1, events: [] }, {
    ...empty,
    entrants: [entrant("event:1", 1, "player:1"), entrant("event:1", 1, "player:1")],
  }), /Duplicate entrant id/);
  const duplicateAlias = alias(1, "player:1", "entrant:1", "event:1", "One");
  assert.throws(() => auditHistoricalOutcomes({ schemaVersion: 1, events: [] }, {
    ...empty,
    aliases: [duplicateAlias, { ...duplicateAlias }],
  }), /Duplicate alias id/);
  assert.throws(() => auditHistoricalOutcomes({ schemaVersion: 1, events: [] }, {
    ...empty,
    aliases: [{ ...duplicateAlias, id: null }],
  }), /alias needs a non-empty id/);
});
