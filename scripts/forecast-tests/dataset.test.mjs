import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvents } from '../lib/forecast/dataset.mjs';

function entrant(id, playerId = id, tag = `Player ${id}`) {
  return { id, name: tag, participants: [{ id: id + 10000, gamerTag: tag, player: playerId == null ? null : { id: playerId } }] };
}
function set(id = 50, left = 10, right = 20) {
  return {
    id, state: 3, winnerId: left, round: 1, fullRoundText: 'Winners Round 1', wPlacement: 1, lPlacement: 2,
    startedAt: 1700000050, completedAt: 1700000150,
    phaseGroup: { id: 7, phase: { id: 6, name: 'Pools' } },
    slots: [
      { id: 501, entrant: { id: left }, standing: { stats: { score: { value: 2 } } }, prereqId: 48, prereqType: 'set', prereqPlacement: 1, prereqCondition: 'winner', slotIndex: 0, seed: { id: 30, seedNum: 1 } },
      { id: 502, entrant: { id: right }, standing: { stats: { score: { value: 1 } } }, prereqId: 49, prereqType: 'set', prereqPlacement: 1 },
    ],
  };
}
function bundle(eventId = 1) {
  return {
    schemaVersion: 1,
    event: {
      id: eventId, name: 'Melee Singles', slug: `tournament/example/event/${eventId}`,
      startAt: 1700000000, isOnline: false, entrantSizeMin: 1,
      videogame: { id: 1, name: 'Super Smash Bros. Melee' },
      phases: [{ id: 6, name: 'Pools', phaseOrder: 1 }],
      tournament: { id: 100, name: 'Example', startAt: 1699990000, endAt: 1700200000, isOnline: false },
    },
    major: { id: 'example-2023', name: 'Example', year: 2023, tier: 'major', format: 'singles', sources: [{ url: 'https://liquipedia.net/smash/Example' }] },
    entrants: [entrant(10), entrant(20)], sets: [set()],
    seeds: [
      { id: 30, entrant: { id: 10 }, seedNum: 1, phase: { id: 6, name: 'Pools' } },
      { id: 31, entrant: { id: 20 }, seedNum: 2, phase: { id: 6, name: 'Pools' } },
    ],
    standings: [{ id: 40, entrant: { id: 10 }, placement: 1 }, { id: 41, entrant: { id: 20 }, placement: 2 }],
    phaseGroups: [{ id: 7, phase: { id: 6, name: 'Pools' }, bracketType: 'DOUBLE_ELIMINATION' }],
    provenance: { source: 'start.gg', fetchedAt: '2026-01-01T00:00:00Z', requests: [{ operation: 'EventSets', cacheKey: 'abc123', page: 1 }], availableOptionalFields: { slotPrerequisites: ['prereqCondition'] } },
  };
}
function deeplyFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deeplyFreeze(child); }
  return value;
}

test('canonical rows retain public identifiers, provenance, bracket dependencies and major citations', () => {
  const input = deeplyFreeze(bundle());
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.schemaVersion, 1);
  assert.deepEqual(normalized.quality.counts, {
    sourceBundles: 1, events: 1, eligibleEvents: 1, players: 2, anonymousPlayers: 0,
    aliases: 2, entrants: 2, seeds: 2, standings: 2, sourceSetRows: 1, sets: 1,
    duplicateSetCopies: 0, eligibleSets: 1, excludedSets: 0,
  });
  const game = normalized.sets[0];
  assert.equal(game.id, 'startgg:set:50');
  assert.equal(game.winnerPlayerId, 'startgg:player:10');
  assert.deepEqual(game.scores, [2, 1]);
  assert.equal(game.bracket.slots[0].prereqId, '48');
  assert.equal(game.bracket.slots[0].prereqPlacement, 1);
  assert.equal(game.bracket.slots[0].prereqCondition, 'winner');
  assert.equal(game.bracket.slots[0].seed.seedNum, 1);
  assert.equal(game.bracket.wPlacement, 1);
  assert.deepEqual(game.bracket.phaseGroup, input.sets[0].phaseGroup);
  assert.deepEqual(normalized.events[0].phaseGroups, input.phaseGroups);
  assert.deepEqual(normalized.events[0].phases, input.event.phases);
  assert.deepEqual(normalized.events[0].major, input.major);
  assert.equal(game.source.id, '50');
  assert.equal(normalized.provenance[0].requests[0].cacheKey, 'abc123');
  assert.deepEqual(normalized.provenance[0].availableOptionalFields, input.provenance.availableOptionalFields);
  const provenanceIds = new Set(normalized.provenance.map((x) => x.id));
  for (const type of ['events', 'players', 'aliases', 'entrants', 'seeds', 'sets', 'standings']) {
    for (const row of normalized[type]) {
      assert.equal(row.source.system, 'start.gg');
      assert.ok(row.source.provenanceIds.length);
      for (const provenanceId of row.source.provenanceIds) assert.ok(provenanceIds.has(provenanceId));
    }
  }
  normalized.provenance[0].requests[0].page = 99;
  normalized.events[0].major.sources[0].url = 'changed';
  assert.equal(input.provenance.requests[0].page, 1);
  assert.equal(input.major.sources[0].url, 'https://liquipedia.net/smash/Example');
});

