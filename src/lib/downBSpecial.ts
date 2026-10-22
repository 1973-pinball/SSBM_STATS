import { Character, Frames, isDamaged, type FrameEntryType } from "@slippi/slippi-js";

/**
 * Down-B activations, not B-button presses. One activation includes its held,
 * hit, turn, landing, and ground/air phases. Only the Ice Climbers leader counts.
 *
 * Action states/internal character IDs and entry/transition callbacks checked at:
 * https://github.com/doldecomp/melee/tree/f0cdbb0a7046aea44c7177fd72abf33c3d2af4d4/src/melee/ft/kinds
 * Each kind's forward.h + ft<kind>.c gives the state numbers; its speciallw.c
 * supplies entry/continuation rules. Clones reuse their parent's callbacks.
 * Samus uses ftsamusspeciallw1.c: 355/356 start bombs, whereas 341/342 are the
 * reaction to a bomb explosion and must NEVER count as another activation.
 * Captain/Ganon's oddly named SpecialHiThrow1 (363) is Down-B's wall rebound.
 * G&W's held bucket resets to animation frame 4; it is not a new activation.
 * Zelda/Sheik change internal character during one activation; transformation-in
 * end states belong to that activation. Kirby's copied neutral specials do not.
 *
 * Post-frame damage/instance semantics:
 * https://github.com/project-slippi/slippi-wiki/blob/master/SPEC.md#post-frame-update
 * LastAttackLanded is persistent, so it is never itself evidence of a hit. A
 * hit attempt requires new opponent damage + attacker/move attribution during
 * the activation. Newer replays also match fighter instances, excluding items.
 *
 * No-hit is NOT a true whiff: shield contact, reflections, and cancelled moves
 * can deal no opponent damage. Utility, counter, item, and delayed/projectile
 * moves deliberately expose attempts only, because their useful outcomes cannot
 * be recovered from the fighter's action interval and damage alone.
 */
export interface DownBCapability {
  attempts: boolean;
  outcomes: boolean;
  reason: string | null;
}

export interface DownBCounts {
  attempts: number;
  hitAttempts?: number;
  noHitAttempts?: number;
  incompleteAttempts?: number;
}

interface Definition {
  states: readonly number[];
  starts: readonly number[];
  outcomes: boolean;
  reason: string | null;
  /** Samus can start a bomb from crouch at animation frame 3. */
  initialCounterMax?: number;
}

const projectile = "Damage from items or projectiles can outlast the Down-B animation; outcome rates are unavailable.";
const utility = "This Down B has a utility or defensive effect; opponent damage does not measure its success.";
const transformation = "Transformations are counted as activations; hit and no-hit rates do not apply.";
const counter = "Counter activations are tracked, but damage alone cannot measure whether a counter was triggered or useful.";
const direct = (states: readonly number[], starts: readonly number[]): Definition => ({ states, starts, outcomes: true, reason: null });
const other = (states: readonly number[], starts: readonly number[], reason: string): Definition => ({ states, starts, outcomes: false, reason });

const mario = direct([349, 350], [349, 350]);
const fox = direct([360, 361, 362, 363, 364, 365, 366, 367, 368, 369], [360, 365]);
const captain = direct([357, 358, 359, 360, 361, 362, 363], [357, 359]);
const link = other([358, 359], [358, 359], projectile);
const pikachu = other([359, 360, 361, 362, 363, 364, 365, 366], [359, 363], projectile);
const marth = other([369, 370, 371, 372], [369, 371], counter);
const climbers = other([357, 358], [357, 358], projectile);

/** Keys are INTERNAL post-frame IDs, not character-select/settings IDs. */
const DEFINITIONS: Readonly<Record<number, Definition>> = {
  0: mario,
  1: fox,
  2: captain,
  3: direct([383, 384, 385, 386], [383]),
  4: direct([393, 394, 395, 396, 397, 398], [393, 396]),
  5: direct([361, 362, 363], [361, 362]),
  6: link,
  7: other([361, 362, 363, 364], [361, 363], transformation),
  8: other([367, 368, 369, 370, 371, 372, 373, 374, 375, 376], [367, 372], utility),
  9: other([352, 353], [352, 353], "Turnip pulls are counted; throws and later item damage cannot be assigned to the pull animation."),
  10: climbers,
  11: climbers,
  12: pikachu,
  13: { ...other([355, 356], [355, 356], projectile), initialCounterMax: 3 },
  14: other([366, 367, 368], [366, 368], projectile),
  15: direct([369, 370, 371, 372], [369, 370, 371, 372]),
  16: other([359, 360], [359, 360], "Disable can stun without dealing damage; damage-based outcome rates are unavailable."),
  17: direct([357, 358], [357, 358]),
  18: marth,
  19: other([355, 356, 357, 358], [355, 357], transformation),
  20: link,
  21: mario,
  22: fox,
  23: pikachu,
  24: other([375, 376, 377, 378, 379, 380], [375, 377, 378, 380], utility),
  25: captain,
  26: marth,
};

