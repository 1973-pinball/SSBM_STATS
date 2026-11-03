import { Frames, isCommandGrabbed, isDamaged, isGrabbed } from "@slippi/slippi-js";
import type { FrameEntryType, GameStartType } from "@slippi/slippi-js";

/** Observational windows, not frame advantage or proof of a guaranteed punish. */
export const DEFENSIVE_OUTCOME_WINDOW_FRAMES = 30;
export const DEFENSIVE_SEQUENCE_WINDOW_FRAMES = 15;
/** Continuous ledge sequences need time to rise from below stage height. */
export const LEDGE_SEQUENCE_WINDOW_FRAMES = DEFENSIVE_OUTCOME_WINDOW_FRAMES;

export const LEDGE_OPTION_LABELS = [
  { key: "getup", label: "Get up" },
  { key: "roll", label: "Ledge roll" },
  { key: "attack", label: "Ledge attack" },
  { key: "jump", label: "Ledge jump" },
  { key: "drop", label: "Drop" },
  { key: "dropJump", label: "Drop → jump" },
  { key: "dropAerial", label: "Drop → aerial" },
  { key: "ledgedash", label: "Ledgedash" },
  { key: "regrab", label: "Drop → regrab" },
  { key: "unknown", label: "Other / unknown" },
] as const;
export const OOS_OPTION_LABELS = [
  { key: "grab", label: "Grab" },
  { key: "rollForward", label: "Roll forward" },
  { key: "rollBackward", label: "Roll backward" },
  { key: "spotDodge", label: "Spot dodge" },
  { key: "jump", label: "Jump" },
  { key: "aerial", label: "Jump → aerial" },
  { key: "wavedash", label: "Wavedash" },
  { key: "fall", label: "Drop / fall" },
  { key: "shieldRelease", label: "Shield release" },
  { key: "unknown", label: "Other / unknown" },
] as const;
export type LedgeOption = typeof LEDGE_OPTION_LABELS[number]["key"];
export type OosOption = typeof OOS_OPTION_LABELS[number]["key"];
export interface ChoiceOutcomes {
  attempts: number;
  punished: number;
  hit: number;
  traded: number;
  noHit: number;
  incomplete: number;
  /** Eligible shield exits with recorded C-stick input; neither causation nor a buffer detector. */
  cStickInputs?: number;
  /** Eligible shield exits with both finite C-stick axes on their exit frame. */
  cStickSamples?: number;
}
export interface DefensiveStats {
  ledge: Partial<Record<LedgeOption, ChoiceOutcomes>>;
  oos: Partial<Record<OosOption, ChoiceOutcomes>>;
  shieldExits: Partial<Record<OosOption, ChoiceOutcomes>>;
}
/** Optional local audit hook. Production parsing does not retain these events. */
export interface DefensiveChoiceEvent {
  playerIndex: number;
  section: keyof DefensiveStats;
  option: LedgeOption | OosOption;
  startFrame: number;
  endFrame: number;
  outcome: Outcome;
}

type Post = NonNullable<FrameEntryType["players"][number]>["post"];
type Pre = NonNullable<FrameEntryType["players"][number]>["pre"];
type Snapshot = {
  actionStateId: number;
  percent: number;
  stocksRemaining: number;
  lastHitBy: number;
  internalCharacterId: number | undefined;
  isAirborne: boolean | undefined;
  hitlagRemaining: number | undefined;
  immediateAirDodgeLanding: boolean;
  cStickInput: boolean | undefined;
};
type Outcome = "punished" | "hit" | "traded" | "noHit" | "incomplete";
type Choice = {
  section: keyof DefensiveStats;
  option: LedgeOption | OosOption;
  start: number;
  sequenceOpen: boolean;
  sawJump: boolean;
  sawAirDodge: boolean;
  cStickInput?: boolean;
};
type PlayerTrack = {
  playerIndex: number;
  valid: boolean;
  seen: boolean;
  previous: Snapshot | null;
  shieldContact: number | null;
  pending: Choice | null;
  stats: DefensiveStats;
  currentFrame: number;
  onChoice?: (event: DefensiveChoiceEvent) => void;
};
export interface DefensiveAccumulator {
  players: PlayerTrack[];
  previousFrame: number | null;
}