const setCases = [
  ['bye', (s) => { s.slots[1].entrant = null; }],
  ['bye', (s) => { s.slots.pop(); }],
  ['dq', (s) => { s.slots[1].standing.stats.score.value = -1; }],
  ['dq', (s) => { s.slots[1].entrant.isDisqualified = true; }],
  ['unfinished', (s) => { s.state = 2; }],
  ['missing_set_id', (s) => { delete s.id; }],
  ['missing_entrant', (s) => { s.slots[1].entrant.id = 999; }],
  ['missing_or_invalid_score', (s) => { delete s.slots[1].standing; }],
  ['missing_or_invalid_score', (s) => { s.slots[1].standing.stats.score.value = 0.5; }],
  ['missing_or_invalid_score', (s) => { s.slots[1].standing.stats.score.value = '1'; }],
  ['missing_or_invalid_winner', (s) => { s.winnerId = null; }],
  ['missing_or_invalid_winner', (s) => { s.winnerId = 999; }],
  ['winner_score_mismatch', (s) => { s.winnerId = 20; }],
  ['winner_score_mismatch', (s) => { s.slots[1].standing.stats.score.value = 2; }],
  ['self_match', (s) => { s.slots[1].entrant.id = 10; }],
];

test('multiple registrations for one player stay distinct, are flagged, and do not blanket-exclude valid sets', () => {
  const input = bundle();
  input.entrants.push({ ...structuredClone(input.entrants[0]), id: 30 });
  input.sets.push(set(51, 10, 30));
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.players.length, 2);
  assert.equal(normalized.entrants.length, 3);
  assert.deepEqual(normalized.quality.multipleEntrantsPerPlayerEvent, [{
    eventId: 'startgg:event:1', playerId: 'startgg:player:10',
    entrantIds: ['startgg:entrant:10', 'startgg:entrant:30'], participantIds: ['10010'],
  }]);
  assert.equal(normalized.sets.find(row => row.source.id === '50').eligible, true);
  assert.ok(normalized.sets.find(row => row.source.id === '51').exclusionReasons.includes('self_match'));
  input.entrants.reverse();
  assert.deepEqual(normalizeEvents([input]), normalized);
});

for (const [reason, mutate] of setCases) {
  test(`rejects ${reason}: ${mutate}`, () => {
    const input = bundle(); mutate(input.sets[0]);
    const normalized = normalizeEvents([input]);
    assert.equal(normalized.sets[0].eligible, false);
    assert.ok(normalized.sets[0].exclusionReasons.includes(reason));
    assert.equal(normalized.quality.exclusionReasons[reason], 1);
    assert.equal(normalized.sets[0].bracket.fullRoundText, 'Winners Round 1');
  });
}

const eventCases = [
  ['event_non_melee', (e) => { e.videogame.id = 1386; }],
  ['event_unknown_game', (e) => { delete e.videogame; }],
  ['event_online', (e) => { e.isOnline = true; }],
  ['event_online', (e) => { e.tournament.isOnline = true; }],
  ['event_unknown_online', (e) => { delete e.isOnline; delete e.tournament.isOnline; }],
  ['event_non_singles', (e) => { e.teamRosterSize = { minPlayers: 2, maxPlayers: 2 }; }],
  ['event_non_singles', (e) => { e.entrantSizeMin = 2; }],
  ['event_missing_start', (e) => { delete e.startAt; delete e.tournament.startAt; }],
  ['event_invalid_dates', (e) => { e.endAt = e.startAt - 1; }],
];
for (const [reason, mutate] of eventCases) {
  test(`rejects ${reason}: ${mutate}`, () => {
    const input = bundle(); mutate(input.event);
    const normalized = normalizeEvents([input]);
    assert.equal(normalized.events[0].eligible, false);
    assert.ok(normalized.events[0].exclusionReasons.includes(reason));
    assert.ok(normalized.sets[0].exclusionReasons.includes(reason));
    assert.equal(normalized.quality.counts.eligibleSets, 0);
  });
}