// Named slippi-js settings IDs -> decomp FighterKind internal IDs. These two
// orders differ substantially; do not index one table with the other's IDs.
const EXTERNAL_TO_INTERNAL: Readonly<Record<number, number>> = {
  [Character.CAPTAIN_FALCON]: 2, [Character.DONKEY_KONG]: 3, [Character.FOX]: 1,
  [Character.GAME_AND_WATCH]: 24, [Character.KIRBY]: 4, [Character.BOWSER]: 5,
  [Character.LINK]: 6, [Character.LUIGI]: 17, [Character.MARIO]: 0,
  [Character.MARTH]: 18, [Character.MEWTWO]: 16, [Character.NESS]: 8,
  [Character.PEACH]: 9, [Character.PIKACHU]: 12, [Character.ICE_CLIMBERS]: 10,
  [Character.JIGGLYPUFF]: 15, [Character.SAMUS]: 13, [Character.YOSHI]: 14,
  [Character.ZELDA]: 19, [Character.SHEIK]: 7, [Character.FALCO]: 22,
  [Character.YOUNG_LINK]: 20, [Character.DR_MARIO]: 21, [Character.ROY]: 26,
  [Character.PICHU]: 23, [Character.GANONDORF]: 25,
};

export function getDownBCapability(externalCharacterId: number): DownBCapability {
  const internal = EXTERNAL_TO_INTERNAL[externalCharacterId];
  const definition = internal === undefined ? undefined : DEFINITIONS[internal];
  return definition
    ? { attempts: true, outcomes: definition.outcomes, reason: definition.reason }
    : { attempts: false, outcomes: false, reason: "Down-B tracking is unavailable for this character." };
}

type Post = NonNullable<FrameEntryType["players"][number]>["post"];
type Previous = Pick<Post, "internalCharacterId" | "actionStateId" | "actionStateCounter" | "percent" | "stocksRemaining" | "instanceId">;
interface Active { hit: boolean }
interface PlayerTrack {
  playerIndex: number;
  expectedInternal: number | undefined;
  attemptsKnown: boolean;
  outcomesKnown: boolean;
  seen: boolean;
  counts: Required<DownBCounts>;
  active: Active | null;
  previous: Previous | null;
}

export interface DownBAccumulator {
  players: PlayerTrack[];
  previousFrame: number | null;
}

export function createDownBAccumulator(players: readonly { playerIndex: number; characterId?: number }[]): DownBAccumulator | null {
  if (players.length !== 2 || players[0]!.playerIndex === players[1]!.playerIndex) return null;
  return {
    previousFrame: null,
    players: players.map((player) => ({
      playerIndex: player.playerIndex,
      expectedInternal: EXTERNAL_TO_INTERNAL[player.characterId ?? -1],
      attemptsKnown: getDownBCapability(player.characterId ?? -1).attempts,
      outcomesKnown: getDownBCapability(player.characterId ?? -1).outcomes,
      seen: false,
      counts: { attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 },
      active: null,
      previous: null,
    })),
  };
}

const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const transformKind = (kind: number | undefined) => kind === 7 || kind === 19;
const climberKind = (kind: number | undefined) => kind === 10 || kind === 11;
const validCharacter = (expected: number | undefined, actual: number | undefined) =>
  expected === actual || (transformKind(expected) && transformKind(actual)) || (climberKind(expected) && climberKind(actual));

function complete(track: PlayerTrack): void {
  if (!track.active) return;
  if (track.active.hit) track.counts.hitAttempts++;
  else track.counts.noHitAttempts++;
  track.active = null;
}

function confirmedHit(track: PlayerTrack, post: Post, opponent: Post, previousOpponent: Previous | null): boolean {
  if (!previousOpponent || !finite(opponent.percent) || !finite(previousOpponent.percent) ||
      opponent.percent <= previousOpponent.percent || opponent.lastHitBy !== track.playerIndex || post.lastAttackLanded !== 21) return false;
  if (!(finite(opponent.actionStateId) && isDamaged(opponent.actionStateId)) && !(finite(opponent.hitlagRemaining) && opponent.hitlagRemaining > 0)) return false;
  // Modern files distinguish the fighter's active action from a lingering item.
  // A trade can replace the attacker's action on the very frame it connects.
  if (finite(opponent.instanceHitBy) && finite(post.instanceId)) {
    if (opponent.instanceHitBy === 0) return false;
    return opponent.instanceHitBy === post.instanceId || opponent.instanceHitBy === track.previous?.instanceId;
  }
  return true;
}

