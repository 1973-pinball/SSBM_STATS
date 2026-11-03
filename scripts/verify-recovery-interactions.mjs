import assert from "node:assert/strict";
import {
  addRecoveryFrame, createRecoveryAccumulator, finishRecoveryAccumulator, RECOVERY_RETURN_FRAMES,
} from "../src/lib/recoveryInteractions.ts";

const settings = (extra = {}) => ({ stageId: 31, isTeams: false, isFrozenPS: false,
  players: [{ playerIndex: 0 }, { playerIndex: 1 }], ...extra });
const post = (extra = {}) => ({ positionX: 0, positionY: 0, actionStateId: 14, percent: 0,
  stocksRemaining: 4, lastHitBy: 255, isAirborne: false, isFollower: false, ...extra });
const recovering = (extra = {}) => post({ positionX: 90, positionY: 20, actionStateId: 29,
  percent: 20, lastHitBy: 1, isAirborne: true, ...extra });
const holding = () => post({ positionX: 71.3, positionY: -8, actionStateId: 253, isAirborne: true });
function fixture(options) {
  const acc = createRecoveryAccumulator(settings(options));
  assert.ok(acc);
  let frame = 0;
  const feed = (a = post(), b = post()) => addRecoveryFrame(acc, { frame: frame++, players: { 0: { post: a }, 1: { post: b } } });
  feed();
  const launch = (extra = {}) => feed(recovering({ actionStateId: 87, ...extra }));
  const land = (b = post(), extra = {}) => {
    for (let i = 0; i < RECOVERY_RETURN_FRAMES; i++) feed(recovering({ positionX: 40, positionY: 0,
      actionStateId: 14, isAirborne: false, ...extra }), b);
  };
  const result = () => finishRecoveryAccumulator(acc);
  return { acc, feed, launch, land, result };
}
const sum = (rows, key) => Object.values(rows).reduce((n, row) => n + row[key], 0);

// A high approach is measured independently of the forced launch trajectory.
{
  const f = fixture();
  f.launch({ positionY: -20 });
  f.feed(recovering());
  f.land();
  const me = f.result().get(0), opp = f.result().get(1);
  assert.deepEqual(me.recoveries.high, { attempts: 1, reachedLedge: 0, hitDuringRecovery: 0, returned: 1, died: 0, incomplete: 0 });
  assert.equal(opp.edgeguards.unknown.opportunities, 1);
  assert.equal(opp.edgeguards.unknown.opponentReturned, 1);
  assert.equal(opp.edgeguards.unknown.contested, 0);
}

// Reaching ledge is a milestone, not success; regrabs stay one episode.
{
  const f = fixture();
  f.launch();
  f.feed(recovering({ positionY: -20 }));
  f.feed(recovering({ positionX: 71, positionY: -8, actionStateId: 252 }));
  f.feed(recovering({ positionX: 75, positionY: -15 }));
  f.feed(recovering({ positionX: 71, positionY: -8, actionStateId: 252 }));
  f.feed(recovering({ actionStateId: 0, stocksRemaining: 3, positionY: -120 }));
  const me = f.result().get(0), opp = f.result().get(1);
  assert.deepEqual(me.recoveries.low, { attempts: 1, reachedLedge: 1, hitDuringRecovery: 0, returned: 0, died: 1, incomplete: 0 });
  assert.equal(opp.edgeguards.unknown.uncontestedDeaths, 1);
  assert.equal(opp.edgeguards.unknown.stocksTaken, 0);
}

// The initiating launch is excluded; all later opponent hits count once per
// attempt, including a rehit before the first actionable recovery frame.
{
  const f = fixture();
  f.launch();
  f.feed(recovering({ actionStateId: 87, percent: 25 }));
  f.feed(recovering({ percent: 25 }));
  f.land(post(), { percent: 25 });
  assert.equal(f.result().get(0).recoveries.high.hitDuringRecovery, 1,
    "a rehit before recovery eligibility is preserved once the attempt qualifies");
}
{
  const f = fixture();
  f.launch();
  f.feed(recovering({ actionStateId: 87, percent: 25 }));
  f.feed(recovering({ percent: 25 }));
  f.feed(recovering({ actionStateId: 87, percent: 35 }));
  f.feed(recovering({ percent: 35 }));
  f.land(post(), { percent: 35 });
  assert.equal(f.result().get(0).recoveries.high.hitDuringRecovery, 1,
    "multiple rehits, including one before eligibility, count one hit recovery");
  f.launch({ percent: 55 });
  f.feed(recovering({ percent: 55 }));
  f.land(post(), { percent: 55 });
  const row = f.result().get(0).recoveries.high;
  assert.equal(row.attempts, 2);
  assert.equal(row.hitDuringRecovery, 1, "hit observation resets between recovery attempts");
}