test('format is unknown without entrant evidence and singles can be established by roster or participants', () => {
  const input = bundle(); delete input.event.entrantSizeMin;
  assert.equal(normalizeEvents([input]).events[0].format, 'singles');
  input.entrants = [];
  assert.ok(normalizeEvents([input]).events[0].exclusionReasons.includes('event_unknown_format'));
  input.event.teamRosterSize = { minPlayers: 1, maxPlayers: 1 };
  assert.equal(normalizeEvents([input]).events[0].format, 'singles');
});

test('identical source set IDs deduplicate without changing the outcome', () => {
  const input = bundle(); input.sets.push(structuredClone(input.sets[0]));
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.sets.length, 1);
  assert.equal(normalized.sets[0].eligible, true);
  assert.equal(normalized.quality.counts.duplicateSetCopies, 1);
  assert.deepEqual(normalized.quality.duplicateSets, [{ setId: 'startgg:set:50', sourceRows: 2, removedCopies: 1 }]);
});

test('conflicting source set IDs exclude every outcome variant, retaining audit evidence', () => {
  const first = bundle(); const second = structuredClone(first);
  second.provenance.fetchedAt = '2026-01-02T00:00:00Z';
  second.sets[0].slots[1].standing.stats.score.value = 0;
  const normalized = normalizeEvents([first, second]);
  assert.equal(normalized.sets.length, 1);
  assert.equal(normalized.sets[0].eligible, false);
  assert.ok(normalized.sets[0].exclusionReasons.includes('conflicting_set_id'));
  assert.equal(normalized.sets[0].conflictingObservations.length, 2);
  assert.equal(normalized.sets[0].source.provenanceIds.length, 2);
  assert.deepEqual(normalized, normalizeEvents([second, first]));
});

test('authoritative player IDs survive renames; matching tags never merge different players', () => {
  const first = bundle();
  first.entrants[0] = entrant(10, 123, 'Old Tag');
  first.entrants[1] = entrant(20, 456, 'NEW TAG');
  const second = bundle(2); second.sets[0] = set(60, 110, 120);
  second.entrants = [entrant(110, 123, 'New Tag'), entrant(120, 789, 'Different')];
  second.seeds = []; second.standings = [];
  const normalized = normalizeEvents([first, second]);
  assert.equal(normalized.players.length, 3);
  assert.deepEqual(normalized.quality.renamedPlayers, [{ playerId: 'startgg:player:123', tags: ['New Tag', 'Old Tag'] }]);
  assert.deepEqual(normalized.quality.tagCollisions, [{ comparisonTag: 'new tag', playerIds: ['startgg:player:123', 'startgg:player:456'] }]);
  assert.deepEqual(normalized.players.find((p) => p.id === 'startgg:player:123').entrantIds, ['startgg:entrant:10', 'startgg:entrant:110']);
});

test('missing player IDs remain anonymous and entrant-scoped even when tags match', () => {
  const input = bundle(); input.entrants = [entrant(10, null, 'Same'), entrant(20, null, 'Same')];
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.players.length, 2);
  assert.equal(normalized.players.every((p) => p.anonymous), true);
  assert.notEqual(normalized.entrants[0].playerId, normalized.entrants[1].playerId);
  assert.equal(normalized.sets[0].eligible, true);
  assert.equal(normalized.quality.anonymousPlayers.length, 2);
  assert.equal(normalized.quality.tagCollisions.length, 1);
  input.entrants[0].participants = [];
  assert.equal(normalizeEvents([input]).players.length, 2);
});

test('separate entrant IDs for the same authoritative player are a self-match', () => {
  const input = bundle(); input.entrants[1].participants[0].player.id = 10;
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.players.length, 1);
  assert.ok(normalized.sets[0].exclusionReasons.includes('self_match'));
});

