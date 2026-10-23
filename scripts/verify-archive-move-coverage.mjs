/** Legacy special placeholders must never become measured benchmark zeros. */
import assert from "node:assert/strict";
import { ARCHIVE_SPECIAL_MOVE_IDS, addArchiveSpecialOutcomes, assertArchiveSpecialMeasurements,
  addArchiveDownBOutcomes, assertArchiveDownBMeasurements } from "./lib/archive-move-coverage.mjs";
const unused = { attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 };
const measured = { attempts: 5, hitAttempts: 2, noHitAttempts: 2, incompleteAttempts: 1, landed: 8 };
const record = (moveId, move, overrides = {}) => ({ statsVersion: 5, isTeams: false,
  players: [{ characterId: 2, moveStats: { [moveId]: move } }, { characterId: 20, moveStats: {} }], ...overrides });
for (const moveId of ARCHIVE_SPECIAL_MOVE_IDS) {
  const aggregate = {};
  addArchiveSpecialOutcomes(aggregate, { landed: 4 }, moveId, 5);
  assert.deepEqual(aggregate, {}, "unmeasured moves supply no coverage");
  const attemptOnly = {};
  addArchiveSpecialOutcomes(attemptOnly, { attempts: 0, landed: 4 }, moveId, 5);
  assert.deepEqual(attemptOnly, { attemptGames: 1 }, "explicit zero attempts do not imply outcomes");
  assertArchiveSpecialMeasurements(record(moveId, unused), "unused fixture");
  assertArchiveSpecialMeasurements(record(moveId, measured), "measured fixture");
  addArchiveSpecialOutcomes(aggregate, unused, moveId, 5);
  addArchiveSpecialOutcomes(aggregate, measured, moveId, 5);
  assert.deepEqual(aggregate, { attemptGames: 2, outcomeGames: 2, hitAttempts: 2, noHitAttempts: 2, incompleteAttempts: 1 });
  assert.equal(100 * aggregate.noHitAttempts / (aggregate.hitAttempts + aggregate.noHitAttempts), 50,
    "multi-hit landed counts and unfinished uses do not become completed outcomes");
  for (const malformed of [
    { attempts: -1 }, { attempts: 1.5 }, { attempts: 3, hitAttempts: 1 },
    { attempts: 3, hitAttempts: 1, noHitAttempts: 1, incompleteAttempts: 0 },
    { attempts: 3, hitAttempts: 2, noHitAttempts: -1, incompleteAttempts: 2 },
  ]) assert.throws(() => assertArchiveSpecialMeasurements(record(moveId, malformed), "invalid fixture"), /invalid special-move/);
  assert.throws(() => assertArchiveSpecialMeasurements(record(moveId, measured, { isTeams: true }), "doubles"), /invalid special-move/);
  assert.throws(() => assertArchiveSpecialMeasurements(record(moveId, { attempts: 0 }, { isTeams: true }), "doubles zero"), /invalid special-move/);
  assertArchiveSpecialMeasurements(record(moveId, { landed: 3 }, { isTeams: true }), "untracked doubles");
  const invalidRoster = record(moveId, measured);
  invalidRoster.players.push({ characterId: 0, moveStats: {} });
  assert.throws(() => assertArchiveSpecialMeasurements(invalidRoster, "three-player non-team game"), /invalid special-move/);
  assert.throws(() => assertArchiveSpecialMeasurements(record(moveId, measured, { statsVersion: 4 }), "stale export"), /requires archive stats v5/);
  const legacy = {};
  addArchiveSpecialOutcomes(legacy, unused, moveId, 3);
  assert.deepEqual(legacy, {}, "stats3 placeholders have no coverage");
  addArchiveSpecialOutcomes(legacy, unused, moveId, 4);
  assert.deepEqual(legacy, moveId === 21 ? { attemptGames: 1, outcomeGames: 1, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 } : {},
    "only Down B was measured in stats4");
}
assertArchiveDownBMeasurements(record(21, unused, { statsVersion: 4 }), "retained v4");
const legacyDownB = {};
addArchiveDownBOutcomes(legacyDownB, measured);
assert.equal(legacyDownB.attemptGames, 1, "immutable stats4 Down B tools remain usable");
assert.throws(() => assertArchiveSpecialMeasurements(record(2, measured), "normal move"), /invalid special-move outcome/);
const combined = Object.fromEntries(ARCHIVE_SPECIAL_MOVE_IDS.map(id => [id, {}]));
addArchiveSpecialOutcomes(combined[18], unused, 18, 5);
addArchiveSpecialOutcomes(combined[21], measured, 21, 5);
assert.equal(combined[18].attemptGames, 1);
assert.equal(combined[21].attemptGames, 1);
assert.deepEqual(combined[19], {}, "one special's coverage never creates another special's denominator");
console.log("Archive special coverage passed: four independent moves, unused games, attempt-only coverage, legacy stats4 Down B, stale placeholders, and invalid partitions.");