// Holding ledge and grabs without damage are contests, but not observed hits.
// Stale attacker IDs on magnifier ticks, self-damage, and unattributed damage
// also cannot establish that the opponent hit this recovery.
for (const extra of [
  { actionStateId: 223, percent: 20 },
  { percent: 21 },
  { actionStateId: 87, percent: 21, lastHitBy: 0 },
  { actionStateId: 87, percent: 21, lastHitBy: 255 },
]) {
  const f = fixture();
  f.launch();
  f.feed(recovering(), holding());
  f.feed(recovering(extra), holding());
  f.land(post(), { percent: extra.percent });
  const result = f.result();
  assert.equal(result.get(0).recoveries.high.hitDuringRecovery, 0,
    `non-opponent-hit evidence does not count: ${JSON.stringify(extra)}`);
  assert.ok(sum(result.get(1).edgeguards, "contested") > 0,
    "the hit metric is distinct from the existing positional contest metric");
}

// Hitlag can establish a fresh opponent hit even during a non-damage animation.
{
  const f = fixture();
  f.launch(); f.feed(recovering());
  f.feed(recovering({ actionStateId: 65, percent: 25, hitlagRemaining: 2 }));
  f.land(post(), { percent: 25 });
  assert.equal(f.result().get(0).recoveries.high.hitDuringRecovery, 1);
}

// Observed hits survive an unresolved ending; repeated finish calls do not
// increment them. A launch KO with rehits but no recovery eligibility stays out.
{
  const f = fixture();
  f.launch(); f.feed(recovering());
  f.feed(recovering({ actionStateId: 87, percent: 30 }));
  const result = f.result();
  assert.equal(result.get(0).recoveries.high.hitDuringRecovery, 1);
  assert.equal(result.get(0).recoveries.high.incomplete, 1);
  assert.deepEqual(f.result(), result);
  const ko = fixture();
  ko.launch();
  ko.feed(recovering({ actionStateId: 87, percent: 30 }));
  ko.feed(recovering({ actionStateId: 0, percent: 30, stocksRemaining: 3 }));
  assert.deepEqual(ko.result().get(0).recoveries, {});
}

// No new hit is required for observing a ledge-hold contest.
{
  const f = fixture();
  f.launch();
  f.feed(recovering({ positionY: -20 }), holding());
  f.feed(recovering({ actionStateId: 0, stocksRemaining: 3, positionY: -120 }), holding());
  assert.deepEqual(f.result().get(1).edgeguards.holdLedge, {
    opportunities: 1, contested: 1, completedContests: 1, stocksTaken: 1,
    opponentReturned: 0, uncontestedDeaths: 0, incomplete: 0,
  });
}

// Failed contests belong in the rate denominator, including a high -> low sequence.
{
  const f = fixture();
  f.launch();
  f.feed(recovering(), post({ positionX: 85, positionY: 25, actionStateId: 25, isAirborne: true }));
  f.feed(recovering({ positionY: -15 }), post({ positionX: 85, positionY: -10, actionStateId: 29, isAirborne: true }));
  f.land();
  assert.equal(f.result().get(0).recoveries.mixed.returned, 1);
  const row = f.result().get(1).edgeguards.mixed;
  assert.equal(row.completedContests, 1);
  assert.equal(row.opponentReturned, 1);
  assert.equal(row.stocksTaken, 0);
}

// Voluntary offstage movement, a routine ledge drop, and uninterrupted launch KOs are excluded.
{
  const f = fixture();
  f.feed(post({ positionX: 85, positionY: 10, actionStateId: 25, isAirborne: true }));
  f.feed(post({ positionX: 71, positionY: -8, actionStateId: 253, isAirborne: true }));
  f.feed(post({ positionX: 85, positionY: -15, actionStateId: 29, isAirborne: true }));
  f.feed(post());
  f.launch();
  f.feed(recovering({ actionStateId: 87, positionX: 150 }));
  f.feed(recovering({ actionStateId: 0, stocksRemaining: 3, positionX: 230 }));
  assert.deepEqual(f.result().get(0).recoveries, {});
  assert.deepEqual(f.result().get(1).edgeguards, {});
}

