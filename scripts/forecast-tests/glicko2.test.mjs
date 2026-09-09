import test from "node:test";
import assert from "node:assert/strict";
import { fitGlicko2Model, updateGlicko2Rating } from "../lib/forecast/glicko2.mjs";

const event = (id, start, end) => ({ id, eligible: true, chronology: {
  reportedEventStartAt: start, reportedTournamentStartAt: start - 1,
  reportedEventEndAt: end, reportedTournamentEndAt: end + 1,
} });
const game = (id, eventId, a, b, winner, completedAt = null) => ({
  id, eventId, eligible: true, playerIds: [a, b], winnerPlayerId: winner,
  timestamps: { completedAt },
});

test("single-period update reproduces Glickman's published Glicko-2 example", () => {
  const updated = updateGlicko2Rating(
    { rating: 1500, rd: 200, volatility: 0.06 },
    [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 },
    ],
  );
  assert.ok(Math.abs(updated.rating - 1464.06) < 0.01, `rating ${updated.rating}`);
  assert.ok(Math.abs(updated.rd - 151.52) < 0.01, `RD ${updated.rd}`);
  assert.ok(Math.abs(updated.volatility - 0.059996) < 0.000001, `volatility ${updated.volatility}`);
});

test("event rating periods and their forecasts are deterministic under input reordering", () => {
  const events = [event("e1", 100, 200), event("e2", 300, 400)];
  const sets = [
    game("s2", "e1", "a", "b", "a"),
    game("s1", "e1", "b", "a", "a"),
    game("s3", "e2", "b", "c", "b"),
  ];
  const left = fitGlicko2Model({ events, sets, cutoff: 500 });
  const right = fitGlicko2Model({ events: [...events].reverse(), sets: [...sets].reverse(), cutoff: 500 });
  const targets = [
    { playerIds: ["a", "b"] },
    { playerIds: ["b", "c"] },
    { playerIds: ["a", "c"] },
  ];
  assert.deepEqual(targets.map((row) => left.predict(row)), targets.map((row) => right.predict(row)));
  assert.equal(left.methodology.ratingPeriods, 2);
  assert.equal(left.methodology.trainedPlayers, 3);
});

test("pair probabilities are symmetric and unknown-player coverage is explicit", () => {
  const model = fitGlicko2Model({
    events: [event("e1", 100, 200)],
    sets: [game("s1", "e1", "a", "b", "a"), game("s2", "e1", "a", "b", "a")],
    cutoff: 300,
  });
  const forward = model.predict({ playerIds: ["a", "b"] });
  const reverse = model.predict({ playerIds: ["b", "a"] });
  assert.ok(forward.p > 0.5);
  assert.ok(Math.abs(forward.p + reverse.p - 1) < 1e-12);
  assert.deepEqual(model.predict({ playerIds: ["new-a", "new-b"] }), {
    p: 0.5, covered: false, knownPlayers: 0,
  });
  const oneKnown = model.predict({ playerIds: ["a", "new"] });
  const oneKnownReverse = model.predict({ playerIds: ["new", "a"] });
  assert.equal(oneKnown.knownPlayers, 1);
  assert.equal(oneKnown.covered, false);
  assert.ok(Math.abs(oneKnown.p + oneKnownReverse.p - 1) < 1e-12);
});

test("inactive rating periods increase RD without changing rating or volatility", () => {
  const current = { rating: 1620, rd: 80, volatility: 0.05 };
  const updated = updateGlicko2Rating(current, []);
  assert.equal(updated.rating, current.rating);
  assert.equal(updated.volatility, current.volatility);
  assert.ok(updated.rd > current.rd);
});

test("fitting rejects ineligible, late, duplicate, and malformed training data", () => {
  const e1 = event("e1", 100, 200);
  const valid = game("s1", "e1", "a", "b", "a", 150);
  assert.throws(() => fitGlicko2Model({ events: [{ ...e1, eligible: false }], sets: [valid], cutoff: 300 }), /strictly before/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [{ ...valid, eligible: false }], cutoff: 300 }), /ineligible/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [{ ...valid, timestamps: { completedAt: 300 } }], cutoff: 300 }), /strictly before/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [valid, { ...valid }], cutoff: 300 }), /Duplicate training set/);
  assert.throws(() => fitGlicko2Model({ events: [e1, { ...e1 }], sets: [valid], cutoff: 300 }), /Duplicate training event/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [{ ...valid, winnerPlayerId: "c" }], cutoff: 300 }), /valid winner/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [valid], cutoff: 200 }), /strictly before/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [valid], cutoff: 300, options: { tau: 0 } }), /positive/);
  assert.throws(() => fitGlicko2Model({ events: [e1], sets: [valid], cutoff: 300, options: { surprise: 1 } }), /Unknown/);
});
