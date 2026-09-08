import {
  SlippiGame,
  Frames,
  GameEndMethod,
  ActionsComputer,
  InputComputer,
  SlpParser,
  SlpParserEvent,
  SlpStream,
  SlpStreamEvent,
  Command,
  calcDamageTaken,
  didLoseStock,
  isDamaged,
  State,
} from "@slippi/slippi-js";
import type { FrameEntryType, FramesType, GameEndType, GameStartType, MetadataType } from "@slippi/slippi-js";
import { CURRENT_STATS_VERSION } from "./types";
import type { GameRecord, GameType, MoveAgg, PlayerSide, TechCounts } from "./types";

const MIN_GAME_SECONDS = 30;

/**
 * Thrown when the replay was read while Slippi was still writing it. Nothing is
 * wrong with the file — we were early — so pool.ts must retry it on the next
 * scan rather than tombstone it, and above all must not cache what it got:
 * a partial parse has no metadata block and therefore no `playedAt`, and
 * `gameKey()` falls back to the file id when `playedAt` is null, so the
 * fragment would never collapse against the finished game.
 */
export class IncompleteReplayError extends Error {
  constructor() {
    super("replay is still being written");
    this.name = "IncompleteReplayError";
  }
}

function detectGameType(matchId: string | null | undefined): GameType {
  if (!matchId) return "offline";
  if (matchId.includes("mode.ranked")) return "ranked";
  if (matchId.includes("mode.unranked")) return "unranked";
  if (matchId.includes("mode.direct")) return "direct";
  return "unknown";
}

/**
 * slippi-js registers six stat computers and runs every one of them over every
 * frame, but this file reads only three of the results: `overall` (built from
 * inputs + conversions), `actionCounts`, and `conversions`. Combos, stocks and
 * target breaks are computed and thrown away — measured at 12–15% of a full
 * parse across a real library, which on a 20k-game import is minutes of CPU.
 *
 * `Stats.allComputers` is a plain array that `register()` pushes onto, so the
 * cheapest fix is to narrow it. Those are TS-private fields, hence the guard: if
 * a slippi-js upgrade changes the shape, every computer stays registered and the
 * parse is merely as slow as it used to be. What makes this safe rather than
 * merely fast is that ConversionComputer derives stock losses from the frames
 * itself rather than reading StockComputer, and `generateOverallStats` is handed
 * only settings/inputs/conversions/playableFrameCount — verified over 49 real
 * replays, where overall, actionCounts, conversions, lastFrame and
 * playableFrameCount all came back byte-identical to a stock parse.
 *
 * If a future stat needs combos or stocks, add the computer back here.
 *
 * Exported only so `scripts/verify-parse.mjs` can assert that the reach-in still
 * binds. The guard makes a slippi-js shape change degrade to slow-but-correct,
 * which is the safe direction and therefore the silent one — nothing in the app
 * would ever surface it. That script is the thing that notices.
 */
export function dropUnreadComputers(game: SlippiGame): void {
  const g = game as unknown as {
    statsComputer?: { allComputers?: unknown[] };
    actionsComputer?: unknown;
    conversionComputer?: unknown;
    inputComputer?: unknown;
  };
  const stats = g.statsComputer;
  if (!stats || !Array.isArray(stats.allComputers)) return;
  const { actionsComputer, conversionComputer, inputComputer } = g;
  if (!actionsComputer || !conversionComputer || !inputComputer) return;
  stats.allComputers = [actionsComputer, conversionComputer, inputComputer];
}

interface TeamsStats {
  dmgMatrix: number[][]; // [attacker][victim] in settings.players order; diagonal = self/unattributed
  killMatrix: number[][]; // same shape; diagonal = self-destructs
  actionsByPlayerIndex: Map<number, ReturnType<ActionsComputer["fetch"]>[number]>;
  inputCountByPlayerIndex: Map<number, number>;
}

type SlippiActionCounts = ReturnType<ActionsComputer["fetch"]>[number];
type PostFrameUpdate = NonNullable<FrameEntryType["players"][number]>["post"];

const emptyTechCounts = (): TechCounts => ({
  inPlace: 0,
  toward: 0,
  away: 0,
  missed: 0,
  wallSuccess: 0,
  wallMissed: 0,
});

function techCountsFrom(actions: SlippiActionCounts | undefined): TechCounts {
  return {
    inPlace: actions?.groundTechCount?.neutral ?? 0,
    toward: actions?.groundTechCount?.in ?? 0,
    away: actions?.groundTechCount?.away ?? 0,
    missed: actions?.groundTechCount?.fail ?? 0,
    wallSuccess: actions?.wallTechCount?.success ?? 0,
    wallMissed: actions?.wallTechCount?.fail ?? 0,
  };
}

interface TeamsAccumulator {
  players: GameStartType["players"];
  computers: { actions: ActionsComputer; inputs: InputComputer }[];
  posOf: Map<number, number>;
  dmgMatrix: number[][];
  killMatrix: number[][];
  prev: FrameEntryType | null;
}

