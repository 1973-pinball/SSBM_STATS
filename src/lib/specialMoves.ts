import { Character, Frames, isDamaged, type FrameEntryType } from "@slippi/slippi-js";
import { addDownBFrame, createDownBAccumulator, finishDownBAccumulator, getDownBCapability, type DownBCounts } from "./downBSpecial.ts";

export const SPECIAL_MOVE_IDS = [18, 19, 20, 21] as const;
export type SpecialMoveId = typeof SPECIAL_MOVE_IDS[number];
export interface SpecialMoveCapability { attempts: boolean; outcomes: boolean; reason: string | null }
export type SpecialMoveCounts = DownBCounts;
type NewMoveId = 18 | 19 | 20;
const NEW_MOVE_IDS = [18, 19, 20] as const;

/**
 * Activations, not button presses or individual projectiles. Entry callbacks,
 * action tables and continuation callbacks audited at this immutable revision:
 * https://github.com/doldecomp/melee/tree/f0cdbb0a7046aea44c7177fd72abf33c3d2af4d4/src/melee/ft/kinds
 * Each fighter's forward.h and specialn/s/hi.c are the primary sources; clones
 * reuse the parent callbacks in their init tables. Numbers below are INTERNAL
 * fighter IDs, whereas getSpecialMoveCapability accepts character-select IDs.
 *
 * Charge, held fire, Dancing Blade, Quick Attack's second zip and ground/air
 * transitions stay one activation. Fully charged DK punch can enter its release
 * directly. Link's returning boomerang catch is passive and never a new use.
 * Yoshi's grounded Egg Roll also enters SpecialAirSStart_1 (360).
 * Young Link's bow startup advances at 1.33x, so its first post-frame counter
 * may already be 1.33 (ftlinkspecialn.c applies specialn_anim_rate on entry).
 * Fox/Falco's damaging afterimage inherits the fighter's instance ID and is
 * destroyed when its owner leaves the Side-B family (itfoxillusion.c and
 * ftFx_SpecialS_CheckGhostRemove). Its outcomes therefore remain attributable.
 * Sheik's Vanish and Peach's Bomber explosions lack that owner-state lifetime
 * bound; they deliberately expose attempts only even though many hits occur
 * during the fighter animation.
 * Kirby copy states cannot be attributed without copy identity, so they remove
 * neutral-special coverage only. Actual Sheik/Zelda form changes remove N/S/Up
 * coverage: combining different characters' moves would mislabel comparisons.
 *
 * Only reliably attributed per-use damage exposes hit/no-hit outcomes, including
 * Fox/Falco's lifetime-bound afterimage. No-hit includes
 * shields, cancels, defensive/recovery uses and interruptions; it is not a
 * verified whiff or a measure of whether a recovery succeeded. Independent projectiles,
 * command grabs, counters and utility effects expose attempts only. Down B
 * delegates to the v4 detector so its established counts remain identical.
 */