test('conflicting identity for one entrant ID is reported and excluded instead of guessed', () => {
  const input = bundle(); input.entrants.push(entrant(10, 789));
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.quality.entrantConflicts.length, 1);
  assert.equal(normalized.entrants.find((e) => e.id === 'startgg:entrant:10').playerId, null);
  assert.ok(normalized.sets[0].exclusionReasons.includes('entrant_identity_conflict'));
});

test('dates preserve source precision, chronological event order and actual set timestamps only', () => {
  const later = bundle(2); later.event.startAt += 1000000; later.event.tournament.endAt += 1000000;
  later.entrants = []; later.sets = []; later.seeds = []; later.standings = [];
  const earlier = bundle(); delete earlier.event.startAt; delete earlier.sets[0].startedAt;
  const normalized = normalizeEvents([later, earlier]);
  assert.deepEqual(normalized.events.map((e) => e.id), ['startgg:event:1', 'startgg:event:2']);
  assert.equal(normalized.events[0].chronology.startAt, earlier.event.tournament.startAt);
  assert.equal(normalized.events[0].chronology.startAtSource, 'tournament.startAt');
  assert.equal(normalized.sets[0].timestamps.startedAt, null);
  assert.equal(normalized.sets[0].timestamps.completedAt, earlier.sets[0].completedAt);
});

test('phase seeds remain separate from placements and availability is not invented', () => {
  const input = bundle(); input.seeds.push({ id: 32, entrant: { id: 10 }, seedNum: 3, phase: { id: 8, name: 'Top 32' } });
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.seeds.length, 3);
  assert.equal(normalized.seeds[2].seedNum, 3);
  assert.equal(normalized.seeds[2].phase.id, 8);
  assert.equal(normalized.seeds[2].role, 'phase-seed');
  assert.equal(normalized.seeds[2].observedBeforeEvent, false);
  assert.equal(normalized.seeds[2].usableAsPreEventFeature, null);
  assert.equal(normalized.seeds[2].availability, 'unverified-historical');
  assert.equal(normalized.standings[0].placement, 1);
  assert.equal(normalized.standings.every((s) => s.usableAsPreEventFeature === false && s.role === 'outcome'), true);
  input.provenance.fetchedAt = '2020-01-01T00:00:00Z';
  assert.equal(normalizeEvents([input]).seeds[0].usableAsPreEventFeature, true);
  input.provenance.fetchedAt = new Date(input.event.startAt * 1000).toISOString();
  assert.equal(normalizeEvents([input]).seeds[0].observedBeforeEvent, false);
});

test('invalid seeds and standings are retained and labelled', () => {
  const input = bundle(); input.seeds[0].seedNum = 0; input.seeds[1].phase = null;
  input.standings[0].placement = -1; input.standings[1].entrant.id = 999;
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.quality.invalidSeeds.length, 2);
  assert.equal(normalized.seeds[0].usableAsPreEventFeature, false);
  assert.equal(normalized.quality.invalidStandings.length, 2);
});

test('seed and standing references cannot borrow an entrant from another event', () => {
  const first = bundle(); const second = bundle(2);
  second.entrants = [entrant(30)]; second.sets = [];
  const normalized = normalizeEvents([first, second]);
  const seed = normalized.seeds.find((s) => s.source.eventIds.includes('startgg:event:2'));
  assert.ok(seed.exclusionReasons.includes('source_conflict'));
  assert.ok(normalized.standings.filter((s) => s.eventId === 'startgg:event:2').every((s) => s.exclusionReasons.includes('missing_entrant')));
});

test('conflicting major mappings are deterministic and retain mapping provenance', () => {
  const first = bundle(); const second = structuredClone(first);
  second.major.id = 'other-major';
  const normalized = normalizeEvents([first, second]);
  assert.deepEqual(normalized, normalizeEvents([second, first]));
  assert.equal(normalized.provenance.length, 2);
  assert.equal(normalized.provenance.some((p) => p.major.id === 'other-major'), true);
  assert.ok(normalized.events[0].exclusionReasons.includes('event_source_conflict'));
});