function createTeamsAccumulator(settings: GameStartType): TeamsAccumulator | null {
  const players = settings.players;
  if (players.length !== 4) return null;
  const byTeam = new Map<number, number>();
  for (const p of players) {
    if (p.teamId === null || p.teamId === undefined) return null;
    byTeam.set(p.teamId, (byTeam.get(p.teamId) ?? 0) + 1);
  }
  if (byTeam.size !== 2 || Array.from(byTeam.values()).some((n) => n !== 2)) return null;

  const teamIds = Array.from(byTeam.keys());
  const teamA = players.filter((p) => p.teamId === teamIds[0]);
  const teamB = players.filter((p) => p.teamId === teamIds[1]);
  // One computer per cross-team pair; each handles both of its players.
  const computers = [
    [teamA[0], teamB[0]],
    [teamA[1], teamB[1]],
  ].map((pair) => {
    const fake = { ...settings, players: pair } as GameStartType;
    const actions = new ActionsComputer();
    actions.setup(fake);
    const inputs = new InputComputer();
    inputs.setup(fake);
    return { actions, inputs };
  });

  return {
    players,
    computers,
    posOf: new Map(players.map((p, i) => [p.playerIndex, i])),
    dmgMatrix: players.map(() => players.map(() => 0)),
    killMatrix: players.map(() => players.map(() => 0)),
    prev: null,
  };
}

function addTeamsFrame(acc: TeamsAccumulator, frame: FrameEntryType, frames: FramesType): void {
  const { players, computers, posOf, dmgMatrix, killMatrix } = acc;
  if (!frame.players || players.some((p) => !frame.players[p.playerIndex]?.post)) return;

  // InputComputer reaches back to frame-1 for each of its two players' `pre`
  // blocks and does not guard that lookup. Keep action/damage computation when
  // a malformed predecessor is missing and skip only that input sample.
  const prevFrame = frames[frame.frame - 1];
  const inputsReady =
    players.every((p) => frame.players[p.playerIndex]?.pre) &&
    prevFrame?.players !== undefined &&
    players.every((p) => prevFrame.players[p.playerIndex]?.pre);
  for (const { actions, inputs } of computers) {
    actions.processFrame(frame);
    if (inputsReady) inputs.processFrame(frame, frames);
  }
  if (acc.prev?.players) {
    for (const p of players) {
      const post = frame.players[p.playerIndex]!.post;
      const prevPost = acc.prev.players[p.playerIndex]?.post;
      if (!prevPost) continue;
      const vi = posOf.get(p.playerIndex)!;
      const lhb = post.lastHitBy;
      const ai = lhb !== null && lhb !== undefined && lhb !== p.playerIndex && posOf.has(lhb) ? posOf.get(lhb)! : vi;
      const dmg = calcDamageTaken(post, prevPost);
      if (dmg > 0) dmgMatrix[ai]![vi]! += dmg;
      if (didLoseStock(post, prevPost)) killMatrix[ai]![vi]! += 1;
    }
  }
  acc.prev = frame;
}

function finishTeamsAccumulator(acc: TeamsAccumulator): TeamsStats {
  const actionsByPlayerIndex = new Map<number, ReturnType<ActionsComputer["fetch"]>[number]>();
  const inputCountByPlayerIndex = new Map<number, number>();
  for (const { actions, inputs } of acc.computers) {
    for (const a of actions.fetch()) actionsByPlayerIndex.set(a.playerIndex, a);
    for (const i of inputs.fetch()) inputCountByPlayerIndex.set(i.playerIndex, i.inputCount);
  }
  return { dmgMatrix: acc.dmgMatrix, killMatrix: acc.killMatrix, actionsByPlayerIndex, inputCountByPlayerIndex };
}

/**
 * slippi-js's stat computers are singles-only (they no-op on 4-player games),
 * so for clean 2v2s we make our own frame pass. Damage and kills are
 * attributed through each victim's `lastHitBy`, split into a full
 * attacker→victim matrix — that one structure yields enemy damage, friendly
 * fire (both directions), damage taken by source, and real stock captures.
 * Action/input counts reuse the library's own per-player state machines by
 * running them pairwise across teams; the opponent's position determines tech
 * direction relative to that opponent.
 */
function computeTeamsStats(game: SlippiGame, settings: GameStartType, lastFrame: number): TeamsStats | null {
  const acc = createTeamsAccumulator(settings);
  if (!acc) return null;

  // Frames are keyed by frame number from Frames.FIRST upward, so walk the range
  // numerically rather than materializing and sorting the key set: the old
  // Object.keys().map(Number).sort() allocated one string plus one number per
  // frame and cost ~1 ms per six-minute replay, twice over on a teams game.
  const frames = game.getFrames();
  for (let fn = Frames.FIRST; fn <= lastFrame; fn++) {
    const frame = frames[fn];
    if (frame) addTeamsFrame(acc, frame, frames);
  }
  return finishTeamsAccumulator(acc);
}

const LANDING_TO_MOVE: Record<number, number> = { 0x46: 13, 0x47: 14, 0x48: 15, 0x49: 16, 0x4a: 17 };

interface AerialLCAggregate {
  prevAnim: Map<number, number | null>;
  prevCounter: Map<number, number | null>;
  byPlayer: Map<number, Map<number, { success: number; fail: number }>>;
}

function createAerialLCAggregate(settings: GameStartType): AerialLCAggregate | null {
  if (settings.players.length !== 2 || settings.isTeams) return null;
  return {
    prevAnim: new Map(settings.players.map((p) => [p.playerIndex, null])),
    prevCounter: new Map(settings.players.map((p) => [p.playerIndex, null])),
    byPlayer: new Map(settings.players.map((p) => [p.playerIndex, new Map()])),
  };
}