interface Definition {
  states: readonly number[];
  starts: readonly number[];
  outcomes: boolean;
  reason: string | null;
  /** First post-frame animation position for character-specific startup rates. */
  initialCounterMax?: number;
  /** Held Chef may reset the entry state's animation without a fresh use. */
  allowSameStateRestart?: boolean;
  /** Known terminal phases from which a new activation can immediately start. */
  restartFrom?: readonly number[];
}
const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const projectile = "Items or projectiles can deal damage outside the activation; hit and no-hit rates are unavailable.";
const utility = "This move has a utility or defensive effect that opponent damage alone cannot measure.";
const capture = "Captures, throws or partner effects cannot be reliably assigned from fighter damage frames alone.";
const direct = (states: readonly number[], starts = states): Definition => ({ states, starts, outcomes: true, reason: null });
const other = (states: readonly number[], starts: readonly number[], reason = projectile): Definition => ({ states, starts, outcomes: false, reason });
type Three = Record<NewMoveId, Definition>;
const mario: Three = { 18: other([343, 344], [343, 344]), 19: other([345, 346], [345, 346], utility), 20: direct([347, 348]) };
const fox: Three = {
  18: { ...other(range(341, 346), [341, 344]), restartFrom: [343, 346] },
  19: direct(range(347, 352), [347, 350]), 20: direct(range(353, 359), [353, 354]),
};
const captain: Three = { 18: direct([347, 348]), 19: direct(range(349, 352), [349, 351]), 20: other(range(353, 356), [353, 354], capture) };
const link: Three = {
  18: other(range(344, 349), [344, 347]),
  // 351/354 are automatic return catches, including after other actions.
  19: other([350, 352, 353, 355], [350, 352, 353, 355]), 20: direct([356, 357]),
};
const pikachu: Three = { 18: other([341, 342], [341, 342]), 19: direct(range(343, 352), [343, 348]), 20: direct(range(353, 358), [353, 356]) };
const marth: Three = { 18: direct(range(341, 348), [341, 345]), 19: direct(range(349, 366), [349, 358]), 20: direct([367, 368]) };
const climbers: Three = {
  18: other([341, 342], [341, 342]),
  19: other(range(343, 346), range(343, 346), capture),
  20: other(range(347, 356), [347, 352], capture),
};
const DEFINITIONS: Readonly<Record<number, Three>> = {
  0: mario, 1: fox, 2: captain,
  3: { 18: direct(range(369, 378), [369, 373, 374, 378]), 19: direct([379, 380]), 20: direct([381, 382]) },
  4: { 18: other(range(353, 382), [353, 371], capture), 19: direct([383, 384]), 20: other(range(385, 392), [385, 389]) },
  5: { 18: other(range(341, 346), [341, 344]), 19: other(range(347, 358), [347, 353], capture), 20: direct([359, 360]) },
  6: link,
  7: { 18: other(range(341, 348), [341, 345]), 19: other(range(349, 354), [349, 352]), 20: other(range(355, 360), [355, 358]) },
  8: { 18: other(range(348, 355), [348, 352]), 19: other([356, 357], [356, 357]), 20: other(range(358, 366), [358, 362]) },
  9: { 18: other(range(365, 368), [365, 367], utility), 19: other(range(354, 360), [354, 357]), 20: other(range(361, 364), [361, 363]) },
  10: climbers, 11: climbers, 12: pikachu,
  13: { 18: other(range(343, 348), [343, 347]), 19: other(range(349, 352), range(349, 352)), 20: direct([353, 354]) },
  14: { 18: other(range(346, 355), [346, 351], capture), 19: direct(range(356, 363), [360]), 20: other([364, 365], [364, 365]) },
  15: { 18: direct(range(346, 362), [346, 347, 354, 355]), 19: direct([363, 364]), 20: other(range(365, 368), range(365, 368), utility) },
  16: { 18: other(range(341, 350), [341, 346]), 19: other([351, 352], [351, 352], capture), 20: other(range(353, 358), [353, 356], utility) },
  17: { 18: other([341, 342], [341, 342]), 19: direct(range(343, 354), [343, 349]), 20: direct([355, 356]) },
  18: marth,
  19: { 18: direct([341, 342]), 19: other(range(343, 348), [343, 346]), 20: direct(range(349, 354), [349, 352]) },
  20: { ...link, 18: { ...link[18], initialCounterMax: 1.33001 } }, 21: mario, 22: fox,
  23: { ...pikachu, 20: other(range(353, 358), [353, 356], utility) },
  24: { 18: { ...other([353, 354], [353, 354]), allowSameStateRestart: false }, 19: direct(range(355, 372)), 20: direct([373, 374]) },
  25: captain, 26: marth,
};
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
export function getSpecialMoveCapability(externalCharacterId: number, moveId: number): SpecialMoveCapability {
  if (moveId === 21) return getDownBCapability(externalCharacterId);
  const internal = EXTERNAL_TO_INTERNAL[externalCharacterId];
  const definition = internal === undefined || !NEW_MOVE_IDS.includes(moveId as NewMoveId) ? undefined : DEFINITIONS[internal]?.[moveId as NewMoveId];
  return definition ? { attempts: true, outcomes: definition.outcomes, reason: definition.reason }
    : { attempts: false, outcomes: false, reason: "Special-move tracking is unavailable for this character or move." };
}

