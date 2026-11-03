import { Frames, isCommandGrabbed, isGrabbed, isDead, type FrameEntryType, type GameStartType } from "@slippi/slippi-js";

export type RecoveryRoute = "high" | "low" | "mixed" | "unknown";
export type EdgeguardTactic = "onstage" | "holdLedge" | "high" | "low" | "mixed" | "unknown";
export const RECOVERY_ROUTE_LABELS: Record<RecoveryRoute, string> = {
  high: "High", low: "Low", mixed: "Mixed", unknown: "Unclassified",
};
export const EDGEGUARD_TACTIC_LABELS: Record<EdgeguardTactic, string> = {
  onstage: "Onstage", holdLedge: "Hold ledge", high: "Offstage high", low: "Offstage low", mixed: "Mixed", unknown: "Uncontested / unclear",
};

export interface RecoveryOutcomes {
  attempts: number;
  /** Overlapping milestone: reaching ledge does not end a recovery. */
  reachedLedge: number;
  /** Attempts with an observed opponent hit after the initial launch, including
   * incomplete attempts. Absent in older analyses; absence is not zero hits. */
  hitDuringRecovery?: number;
  returned: number;
  died: number;
  incomplete: number;
}
export interface EdgeguardOutcomes {
  opportunities: number;
  /** Overlapping counts; only completedContests is a stock-loss-rate denominator. */
  contested: number;
  completedContests: number;
  /** Opponent stock loss during a contest, not proof that the tactic caused it. */
  stocksTaken: number;
  opponentReturned: number;
  uncontestedDeaths: number;
  incomplete: number;
}
export interface RecoveryStats {
  recoveries: Partial<Record<RecoveryRoute, RecoveryOutcomes>>;
  edgeguards: Partial<Record<EdgeguardTactic, EdgeguardOutcomes>>;
}

export const RECOVERY_RETURN_FRAMES = 30;
export const RECOVERY_APPROACH_DISTANCE = 40;
const HEIGHT_BAND = 5;
// Fighter roots briefly dip below the floor before landing collision resolves.
// A shallow negative Y at center stage is not evidence of being offstage.
const UNDER_STAGE_DEPTH = 20;
const EDGE_MARGIN = 2;
const RECENT_LAUNCH_FRAMES = 15;
const CONTEST_DISTANCE = 60;
const ONSTAGE_CONTEST_DISTANCE = 25;

/** Ground edge coordinates, not the fighter's displaced ledge-hang position.
 * Source: libmelee's measured EDGE_GROUND_POSITION (checked 2026-11-02):
 * https://github.com/altf4/libmelee/blob/master/melee/stages.py
 * Replay stage IDs are the internal IDs used by Slippi, not CSS IDs.
 * Unfrozen/unknown Stadium is excluded because transformations change geometry.
 */
const GROUND_EDGES: Readonly<Record<number, number>> = {
  2: 63.3475494385, 3: 87.75, 8: 56, 28: 77.2713012695,
  31: 68.4000015259, 32: 85.5656967163,
};