function addAerialLCFrame(acc: AerialLCAggregate, settings: GameStartType, frame: FrameEntryType): void {
  if (!frame.players) return;
  for (const p of settings.players) {
    const post = frame.players[p.playerIndex]?.post;
    if (!post) continue;
    const anim = post.actionStateId ?? null;
    const counter = post.actionStateCounter ?? null;
    const prevAnim = acc.prevAnim.get(p.playerIndex) ?? null;
    const prevCounter = acc.prevCounter.get(p.playerIndex) ?? null;
    const isNewAction = anim !== prevAnim || (prevCounter !== null && counter !== null && prevCounter > counter);
    const moveId = anim === null ? undefined : LANDING_TO_MOVE[anim];
    if (isNewAction && moveId !== undefined && (post.lCancelStatus === 1 || post.lCancelStatus === 2)) {
      const byMove = acc.byPlayer.get(p.playerIndex)!;
      const counts = byMove.get(moveId) ?? { success: 0, fail: 0 };
      if (post.lCancelStatus === 1) counts.success++;
      else counts.fail++;
      byMove.set(moveId, counts);
    }
    acc.prevAnim.set(p.playerIndex, anim);
    acc.prevCounter.set(p.playerIndex, counter);
  }
}

function applyAerialLC(acc: AerialLCAggregate, settings: GameStartType, players: PlayerSide[]): void {
  settings.players.forEach((p, i) => {
    for (const [moveId, counts] of acc.byPlayer.get(p.playerIndex) ?? []) {
      const byMove = (players[i]!.moveStats ??= {});
      const move: MoveAgg = (byMove[moveId] ??= {
        landed: 0,
        damage: 0,
        kills: 0,
        killPctSum: 0,
        openings: 0,
        openingDmg: 0,
        lcSuccess: 0,
        lcFail: 0,
      });
      move.lcSuccess += counts.success;
      move.lcFail += counts.fail;
    }
  });
}

interface CrouchCancelAggregate {
  prevPost: Map<number, PostFrameUpdate | null>;
  counts: Map<number, number>;
}

function createCrouchCancelAggregate(settings: GameStartType): CrouchCancelAggregate {
  return {
    prevPost: new Map(settings.players.map((p) => [p.playerIndex, null])),
    counts: new Map(settings.players.map((p) => [p.playerIndex, 0])),
  };
}

const isSquatState = (state: number | undefined): boolean =>
  state !== undefined && state >= State.SQUAT_START && state <= State.SQUAT_END;

function addCrouchCancelFrame(acc: CrouchCancelAggregate, settings: GameStartType, frame: FrameEntryType): void {
  if (!frame.players) return;
  for (const p of settings.players) {
    const post = frame.players[p.playerIndex]?.post;
    if (!post) continue;
    const prevPost = acc.prevPost.get(p.playerIndex) ?? null;
    const actionState = post.actionStateId;
    const tookHit =
      prevPost !== null &&
      calcDamageTaken(post, prevPost) > 0 &&
      actionState !== undefined &&
      (isDamaged(actionState) || (post.hitlagRemaining ?? 0) > 0);
    if (tookHit && isSquatState(prevPost.actionStateId)) {
      acc.counts.set(p.playerIndex, (acc.counts.get(p.playerIndex) ?? 0) + 1);
    }
    acc.prevPost.set(p.playerIndex, post);
  }
}

function computeCrouchCancelCounts(game: SlippiGame, settings: GameStartType, lastFrame: number): Map<number, number> {
  const acc = createCrouchCancelAggregate(settings);
  const frames = game.getFrames();
  for (let fn = Frames.FIRST; fn <= lastFrame; fn++) {
    const frame = frames[fn];
    if (frame) addCrouchCancelFrame(acc, settings, frame);
  }
  return acc.counts;
}

class StreamingFrameSummary {
  private settings: GameStartType | null = null;
  private aerialLC: AerialLCAggregate | null = null;
  private crouchCancels: CrouchCancelAggregate | null = null;
  private teams: TeamsAccumulator | null = null;

  setup(settings: GameStartType): void {
    this.settings = settings;
    this.aerialLC = createAerialLCAggregate(settings);
    this.crouchCancels = createCrouchCancelAggregate(settings);
    this.teams = createTeamsAccumulator(settings);
  }

  process(frame: FrameEntryType, frames: FramesType): void {
    if (!this.settings) return;
    if (this.aerialLC) addAerialLCFrame(this.aerialLC, this.settings, frame);
    if (this.crouchCancels) addCrouchCancelFrame(this.crouchCancels, this.settings, frame);
    if (this.teams) addTeamsFrame(this.teams, frame, frames);
  }

  applyAerialLC(players: PlayerSide[]): void {
    if (this.aerialLC && this.settings) applyAerialLC(this.aerialLC, this.settings, players);
  }

  teamsStats(): TeamsStats | null {
    return this.teams ? finishTeamsAccumulator(this.teams) : null;
  }

  crouchCancelCounts(): Map<number, number> {
    return this.crouchCancels?.counts ?? new Map();
  }
}

/**
 * Make slippi-js consume finalized frames in compact batches, then release each
 * completed batch from both of its internal indexes. Conversions and inputs
 * look back one frame only; online rollback candidates are not finalized yet,
 * so they remain in the parser until safe. Batching keeps Stats.process() on a
 * tight loop instead of re-entering it for every frame, while changing the full
 * parse from retaining every large frame object twice to retaining at most 8,192
 * finalized frames plus the small rollback window.
 *
 * The private-field guard mirrors dropUnreadComputers: an upstream shape change
 * falls back to the old full-frame pass, which is slower but correct.
 */
interface StreamingFrameController {
  flush: () => void;
  applyAerialLC: (players: PlayerSide[]) => void;
  teamsStats: () => TeamsStats | null;
  crouchCancelCounts: () => Map<number, number>;
}