type Post = NonNullable<FrameEntryType["players"][number]>["post"];
type Previous = Pick<Post, "internalCharacterId" | "actionStateId" | "actionStateCounter" | "percent" | "stocksRemaining" | "instanceId">;
interface MoveTrack {
  attemptsKnown: boolean; outcomesKnown: boolean;
  counts: Required<SpecialMoveCounts>;
  active: { hit: boolean } | null;
}
interface PlayerTrack {
  playerIndex: number; expectedInternal: number | undefined; seen: boolean;
  previous: Previous | null; moves: Record<NewMoveId, MoveTrack>;
}
export interface SpecialMovesAccumulator {
  players: PlayerTrack[]; previousFrame: number | null;
  downB: NonNullable<ReturnType<typeof createDownBAccumulator>>;
}
export function createSpecialMovesAccumulator(players: readonly { playerIndex: number; characterId?: number }[]): SpecialMovesAccumulator | null {
  const downB = createDownBAccumulator(players);
  if (!downB) return null;
  return { downB, previousFrame: null, players: players.map(player => ({
    playerIndex: player.playerIndex, expectedInternal: EXTERNAL_TO_INTERNAL[player.characterId ?? -1], seen: false, previous: null,
    moves: Object.fromEntries(NEW_MOVE_IDS.map(moveId => {
      const capability = getSpecialMoveCapability(player.characterId ?? -1, moveId);
      return [moveId, { attemptsKnown: capability.attempts, outcomesKnown: capability.outcomes,
        counts: { attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 }, active: null }];
    })) as Record<NewMoveId, MoveTrack>,
  })) };
}
const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const transformKind = (kind: number | undefined) => kind === 7 || kind === 19;
const climberKind = (kind: number | undefined) => kind === 10 || kind === 11;
const validCharacter = (expected: number | undefined, actual: number | undefined) => expected === actual ||
  (transformKind(expected) && transformKind(actual)) || (climberKind(expected) && climberKind(actual));