// Interrupted landing cannot be counted as a safe return; confirmed landing followed by jump can.
{
  const f = fixture();
  f.launch(); f.feed(recovering());
  for (let i = 0; i < 20; i++) f.feed(recovering({ positionX: 40, positionY: 0, actionStateId: 14, isAirborne: false }));
  f.feed(recovering({ positionX: 40, positionY: 0, actionStateId: 223, isAirborne: false }));
  assert.equal(sum(f.result().get(0).recoveries, "returned"), 0);
  f.feed(recovering({ positionX: 40, positionY: 0, actionStateId: 14, isAirborne: false }));
  for (let i = 0; i < 29; i++) f.feed(recovering({ positionX: 40, positionY: 15, actionStateId: 25 }));
  assert.equal(sum(f.result().get(0).recoveries, "returned"), 1);
}

// Terminal eligible episodes are incomplete and excluded from completed contest denominators.
{
  const f = fixture();
  f.launch(); f.feed(recovering(), holding());
  const result = f.result();
  assert.equal(result.get(0).recoveries.high.incomplete, 1);
  assert.equal(result.get(1).edgeguards.holdLedge.contested, 1);
  assert.equal(result.get(1).edgeguards.holdLedge.completedContests, 0);
  assert.equal(result.get(1).edgeguards.holdLedge.incomplete, 1);
  assert.deepEqual(f.result(), result, "finishing twice must not double count");
}

// A later stock's neutral play cannot become part of the previous player's edgeguard.
{
  const f = fixture();
  f.launch(); f.feed(recovering(), holding());
  f.feed(recovering(), post({ actionStateId: 0, stocksRemaining: 3 }));
  f.land(post({ stocksRemaining: 3 }));
  const row = f.result().get(1).edgeguards.holdLedge;
  assert.equal(row.incomplete, 1);
  assert.equal(row.completedContests, 0);
  assert.equal(f.result().get(0).recoveries.high.returned, 1);
}

// Stage geometry changes whether a given x position is offstage; Stadium needs explicit freeze evidence.
{
  const fd = fixture({ stageId: 32 });
  fd.launch({ positionX: 80 }); fd.feed(recovering({ positionX: 80 })); fd.land();
  assert.deepEqual(fd.result().get(0).recoveries, {});
  for (const options of [{ stageId: 3 }, { stageId: 3, isFrozenPS: null }, { stageId: 99 }]) {
    const f = fixture(options); f.launch(); f.feed(recovering()); f.land();
    assert.equal(f.result().get(0), undefined);
  }
  const ps = fixture({ stageId: 3, isFrozenPS: true });
  ps.launch({ positionX: 105 }); ps.feed(recovering({ positionX: 105 })); ps.land();
  assert.equal(ps.result().get(0).recoveries.high.returned, 1);
}

// Missing fields and missing frames invalidate coverage instead of manufacturing zero attempts.
{
  const f = fixture(); f.launch(); f.feed(recovering({ positionY: null }));
  assert.equal(f.result().get(0), undefined);
  assert.equal(f.result().get(1), undefined);
  const gap = fixture();
  addRecoveryFrame(gap.acc, { frame: 3, players: { 0: { post: post() }, 1: { post: post() } } });
  assert.equal(gap.result().get(0), undefined);
  assert.equal(createRecoveryAccumulator(settings({ isTeams: true })), null);
}