function installStreamingFrameSummary(game: SlippiGame): StreamingFrameController | null {
  const runtime = game as unknown as {
    parser?: {
      frames?: FramesType;
      on: (event: string, listener: (value: never) => void) => unknown;
    };
    statsComputer?: {
      frames?: FramesType;
      allComputers?: { processFrame: (frame: FrameEntryType, frames: FramesType) => void }[];
      lastProcessedFrame?: number;
      process?: () => void;
      addFrame?: (frame: FrameEntryType) => void;
    };
  };
  const parser = runtime.parser;
  const stats = runtime.statsComputer;
  if (
    !parser?.frames ||
    !stats?.frames ||
    !Array.isArray(stats.allComputers) ||
    typeof stats.process !== "function" ||
    typeof stats.addFrame !== "function"
  )
    return null;

  const summary = new StreamingFrameSummary();
  // Two thousand frames is about half a minute of play. Keeping the batch modest
  // materially lowers each worker's live frame-object peak on long imports;
  // the one-frame lookback below preserves identical results across flushes.
  const FRAME_BATCH = 2048;
  let pendingFrames = 0;
  let latestFinalized = Frames.FIRST - 1;
  let summaryNextFrame = Frames.FIRST;

  const flush = () => {
    if (!pendingFrames) return;
    // The library's own tight loop preserves its malformed-frame stop rule and
    // is measurably faster than calling each computer through an event per frame.
    stats.process!();
    const parserFrames = parser.frames!;
    for (let fn = summaryNextFrame; fn <= latestFinalized; fn++) {
      const frame = parserFrames[fn];
      if (frame) summary.process(frame, parserFrames);
    }
    summaryNextFrame = latestFinalized + 1;

    // Keep the last finalized frame for the next batch's one-frame lookback,
    // plus any newer unfinalized rollback candidates held by the parser.
    const keptParserFrames: FramesType = {};
    for (const key of Object.keys(parserFrames)) {
      const fn = Number(key);
      if (fn >= latestFinalized) keptParserFrames[fn] = parserFrames[fn]!;
    }
    parser.frames = keptParserFrames;
    const lastStatsFrame = stats.frames?.[latestFinalized];
    stats.frames = lastStatsFrame ? { [latestFinalized]: lastStatsFrame } : {};
    pendingFrames = 0;
  };

  parser.on(SlpParserEvent.SETTINGS, (settings: GameStartType) => {
    summary.setup(settings);
    // The built-in computers are singles-only. Avoid three no-op calls per
    // finalized frame on teams/FFA; StreamingFrameSummary owns clean 2v2 stats.
    if (settings.players.length !== 2) stats.allComputers = [];
  });
  // SlippiGame's existing finalized-frame listener calls this method. Wrapping
  // it avoids registering a second EventEmitter callback on every game frame.
  const addFrame = stats.addFrame.bind(stats);
  stats.addFrame = (frame: FrameEntryType) => {
    addFrame(frame);
    latestFinalized = frame.frame;
    pendingFrames++;
    if (pendingFrames >= FRAME_BATCH) flush();
  };
  return {
    flush,
    applyAerialLC: (players) => summary.applyAerialLC(players),
    teamsStats: () => summary.teamsStats(),
    crouchCancelCounts: () => summary.crouchCancelCounts(),
  };
}

/**
 * Decision 2's win/loss ladder, resolved to a player (singles) and a team
 * (2v2): valid gameEnd placements, then the stock-out survivor, then the LRAS
 * initiator taking the loss, with anything under MIN_GAME_SECONDS forced
 * indeterminate regardless of how it ended.
 *
 * Both passes share this one implementation so they cannot drift. The header
 * pass has no frame data, so it hands over players whose `stocksRemaining` is
 * null — which the stock-out branches already guard against. That makes the
 * header verdict a strict subset of the full one: it can leave a result
 * undetermined, never report a different winner than the full parse will.
 * Preserve that property. It is what lets the preview's win rates stand on
 * screen without being corrected out from under the user when the full pass
 * lands, and a stock-out branch that stopped guarding on null would silently
 * break it by crediting a win to whoever sorted first.
 */