test('reordering inputs is deterministic and normalizing never mutates a frozen bundle', () => {
  const input = bundle(); input.entrants.push(entrant(30, 30, 'Third'));
  input.sets.push(set(51, 20, 30));
  const reversed = structuredClone(input);
  for (const key of ['entrants', 'sets', 'seeds', 'standings']) reversed[key].reverse();
  const before = JSON.stringify(input);
  assert.deepEqual(normalizeEvents([deeplyFreeze(input)]), normalizeEvents([deeplyFreeze(reversed)]));
  assert.equal(JSON.stringify(input), before);
});

test('conflicting event chronology is excluded even if each isolated observation is valid', () => {
  const first = bundle(); const second = structuredClone(first); second.event.startAt++;
  const normalized = normalizeEvents([first, second]);
  assert.ok(normalized.events[0].exclusionReasons.includes('event_source_conflict'));
  assert.ok(normalized.sets[0].exclusionReasons.includes('event_source_conflict'));
  assert.equal(normalized.quality.eventConflicts.length, 1);
});

test('rejects malformed bundle envelopes and accepts an empty local collection', () => {
  assert.throws(() => normalizeEvents({}), /array/);
  assert.throws(() => normalizeEvents([{ event: { id: 1 } }]), /schemaVersion/);
  const input = bundle(); input.provenance.source = 'unknown';
  assert.throws(() => normalizeEvents([input]), /start.gg/);
  assert.equal(normalizeEvents([]).quality.counts.sets, 0);
});

test('missing or malformed source connections cannot masquerade as an empty complete dataset', () => {
  for (const field of ['entrants', 'sets', 'standings', 'seeds', 'phaseGroups']) {
    for (const invalidValue of [undefined, null, {}, { nodes: [] }, '']) {
      const input = bundle();
      input[field] = invalidValue;
      assert.throws(() => normalizeEvents([input]), new RegExp(`complete ${field} array`));
    }
  }
  const input = bundle();
  delete input.provenance.requests;
  assert.throws(() => normalizeEvents([input]), /provenance.requests array/);
});

test('explicit empty source arrays remain valid for an event without a published field or bracket', () => {
  const input = bundle();
  for (const field of ['entrants', 'sets', 'standings', 'seeds', 'phaseGroups']) input[field] = [];
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.events.length, 1);
  assert.equal(normalized.quality.counts.sets, 0);
  assert.equal(normalized.quality.counts.entrants, 0);
});

test('official source startAt and cross-phase progression routing survive normalization independently', () => {
  const input = bundle();
  input.sets[0].startAt = 1700000010;
  input.sets[0].winnerProgressionSeed = { id: 301 };
  input.sets[0].loserProgressionSeed = { id: 302 };
  Object.assign(input.seeds[0], { groupSeedNum: 4, isBye: false, progressionSeedId: 301, updatedAt: 1699999990 });
  const normalized = normalizeEvents([deeplyFreeze(input)]);
  assert.equal(normalized.sets[0].timestamps.startAt, 1700000010);
  assert.equal(normalized.sets[0].timestamps.startedAt, 1700000050);
  assert.deepEqual(normalized.sets[0].bracket.winnerProgressionSeed, { id: 301 });
  assert.deepEqual(normalized.sets[0].bracket.loserProgressionSeed, { id: 302 });
  assert.equal(normalized.seeds[0].groupSeedNum, 4);
  assert.equal(normalized.seeds[0].isBye, false);
  assert.equal(normalized.seeds[0].progressionSeedId, '301');
  assert.equal(normalized.seeds[0].updatedAt, 1699999990);
  assert.equal(normalized.sets[0].bracket.slots[0].prereqPlacement, 1);
});

test('bye seeds retain their source bracket position but cannot become player seed features', () => {
  const input = bundle(); input.seeds[0].isBye = true;
  const normalized = normalizeEvents([input]);
  assert.equal(normalized.seeds[0].isBye, true);
  assert.equal(normalized.seeds[0].usableAsPreEventFeature, false);
  assert.ok(normalized.seeds[0].exclusionReasons.includes('bye_seed'));
});

test('conflicting cross-phase seed routing is reported rather than silently selected', () => {
  const input = bundle(); input.seeds[0].progressionSeedId = 301;
  const conflict = structuredClone(input.seeds[0]); conflict.progressionSeedId = 302;
  input.seeds.push(conflict);
  const normalized = normalizeEvents([input]);
  assert.ok(normalized.seeds[0].exclusionReasons.includes('source_conflict'));
  assert.equal(normalized.seeds[0].usableAsPreEventFeature, false);
});
