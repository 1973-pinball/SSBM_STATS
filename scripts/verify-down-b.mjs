/** Frame-level Down-B regression checks. No replay files leave this machine. */
import assert from "node:assert/strict";
import { Character } from "@slippi/slippi-js";
import { createDownBAccumulator, addDownBFrame, finishDownBAccumulator, getDownBCapability } from "../src/lib/downBSpecial.ts";

// External ID, internal ID, entry action. These deliberately duplicate the
// source-verified game constants, rather than reading the implementation table.
const roster = [
  [Character.CAPTAIN_FALCON, 2, 357], [Character.DONKEY_KONG, 3, 383], [Character.FOX, 1, 360],
  [Character.GAME_AND_WATCH, 24, 375], [Character.KIRBY, 4, 393], [Character.BOWSER, 5, 361],
  [Character.LINK, 6, 358], [Character.LUIGI, 17, 358], [Character.MARIO, 0, 350],
  [Character.MARTH, 18, 369], [Character.MEWTWO, 16, 359], [Character.NESS, 8, 367],
  [Character.PEACH, 9, 352], [Character.PIKACHU, 12, 359], [Character.ICE_CLIMBERS, 10, 357],
  [Character.JIGGLYPUFF, 15, 369], [Character.SAMUS, 13, 355], [Character.YOSHI, 14, 366],
  [Character.ZELDA, 19, 355], [Character.SHEIK, 7, 361], [Character.FALCO, 22, 360],
  [Character.YOUNG_LINK, 20, 358], [Character.DR_MARIO, 21, 350], [Character.ROY, 26, 369],
  [Character.PICHU, 23, 359], [Character.GANONDORF, 25, 357],
];
assert.deepEqual(roster.map(([external]) => external).sort((a,b)=>a-b), Array.from({length:26},(_,i)=>i));
const direct = new Set([0, 1, 2, 4, 5, 7, 8, 15, 20, Character.DR_MARIO, 25]);
const post = (internalCharacterId, actionStateId = 14, actionStateCounter = 0, extra = {}) => ({
  internalCharacterId, actionStateId, actionStateCounter, isFollower: false,
  percent: 0, stocksRemaining: 4, lastAttackLanded: 0, lastHitBy: 255,
  hitlagRemaining: 0, ...extra,
});
const full = (attempts, hitAttempts = 0, noHitAttempts = attempts - hitAttempts, incompleteAttempts = 0) =>
  ({ attempts, hitAttempts, noHitAttempts, incompleteAttempts });
const run = (external, internal, sequence, options = {}) => {
  const acc = createDownBAccumulator([{ playerIndex: 0, characterId: external }, { playerIndex: 1, characterId: 9 }]);
  assert.ok(acc);
  let fn = -123;
  const feed = (a, b = post(18)) => addDownBFrame(acc, { frame: fn++, players: { 0: { post: a }, 1: { post: b } } });
  feed(post(internal));
  for (const sample of sequence) feed(...sample);
  if (options.close !== false) feed(post(internal));
  return { acc, result: finishDownBAccumulator(acc).get(0), feed };
};

for (const [external, internal, start] of roster) {
  const capability = getDownBCapability(external);
  assert.equal(capability.attempts, true, `character ${external}: attempt coverage`);
  assert.equal(capability.outcomes, direct.has(external), `character ${external}: outcome coverage`);
  assert.equal(capability.reason === null, direct.has(external));
  const noUse = run(external, internal, []).result;
  assert.deepEqual(noUse, direct.has(external) ? full(0) : { attempts: 0 }, `character ${external}: measured zero`);
  const oneUse = run(external, internal, [[post(internal, start, 0)], [post(internal, start, 1)]]).result;
  assert.deepEqual(oneUse, direct.has(external) ? full(1) : { attempts: 1 }, `character ${external}: one activation`);
}
assert.equal(getDownBCapability(26).attempts, false);
assert.equal(getDownBCapability(-1).attempts, false);
assert.equal(createDownBAccumulator([]), null);
assert.equal(createDownBAccumulator([{playerIndex:0,characterId:2},{playerIndex:0,characterId:20}]), null);