function decideWinner(
  settings: GameStartType,
  gameEnd: GameEndType | undefined,
  players: PlayerSide[],
  isTeams: boolean,
  durationFrames: number,
): { winnerIndex: number | null; winnerTeamId: number | null } {
  // Placements are only meaningful when the game actually concluded. On a
  // NO_CONTEST (LRAS quit-out) or UNRESOLVED end the payload can carry stale
  // placement data — typically position 0 parked on player index 0 — which
  // would crown the quitter before the LRAS rule below ever runs.
  const placementsValid =
    gameEnd?.gameEndMethod === GameEndMethod.TIME ||
    gameEnd?.gameEndMethod === GameEndMethod.GAME ||
    gameEnd?.gameEndMethod === GameEndMethod.RESOLVED;

  // --- Win/loss determination (singles only) ---
  let winnerIndex: number | null = null;
  if (!isTeams && players.length === 2) {
    const placements = placementsValid
      ? gameEnd?.placements?.filter((pl) => pl.position !== null && pl.position !== undefined && pl.position >= 0)
      : undefined;
    if (placements && placements.length >= 2) {
      const first = placements.find((pl) => pl.position === 0);
      if (first?.playerIndex !== null && first?.playerIndex !== undefined) {
        winnerIndex = settings.players.findIndex((p) => p.playerIndex === first.playerIndex);
      }
    }
    if (winnerIndex === null || winnerIndex < 0) {
      if (gameEnd?.gameEndMethod === GameEndMethod.GAME) {
        // Stock-out: survivor wins.
        const [a, b] = players;
        if (a && b && a.stocksRemaining !== null && b.stocksRemaining !== null && a.stocksRemaining !== b.stocksRemaining) {
          winnerIndex = a.stocksRemaining > b.stocksRemaining ? 0 : 1;
        }
      } else if (gameEnd?.gameEndMethod === GameEndMethod.NO_CONTEST && gameEnd.lrasInitiatorIndex !== null && gameEnd.lrasInitiatorIndex !== undefined && gameEnd.lrasInitiatorIndex >= 0) {
        // Quit-out: the LRAS initiator takes the loss.
        const quitter = settings.players.findIndex((p) => p.playerIndex === gameEnd.lrasInitiatorIndex);
        if (quitter >= 0) winnerIndex = quitter === 0 ? 1 : 0;
      }
    }
    if (winnerIndex !== null && winnerIndex < 0) winnerIndex = null;
    // Very short games are indeterminate regardless of end method.
    if (durationFrames < MIN_GAME_SECONDS * 60) winnerIndex = null;
  }

  // --- Win/loss determination (teams) ---
  // Same ladder as singles, resolved to a team rather than a player.
  let winnerTeamId: number | null = null;
  const teamIds = new Set(players.map((p) => p.teamId).filter((t): t is number => t !== null));
  if (isTeams && players.length === 4 && teamIds.size === 2) {
    const teamOfPlayerIndex = (playerIndex: number): number | null => {
      const idx = settings.players.findIndex((p) => p.playerIndex === playerIndex);
      return idx >= 0 ? players[idx]!.teamId : null;
    };

    const first = placementsValid ? gameEnd?.placements?.find((pl) => pl.position === 0) : undefined;
    if (first && first.playerIndex !== null && first.playerIndex !== undefined) {
      winnerTeamId = teamOfPlayerIndex(first.playerIndex);
    }
    if (winnerTeamId === null) {
      if (gameEnd?.gameEndMethod === GameEndMethod.GAME) {
        // Stock-out: the team with stocks left wins.
        const stocks = new Map<number, number>();
        let complete = true;
        for (const p of players) {
          if (p.teamId === null || p.stocksRemaining === null) {
            complete = false;
            break;
          }
          stocks.set(p.teamId, (stocks.get(p.teamId) ?? 0) + p.stocksRemaining);
        }
        if (complete && stocks.size === 2) {
          const entries = Array.from(stocks.entries());
          const [tA, sA] = entries[0]!;
          const [tB, sB] = entries[1]!;
          if (sA !== sB) winnerTeamId = sA > sB ? tA : tB;
        }
      } else if (
        gameEnd?.gameEndMethod === GameEndMethod.NO_CONTEST &&
        gameEnd.lrasInitiatorIndex !== null &&
        gameEnd.lrasInitiatorIndex !== undefined &&
        gameEnd.lrasInitiatorIndex >= 0
      ) {
        // Quit-out: the quitter's team takes the loss.
        const quitterTeam = teamOfPlayerIndex(gameEnd.lrasInitiatorIndex);
        if (quitterTeam !== null) {
          winnerTeamId = Array.from(teamIds).find((t) => t !== quitterTeam) ?? null;
        }
      }
    }
    if (durationFrames < MIN_GAME_SECONDS * 60) winnerTeamId = null;
  }

  return { winnerIndex, winnerTeamId };
}

/**
 * Parse a single replay into a GameRecord. Stats-only: frame data is used
 * transiently by slippi-js to compute stats, then everything is discarded
 * except the summary row — ~5 KB for a singles game (p50 4.7, p90 5.6 over a
 * real library), of which the per-move table is the bulk; the headline stats
 * alone are ~1 KB, and teams records carry no move table at all.
 */
