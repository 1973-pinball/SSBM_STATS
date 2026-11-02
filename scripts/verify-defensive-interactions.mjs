/** Behavioral fixtures for defensive choices; synthetic replay frames only. */
import assert from "node:assert/strict";
import { Frames } from "@slippi/slippi-js";
import {
  createDefensiveAccumulator, addDefensiveFrame, finishDefensiveAccumulator,
  DEFENSIVE_OUTCOME_WINDOW_FRAMES, DEFENSIVE_SEQUENCE_WINDOW_FRAMES,
} from "../src/lib/defensiveInteractions.ts";

const settings = { isTeams: false, players: [{ playerIndex: 0, characterId: 2 }, { playerIndex: 1, characterId: 9 }] };
const post = (state = 14, extra = {}) => ({
  actionStateId: state, internalCharacterId: 1, isFollower: false,
  percent: 0, stocksRemaining: 4, lastHitBy: 255, hitlagRemaining: 0,
  isAirborne: (state >= 25 && state <= 34) || (state >= 65 && state <= 69) || state === 236 || state === 252 || state === 253,
  ...extra,
});
const totals = (outcome, attempts = 1) => ({ attempts, punished: 0, hit: 0, traded: 0, noHit: 0, incomplete: 0, [outcome]: attempts });
function replay() {
  const acc = createDefensiveAccumulator(settings);
  let frame = Frames.FIRST;
  let a = post(), b = post(14, { internalCharacterId: 18 });
  const feed = (nextA = a, nextB = b, preA = undefined) => {
    a = nextA; b = nextB;
    addDefensiveFrame(acc, { frame: frame++, players: { 0: { post: a, pre: preA }, 1: { post: b } } });
  };
  feed();
  return {
    acc, feed,
    frames: (count, nextA, nextB) => { for (let i = 0; i < count; i++) feed(nextA, nextB); },
    finish: () => finishDefensiveAccumulator(acc),
    skip: () => { frame++; },
    raw: (players) => addDefensiveFrame(acc, { frame: frame++, players }),
  };
}
function closedLedge(states, outcome = "noHit") {
  const r = replay();
  r.feed(post(252)); r.feed(post(253));
  for (const state of states) r.feed(post(state));
  r.frames(DEFENSIVE_OUTCOME_WINDOW_FRAMES, post(states.at(-1) === 253 ? 253 : 14));
  const stats = r.finish().get(0);
  assert.equal(Object.keys(stats.ledge).length, 1);
  assert.deepEqual(Object.values(stats.ledge)[0], totals(outcome));
  return Object.keys(stats.ledge)[0];
}
for (const [state, key] of [[254, "getup"], [255, "getup"], [256, "attack"], [257, "attack"], [258, "roll"], [259, "roll"], [260, "jump"], [262, "jump"]]) {
  assert.equal(closedLedge([state]), key, `built-in ledge state ${state}`);
}
assert.equal(closedLedge([29]), "drop");
assert.equal(closedLedge([29, 27, 27, 29]), "dropJump");
assert.equal(closedLedge([29, 27, 65]), "dropAerial");
assert.equal(closedLedge([29, 27, 236, 43]), "ledgedash");
assert.equal(closedLedge([29, 236, 43]), "drop", "airdodge without an observed jump is not a ledgedash");
assert.equal(closedLedge([29, 252, 253]), "regrab");
assert.equal(closedLedge([29, 341]), "unknown", "unsupported character state stays unknown");
{
  // Minimized local replay index0, frames3282–3309: the double jump rises
  // from below the stage for24 frames before the air dodge and landing.
  const r = replay(); r.feed(post(253)); r.frames(2, post(29)); r.frames(24, post(27));
  r.feed(post(236)); r.feed(post(43)); r.frames(3, post());
  assert.deepEqual(r.finish().get(0).ledge.ledgedash, totals("noHit"), "late continuous ledgedash stays recognizable");
}
{
  const r = replay(); r.feed(post(253)); r.frames(3, post(29)); r.frames(20, post(27));
  r.feed(post(66)); r.feed(post(66), post(75, { percent: 5, lastHitBy: 0 }));
  assert.deepEqual(r.finish().get(0).ledge.dropAerial, totals("hit"), "drop aerial can start after15 frames while rising");
}
for (const section of ["oos", "shieldExits"]) {
  // Actual replay indices538/615/846 omit236: landing and air dodge happen
  // within one frame. The pre-state/input supplies independent evidence.
  const r = replay(); r.feed(post(section === "oos" ? 181 : 179)); r.frames(4, post(24));
  r.feed(post(43), undefined, { actionStateId: 25, buttons: 64 }); r.frames(30, post());
  assert.deepEqual(r.finish().get(0)[section].wavedash, totals("noHit"));
}
{
  const r = replay(); r.feed(post(253)); r.feed(post(29)); r.frames(20, post(27));
  r.feed(post(43), undefined, { actionStateId: 27, buttons: 32 }); r.frames(30, post());
  assert.deepEqual(r.finish().get(0).ledge.ledgedash, totals("noHit"), "same-frame airdodge landing also applies at ledge");
}
{
  const r = replay(); r.feed(post(179)); r.feed(post(24)); r.feed(post(43)); r.frames(30, post());
  assert.deepEqual(r.finish().get(0).shieldExits.jump, totals("noHit"), "missing pre-input cannot establish an unobserved airdodge");
}
{
  const r = replay(); r.feed(post(181)); r.feed(post(244, { isAirborne: true })); r.frames(30, post());
  assert.deepEqual(r.finish().get(0).oos.fall, totals("noHit"), "Pass244 is a platform shield drop");
}
{
  const r = replay(); r.feed(post(181)); r.feed(post(251, { isAirborne: true })); r.feed(post(38, { isAirborne: true }));
  assert.deepEqual(r.finish().get(0).oos, {}, "forced shield slide-off is not a chosen OOS option");
}
{
  const r = replay();
  r.feed(post(253)); r.feed(post(258));
  r.feed(post(75, { percent: 8, lastHitBy: 1 }));
  r.feed(post(75, { percent: 16, lastHitBy: 1 }));
  assert.deepEqual(r.finish().get(0).ledge.roll, totals("punished"), "follow-up hits do not duplicate the outcome");
}
{
  const r = replay();
  r.feed(post(253)); r.feed(post(256));
  r.feed(post(256), post(223));
  assert.deepEqual(r.finish().get(0).ledge.attack, totals("hit"), "outgoing grab counts before pummel/throw damage");
}
{
  const r = replay();
  r.feed(post(253)); r.feed(post(255)); r.feed(post(223));
  assert.deepEqual(r.finish().get(0).ledge.getup, totals("punished"), "incoming grab counts without damage");
}
{
  const r = replay();
  r.feed(post(253)); r.feed(post(256));
  r.feed(post(75, { percent: 5, lastHitBy: 1 }), post(75, { percent: 7, lastHitBy: 0 }));
  assert.deepEqual(r.finish().get(0).ledge.attack, totals("traded"));
}
{
  const r = replay();
  r.feed(post(253)); r.feed(post(255));
  r.feed(post(75, { percent: 5, lastHitBy: 255 }));
  assert.deepEqual(r.finish().get(0).ledge.getup, totals("incomplete"), "unattributed damage is not an opponent punish");
}
for (const death of [post(0), post(14, { stocksRemaining: 3 })]) {
  const r = replay(); r.feed(post(253)); r.feed(post(29)); r.feed(death);
  assert.deepEqual(r.finish().get(0).ledge.drop, totals("incomplete"), "unattributed death is censored");
}
{
  const r = replay(); r.feed(post(253)); r.feed(post(258));
  assert.deepEqual(r.finish().get(0).ledge.roll, totals("incomplete"), "truncated observation is not a safe outcome");
  assert.deepEqual(r.finish().get(0).ledge.roll, totals("incomplete"), "finishing twice is idempotent");
}
for (const [contact, section] of [[false, "shieldExits"], [true, "oos"]]) {
  for (const [state, key] of [[212, "grab"], [233, "rollForward"], [234, "rollBackward"], [235, "spotDodge"], [24, "jump"], [29, "fall"], [180, "shieldRelease"], [341, "unknown"]]) {
    const r = replay(); r.feed(post(178)); r.feed(post(contact ? 181 : 179)); r.feed(post(state));
    r.frames(DEFENSIVE_OUTCOME_WINDOW_FRAMES, post());
    assert.deepEqual(r.finish().get(0)[section][key], totals("noHit"), `${section}/${key}`);
  }
}
for (const [sequence, key] of [[[24, 25, 65], "aerial"], [[24, 25, 236, 43], "wavedash"], [[24, 25, 341], "unknown"]]) {
  const r = replay(); r.feed(post(181));
  for (const state of sequence) r.feed(post(state, state === 341 ? { isAirborne: true } : {}));
  r.frames(DEFENSIVE_OUTCOME_WINDOW_FRAMES, post());
  assert.deepEqual(r.finish().get(0).oos[key], totals("noHit"), `OOS sequence ${key}`);
}
{
  const r = replay(); r.feed(post(181)); r.feed(post(24)); r.feed(post(25));
  r.feed(post(65), post(75, { percent: 5, lastHitBy: 0 }));
  assert.deepEqual(r.finish().get(0).oos.aerial, totals("hit"), "classify attack on the first contact frame");
}
{
  const r = replay(); r.feed(post(182)); r.feed(post(212)); r.feed(post(212), post(223));
  const result = r.finish().get(0);
  assert.deepEqual(result.shieldExits.grab, totals("hit"));
  assert.deepEqual(result.oos, {}, "powershield startup alone is not shield contact");
}
{
  const r = replay(); r.feed(post(181)); r.frames(31, post(179)); r.feed(post(212));
  r.frames(30, post());
  assert.deepEqual(r.finish().get(0).shieldExits.grab, totals("noHit"), "distant contact is not recent OOS pressure");
}
{
  const r = replay(); r.feed(post(179)); r.feed(post(223));
  assert.deepEqual(r.finish().get(0), { ledge: {}, oos: {}, shieldExits: {} }, "being grabbed out of shield is not a chosen exit");
}
{
  const r = replay(); r.feed(post(253)); r.feed(post(258));
  r.feed(post(179)); r.feed(post(181)); r.feed(post(212), post(223));
  const result = r.finish().get(0);
  assert.deepEqual(result.ledge.roll, totals("incomplete"));
  assert.deepEqual(result.oos.grab, totals("hit"), "one contact belongs only to the latest choice");
}
{
  const r = replay(); r.feed(post(181)); r.feed(post(24));
  r.frames(DEFENSIVE_SEQUENCE_WINDOW_FRAMES, post(25)); r.feed(post(65)); r.frames(30, post());
  assert.deepEqual(r.finish().get(0).oos.jump, totals("noHit"), "a much later aerial is not relabeled OOS");
}
// Window includes the exit frame and the next 29 frames, never the 31st.
for (const [delay, outcome] of [[28, "punished"], [29, "noHit"]]) {
  const r = replay(); r.feed(post(253)); r.feed(post(255)); r.frames(delay, post());
  r.feed(post(75, { percent: 10, lastHitBy: 1 }));
  assert.deepEqual(r.finish().get(0).ledge.getup, totals(outcome));
}
{
  const r = replay(); r.feed(post(253)); r.skip(); r.feed(post(255));
  assert.equal(r.finish().get(0), undefined, "frame gaps invalidate coverage instead of supplying partial totals");
}
{
  const r = replay(); r.raw({ 0: { post: post() } });
  assert.equal(r.finish().get(0), undefined, "missing opponent prevents outcome measurement");
  assert.equal(r.finish().get(1), undefined);
}
{
  const r = replay(); r.feed(post(14, { isAirborne: undefined }));
  assert.equal(r.finish().get(0), undefined, "missing own classification fields invalidates that player's coverage");
  assert.deepEqual(r.finish().get(1), { ledge: {}, oos: {}, shieldExits: {} });
}
{
  const r = replay(); r.feed(post(14, { lastHitBy: undefined }));
  assert.equal(r.finish().get(0), undefined);
  assert.equal(r.finish().get(1), undefined, "missing attribution also affects the opponent's outcomes");
}
assert.equal(createDefensiveAccumulator({ ...settings, isTeams: true }), null);
assert.equal(createDefensiveAccumulator({ ...settings, players: settings.players.slice(0, 1) }), null);
assert.equal(finishDefensiveAccumulator(createDefensiveAccumulator(settings)).get(0), undefined, "no frames is unknown coverage");
assert.deepEqual([...finishDefensiveAccumulator(null)], []);
console.log("Defensive interaction checks passed (choices, sequences, first interactions, censoring, and coverage).");