// All shine phases, air/ground switches, frozen hitlag and loop resets belong to
// one activation. The misleading "Hit" state is projectile reflection.
const shine = run(2, 1, [
  [post(1, 360, 0)], [post(1, 360, 1)], [post(1, 360, 1)],
  [post(1, 365, 0)], [post(1, 366, 0)], [post(1, 366, 10)], [post(1, 366, 0)],
  [post(1, 369, 0)], [post(1, 364, 0)], [post(1, 362, 0)], [post(1, 367, 0)],
  [post(1, 361, 0)], [post(1, 363, 0)], [post(1, 368, 0)],
]);
assert.deepEqual(shine.result, full(1));
assert.deepEqual(run(20, 22, [
  [post(22, 360, 0)], [post(22, 360, 3)], [post(22, 360, 0)],
  [post(22, 24)], [post(22, 365, 0)],
]).result, full(3), "same-state restart and jump-cancelled new shine are distinct");

// One activation may damage an opponent repeatedly; it remains one hit attempt.
assert.deepEqual(run(8, 0, [
  [post(0, 350, 0, { lastAttackLanded: 21, instanceId: 11 }), post(18, 75, 0, { percent: 2, lastHitBy: 0, instanceHitBy: 11 })],
  [post(0, 350, 1, { lastAttackLanded: 21, instanceId: 11 }), post(18, 75, 1, { percent: 4, lastHitBy: 0, instanceHitBy: 11 })],
  [post(0, 349, 0, { lastAttackLanded: 21, instanceId: 12 }), post(18, 75, 2, { percent: 7, lastHitBy: 0, instanceHitBy: 12 })],
]).result, full(1, 1), "multi-hit plus ground transition");
assert.deepEqual(run(2, 1, [
  [post(1, 360, 0, { lastAttackLanded: 21 }), post(18, 181, 0, { shieldSize: 40 })],
]).result, full(1), "shield contact is included in no-hit, never separately called a whiff");
assert.deepEqual(run(2, 1, [
  [post(1, 360, 0, { lastAttackLanded: 21, instanceId: 22 }), post(18)],
  [post(1, 360, 1, { lastAttackLanded: 21, instanceId: 22 }), post(18, 75, 0, { percent: 5, lastHitBy: 0, instanceHitBy: 99 })],
]).result, full(1), "a lingering item instance is not a shine hit");
assert.deepEqual(run(2, 1, [
  [post(1, 360, 0, { lastAttackLanded: 21 }), post(18)],
  [post(1, 360, 1, { lastAttackLanded: 21 }), post(18, 359, 0, { percent: 2, lastHitBy: 0 })],
]).result, full(1), "stale last-hit fields and self-damage are not hit evidence");
assert.deepEqual(run(2, 1, [
  [post(1, 360, 0, { instanceId: 31 }), post(18)],
  [post(1, 75, 0, { lastAttackLanded: 21, instanceId: 32 }), post(18, 75, 0, { percent: 5, lastHitBy: 0, instanceHitBy: 31 })],
]).result, full(1, 1), "a trade credits the preceding attack instance before finishing");
assert.deepEqual(run(2, 1, [
  [post(1, 360, 0)], [post(1, 75, 0)],
]).result, full(1), "an interrupted activation completed without damage");
const open = run(2, 1, [[post(1, 360, 0)]], { close: false });
assert.deepEqual(open.result, full(1, 0, 0, 1), "game-end truncation is excluded from no-hit denominator");
assert.deepEqual(finishDownBAccumulator(open.acc).get(0), open.result, "finishing is idempotent");
assert.deepEqual(run(2, 1, [[post(1, 360, 0, {lastAttackLanded:21}), post(18,75,0,{percent:5,lastHitBy:0})]], { close: false }).result,
  full(1, 1), "a known hit remains known even if the game ends during its animation");