function parseReplayWithMode(id: string, path: string, buf: ArrayBuffer, boundedFrames: boolean): GameRecord {
  const game = new SlippiGame(buf);
  dropUnreadComputers(game);
  const streaming = boundedFrames ? installStreamingFrameSummary(game) : null;
  const settings = game.getSettings();
  if (!settings || !settings.players || settings.players.length === 0) {
    throw new Error("no settings block");
  }

  // The metadata block is written when the game ends and the file is closed,
  // so slippi-js returning nothing here means "severed incomplete file" (its
  // own words) — i.e. we opened the replay of a game still in progress. Bail
  // before the expensive stat pass; pool.ts retries it on the next scan.
  const metadata = game.getMetadata();
  if (!metadata) throw new IncompleteReplayError();
  const gameEnd = game.getGameEnd();
  streaming?.flush();
  const stats = game.getStats();
  const latestFrame = game.getLatestFrame();

  const durationFrames = stats?.lastFrame ?? metadata?.lastFrame ?? 0;
  const isTeams = Boolean(settings.isTeams) || settings.players.length > 2;

  const players: PlayerSide[] = settings.players.map((p) => {
    const overall = stats?.overall?.find((o) => o.playerIndex === p.playerIndex);
    const actions = stats?.actionCounts?.find((a) => a.playerIndex === p.playerIndex);
    const post = latestFrame?.players?.[p.playerIndex]?.post;
    return {
      port: (p.port ?? p.playerIndex + 1) as number,
      isCpu: p.type === 1 ? true : p.type === 0 ? false : undefined,
      connectCode: p.connectCode || null,
      displayName: p.displayName || null,
      characterId: p.characterId ?? -1,
      colorId: p.characterColor ?? 0,
      teamId: isTeams ? p.teamId ?? null : null,
      stocksRemaining: post?.stocksRemaining ?? null,
      kills: overall?.killCount ?? 0,
      totalDamage: overall?.totalDamage ?? 0,
      openingsPerKill: overall?.openingsPerKill?.ratio ?? null,
      damagePerOpening: overall?.damagePerOpening?.ratio ?? null,
      inputsPerMinute: overall?.inputsPerMinute?.ratio ?? null,
      neutralWins: overall?.neutralWinRatio?.count ?? 0,
      counterHits: overall?.counterHitRatio?.count ?? 0,
      beneficialTrades: overall?.beneficialTradeRatio?.count ?? 0,
      lCancelSuccess: actions?.lCancelCount?.success ?? 0,
      lCancelFail: actions?.lCancelCount?.fail ?? 0,
      grabSuccess: actions?.grabCount?.success ?? 0,
      techs: techCountsFrom(actions),
      actions: {
        rolls: actions?.rollCount ?? 0,
        airDodges: actions?.airDodgeCount ?? 0,
        spotDodges: actions?.spotDodgeCount ?? 0,
        wavedashes: actions?.wavedashCount ?? 0,
        wavelands: actions?.wavelandCount ?? 0,
        dashDances: actions?.dashDanceCount ?? 0,
        ledgeGrabs: actions?.ledgegrabCount ?? 0,
        crouchCancels: 0,
        grabs: (actions?.grabCount?.success ?? 0) + (actions?.grabCount?.fail ?? 0),
      },
    };
  });

  // Per-move aggregates from conversions (singles only — the conversion
  // computer no-ops on 4-player games). Every landed hit in a conversion
  // carries its move ID; the first move is the opening, and when the
  // conversion kills, the last move gets the kill at the victim's end %.
  if (!isTeams && stats?.conversions?.length) {
    const idxOf = new Map(settings.players.map((p, i) => [p.playerIndex, i]));
    for (const c of stats.conversions) {
      if (c.moves.length === 0) continue;
      const convDmg = Math.max(0, (c.endPercent ?? c.currentPercent) - c.startPercent);
      c.moves.forEach((m, mi) => {
        const pi = idxOf.get(m.playerIndex);
        if (pi === undefined) return;
        const side = players[pi]!;
        const byMove = (side.moveStats ??= {});
        const a: MoveAgg = (byMove[m.moveId] ??= { landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lcSuccess: 0, lcFail: 0 });
        a.landed++;
        a.damage += m.damage;
        if (mi === 0) {
          a.openings++;
          a.openingDmg += convDmg;
        }
        if (c.didKill && mi === c.moves.length - 1) {
          a.kills++;
          a.killPctSum += c.endPercent ?? c.currentPercent;
        }
      });
    }
  }

  // Per-aerial L-cancels (singles): the landing action state says which aerial
  // (0x46–0x4a = nair..dair landing lag) and `lCancelStatus` on that frame says
  // hit or miss — whiffed aerials included, unlike the conversion-based stats.
  // Mirrors slippi-js's isNewAction guard; we skip its rare edge-cancel
  // correction, so per-move sums can differ from the headline rate by a hair.
  if (!isTeams && settings.players.length === 2) {
    if (streaming) {
      streaming.applyAerialLC(players);
    } else {
      const aerialLC = createAerialLCAggregate(settings)!;
      const frames = game.getFrames();
      for (let fn = Frames.FIRST; fn <= durationFrames; fn++) {
        const frame = frames[fn];
        if (frame) addAerialLCFrame(aerialLC, settings, frame);
      }
      applyAerialLC(aerialLC, settings, players);
    }
  }

  // Per-move attempt counts (singles): slippi-js's action counter already
  // tallies initiations per normal/aerial from animation states — whiffs
  // included. Specials, throws, getup and edge attacks aren't tracked there,
  // so those stay undefined (rendered as "—", not 0). Combined jabs land on
  // move ID 2; the move table groups jab IDs anyway.
  if (!isTeams) {
    settings.players.forEach((p, i) => {
      const ac = stats?.actionCounts?.find((a) => a.playerIndex === p.playerIndex)?.attackCount;
      if (!ac) return;
      const byMove = (players[i]!.moveStats ??= {});
      const put = (moveId: number, attempts: number) => {
        if (attempts <= 0 && !byMove[moveId]) return;
        const a: MoveAgg = (byMove[moveId] ??= { landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lcSuccess: 0, lcFail: 0 });
        a.attempts = attempts;
      };
      put(2, ac.jab1 + ac.jab2 + ac.jab3 + ac.jabm);
      put(6, ac.dash);
      put(7, ac.ftilt);
      put(8, ac.utilt);
      put(9, ac.dtilt);
      put(10, ac.fsmash);
      put(11, ac.usmash);
      put(12, ac.dsmash);
      put(13, ac.nair);
      put(14, ac.fair);
      put(15, ac.bair);
      put(16, ac.uair);
      put(17, ac.dair);
    });
  }

  // Doubles: slippi-js left every stat field zeroed, so fill them from our
  // own frame pass. kills/totalDamage keep singles semantics (enemies only);
  // friendly fire lives in the matrices.
  const teamsStats = isTeams ? (streaming ? streaming.teamsStats() : computeTeamsStats(game, settings, durationFrames)) : null;
  if (teamsStats) {
    const minutes = durationFrames / 3600;
    settings.players.forEach((p, i) => {
      const side = players[i]!;
      let enemyDmg = 0;
      let enemyKills = 0;
      settings.players.forEach((v, j) => {
        if (i === j || v.teamId === p.teamId) return;
        enemyDmg += teamsStats.dmgMatrix[i]![j]!;
        enemyKills += teamsStats.killMatrix[i]![j]!;
      });
      side.totalDamage = enemyDmg;
      side.kills = enemyKills;
      const ac = teamsStats.actionsByPlayerIndex.get(p.playerIndex);
      if (ac) {
        side.lCancelSuccess = ac.lCancelCount?.success ?? 0;
        side.lCancelFail = ac.lCancelCount?.fail ?? 0;
        side.grabSuccess = ac.grabCount?.success ?? 0;
        side.techs = techCountsFrom(ac);
        side.actions = {
          rolls: ac.rollCount ?? 0,
          airDodges: ac.airDodgeCount ?? 0,
          spotDodges: ac.spotDodgeCount ?? 0,
          wavedashes: ac.wavedashCount ?? 0,
          wavelands: ac.wavelandCount ?? 0,
          dashDances: ac.dashDanceCount ?? 0,
          ledgeGrabs: ac.ledgegrabCount ?? 0,
          crouchCancels: side.actions.crouchCancels,
          grabs: (ac.grabCount?.success ?? 0) + (ac.grabCount?.fail ?? 0),
        };
      }
      const inputCount = teamsStats.inputCountByPlayerIndex.get(p.playerIndex);
      side.inputsPerMinute = inputCount !== undefined && minutes > 0 ? inputCount / minutes : null;
    });
  }

  const crouchCancelCounts = streaming
    ? streaming.crouchCancelCounts()
    : computeCrouchCancelCounts(game, settings, durationFrames);
  settings.players.forEach((p, i) => {
    players[i]!.actions.crouchCancels = crouchCancelCounts.get(p.playerIndex) ?? 0;
  });

  const { winnerIndex, winnerTeamId } = decideWinner(settings, gameEnd, players, isTeams, durationFrames);

  return {
    statsVersion: CURRENT_STATS_VERSION,
    id,
    path,
    playedAt: metadata?.startAt ?? null,
    durationFrames,
    stageId: settings.stageId ?? -1,
    gameType: detectGameType(settings.matchInfo?.matchId),
    isTeams,
    players,
    winnerIndex,
    winnerTeamId,
    dmgMatrix: teamsStats?.dmgMatrix ?? null,
    killMatrix: teamsStats?.killMatrix ?? null,
  };
}