/** Singles only. Follower posts are never substituted for the main fighter. */
export function createDefensiveAccumulator(settings: GameStartType, onChoice?: (event: DefensiveChoiceEvent) => void): DefensiveAccumulator | null {
  if (settings.isTeams || settings.players.length !== 2 ||
      new Set(settings.players.map(p => p.playerIndex)).size !== 2 ||
      settings.players.some(p => !Number.isInteger(p.playerIndex))) return null;
  return {
    previousFrame: null,
    players: settings.players.map(p => ({
      playerIndex: p.playerIndex, valid: true, seen: false, previous: null,
      shieldContact: null, pending: null, stats: { ledge: {}, oos: {}, shieldExits: {} },
      currentFrame: Frames.FIRST, onChoice,
    })),
  };
}

const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);
function snapshot(post: Post | undefined, pre: Pre | undefined): Snapshot | null {
  if (!post || post.isFollower === true || !finite(post.actionStateId) || !finite(post.percent) ||
      !finite(post.stocksRemaining) || !finite(post.lastHitBy)) return null;
  return {
    actionStateId: post.actionStateId, percent: post.percent,
    stocksRemaining: post.stocksRemaining, lastHitBy: post.lastHitBy,
    internalCharacterId: post.internalCharacterId, isAirborne: post.isAirborne,
    hitlagRemaining: post.hitlagRemaining,
    // Same deadzone as Slippi's input counter. This only observes the stick:
    // main-stick and button inputs may coexist, and earlier buffers are unknown.
    cStickInput: finite(pre?.cStickX) && finite(pre?.cStickY)
      ? Math.abs(pre.cStickX) >= 0.2875 || Math.abs(pre.cStickY) >= 0.2875 : undefined,
    // EscapeAir can collide and enter LandingFallSpecial within the same
    // simulation frame, so post states need not contain AirDodge at all.
    // Require a recorded jump/fall pre-state and a digital L/R input; an
    // arbitrary special landing is not wavedash evidence.
    immediateAirDodgeLanding: post.actionStateId === 43 && post.isAirborne === false &&
      finite(pre?.actionStateId) && pre.actionStateId >= 24 && pre.actionStateId <= 34 &&
      finite(pre?.buttons ?? pre?.physicalButtons) && (((pre?.buttons ?? pre?.physicalButtons ?? 0) & 0x60) !== 0),
  };
}

const onLedge = (state: number) => state === 252 || state === 253;
// GuardOff (180) is a deliberate release, hence an exit rather than a hold.
const shielding = (state: number) => state === 178 || state === 179 || state === 181 || state === 182;
const grabbed = (state: number) => isGrabbed(state) || isCommandGrabbed(state);
const dead = (state: number) => state >= 0 && state <= 10;
const disrupted = (state: number) => dead(state) || isDamaged(state) || grabbed(state) || (state >= 205 && state <= 211) || state === 251;
const airJump = (state: number) => state === 27 || state === 28;
const jumping = (state: number) => state >= 24 && state <= 28;
const falling = (state: number) => state >= 29 && state <= 34;
// Normal aerial attacks only, including G&W's character-specific aerial states.
// Airborne specials (including Fire Fox) are not aerial attacks here.
const aerial = (post: Snapshot) => (post.actionStateId >= 65 && post.actionStateId <= 69) ||
  (post.internalCharacterId === 24 && [347, 348, 349].includes(post.actionStateId));

function emptyOutcomes(): ChoiceOutcomes {
  return { attempts: 0, punished: 0, hit: 0, traded: 0, noHit: 0, incomplete: 0 };
}
const cStickEligible = (option: LedgeOption | OosOption) =>
  option === "jump" || option === "aerial" || option === "wavedash" ||
  option === "rollForward" || option === "rollBackward" || option === "spotDodge";
function finishChoice(track: PlayerTrack, outcome: Outcome): void {
  const choice = track.pending;
  if (!choice) return;
  const rows = track.stats[choice.section] as Partial<Record<LedgeOption | OosOption, ChoiceOutcomes>>;
  const row = rows[choice.option] ??= emptyOutcomes();
  row.attempts++;
  row[outcome]++;
  if (choice.section !== "ledge" && cStickEligible(choice.option) && choice.cStickInput !== undefined) {
    row.cStickSamples = (row.cStickSamples ?? 0) + 1;
    row.cStickInputs = (row.cStickInputs ?? 0) + Number(choice.cStickInput);
  }
  track.onChoice?.({ playerIndex: track.playerIndex, section: choice.section, option: choice.option,
    startFrame: choice.start, endFrame: track.currentFrame, outcome });
  track.pending = null;
}