function invalidate(track: MoveTrack): void { track.attemptsKnown = false; track.outcomesKnown = false; }
function complete(track: MoveTrack): void {
  if (!track.active) return;
  if (track.active.hit) track.counts.hitAttempts++; else track.counts.noHitAttempts++;
  track.active = null;
}
function confirmedHit(player: PlayerTrack, moveId: NewMoveId, post: Post, opponent: Post, previousOpponent: Previous | null): boolean {
  if (!previousOpponent || !finite(opponent.percent) || !finite(previousOpponent.percent) ||
      opponent.percent <= previousOpponent.percent || opponent.lastHitBy !== player.playerIndex || post.lastAttackLanded !== moveId) return false;
  if (!(finite(opponent.actionStateId) && isDamaged(opponent.actionStateId)) && !(finite(opponent.hitlagRemaining) && opponent.hitlagRemaining > 0)) return false;
  if (finite(opponent.instanceHitBy) && finite(post.instanceId)) {
    return opponent.instanceHitBy !== 0 && (opponent.instanceHitBy === post.instanceId || opponent.instanceHitBy === player.previous?.instanceId);
  }
  return true;
}
/** Finalized contiguous frames only; memory stays constant regardless of replay length. */
export function addSpecialMovesFrame(acc: SpecialMovesAccumulator, frame: FrameEntryType): void {
  addDownBFrame(acc.downB, frame);
  if ((acc.previousFrame === null && frame.frame !== Frames.FIRST) || (acc.previousFrame !== null && frame.frame !== acc.previousFrame + 1)) {
    for (const player of acc.players) for (const moveId of NEW_MOVE_IDS) invalidate(player.moves[moveId]);
  }
  for (let i = 0; i < acc.players.length; i++) {
    const player = acc.players[i]!;
    const otherPlayer = acc.players[1 - i]!;
    const post = frame.players[player.playerIndex]?.post;
    const opponent = frame.players[otherPlayer.playerIndex]?.post;
    if (!post || !finite(post.internalCharacterId) || !finite(post.actionStateId) || post.isFollower === true || !validCharacter(player.expectedInternal, post.internalCharacterId)) {
      for (const moveId of NEW_MOVE_IDS) invalidate(player.moves[moveId]);
      continue;
    }
    player.seen = true;
    const definitions = DEFINITIONS[post.internalCharacterId];
    const previous = player.previous;
    for (const moveId of NEW_MOVE_IDS) {
      const track = player.moves[moveId];
      const definition = definitions?.[moveId];
      if (!definition) { invalidate(track); continue; }
      if (transformKind(post.internalCharacterId) && ((previous && previous.internalCharacterId !== post.internalCharacterId) || player.expectedInternal !== post.internalCharacterId)) invalidate(track);
      if (moveId === 18 && post.internalCharacterId === 4 && post.actionStateId >= 399) invalidate(track);
      if (!definition.outcomes || !opponent || !finite(opponent.percent) || !finite(opponent.lastHitBy) || !finite(post.lastAttackLanded)) track.outcomesKnown = false;
      const inMove = definition.states.includes(post.actionStateId);
      const isStart = definition.starts.includes(post.actionStateId);
      if (inMove && !finite(post.actionStateCounter)) invalidate(track);
      const initialCounterMax = definition.initialCounterMax ?? 1;
      const restarted = !!track.active && isStart && finite(post.actionStateCounter) && post.actionStateCounter <= initialCounterMax &&
        finite(previous?.actionStateCounter) && post.actionStateCounter < previous.actionStateCounter &&
        previous.internalCharacterId === post.internalCharacterId &&
        ((post.actionStateId === previous.actionStateId && definition.allowSameStateRestart !== false) ||
          (previous.actionStateId !== undefined && definition.restartFrom?.includes(previous.actionStateId)));
      if (restarted) complete(track);
      if (inMove && !track.active) {
        if (isStart && finite(post.actionStateCounter) && post.actionStateCounter <= initialCounterMax) {
          track.counts.attempts++; track.active = { hit: false };
          if (!otherPlayer.previous) track.outcomesKnown = false;
        } else invalidate(track);
      }
      if (track.active && opponent && track.outcomesKnown && confirmedHit(player, moveId, post, opponent, otherPlayer.previous)) track.active.hit = true;
      if (!inMove) complete(track);
    }
  }
  for (const player of acc.players) {
    const post = frame.players[player.playerIndex]?.post;
    player.previous = post ? { internalCharacterId: post.internalCharacterId, actionStateId: post.actionStateId,
      actionStateCounter: post.actionStateCounter, percent: post.percent, stocksRemaining: post.stocksRemaining, instanceId: post.instanceId } : null;
  }
  acc.previousFrame = frame.frame;
}
export function finishSpecialMovesAccumulator(acc: SpecialMovesAccumulator): Map<number, Record<SpecialMoveId, SpecialMoveCounts | null>> {
  const downB = finishDownBAccumulator(acc.downB);
  return new Map(acc.players.map(player => {
    const result = { 21: downB.get(player.playerIndex) ?? null } as Record<SpecialMoveId, SpecialMoveCounts | null>;
    for (const moveId of NEW_MOVE_IDS) {
      const track = player.moves[moveId];
      if (!player.seen || !track.attemptsKnown) { result[moveId] = null; continue; }
      if (!track.outcomesKnown) { result[moveId] = { attempts: track.counts.attempts }; continue; }
      const counts = { ...track.counts };
      if (track.active?.hit) counts.hitAttempts++; else if (track.active) counts.incompleteAttempts++;
      result[moveId] = counts;
    }
    return [player.playerIndex, result];
  }));
}
