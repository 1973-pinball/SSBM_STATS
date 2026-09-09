import test from "node:test";
import assert from "node:assert/strict";
import {
  DYNAMIC_BRADLEY_TERRY_OPTIONS,
  fitDynamicBradleyTerryModel,
} from "../lib/forecast/dynamic-bradley-terry.mjs";

const DAY = 86400;
const event = (id, start, end) => ({ id, eligible: true, chronology: {
  reportedEventStartAt: start,
  reportedTournamentStartAt: start - 1,
  reportedEventEndAt: end,
  reportedTournamentEndAt: end,
} });
const game = (id, eventId, a, b, winner, completedAt = null) => ({
  id, eventId, eligible: true, playerIds: [a, b], winnerPlayerId: winner,
  timestamps: { completedAt },
});

test("learns public-player strength, preserves side symmetry, and ignores target outcomes", () => {
  const events = [event("e1", 100, 200)];
  const sets = [
    game("s1", "e1", "a", "b", "a", 150),
    game("s2", "e1", "a", "b", "a", 151),
    game("s3", "e1", "b", "a", "a", 152),
  ];
  const model = fitDynamicBradleyTerryModel({ events, sets, cutoff: 300 });
  const target = game("target", "future", "a", "b", "b");
  const original = model.predict(target);
  assert.ok(original.p > 0.5);
  assert.deepEqual(original, { p: original.p, covered: true, knownPlayers: 2 });
  const swapped = model.predict({ ...target, playerIds: ["b", "a"] });
  assert.ok(Math.abs(original.p + swapped.p - 1) < 1e-15);
  target.winnerPlayerId = "a";
  assert.deepEqual(model.predict(target), original);
});

test("falls back to neutral unless both prediction players were observed", () => {
  const model = fitDynamicBradleyTerryModel({
    events: [event("e1", 100, 200)],
    sets: [game("s1", "e1", "a", "b", "a")],
    cutoff: 300,
  });
  assert.deepEqual(model.predict({ playerIds: ["a", "new"] }),
    { p: 0.5, covered: false, knownPlayers: 1 });
  assert.deepEqual(model.predict({ playerIds: ["new-1", "new-2"] }),
    { p: 0.5, covered: false, knownPlayers: 0 });
  assert.throws(() => model.predict({ playerIds: ["a", "a"] }), /two distinct players/);
});

test("is deterministic and input-order invariant within event batches", () => {
  const events = [event("e1", 100, 200), event("e2", 300, 400)];
  const sets = [
    game("s3", "e2", "b", "c", "b", 350),
    game("s1", "e1", "a", "b", "a", 150),
    game("s2", "e1", "c", "a", "c", 160),
  ];
  const args = { events, sets, cutoff: 500 };
  const left = fitDynamicBradleyTerryModel(args);
  const right = fitDynamicBradleyTerryModel({
    ...args, events: [...events].reverse(), sets: [...sets].reverse(),
  });
  for (const players of [["a", "b"], ["b", "c"], ["c", "a"]]) {
    assert.deepEqual(left.predict({ playerIds: players }), right.predict({ playerIds: players }));
  }
  assert.deepEqual(left.methodology.diagnostics, right.methodology.diagnostics);
});

test("uses reported event chronology but never within-event set timestamps", () => {
  const events = [event("early", 100, 200), event("late", 300, 400)];
  const sets = [
    game("s1", "early", "a", "b", "a", 199),
    game("s2", "late", "a", "b", "b", 301),
  ];
  const left = fitDynamicBradleyTerryModel({ events, sets, cutoff: 500 });
  const changedTimestamps = sets.map((set, index) => ({
    ...set, timestamps: { completedAt: index ? 399 : 101 },
  }));
  const right = fitDynamicBradleyTerryModel({ events, sets: changedTimestamps, cutoff: 500 });
  assert.deepEqual(left.predict({ playerIds: ["a", "b"] }), right.predict({ playerIds: ["a", "b"] }));

  const reversedEventChronology = [event("early", 300, 400), event("late", 100, 200)];
  const reversed = fitDynamicBradleyTerryModel({
    events: reversedEventChronology,
    sets: sets.map((set) => ({ ...set, timestamps: { completedAt: null } })),
    cutoff: 500,
  });
  assert.notEqual(left.predict({ playerIds: ["a", "b"] }).p,
    reversed.predict({ playerIds: ["a", "b"] }).p);
});

test("decays older learned skills toward neutral at the forecast cutoff", () => {
  const args = {
    events: [event("e1", 100, 200)],
    sets: [game("s1", "e1", "a", "b", "a")],
  };
  const recent = fitDynamicBradleyTerryModel({ ...args, cutoff: 201 });
  const old = fitDynamicBradleyTerryModel({
    ...args, cutoff: 201 + DYNAMIC_BRADLEY_TERRY_OPTIONS.halfLifeDays * DAY,
  });
  const target = { playerIds: ["a", "b"] };
  assert.ok(recent.predict(target).p > old.predict(target).p);
  assert.ok(old.predict(target).p > 0.5);
});

test("reports the exact dynamic objective and convergence diagnostics", () => {
  const model = fitDynamicBradleyTerryModel({
    events: [event("e1", 100, 200)],
    sets: [game("s1", "e1", "a", "b", "a")],
    cutoff: 300,
  });
  assert.equal(model.id, "dynamic-bradley-terry");
  assert.equal(model.methodology.kind, "dynamic-event-state-bradley-terry");
  assert.equal(model.methodology.sameEventUpdates, false);
  assert.match(model.methodology.objective, /joint Bradley-Terry log likelihood/);
  assert.match(model.methodology.optimizer, /full-batch gradient ascent/);
  assert.equal(model.methodology.diagnostics.length, 1);
  assert.equal(model.methodology.diagnostics[0].converged, true);
  assert.ok(model.methodology.diagnostics[0].iterations > 0);
  assert.ok(Number.isFinite(model.methodology.diagnostics[0].objective));
});

test("rejects invalid, duplicate, ineligible, or post-cutoff training inputs", () => {
  const e1 = event("e1", 100, 200);
  const s1 = game("s1", "e1", "a", "b", "a");
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1, e1], sets: [s1], cutoff: 300 }),
    /Duplicate training event/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1], sets: [s1, s1], cutoff: 300 }),
    /Duplicate training set/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1], sets: [{ ...s1, eligible: false }], cutoff: 300 }),
    /ineligible/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1], sets: [{ ...s1, timestamps: { completedAt: 300 } }], cutoff: 300 }),
    /strictly before cutoff/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [event("late", 100, 300)], sets: [], cutoff: 300 }),
    /strictly before cutoff/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1], sets: [{ ...s1, winnerPlayerId: "c" }], cutoff: 300 }),
    /valid winner/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1], sets: [s1], cutoff: 300,
    options: { ridge: 0 } }), /positive finite/);
  assert.throws(() => fitDynamicBradleyTerryModel({ events: [e1], sets: [s1], cutoff: 300,
    options: { maxIterations: 1.5 } }), /maxIterations/);
});