/** Consume FINALIZED frames in ascending, contiguous order; retain no frame map. */
export function addDownBFrame(acc: DownBAccumulator, frame: FrameEntryType): void {
  if ((acc.previousFrame === null && frame.frame !== Frames.FIRST) ||
      (acc.previousFrame !== null && frame.frame !== acc.previousFrame + 1)) {
    // Missing prefixes, gaps, and rollbacks cannot establish a game denominator.
    for (const track of acc.players) { track.attemptsKnown = false; track.outcomesKnown = false; }
  }
  for (let i = 0; i < acc.players.length; i++) {
    const track = acc.players[i]!;
    const otherTrack = acc.players[1 - i]!;
    const post = frame.players[track.playerIndex]?.post;
    const opponent = frame.players[otherTrack.playerIndex]?.post;
    if (!post || !finite(post.internalCharacterId) || !finite(post.actionStateId) ||
        post.isFollower === true || !validCharacter(track.expectedInternal, post.internalCharacterId)) {
      track.attemptsKnown = false;
      track.outcomesKnown = false;
      continue;
    }
    track.seen = true;
    const definition = DEFINITIONS[post.internalCharacterId];
    if (!definition) { track.attemptsKnown = false; track.outcomesKnown = false; continue; }
    if (!definition.outcomes) track.outcomesKnown = false;
    if (!opponent || !finite(opponent.percent) || !finite(opponent.lastHitBy) || !finite(post.lastAttackLanded)) track.outcomesKnown = false;
    const inMove = definition.states.includes(post.actionStateId);
    const isStart = definition.starts.includes(post.actionStateId);
    const previous = track.previous;
    const previousDefinition = previous?.internalCharacterId === undefined ? undefined : DEFINITIONS[previous.internalCharacterId];
    const previousIsStart = previous?.actionStateId !== undefined && previousDefinition?.starts.includes(previous.actionStateId);
    if (inMove && !finite(post.actionStateCounter)) { track.attemptsKnown = false; track.outcomesKnown = false; }
    const restarted = !!track.active && isStart && finite(post.actionStateCounter) &&
      post.actionStateCounter <= (definition.initialCounterMax ?? 1) && finite(previous?.actionStateCounter) &&
      post.actionStateCounter < previous.actionStateCounter &&
      // Ground/air variants are one action even if their animation resets.
      (post.actionStateId === previous.actionStateId || !previousIsStart) &&
      previous.internalCharacterId === post.internalCharacterId;
    if (restarted) complete(track);
    if (inMove && !track.active) {
      if (isStart && finite(post.actionStateCounter) && post.actionStateCounter <= (definition.initialCounterMax ?? 1)) {
        track.counts.attempts++;
        track.active = { hit: false };
        if (!otherTrack.previous) track.outcomesKnown = false;
      } else {
        // Joining a held/landing/end phase does not establish an initiation.
        track.attemptsKnown = false;
        track.outcomesKnown = false;
      }
    }
    if (track.active && opponent && track.outcomesKnown && confirmedHit(track, post, opponent, otherTrack.previous)) track.active.hit = true;
    if (!inMove) complete(track);
  }
  // All players read the SAME predecessor. Do not update this in the loop above.
  for (const track of acc.players) {
    const post = frame.players[track.playerIndex]?.post;
    track.previous = post ? {
      internalCharacterId: post.internalCharacterId,
      actionStateId: post.actionStateId,
      actionStateCounter: post.actionStateCounter,
      percent: post.percent,
      stocksRemaining: post.stocksRemaining,
      instanceId: post.instanceId,
    } : null;
  }
  acc.previousFrame = frame.frame;
}

/** Snapshot; repeated reads do not consume an active attempt or mutate totals. */
export function finishDownBAccumulator(acc: DownBAccumulator): Map<number, DownBCounts | null> {
  return new Map(acc.players.map((track) => {
    if (!track.seen || !track.attemptsKnown) return [track.playerIndex, null];
    if (!track.outcomesKnown) return [track.playerIndex, { attempts: track.counts.attempts }];
    const counts = { ...track.counts };
    if (track.active?.hit) counts.hitAttempts++;
    else if (track.active) counts.incompleteAttempts++;
    return [track.playerIndex, counts];
  }));
}
