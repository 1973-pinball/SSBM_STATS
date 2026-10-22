/** Old special-attempt placeholders must never become measured benchmark zeros. */
import assert from "node:assert/strict";
import { addArchiveDownBOutcomes, assertArchiveDownBMeasurements } from "./lib/archive-move-coverage.mjs";

const record = (move, overrides = {}) => ({
  statsVersion: 4,
  isTeams: false,
  players: [{ characterId: 2, moveStats: { 21: move } }],
  ...overrides,
});
const aggregate = {};
addArchiveDownBOutcomes(aggregate, { landed: 4 });
assert.deepEqual(aggregate, {}, "an unmeasured move provides no measured coverage");
const attemptOnly = {};
addArchiveDownBOutcomes(attemptOnly, { attempts: 0, landed: 4 });
assert.deepEqual(attemptOnly, { attemptGames: 1 }, "an explicit current-schema attempt zero does not imply outcome coverage");

const unused = { attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 };
assertArchiveDownBMeasurements(record(unused), "unused fixture");
addArchiveDownBOutcomes(aggregate, unused);
const measured = { attempts: 5, hitAttempts: 2, noHitAttempts: 2, incompleteAttempts: 1, landed: 8 };
assertArchiveDownBMeasurements(record(measured), "measured fixture");
addArchiveDownBOutcomes(aggregate, measured);
assert.deepEqual(aggregate, {
  attemptGames: 2, outcomeGames: 2, hitAttempts: 2, noHitAttempts: 2, incompleteAttempts: 1,
}, "unused measured games count, while multi-hit landed totals never manufacture outcomes");
assert.equal(100 * aggregate.noHitAttempts / (aggregate.hitAttempts + aggregate.noHitAttempts), 50,
  "unfinished uses stay out of the outcome-rate denominator");

assertArchiveDownBMeasurements(record({ attempts: 0, landed: 2 }), "legacy fixture");
assert.throws(() => assertArchiveDownBMeasurements(record({ attempts: 0, landed: 2 }, { statsVersion: 3 }), "old export fixture"),
  /requires archive stats v4/, "old numeric placeholders cannot be upgraded into covered-game zeros");
for (const malformed of [
  { attempts: 3, hitAttempts: 1 },
  { attempts: 3, hitAttempts: 1, noHitAttempts: 1, incompleteAttempts: 0 },
  { attempts: 3, hitAttempts: 2, noHitAttempts: -1, incompleteAttempts: 2 },
]) {
  assert.throws(() => assertArchiveDownBMeasurements(record(malformed), "malformed fixture"), /invalid Down B/);
}
assert.throws(() => assertArchiveDownBMeasurements(record(measured, { isTeams: true }), "doubles fixture"), /invalid Down B/);
assertArchiveDownBMeasurements({
  statsVersion: 4, isTeams: false, players: [{ characterId: 9, moveStats: { 21: { attempts: 3 } } }],
}, "attempt-only character fixture");

console.log("Archive Down B coverage passed: unmeasured records, measured unused games, attempt-only characters, distinct outcomes, unfinished uses, and invalid-source rejection.");