export function parseReplay(id: string, path: string, buf: ArrayBuffer): GameRecord {
  return parseReplayWithMode(id, path, buf, true);
}

/** Retained-frame baseline for scripts/verify-parse.mjs; never used by the app. */
export function parseReplayRetainedForVerification(id: string, path: string, buf: ArrayBuffer): GameRecord {
  return parseReplayWithMode(id, path, buf, false);
}

/**
 * The fast pass: everything a replay's settings, metadata and game-end blocks
 * can answer, and nothing that needs the frames.
 *
 * `getSettings()` stops iterating at the first post-frame update, while
 * `getMetadata()` and `getGameEnd({ skipProcessing: true })` seek to their own
 * blocks and read them directly. So this never materializes a frame — which is
 * where essentially the whole cost of a parse lives, between slippi-js's frame
 * assembly and the six stat computers it runs over every one of them.
 *
 * What it therefore cannot produce is any execution metric: kills, damage,
 * openings, L-cancels, action counts and the per-move table all come out of the
 * frame pass. Those fields are left at their zero/null values and the record is
 * flagged `statsLevel: "header"`, which `hasFullStats` reads and every averaging
 * selector filters on. It also cannot see the final frame, so `stocksRemaining`
 * is null and the ladder's stock-out branch declines to guess — see decideWinner
 * for why that subset property matters.
 *
 * Records from here are a preview. pool.ts streams them to the dashboard and
 * never caches them; the full pass follows behind and replaces them in place.
 */
function buildHeaderRecord(
  id: string,
  path: string,
  settings: GameStartType,
  metadata: MetadataType,
  gameEnd: GameEndType | undefined,
): GameRecord {
  const durationFrames = metadata.lastFrame ?? 0;
  const isTeams = Boolean(settings.isTeams) || settings.players.length > 2;

  const players: PlayerSide[] = settings.players.map((p) => ({
    port: (p.port ?? p.playerIndex + 1) as number,
    isCpu: p.type === 1 ? true : p.type === 0 ? false : undefined,
    connectCode: p.connectCode || null,
    displayName: p.displayName || null,
    characterId: p.characterId ?? -1,
    colorId: p.characterColor ?? 0,
    teamId: isTeams ? p.teamId ?? null : null,
    // Unknown without the final frame. Left null rather than zeroed: the ladder
    // treats null as "don't guess" and zero as "lost every stock".
    stocksRemaining: null,
    kills: 0,
    totalDamage: 0,
    openingsPerKill: null,
    damagePerOpening: null,
    inputsPerMinute: null,
    neutralWins: 0,
    counterHits: 0,
    beneficialTrades: 0,
    lCancelSuccess: 0,
    lCancelFail: 0,
    grabSuccess: 0,
    techs: emptyTechCounts(),
    actions: { rolls: 0, airDodges: 0, spotDodges: 0, wavedashes: 0, wavelands: 0, dashDances: 0, ledgeGrabs: 0, crouchCancels: 0, grabs: 0 },
  }));

  const { winnerIndex, winnerTeamId } = decideWinner(settings, gameEnd, players, isTeams, durationFrames);

  return {
    statsVersion: CURRENT_STATS_VERSION,
    id,
    path,
    playedAt: metadata.startAt ?? null,
    durationFrames,
    stageId: settings.stageId ?? -1,
    gameType: detectGameType(settings.matchInfo?.matchId),
    isTeams,
    players,
    winnerIndex,
    winnerTeamId,
    dmgMatrix: null,
    killMatrix: null,
    statsLevel: "header",
  };
}

