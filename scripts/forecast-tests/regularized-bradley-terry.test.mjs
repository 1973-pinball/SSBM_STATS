import test from "node:test";
import assert from "node:assert/strict";
import { fitRegularizedBradleyTerryModel, restoreRegularizedBradleyTerryModel } from "../lib/forecast/regularized-bradley-terry.mjs";

const event = (id, start, end) => ({ id, eligible: true, chronology: {
  reportedEventStartAt: start, reportedTournamentStartAt: start,
  reportedEventEndAt: end, reportedTournamentEndAt: end,
} });
const game = (id, eventId, a, b, winner, completedAt = null) => ({
  id, eventId, eligible: true, entrantIds: [`${eventId}:${a}`, `${eventId}:${b}`],
  playerIds: [a, b], winnerPlayerId: winner,
  ...(completedAt == null ? {} : { timestamps: { completedAt } }),
});
const seedIndex = (rows = [], allowHistorical = true) => ({
  seeds: new Map(rows.map(([eventId, player, rank]) => [`${eventId}:${player}`, rank])),
  allowHistorical,
});

function historyFixture() {
  const events = [event("e1", 100, 200), event("e2", 300, 400), event("e3", 500, 600)];
  const sets = [
    game("g1", "e1", "alice", "bob", "alice"),
    game("g2", "e1", "alice", "bob", "alice"),
    game("g3", "e2", "alice", "bob", "alice"),
    game("g4", "e2", "alice", "bob", "alice"),
  ];
  return { events, sets, cutoff: 499, seedIndex: seedIndex() };
}

test("learns categorical player history and is exactly side-complementary", () => {
  const fixture = historyFixture();
  const model = fitRegularizedBradleyTerryModel({
    ...fixture, events: fixture.events.slice(0, 2),
  });
  const forward = model.predict(game("target", "e3", "alice", "bob", "alice"));
  const reverse = model.predict(game("target", "e3", "bob", "alice", "alice"));
  assert.ok(forward.p > 0.5);
  assert.ok(model.methodology.coefficients.form > 0);
  assert.ok(Math.abs(forward.p + reverse.p - 1) < 1e-12);
  assert.equal(forward.knownPlayers, 2);
  assert.match(model.methodology.playerEffects, /categorical/);
  assert.equal(model.methodology.characterFeature, "not included");
});

test("unknown players and unavailable features have documented neutral behavior", () => {
  const fixture = historyFixture();
  const model = fitRegularizedBradleyTerryModel({
    ...fixture, events: fixture.events.slice(0, 2),
  });
  assert.deepEqual(model.predict(game("u", "e3", "new-a", "new-b", "new-a")), {
    p: 0.5, covered: false, knownPlayers: 0, seedCovered: false, formKnownPlayers: 0,
  });
  assert.match(model.methodology.missingSeed, /zero feature/);
  assert.match(model.methodology.missingForm, /zero form/);
});

test("player ID magnitudes are irrelevant categorical labels", () => {
  const events = [event("e1", 100, 200)];
  const left = fitRegularizedBradleyTerryModel({
    events, cutoff: 299, seedIndex: seedIndex(),
    sets: [game("g1", "e1", "1", "2", "1"), game("g2", "e1", "1", "2", "1")],
  });
  const right = fitRegularizedBradleyTerryModel({
    events, cutoff: 299, seedIndex: seedIndex(),
    sets: [game("g1", "e1", "999999999", "3", "999999999"), game("g2", "e1", "999999999", "3", "999999999")],
  });
  assert.equal(
    left.predict(game("t1", "e2", "1", "2", "1")).p,
    right.predict(game("t2", "e2", "999999999", "3", "999999999")).p,
  );
});

test("training-only seed differences can predict a matchup between unseen players", () => {
  const events = [event("e1", 100, 200), event("e2", 300, 400)];
  const sets = [];
  const seeds = [];
  for (let index = 0; index < 16; index++) {
    const strong = `strong-${index}`;
    const weak = `weak-${index}`;
    sets.push(game(`g-${index}`, "e1", strong, weak, strong));
    seeds.push(["e1", strong, 1], ["e1", weak, 16]);
  }
  seeds.push(["e2", "rookie-high", 1], ["e2", "rookie-low", 16]);
  const model = fitRegularizedBradleyTerryModel({ events: events.slice(0, 1), sets, cutoff: 299, seedIndex: seedIndex(seeds) });
  const prediction = model.predict(game("target", "e2", "rookie-high", "rookie-low", "rookie-high"));
  assert.ok(prediction.p > 0.5);
  assert.equal(prediction.knownPlayers, 0);
  assert.equal(prediction.seedCovered, true);
  assert.ok(model.methodology.coefficients.seed > 0);
});