// Repeating Hand Slap is one held activation; Bowser's ascent/fall/landing and
// Falcon's wall rebound must also stay in their original activation.
assert.deepEqual(run(1, 3, [[post(3,383,0)], [post(3,384,0)], [post(3,384,30)], [post(3,384,0)], [post(3,385,0)], [post(3,386,0)]]).result, full(1));
assert.deepEqual(run(5, 5, [[post(5,361,0)], [post(5,361,29)], [post(5,362,30)], [post(5,363,0)]]).result, full(1));
assert.deepEqual(run(0, 2, [[post(2,357,0)], [post(2,363,0)], [post(2,362,0)]]).result, full(1));
assert.deepEqual(run(4, 4, [[post(4,396,0)], [post(4,397,0)], [post(4,394,0)], [post(4,394,0)], [post(4,395,0)]]).result, full(1));
assert.deepEqual(run(3, 24, [[post(24,375,0)], [post(24,375,20)], [post(24,375,4)], [post(24,376,0)], [post(24,375,4)], [post(24,378,4)]]).result, {attempts:1});
assert.deepEqual(run(3, 24, [[post(24,377,0)], [post(24,380,10)]]).result, {attempts:1}, "full bucket release can start directly in shoot state");
assert.deepEqual(run(16, 13, [[post(13,342,0)], [post(13,341,10)], [post(13,355,3)], [post(13,356,4)]]).result, {attempts:1}, "bomb jumps are not bomb attempts");
assert.deepEqual(run(14, 11, [[post(11,357,0)], [post(11,358,2)]]).result, {attempts:1}, "Nana can be the non-follower leader");

const transform = run(Character.SHEIK, 7, [
  [post(7,361,0)], [post(7,361,30)], [post(19,356,40)], [post(19,14)],
  [post(19,357,0)], [post(7,364,40)], [post(7,14)],
]);
assert.deepEqual(transform.result, {attempts:2}, "two transformations, not four form-change animations");

const gapped = run(2, 1, [[post(1,360,0)]], {close:false});
addDownBFrame(gapped.acc, {frame:999,players:{0:{post:post(1)},1:{post:post(18)}}});
assert.equal(finishDownBAccumulator(gapped.acc).get(0), null, "missing frame coverage is unknown");
for (const initial of [post(1), post(1,360,0)]) {
  const missingPrefix = createDownBAccumulator([{playerIndex:0,characterId:Character.FOX},{playerIndex:1,characterId:Character.MARTH}]);
  addDownBFrame(missingPrefix, {frame:1000,players:{0:{post:initial},1:{post:post(18)}}});
  addDownBFrame(missingPrefix, {frame:1001,players:{0:{post:post(1)},1:{post:post(18)}}});
  assert.equal(finishDownBAccumulator(missingPrefix).get(0), null, "a missing prefix cannot establish zero or complete attempt coverage");
}
assert.equal(run(2,1,[[post(1,361,0)]]).result, null, "missing initiation is not a measured attempt");
assert.equal(run(2,1,[[post(1,360,0,{actionStateCounter:undefined})]]).result, null, "missing animation counter is not measured coverage");
assert.equal(run(2,1,[[post(1,360,20)]]).result, null, "joining an advanced start animation is not a measured initiation");
assert.equal(run(2,1,[[post(22,360,0)]]).result, null, "unexplained character changes invalidate coverage");
assert.deepEqual(run(2,1,[[post(1,360,0),post(18,14,0,{percent:undefined})]]).result,{attempts:1},"missing damage evidence leaves attempts but no outcome rates");

// Consecutive processing across arbitrary batches must not change the result or
// grow retained memory with game length.
const repeated = run(2, 1, [], {close:false});
for (let i = 0; i < 10000; i++) repeated.feed(post(1,14,i));
assert.deepEqual(finishDownBAccumulator(repeated.acc).get(0), full(0));
assert.equal(repeated.acc.players.length, 2);
assert.equal(Object.keys(repeated.acc.players[0].previous).length, 6);
console.log("Down-B checks passed: all 26 characters, measured zeros, action phases, multi-hits, outcomes, transformations, and missing coverage.");