// Replay-trace regressions: transient landing roots, missed-tech slide-offs,
// stale attacker IDs on non-reactive damage, and ledge-animation route leakage.
{
  const f = fixture();
  f.feed(recovering({ positionX: 39, positionY: -6, actionStateId: 80 }));
  f.land();
  assert.deepEqual(f.result().get(0).recoveries, {}, "one frame below the floor at center stage is not a recovery");
}
{
  const f = fixture();
  f.feed(recovering({ positionX: 39, positionY: 27, actionStateId: 91 }));
  for (let i = 0; i < 25; i++) f.feed(recovering({ positionX: 45, positionY: 27, actionStateId: 183, isAirborne: false }));
  for (let i = 0; i < 8; i++) f.feed(recovering({ positionX: 60, positionY: 27 }));
  f.feed(recovering({ positionX: 75, positionY: 15 }));
  f.feed(recovering({ positionX: 71, positionY: -23, actionStateId: 252 }));
  f.feed(recovering({ positionX: 71, positionY: -23, actionStateId: 255 }));
  f.land();
  assert.equal(f.result().get(0).recoveries.high.returned, 1, "forced slide-off remains associated with the preceding hit");
  assert.equal(f.result().get(0).recoveries.mixed, undefined, "ledge get-up height does not alter the approach route");
}
{
  const f = fixture();
  f.feed(recovering({ percent: 0, lastHitBy: 1, positionX: 160 }));
  f.feed(recovering({ percent: 1, lastHitBy: 1, positionX: 160 }));
  assert.deepEqual(f.result().get(0).recoveries, {}, "offscreen percent ticks with stale lastHitBy do not start recoveries");
  const active = fixture();
  active.launch(); active.feed(recovering({ positionX: 150 }));
  active.feed(recovering({ positionX: 150, percent: 21 }));
  active.feed(recovering({ positionX: 150, percent: 21, actionStateId: 0, stocksRemaining: 3 }));
  assert.equal(active.result().get(1).edgeguards.unknown.uncontestedDeaths, 1,
    "non-reactive offscreen damage cannot turn an unattended death into a contest");
}
{
  const f = fixture({ stageId: 8 });
  f.launch({ positionX: 70 }); f.feed(recovering({ positionX: 70 }));
  f.land(post(), { positionX: 48, positionY: -2 });
  assert.equal(f.result().get(0).recoveries.high.returned, 1, "grounded return on Yoshi's slope does not require walking to center stage");
}
{
  const f = fixture();
  f.feed(recovering({ positionX: 50, positionY: 35, actionStateId: 87 }));
  for (let i = 0; i < 35; i++) f.feed(recovering({ positionX: 65, positionY: 15, actionStateId: 38 }));
  f.feed(recovering({ positionX: 75, positionY: 10, actionStateId: 38 }));
  f.feed(recovering({ positionX: 80, positionY: 5, actionStateId: 27 }));
  f.land();
  assert.equal(f.result().get(0).recoveries.high.returned, 1, "a continuing tumble cannot expire before crossing the edge");
  const intentional = fixture();
  intentional.feed(recovering({ positionX: 50, positionY: 35, actionStateId: 87 }));
  intentional.feed(recovering({ positionX: 50, positionY: 0, actionStateId: 14, isAirborne: false }));
  intentional.feed(recovering({ positionX: 50, positionY: 20, actionStateId: 66 }));
  intentional.feed(recovering({ positionX: 90, positionY: 20 }));
  assert.deepEqual(intentional.result().get(0).recoveries, {}, "grounded control ends pending forced-launch attribution before a voluntary aerial excursion");
}
{
  const f = fixture();
  f.launch();
  f.feed(recovering({ positionX: 100, positionY: 160 }), post({ positionX: 50, positionY: 0, actionStateId: 60 }));
  f.feed(recovering({ positionX: 100, positionY: 160, actionStateId: 0, stocksRemaining: 3 }));
  assert.equal(f.result().get(1).edgeguards.unknown.uncontestedDeaths, 1,
    "an unrelated grounded attack far below a recovering player is not an observed contest");
}
{
  const f = fixture({ stageId: 28 });
  f.feed(recovering({ positionX: 0, positionY: 0, actionStateId: 89 }));
  for (let i = 0; i < 40; i++) f.feed(recovering({ positionX: 77.3, positionY: 0, actionStateId: 201, isAirborne: false }));
  f.feed(recovering({ positionX: 78, positionY: -5.6 }));
  f.feed(recovering({ positionX: 83.8, positionY: -20.7, actionStateId: 252 }));
  f.land();
  assert.equal(f.result().get(0).recoveries.low.reachedLedge, 1,
    "a tech-roll slide-off just beyond the lip counts even inside the horizontal tolerance");
}

console.log("Recovery interactions: trajectory, ledge, observed recovery hits, contested outcomes, stage coverage, gaps and incomplete episodes passed.");