export function parseHeader(id: string, path: string, buf: ArrayBuffer): GameRecord {
  const game = new SlippiGame(buf);
  const settings = game.getSettings();
  if (!settings || !settings.players || settings.players.length === 0) {
    throw new Error("no settings block");
  }

  // Same "severed incomplete file" check as the full parse, and it matters more
  // here: this pass is cheap enough to reach a replay Slippi is mid-write on.
  const metadata = game.getMetadata();
  if (!metadata) throw new IncompleteReplayError();
  return buildHeaderRecord(id, path, settings, metadata, game.getGameEnd({ skipProcessing: true }));
}

const SLP_RAW_POSITION = 15;
const HEADER_SETTINGS_CHUNK = 64 * 1024;
const HEADER_SETTINGS_LIMIT = 1024 * 1024;

async function readFileRange(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * File-backed preview parser. A normal replay is a UBJSON envelope whose raw
 * command-stream length lives in bytes 11–14, so the three preview ingredients
 * can be read independently: settings from the first 64 KiB (growing only when
 * needed), the fixed-size GAME_END command at the raw stream's tail, and the
 * small metadata object after it. The old worker handed `parseHeader` a full
 * `arrayBuffer()`, reading multi-megabyte frame data that this pass never uses
 * and then reading those same bytes again for the authoritative full pass.
 *
 * Pre-UBJSON/unknown layouts fall back to the whole-buffer parser. That path is
 * rare, but preserving it keeps compatibility broader than this optimization.
 */
export async function parseHeaderFile(id: string, path: string, file: File): Promise<GameRecord> {
  const fullFallback = async (): Promise<GameRecord> => parseHeader(id, path, await file.arrayBuffer());
  const first = await readFileRange(file, 0, Math.min(file.size, HEADER_SETTINGS_CHUNK));
  if (first.length < SLP_RAW_POSITION || first[0] !== "{".charCodeAt(0)) return fullFallback();

  const rawLength = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(SLP_RAW_POSITION - 4);
  const rawEnd = SLP_RAW_POSITION + rawLength;
  const metadataPosition = rawEnd + 10;
  const metadataEnd = file.size - 1;
  if (rawLength <= 0 || rawEnd > file.size || metadataPosition >= metadataEnd) throw new IncompleteReplayError();

  const parser = new SlpParser();
  const stream = new SlpStream();
  const headerState: { messageSizes: Map<Command, number> | null; messageSizesCommand: Uint8Array | null } = {
    messageSizes: null,
    messageSizesCommand: null,
  };
  stream.on(SlpStreamEvent.RAW, ({ command, payload }) => {
    if (command === Command.MESSAGE_SIZES) headerState.messageSizesCommand = payload.slice();
  });
  stream.on(SlpStreamEvent.COMMAND, ({ command, payload }) => {
    if (command === Command.MESSAGE_SIZES && payload instanceof Map) headerState.messageSizes = payload as Map<Command, number>;
    parser.handleCommand(command, payload);
  });

  let readPosition = SLP_RAW_POSITION;
  const firstRawEnd = Math.min(first.length, rawEnd);
  if (firstRawEnd > readPosition) {
    stream.process(first.subarray(readPosition, firstRawEnd));
    readPosition = firstRawEnd;
  }
  const settingsReadEnd = Math.min(rawEnd, SLP_RAW_POSITION + HEADER_SETTINGS_LIMIT);
  while (!parser.getSettings() && readPosition < settingsReadEnd) {
    const next = Math.min(settingsReadEnd, readPosition + HEADER_SETTINGS_CHUNK);
    stream.process(await readFileRange(file, readPosition, next));
    readPosition = next;
  }
  const settings = parser.getSettings();
  if (!settings || !settings.players || settings.players.length === 0) return fullFallback();

  // Reuse slippi-js's own UBJSON decoder without handing it the frame body:
  // build a compact valid envelope containing the original header, message-size
  // command, metadata marker/tail, and closing brace. This keeps the ranged and
  // whole-buffer paths on one decoder and avoids a second browser polyfill.
  if (!headerState.messageSizesCommand) return fullFallback();
  const metadataTail = await readFileRange(file, rawEnd, metadataEnd);
  const compactRawEnd = SLP_RAW_POSITION + headerState.messageSizesCommand.length;
  const compact = new Uint8Array(compactRawEnd + metadataTail.length + 1);
  compact.set(first.subarray(0, SLP_RAW_POSITION));
  new DataView(compact.buffer).setUint32(SLP_RAW_POSITION - 4, headerState.messageSizesCommand.length);
  compact.set(headerState.messageSizesCommand, SLP_RAW_POSITION);
  compact.set(metadataTail, compactRawEnd);
  compact[compact.length - 1] = "}".charCodeAt(0);
  let metadata: MetadataType | undefined;
  try {
    metadata = new SlippiGame(compact.buffer).getMetadata();
  } catch {
    // Matches slippi-js: an undecodable/missing metadata block means the file
    // was severed while still being written, and must be retried rather than cached.
  }
  if (!metadata) throw new IncompleteReplayError();

  let gameEnd: GameEndType | undefined;
  const gameEndPayloadSize = headerState.messageSizes?.get(Command.GAME_END);
  if (headerState.messageSizesCommand && gameEndPayloadSize && gameEndPayloadSize > 0) {
    const gameEndSize = gameEndPayloadSize + 1;
    const gameEndPosition = rawEnd - gameEndSize;
    if (gameEndPosition >= SLP_RAW_POSITION) {
      const endStream = new SlpStream();
      endStream.on(SlpStreamEvent.COMMAND, ({ command, payload }) => {
        if (command === Command.GAME_END) gameEnd = payload as GameEndType;
      });
      endStream.process(headerState.messageSizesCommand);
      endStream.process(await readFileRange(file, gameEndPosition, rawEnd));
    }
  }

  return buildHeaderRecord(id, path, settings, metadata, gameEnd);
}
