import test from "node:test";
import assert from "node:assert/strict";
import { fitBasicModels, initialSeedIndex } from "../lib/forecast/baselines.mjs";

const event = (id, start, end) => ({ id, eligible: true, chronology: {
  reportedEventStartAt: start, reportedTournamentStartAt: start - 1,
  reportedEventEndAt: end, reportedTournamentEndAt: end + 1,
} });
const game = (id, eventId, a, b, winner) => ({ id, eventId, eligible: true,
  entrantIds: [eventId + a, eventId + b], playerIds: [a, b], winnerPlayerId: winner });
const seed = (id, eventId, phaseId, entrant, n) => ({ id, source: { id }, eventId, phase: { id: phaseId, phaseOrder: 99 },
  entrantId: eventId + entrant, seedNum: n, exclusionReasons: [], usableAsPreEventFeature: null });

function fixture() {
  return {
    events: [event("e1", 100, 200), event("e2", 300, 400)],
    entrants: ["e1", "e2"].flatMap((eventId) => ["a", "b"].map((p) => ({ id: eventId + p, eventId }))),
    seeds: [seed("s1", "e1", 1, "a", 1), seed("s2", "e1", 1, "b", 2), seed("s3", "e2", 2, "a", 1), seed("s4", "e2", 2, "b", 2)],
    sets: [game("g1", "e1", "a", "b", "a"), game("g2", "e1", "b", "a", "a")],
  };
}

test("initial seeding ignores phaseOrder, rejects incomplete/reranked or ambiguous phases", () => {
  const d = fixture();
  d.seeds.push(seed("later1", "e1", 3, "a", 1));
  let result = initialSeedIndex(d);
  assert.equal(result.seeds.get("e1b"), 2);
  assert.equal(result.reports[0].historical, 2);
  assert.equal(initialSeedIndex(d, { allowHistorical: false }).seeds.size, 0);
  d.seeds.push(seed("later2", "e1", 3, "b", 2));
  assert.equal(initialSeedIndex(d).reports[0].reason, "ambiguous_full_field_seed_phases");
  d.seeds[0].progressionSeedId = "later1";
  result = initialSeedIndex(d);
  assert.equal(result.reports[0].phaseId, "1");
  assert.equal(result.seeds.get("e1a"), 1);
  d.seeds[1].seedNum = 1;
  assert.equal(initialSeedIndex(d).reports[0].available, 0);
});

test("models use only supplied prior outcomes and do not learn from a prediction target", () => {
  const d = fixture();
  const models = fitBasicModels({ events: [d.events[0]], sets: d.sets, cutoff: 299, seedIndex: initialSeedIndex(d) });
  const target = game("target", "e2", "a", "b", "b");
  assert.equal(models[0].predict(target).p, 0.5);
  assert.equal(models[1].methodology.seedConfidence, 0.75);
  assert.equal(models[1].predict(target).p, 0.75);
  assert.ok(models[2].predict(target).p > 0.5);
  const before = models.map((m) => m.predict(target));
  target.winnerPlayerId = "a";
  assert.deepEqual(models.map((m) => m.predict(target)), before);
  assert.throws(() => fitBasicModels({ events: d.events, sets: d.sets, cutoff: 299, seedIndex: initialSeedIndex(d) }), /strictly before/);
});

test("direct fitting refuses late training outcomes even when the reported event end is early", () => {
  const d = fixture();
  d.sets[0].timestamps = { completedAt: 299 };
  assert.throws(() => fitBasicModels({ events: [d.events[0]], sets: d.sets,
    cutoff: 299, seedIndex: initialSeedIndex(d) }), /Training outcome/);
});

test("strict seed availability checks the conservative cutoff, not a nominal-event flag", () => {
  const d = fixture();
  d.provenance = [{ id: "p", fetchedAt: new Date(99500).toISOString() }];
  for (const s of d.seeds) { s.source.provenanceIds = ["p"]; s.usableAsPreEventFeature = true; }
  const strict = initialSeedIndex(d, { allowHistorical: false });
  assert.equal(strict.seeds.has("e1a"), false);
  assert.equal(strict.reports[0].historical, 2);
  d.provenance[0].fetchedAt = new Date(98000).toISOString();
  assert.equal(initialSeedIndex(d, { allowHistorical: false }).seeds.get("e1a"), 1);
});

test("event-batch Elo is input-order invariant, zero-sum symmetric, and reports unseen players", () => {
  const d = fixture();
  const args = { events: [d.events[0]], sets: d.sets, cutoff: 299, seedIndex: initialSeedIndex(d) };
  const left = fitBasicModels(args)[2];
  const right = fitBasicModels({ ...args, sets: [...d.sets].reverse() })[2];
  const target = game("t", "e2", "a", "b", "a");
  assert.deepEqual(left.predict(target), right.predict(target));
  assert.ok(Math.abs(left.predict(target).p + left.predict({ ...target, playerIds: ["b", "a"] }).p - 1) < 1e-12);
  assert.deepEqual(left.predict({ playerIds: ["unknown-a", "unknown-b"] }), { p: 0.5, covered: false, knownPlayers: 0 });
});

test("older training events have smaller Elo influence and unknown seeds fall back to neutral", () => {
  const d = fixture();
  const args = { events: [d.events[0]], sets: d.sets, seedIndex: initialSeedIndex(d) };
  const current = fitBasicModels({ ...args, cutoff: 299 });
  const older = fitBasicModels({ ...args, cutoff: 299 + 730 * 86400 });
  const target = game("t", "e2", "a", "b", "a");
  assert.ok(older[2].predict(target).p < current[2].predict(target).p);
  assert.deepEqual(current[1].predict({ ...target, entrantIds: ["missing", "e2b"] }), { p: 0.5, covered: false });
  assert.throws(() => fitBasicModels({ ...args, cutoff: 299, sets: [...d.sets, d.sets[0]] }), /Duplicate training set/);
});