function ledgeChoice(post: Snapshot, frame: number): Choice {
  const state = post.actionStateId;
  const option: LedgeOption = state === 254 || state === 255 ? "getup"
    : state === 256 || state === 257 ? "attack"
    : state === 258 || state === 259 ? "roll"
    : state >= 260 && state <= 263 ? "jump"
    : airJump(state) ? "dropJump"
    : falling(state) ? "drop"
    : aerial(post) ? "dropAerial"
    : "unknown";
  return { section: "ledge", option, start: frame,
    sequenceOpen: option === "drop" || option === "dropJump",
    sawJump: airJump(state), sawAirDodge: false };
}
function shieldChoice(post: Snapshot, frame: number, contacted: boolean): Choice {
  const state = post.actionStateId;
  const option: OosOption = state === 212 || state === 214 ? "grab"
    : state === 233 ? "rollForward" : state === 234 ? "rollBackward"
    : state === 235 ? "spotDodge" : jumping(state) ? "jump"
    : falling(state) || state === 244 ? "fall" : state === 180 || state === 14 ? "shieldRelease"
    : "unknown";
  return { section: contacted ? "oos" : "shieldExits", option, start: frame,
    sequenceOpen: option === "jump", sawJump: jumping(state), sawAirDodge: false,
    cStickInput: cStickEligible(option) ? post.cStickInput : undefined };
}

/** Recognize only observed short sequences; character-specific specials stay unknown. */
function advanceSequence(choice: Choice, post: Snapshot, frame: number): void {
  if (!choice.sequenceOpen) return;
  const window = choice.section === "ledge" ? LEDGE_SEQUENCE_WINDOW_FRAMES : DEFENSIVE_SEQUENCE_WINDOW_FRAMES;
  if (frame - choice.start >= window) {
    choice.sequenceOpen = false;
    return;
  }
  const state = post.actionStateId;
  if (disrupted(state)) return;
  if (choice.section === "ledge") {
    if (onLedge(state)) {
      // Only an uninterrupted drop/jump sequence can reach this branch. A
      // special closes the sequence as unknown, so this is not a stall counter.
      choice.option = "regrab";
      choice.sequenceOpen = false;
    } else if (airJump(state)) {
      choice.sawJump = true;
      choice.option = "dropJump";
    } else if (aerial(post)) {
      choice.option = "dropAerial";
      choice.sequenceOpen = false;
    } else if (state === 236) {
      choice.sawAirDodge = true;
    } else if (!post.isAirborne) {
      if (choice.sawJump && (choice.sawAirDodge || post.immediateAirDodgeLanding) && state === 43) choice.option = "ledgedash";
      else if (state >= 341) choice.option = "unknown";
      choice.sequenceOpen = false;
    } else if (!falling(state)) {
      choice.option = "unknown";
      choice.sequenceOpen = false;
    }
  } else {
    if (aerial(post)) {
      choice.option = "aerial";
      choice.sequenceOpen = false;
    } else if (state === 236) {
      choice.sawAirDodge = true;
    } else if (jumping(state) || falling(state)) {
      choice.sawJump = true;
    } else if (!post.isAirborne) {
      if (choice.sawJump && (choice.sawAirDodge || post.immediateAirDodgeLanding) && state === 43) choice.option = "wavedash";
      else if (state >= 341) choice.option = "unknown";
      choice.sequenceOpen = false;
    } else {
      choice.option = "unknown";
      choice.sequenceOpen = false;
    }
  }
}

function hitOrGrab(victim: Snapshot, previous: Snapshot, attackerIndex: number): boolean {
  if (victim.stocksRemaining !== previous.stocksRemaining) return false;
  if (grabbed(victim.actionStateId) && !grabbed(previous.actionStateId)) return true;
  return victim.percent > previous.percent && victim.lastHitBy === attackerIndex &&
    (isDamaged(victim.actionStateId) || (victim.hitlagRemaining ?? 0) > 0);
}

