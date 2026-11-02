import assert from "node:assert/strict";
import { createPunishAccumulator, addPunishFrame, finishPunishAccumulator } from "../src/lib/punishContext.ts";

function fixture() {
  const acc = createPunishAccumulator({ players: [{ playerIndex: 0 }, { playerIndex: 1 }], isTeams: false });
  let fn = -123;
  let mine = { actionStateId: 14, percent: 0, stocksRemaining: 4, lastHitBy: 255, internalCharacterId: 1, hitlagRemaining: 0 };
  const feed = (patch = {}, count = 1) => {
    mine = { ...mine, ...patch };
    for (let i = 0; i < count; i++) addPunishFrame(acc, { frame: fn++, players: { 0: { post: mine }, 1: { post: { ...mine, percent: 0, actionStateId: 14 } } } });
  };
  feed();
  return { acc, feed, result: () => finishPunishAccumulator(acc).get(0) };
}

{
  const f = fixture();
  f.feed({ actionStateId: 65 });
  f.feed({ actionStateId: 14 }, 10);
  f.feed({ actionStateId: 75, percent: 12, lastHitBy: 1 });
  f.feed({ percent: 20 });
  f.feed({ actionStateId: 14 }, 45);
  assert.deepEqual(f.result().beforeOpening.nair, { openings: 1, damage: 20, kills: 0, incomplete: 0 }, "combo followups don't become new openings; recent completed aerial is preserved");
  f.feed({ actionStateId: 233 });
  f.feed({ actionStateId: 223 });
  f.feed({ actionStateId: 75, percent: 27 });
  f.feed({ actionStateId: 0, stocksRemaining: 3, percent: 0 });
  assert.deepEqual(f.result().beforeOpening.roll, { openings: 1, damage: 7, kills: 1, incomplete: 0 }, "grab starts episode before pummel damage; attributed stock loss closes it");
}
{
  const f = fixture();
  f.feed({ actionStateId: 58 });
  f.feed({ actionStateId: 14 }, 31);
  f.feed({ actionStateId: 75, percent: 5, lastHitBy: 1 });
  assert.deepEqual(f.result().beforeOpening.groundMovement, { openings: 1, damage: 0, kills: 0, incomplete: 1 }, "expired context is not blamed, truncated damage omitted from resolved denominator");
  assert.deepEqual(f.result(), f.result(), "finish is a repeatable snapshot");
}
{
  const f = fixture();
  f.feed({ actionStateId: 14, percent: 1, lastHitBy: 0 });
  assert.deepEqual(f.result().beforeOpening, {}, "self damage is not an opening");
  addPunishFrame(f.acc, { frame: 99, players: {} });
  assert.equal(f.result(), undefined, "missing frames cannot masquerade as measured zeros");
}
assert.equal(createPunishAccumulator({ isTeams: true, players: [{}, {}, {}, {}] }), null);
for (const rapidJabPhase of [47, 48, 49]) {
  const f = fixture();
  f.feed({ actionStateId: rapidJabPhase });
  f.feed({ actionStateId: 75, percent: 6, lastHitBy: 1 });
  f.feed({ actionStateId: 14 }, 45);
  assert.equal(f.result().beforeOpening.jab.openings, 1, "rapid-jab start, loop and end retain jab context");
}
{
  const f = fixture();
  f.feed({ actionStateId: 214 }, 15);
  f.feed({ actionStateId: 18 });
  f.feed({ actionStateId: 20 }, 7);
  f.feed({ actionStateId: 18 });
  f.feed({ actionStateId: 20 }, 8);
  f.feed({ actionStateId: 226 });
  assert.equal(f.result().beforeOpening.groundMovement.openings, 1,
    "a grab after deliberate dash dancing belongs to movement, not an earlier attempted grab");
  assert.equal(f.result().beforeOpening.grab, undefined);
}
console.log("Punish context: opening attribution, combo grouping, grabs, stock loss, lookback, truncation and coverage checks passed.");