type RawPost = NonNullable<FrameEntryType["players"][number]>["post"];
interface Sample {
  x: number; y: number; state: number; percent: number; stocks: number;
  airborne: boolean; lastHitBy: number; hitlag: number;
}
type Tactic = Exclude<EdgeguardTactic, "mixed" | "unknown">;
interface Episode {
  side: number;
  started: number;
  eligible: boolean;
  reachedLedge: boolean;
  wasHitDuringRecovery: boolean;
  landed: boolean;
  stableFrames: number;
  high: boolean;
  low: boolean;
  approachEnded: boolean;
  tactics: Set<Tactic>;
  opponentStock: number;
  opponentLostStock: boolean;
}
interface PlayerTrack {
  index: number;
  previous: Sample | null;
  launchUntil: number;
  episode: Episode | null;
  stats: RecoveryStats;
}
export interface RecoveryAccumulator {
  edge: number | null;
  players: PlayerTrack[];
  previousFrame: number | null;
  valid: boolean;
  seen: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const cliff = (state: number): boolean => state === 252 || state === 253;
const damageAnimation = (state: number): boolean => state >= 75 && state <= 91;
const captured = (state: number): boolean => isGrabbed(state) || isCommandGrabbed(state);
const disabled = (state: number): boolean => damageAnimation(state) || captured(state) || isDead(state)
  || state === 12 || state === 13 || state === 251 || (state >= 183 && state <= 204);
const attacking = (state: number): boolean => (state >= 44 && state <= 69) || (state >= 212 && state <= 222) || state >= 341;
const offstage = (post: Sample, edge: number): boolean => Math.abs(post.x) > edge + EDGE_MARGIN
  || (Math.abs(post.x) > edge - 4 && post.y < -HEIGHT_BAND) || post.y < -UNDER_STAGE_DEPTH;
// The tolerance includes Yoshi's sloped outer floor while excluding Randall.
const inStage = (post: Sample, edge: number): boolean => Math.abs(post.x) <= edge && post.y >= -HEIGHT_BAND;
const freshHit = (post: Sample, previous: Sample | null, opponentIndex: number): boolean => !!previous
  && post.stocks === previous.stocks && post.percent > previous.percent && post.lastHitBy === opponentIndex
  // lastHitBy persists. Magnifier/self-damage must not manufacture a launch or contest.
  && (damageAnimation(post.state) || captured(post.state) || post.hitlag > 0);

function sample(post: RawPost | undefined): Sample | null {
  if (!post || !finite(post.positionX) || !finite(post.positionY) || !finite(post.actionStateId)
    || !finite(post.percent) || !finite(post.stocksRemaining) || !finite(post.lastHitBy)
    || typeof post.isAirborne !== "boolean" || post.isFollower === true) return null;
  return { x: post.positionX, y: post.positionY, state: post.actionStateId,
    percent: post.percent, stocks: post.stocksRemaining, airborne: post.isAirborne, lastHitBy: post.lastHitBy,
    hitlag: finite(post.hitlagRemaining) ? post.hitlagRemaining : 0 };
}

export function createRecoveryAccumulator(settings: GameStartType): RecoveryAccumulator | null {
  if (settings.isTeams || settings.players.length !== 2) return null;
  const stage = settings.stageId;
  const edge = !finite(stage) || (stage === 3 && settings.isFrozenPS !== true) ? null : GROUND_EDGES[stage] ?? null;
  return { edge, players: settings.players.map((p) => ({ index: p.playerIndex, previous: null,
    launchUntil: -Infinity, episode: null, stats: { recoveries: {}, edgeguards: {} } })),
  previousFrame: null, valid: edge !== null, seen: false };
}

function routeOf(episode: Episode): RecoveryRoute {
  return episode.high ? episode.low ? "mixed" : "high" : episode.low ? "low" : "unknown";
}
function tacticOf(episode: Episode): EdgeguardTactic {
  return episode.tactics.size > 1 ? "mixed" : episode.tactics.values().next().value ?? "unknown";
}
function copyStats(stats: RecoveryStats): RecoveryStats {
  return {
    recoveries: Object.fromEntries(Object.entries(stats.recoveries).map(([k, v]) => [k, { ...v }])),
    edgeguards: Object.fromEntries(Object.entries(stats.edgeguards).map(([k, v]) => [k, { ...v }])),
  };
}
function record(episode: Episode, outcome: "returned" | "died" | "incomplete", recovering: RecoveryStats, guarding: RecoveryStats): void {
  // A straight launch KO before any actionable offstage frame is not a recovery attempt.
  if (!episode.eligible) return;
  const route = routeOf(episode);
  const recovery = recovering.recoveries[route] ??= {
    attempts: 0, reachedLedge: 0, hitDuringRecovery: 0, returned: 0, died: 0, incomplete: 0,
  };
  recovery.attempts++;
  recovery[outcome]++;
  if (episode.reachedLedge) recovery.reachedLedge++;
  if (episode.wasHitDuringRecovery) recovery.hitDuringRecovery = (recovery.hitDuringRecovery ?? 0) + 1;
  const tactic = tacticOf(episode);
  const edgeguard = guarding.edgeguards[tactic] ??= {
    opportunities: 0, contested: 0, completedContests: 0, stocksTaken: 0, opponentReturned: 0, uncontestedDeaths: 0, incomplete: 0,
  };
  edgeguard.opportunities++;
  const contested = episode.tactics.size > 0;
  if (contested) edgeguard.contested++;
  if (outcome === "incomplete" || episode.opponentLostStock) edgeguard.incomplete++;
  else {
    if (contested) edgeguard.completedContests++;
    if (outcome === "returned") edgeguard.opponentReturned++;
    else if (contested) edgeguard.stocksTaken++;
    else edgeguard.uncontestedDeaths++;
  }
}

function observeContest(episode: Episode, post: Sample, opponent: Sample, edge: number, hit: boolean): void {
  if (episode.opponentLostStock || (disabled(opponent.state) && !hit)) return;
  const sameSide = opponent.x * (Math.sign(post.x) || episode.side) > 0;
  const approaching = offstage(post, edge) || cliff(post.state);
  if (approaching && cliff(opponent.state) && sameSide && Math.abs(Math.abs(opponent.x) - edge) <= 12) {
    episode.tactics.add("holdLedge");
    return;
  }
  if (!sameSide) {
    // A projectile hit from far away is a contest, but its origin is still onstage.
    if (hit && inStage(opponent, edge)) episode.tactics.add("onstage");
    return;
  }
  const distance = Math.hypot(opponent.x - post.x, opponent.y - post.y);
  if (offstage(opponent, edge) && (hit || (approaching && distance <= CONTEST_DISTANCE))) {
    episode.tactics.add(opponent.y < 0 ? "low" : "high");
  } else if (inStage(opponent, edge) && (hit || (attacking(opponent.state)
    && Math.abs(opponent.x) >= edge - ONSTAGE_CONTEST_DISTANCE && distance <= CONTEST_DISTANCE))) {
    episode.tactics.add("onstage");
  }
}

/** One compact state machine per player. No frame objects or trajectories are retained.
 * Route uses controlled movement in the 40-unit approach corridor: above +5 is
 * high, below -5 is low, both is mixed. The launch/hitstun path is excluded.
 * Route sampling stops at the first ledge catch or onstage landing: subsequent
 * ledge get-up animations cannot retroactively turn a high approach into low.
 * A return needs a landing followed by 30 continuous non-disabled frames within
 * the stage bounds; getting hit or grabbed resets that interval. Ledge is only
 * a milestone, so regrabs and ledgedashes stay in the same recovery episode.
 */
export function addRecoveryFrame(acc: RecoveryAccumulator, frame: FrameEntryType): void {
  if (!acc.valid || acc.edge === null) return;
  if (!Number.isInteger(frame.frame) || (acc.previousFrame !== null && frame.frame !== acc.previousFrame + 1)) {
    acc.valid = false; return;
  }
  acc.previousFrame = frame.frame;
  const samples = acc.players.map((p) => sample(frame.players?.[p.index]?.post));
  if (samples.some((p) => p === null)) { acc.valid = false; return; }
  if (frame.frame < Frames.FIRST_PLAYABLE) {
    acc.players.forEach((p, i) => { p.previous = samples[i]!; });
    return;
  }
  acc.seen = true;
  for (let i = 0; i < 2; i++) {
    const player = acc.players[i]!;
    const opponentPlayer = acc.players[1 - i]!;
    const post = samples[i]!;
    const opponent = samples[1 - i]!;
    const hit = freshHit(post, player.previous, opponentPlayer.index);
    const died = isDead(post.state) || (player.previous !== null && post.stocks < player.previous.stocks);
    const outside = offstage(post, acc.edge);
    if (hit || (damageAnimation(post.state) && post.lastHitBy === opponentPlayer.index) || post.state === 251) {
      player.launchUntil = frame.frame + RECENT_LAUNCH_FRAMES;
    }
    // A missed-tech slide-off can spend longer than the lookback in knockdown.
    // Preserve the confirmed launch through that forced phase, not through a
    // later grounded action such as deliberately running or jumping offstage.
    const passiveLaunchState = (post.state >= 183 && post.state <= 204) || (post.state >= 29 && post.state <= 38)
      || post.state === 42 || post.state === 43;
    if (player.launchUntil > -Infinity && passiveLaunchState) {
      player.launchUntil = frame.frame + RECENT_LAUNCH_FRAMES;
    }
    if (!outside && !disabled(post.state) && !post.airborne && !passiveLaunchState) player.launchUntil = -Infinity;
    if (!player.episode && !died && outside && post.airborne && player.launchUntil >= frame.frame) {
      player.episode = { side: Math.sign(post.x) || Math.sign(player.previous?.x ?? 1) || 1,
        started: frame.frame, eligible: false, reachedLedge: false, wasHitDuringRecovery: false, landed: false, stableFrames: 0,
        high: false, low: false, approachEnded: false, tactics: new Set(), opponentStock: opponent.stocks, opponentLostStock: false };
    }
    const episode = player.episode;
    if (!episode) continue;
    // Exclude the hit that starts this episode. Later hits count even during
    // the launch's disabled frames, provided the episode ultimately qualifies
    // as a recovery. Track once per attempt, not once per damaging frame.
    if (hit && frame.frame > episode.started) episode.wasHitDuringRecovery = true;
    if (opponent.stocks < episode.opponentStock || isDead(opponent.state)) episode.opponentLostStock = true;
    if (cliff(post.state)) { episode.reachedLedge = true; episode.eligible = true; episode.approachEnded = true; }
    if (!post.airborne && inStage(post, acc.edge)) episode.approachEnded = true;
    if (outside && !disabled(post.state) && !cliff(post.state)) {
      episode.eligible = true;
      // Do not use the ledge catch itself to force every route into the low bucket.
      if (!episode.approachEnded && Math.abs(post.x) <= acc.edge + RECOVERY_APPROACH_DISTANCE) {
        if (post.y > HEIGHT_BAND) episode.high = true;
        if (post.y < -HEIGHT_BAND) episode.low = true;
      }
    }
    if (episode.eligible && frame.frame > episode.started) observeContest(episode, post, opponent, acc.edge, hit);
    if (died) {
      record(episode, "died", player.stats, opponentPlayer.stats);
      player.episode = null; player.launchUntil = -Infinity;
      continue;
    }
    if (inStage(post, acc.edge) && !disabled(post.state) && !cliff(post.state)) {
      if (!post.airborne) episode.landed = true;
      if (episode.landed && !hit) episode.stableFrames++;
      else episode.stableFrames = 0;
    } else {
      episode.stableFrames = 0;
      episode.landed = false;
    }
    if (episode.stableFrames >= RECOVERY_RETURN_FRAMES) {
      record(episode, "returned", player.stats, opponentPlayer.stats);
      player.episode = null; player.launchUntil = -Infinity;
    }
  }
  acc.players.forEach((p, i) => { p.previous = samples[i]!; });
}

/** Parent parser must also verify finalized/observed frames match metadata's last frame.
 * Finishing is idempotent; unfinished eligible episodes contribute incomplete only.
 */
export function finishRecoveryAccumulator(acc: RecoveryAccumulator): Map<number, RecoveryStats | undefined> {
  if (!acc.valid || !acc.seen) return new Map(acc.players.map((p) => [p.index, undefined]));
  const results = acc.players.map((p) => copyStats(p.stats));
  acc.players.forEach((p, i) => {
    if (p.episode) record(p.episode, "incomplete", results[i]!, results[1 - i]!);
  });
  return new Map(acc.players.map((p, i) => [p.index, results[i]!]));
}