function resolveOutcome(track: PlayerTrack, post: Snapshot, opponent: Snapshot, previous: Snapshot,
  previousOpponent: Snapshot, opponentIndex: number, frame: number): void {
  if (!track.pending) return;
  const incoming = hitOrGrab(post, previous, opponentIndex);
  const outgoing = hitOrGrab(opponent, previousOpponent, track.playerIndex);
  if (incoming || outgoing) finishChoice(track, incoming && outgoing ? "traded" : incoming ? "punished" : "hit");
  else if (post.stocksRemaining !== previous.stocksRemaining || opponent.stocksRemaining !== previousOpponent.stocksRemaining ||
      dead(post.actionStateId) || dead(opponent.actionStateId) || disrupted(post.actionStateId)) {
    // A death or interruption without attributable contact does not establish a punish.
    finishChoice(track, "incomplete");
  } else if (frame - track.pending.start >= DEFENSIVE_OUTCOME_WINDOW_FRAMES - 1) finishChoice(track, "noHit");
}

/**
 * Finalized, contiguous frames from Frames.FIRST only. Retains two snapshots and
 * one pending choice per player, never a replay frame history. The caller must
 * additionally verify that finalized frames reach the declared replay ending.
 *
 * OOS means an exit after observed GuardSetOff (shield damage) within 30 frames
 * of that exit, during the same hold. GuardReflect alone can be a powershield
 * startup and is deliberately insufficient evidence. Other exits are separate.
 * First damaging hit or grab in the 30-frame inclusive window wins; both on one
 * frame is a trade. Shield contact alone is neither a hit nor a punish. This is
 * an interaction following a choice, not proof the choice caused the outcome.
 */
export function addDefensiveFrame(acc: DefensiveAccumulator | null, frame: FrameEntryType): void {
  if (!acc) return;
  if ((acc.previousFrame === null && frame.frame !== Frames.FIRST) ||
      (acc.previousFrame !== null && frame.frame !== acc.previousFrame + 1)) {
    for (const track of acc.players) track.valid = false;
  }
  const posts = acc.players.map(track => snapshot(frame.players?.[track.playerIndex]?.post, frame.players?.[track.playerIndex]?.pre));
  for (let i = 0; i < acc.players.length; i++) {
    const track = acc.players[i]!;
    track.currentFrame = frame.frame;
    const other = acc.players[1 - i]!;
    const post = posts[i];
    const opponent = posts[1 - i];
    if (!post || !opponent || typeof post.isAirborne !== "boolean" || !finite(post.internalCharacterId)) {
      track.valid = false;
      continue;
    }
    track.seen = true;
    if (!track.valid) continue;
    const previous = track.previous;
    const previousOpponent = other.previous;
    if (previous && previousOpponent) {
      const sameStock = post.stocksRemaining === previous.stocksRemaining;
      let next: Choice | null = null;
      if (sameStock && !disrupted(post.actionStateId)) {
        if (onLedge(previous.actionStateId) && !onLedge(post.actionStateId)) next = ledgeChoice(post, frame.frame);
        else if (shielding(previous.actionStateId) && !shielding(post.actionStateId)) {
          next = shieldChoice(post, frame.frame, track.shieldContact !== null &&
            frame.frame - track.shieldContact <= DEFENSIVE_OUTCOME_WINDOW_FRAMES);
        }
      }
      if (next) {
        // Do not assign a later interaction to two successive defensive choices.
        finishChoice(track, "incomplete");
        track.pending = next;
      } else if (track.pending) {
        advanceSequence(track.pending, post, frame.frame);
      }
      resolveOutcome(track, post, opponent, previous, previousOpponent, other.playerIndex, frame.frame);
    }
    if (post.actionStateId === 181) track.shieldContact = frame.frame;
    else if (!shielding(post.actionStateId)) track.shieldContact = null;
  }
  // Advance both snapshots together: outcome attribution always compares frame n-1.
  for (let i = 0; i < acc.players.length; i++) acc.players[i]!.previous = posts[i] ?? null;
  acc.previousFrame = frame.frame;
}

/** Pending windows are censored, not silently counted as successful escapes. */
export function finishDefensiveAccumulator(acc: DefensiveAccumulator | null): Map<number, DefensiveStats | undefined> {
  const result = new Map<number, DefensiveStats | undefined>();
  if (!acc) return result;
  for (const track of acc.players) {
    finishChoice(track, "incomplete");
    result.set(track.playerIndex, track.valid && track.seen ? track.stats : undefined);
  }
  return result;
}