test("fit is deterministic and invariant to supplied event and set order", () => {
  const fixture = historyFixture();
  const args = { ...fixture, events: fixture.events.slice(0, 2) };
  const left = fitRegularizedBradleyTerryModel(args);
  const right = fitRegularizedBradleyTerryModel({
    ...args, events: [...args.events].reverse(), sets: [...args.sets].reverse(),
  });
  const target = game("target", "e3", "alice", "bob", "alice");
  assert.deepEqual(left.predict(target), right.predict(target));
  assert.deepEqual(left.methodology.coefficients, right.methodology.coefficients);
  assert.deepEqual(left.methodology.fit, right.methodology.fit);
});

test("events with equal reported completion times cannot leak form into one another", () => {
  const events = [event("e1", 100, 200), event("e2", 100, 200)];
  const sets = [
    game("g1", "e1", "alice", "bob", "alice"),
    game("g2", "e2", "alice", "bob", "alice"),
  ];
  const model = fitRegularizedBradleyTerryModel({ events, sets, cutoff: 299, seedIndex: seedIndex() });
  assert.equal(model.methodology.coefficients.form, 0);
  assert.match(model.methodology.chronology, /equal-completion-time/);
});

test("constructor rejects future events, late outcomes, and duplicate observations", () => {
  const fixture = historyFixture();
  assert.throws(() => fitRegularizedBradleyTerryModel({
    ...fixture, events: fixture.events, cutoff: 499,
  }), /strictly before cutoff/);
  assert.throws(() => fitRegularizedBradleyTerryModel({
    ...fixture, events: fixture.events.slice(0, 2), sets: [game("late", "e1", "alice", "bob", "alice", 499)],
  }), /Training outcome/);
  assert.throws(() => fitRegularizedBradleyTerryModel({
    ...fixture, events: fixture.events.slice(0, 2), sets: [fixture.sets[0], fixture.sets[0]],
  }), /Duplicate training set/);
});

test("prediction never reads the target winner and strict seed policy is disclosed", () => {
  const fixture = historyFixture();
  const model = fitRegularizedBradleyTerryModel({
    ...fixture, events: fixture.events.slice(0, 2), seedIndex: seedIndex([], false),
  });
  const target = game("target", "e3", "alice", "bob", "alice");
  const before = model.predict(target);
  target.winnerPlayerId = "bob";
  assert.deepEqual(model.predict(target), before);
  assert.equal(model.methodology.seedAvailability, "observed before cutoff only");
});

test("saved fitted state reproduces predictions without historical sets and accepts fresh event seeds", () => {
  const fixture = historyFixture();
  const seeds = seedIndex([["e1", "alice", 1], ["e1", "bob", 2], ["e2", "alice", 1],
    ["e2", "bob", 2], ["e3", "alice", 2], ["e3", "bob", 1]]);
  const model = fitRegularizedBradleyTerryModel({ ...fixture, events: fixture.events.slice(0, 2), seedIndex: seeds });
  const exported = JSON.parse(JSON.stringify(model.snapshot));
  const restored = restoreRegularizedBradleyTerryModel(exported, { seedIndex: seeds });
  for (const [a, b] of [["alice", "bob"], ["bob", "alice"], ["alice", "new"], ["new", "other"]]) {
    const target = game("target", "e3", a, b, a);
    assert.deepEqual(restored.predict(target), model.predict(target));
  }
  assert.equal(restored.snapshot.cutoff, fixture.cutoff);
  assert.deepEqual(restored.methodology.fit, model.methodology.fit);
  const target = game("target", "e3", "alice", "bob", "alice");
  const before = restored.predict(target);
  exported.methodology.featureScales.seed = 0;
  exported.abilities[0][1] = 900;
  restored.snapshot.abilities[0][1] = -900;
  assert.deepEqual(restored.predict(target), before, "caller mutations must not alter restored predictions");
  const newSeeds = seedIndex([["new-event", "alice", 2], ["new-event", "bob", 1]]);
  const newEvent = restoreRegularizedBradleyTerryModel(model.snapshot, { seedIndex: newSeeds });
  assert.deepEqual(newEvent.predict(game("new", "new-event", "alice", "bob", "alice")), before);
});

test("fitted snapshot loading rejects malformed or incomplete player state", () => {
  const fixture = historyFixture();
  const model = fitRegularizedBradleyTerryModel({ ...fixture, events: fixture.events.slice(0, 2) });
  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.cutoff = null; },
    (value) => { value.abilities.push(value.abilities[0]); },
    (value) => { value.abilities[0][1] = null; },
    (value) => { value.methodology.coefficients.seed = Infinity; },
    (value) => { value.methodology.featureScales.form = 0; },
    (value) => { value.targetForm.push(["unknown", 0]); },
    (value) => { value.targetForm.pop(); },
    (value) => { delete value.methodology.fit; },
    (value) => { value.methodology.fit.converged = "true"; },
    (value) => { value.methodology.fit.iterations = -1; },
    (value) => { value.methodology.fit.objective = null; },
  ]) {
    const snapshot = model.snapshot;
    mutate(snapshot);
    assert.throws(() => restoreRegularizedBradleyTerryModel(snapshot, { seedIndex: fixture.seedIndex }), /snapshot/i);
  }
});
