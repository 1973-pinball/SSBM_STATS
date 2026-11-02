import { isCommandGrabbed, isDamaged, isDead, isDown, isGrabbed, isTeching } from "@slippi/slippi-js";
import type { FrameEntryType, GameStartType, PostFrameUpdateType } from "@slippi/slippi-js";

/** Descriptive context, not proof of a whiff or an unavoidable punish. */
export const PUNISH_ACTION_LABELS = {
  jab: "Jab", dashAttack: "Dash attack", ftilt: "Forward tilt", utilt: "Up tilt", dtilt: "Down tilt",
  fsmash: "Forward smash", usmash: "Up smash", dsmash: "Down smash",
  nair: "Neutral air", fair: "Forward air", bair: "Back air", uair: "Up air", dair: "Down air",
  grab: "Grab", shield: "Shield", roll: "Roll", spotDodge: "Spot dodge", airDodge: "Air dodge",
  jump: "Jump", landing: "Landing", ledge: "Ledge", groundMovement: "Idle / ground movement",
  specialOrUnique: "Special / character-specific action", unknown: "Other / unknown",
} as const;
export type PunishAction = keyof typeof PUNISH_ACTION_LABELS;
export interface PunishOutcome { openings: number; damage: number; kills: number; incomplete: number }
export interface PunishStats { beforeOpening: Partial<Record<PunishAction, PunishOutcome>> }
export const OPENING_CONTEXT_FRAMES = 30;
export const OPENING_RESET_FRAMES = 45;

type Post = Pick<PostFrameUpdateType, "actionStateId" | "percent" | "stocksRemaining" | "lastHitBy" | "internalCharacterId" | "hitlagRemaining">;
interface Track {
  index: number; opponent: number; previous: Post | null; known: boolean;
  recent: { action: PunishAction; frame: number } | null;
  active: { action: PunishAction; damage: number; quiet: number } | null;
  stats: PunishStats;
}
export interface PunishAccumulator { players: Track[]; previousFrame: number | null }
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const captured = (s: number) => isGrabbed(s) || isCommandGrabbed(s);
const disabled = (s: number) => isDamaged(s) || captured(s) || isDead(s) || isDown(s) || isTeching(s);

function actionFor(s: number): PunishAction | null {
  // Common-state IDs: project-slippi/slippi-js State. Character-specific states
  // deliberately remain coarse: their numeric IDs overlap across the roster.
  if (s >= 341) return "specialOrUnique";
  if (s >= 44 && s <= 49) return "jab";
  if (s === 50) return "dashAttack";
  if (s >= 51 && s <= 55) return "ftilt";
  if (s === 56) return "utilt";
  if (s === 57) return "dtilt";
  if (s >= 58 && s <= 62) return "fsmash";
  if (s === 63) return "usmash";
  if (s === 64) return "dsmash";
  if (s >= 65 && s <= 74) return (["nair", "fair", "bair", "uair", "dair"] as const)[(s - 65) % 5]!;
  if (s >= 212 && s <= 222) return "grab";
  if (s >= 178 && s <= 182) return "shield";
  if (s === 233 || s === 234) return "roll";
  if (s === 235) return "spotDodge";
  if (s === 236) return "airDodge";
  if (s >= 24 && s <= 28) return "jump";
  if (s === 42 || s === 43) return "landing";
  if (s >= 252 && s <= 263) return "ledge";
  // Deliberate movement is a new choice. A later dash/turn must not remain
  // attributed to an attack or grab that ended several actions ago.
  if ((s >= 15 && s <= 23) || (s >= 39 && s <= 41)) return "groundMovement";
  // Idle/fall preserve a recently finished action for up to 30 frames, so an
  // attack ending just before a hit is not relabelled as an idle mistake.
  if (s === 14 || (s >= 29 && s <= 38)) return null;
  return "unknown";
}

export function createPunishAccumulator(settings: GameStartType): PunishAccumulator | null {
  if (settings.isTeams || settings.players.length !== 2) return null;
  return { previousFrame: null, players: settings.players.map((p, i) => ({
    index: p.playerIndex, opponent: settings.players[1 - i]!.playerIndex,
    previous: null, known: true, recent: null, active: null, stats: { beforeOpening: {} },
  })) };
}
function row(track: Track, action: PunishAction): PunishOutcome {
  return track.stats.beforeOpening[action] ??= { openings: 0, damage: 0, kills: 0, incomplete: 0 };
}
function close(track: Track, killed: boolean): void {
  if (!track.active) return;
  const value = row(track, track.active.action);
  value.damage += track.active.damage;
  if (killed) value.kills++;
  track.active = null;
}

export function addPunishFrame(acc: PunishAccumulator, frame: FrameEntryType): void {
  if (acc.previousFrame !== null && frame.frame !== acc.previousFrame + 1) {
    for (const track of acc.players) track.known = false;
  }
  for (const track of acc.players) {
    const post = frame.players[track.index]?.post;
    if (!post || !finite(post.actionStateId) || !finite(post.percent) || !finite(post.stocksRemaining)
      || !finite(post.lastHitBy) || !finite(post.internalCharacterId)) {
      track.known = false; track.previous = null; continue;
    }
    const prev = track.previous;
    if (prev && track.known) {
      const state = post.actionStateId;
      const damage = Math.max(0, post.percent - prev.percent!);
      const lostStock = post.stocksRemaining < prev.stocksRemaining!;
      const hit = damage > 0 && post.lastHitBy === track.opponent
        && (isDamaged(state) || captured(state) || (post.hitlagRemaining ?? 0) > 0);
      const grabbed = captured(state) && !captured(prev.actionStateId!);
      if (!track.active && !lostStock && (hit || grabbed)) {
        const recent = track.recent;
        const action = recent && frame.frame - recent.frame <= OPENING_CONTEXT_FRAMES
          ? recent.action : (prev.actionStateId! >= 14 && prev.actionStateId! <= 23 ? "groundMovement" : "unknown");
        track.active = { action, damage: 0, quiet: 0 };
        row(track, action).openings++;
      }
      if (track.active) {
        if (hit) track.active.damage += damage;
        if (lostStock) close(track, post.lastHitBy === track.opponent);
        else {
          track.active.quiet = disabled(state) || hit || grabbed ? 0 : track.active.quiet + 1;
          if (track.active.quiet >= OPENING_RESET_FRAMES) close(track, false);
        }
      }
      if (lostStock || isDead(state)) track.recent = null;
      else if (!disabled(state)) {
        const action = actionFor(state);
        if (action) track.recent = { action, frame: frame.frame };
      }
    } else if (track.known && !disabled(post.actionStateId)) {
      const action = actionFor(post.actionStateId);
      if (action) track.recent = { action, frame: frame.frame };
    }
    track.previous = { actionStateId: post.actionStateId, percent: post.percent, stocksRemaining: post.stocksRemaining,
      lastHitBy: post.lastHitBy, internalCharacterId: post.internalCharacterId, hitlagRemaining: post.hitlagRemaining };
  }
  acc.previousFrame = frame.frame;
}

export function finishPunishAccumulator(acc: PunishAccumulator): Map<number, PunishStats | undefined> {
  return new Map(acc.players.map(track => {
    if (!track.known || !track.previous) return [track.index, undefined];
    const beforeOpening = Object.fromEntries(Object.entries(track.stats.beforeOpening).map(([key, value]) => [key, { ...value }])) as PunishStats["beforeOpening"];
    if (track.active) beforeOpening[track.active.action]!.incomplete++;
    return [track.index, { beforeOpening }];
  }));
}
