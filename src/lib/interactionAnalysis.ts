import { Frames } from "@slippi/slippi-js";
import type { FrameEntryType, GameStartType } from "@slippi/slippi-js";
import { createDefensiveAccumulator, addDefensiveFrame, finishDefensiveAccumulator } from "./defensiveInteractions.ts";
import { createRecoveryAccumulator, addRecoveryFrame, finishRecoveryAccumulator } from "./recoveryInteractions.ts";
import { createPunishAccumulator, addPunishFrame, finishPunishAccumulator } from "./punishContext.ts";
import type { PlayerSide } from "./types";
import type { SpecialMoveFrameBounds } from "./specialMoves";

/** Three small state machines; never retain raw frames or per-event histories. */
export function createInteractionAccumulator(settings: GameStartType) {
  if (settings.isTeams || settings.players.length !== 2) return null;
  return {
    indices: settings.players.map(p => p.playerIndex),
    defense: createDefensiveAccumulator(settings),
    recovery: createRecoveryAccumulator(settings),
    punish: createPunishAccumulator(settings),
    firstFrame: null as number | null,
    lastFrame: null as number | null,
    contiguous: true,
  };
}
type Accumulator = NonNullable<ReturnType<typeof createInteractionAccumulator>>;
export function addInteractionFrame(acc: Accumulator, frame: FrameEntryType): void {
  if (acc.firstFrame === null) acc.firstFrame = frame.frame;
  if (acc.lastFrame !== null && frame.frame !== acc.lastFrame + 1) acc.contiguous = false;
  acc.lastFrame = frame.frame;
  if (acc.defense) addDefensiveFrame(acc.defense, frame);
  if (acc.recovery) addRecoveryFrame(acc.recovery, frame);
  if (acc.punish) addPunishFrame(acc.punish, frame);
}
export function finishInteractionAccumulator(acc: Accumulator, bounds: SpecialMoveFrameBounds): Map<number, Pick<PlayerSide, "defense" | "recovery" | "punish">> {
  if (!acc.contiguous || acc.firstFrame !== Frames.FIRST || acc.lastFrame !== bounds.expectedLastFrame
    || bounds.finalizedLastFrame !== bounds.expectedLastFrame) return new Map();
  const defense = acc.defense ? finishDefensiveAccumulator(acc.defense) : new Map();
  const recovery = acc.recovery ? finishRecoveryAccumulator(acc.recovery) : new Map();
  const punish = acc.punish ? finishPunishAccumulator(acc.punish) : new Map();
  return new Map(acc.indices.map(index => [index, { defense: defense.get(index), recovery: recovery.get(index), punish: punish.get(index) }]));
}
