import type { ActionCounts, Filters, GameRecord, GameType, PlayerSide, ResolvedGame, ResolvedTeamGame, TechCounts } from "./types";
import { ACTION_LABELS, hasCurrentStats, hasFullStats, hasKnownCpu } from "./types";
import { INCLUDED_CHARACTER_ID_SET, INCLUDED_STAGE_ID_SET } from "./config";
import { moveGroup, moveGroupTracksAttempts } from "./melee";

/**
 * Every side is a character anyone could actually have picked. One malformed
 * replay reporting Sandbag or Popo is enough to put a "Char 31" row in the
 * matchup tables, and there is no honest name to give it — so the game is
 * dropped whole, the same treatment an illegal stage gets.
 */
const playableRoster = (players: PlayerSide[]): boolean =>
  players.every((p) => INCLUDED_CHARACTER_ID_SET.has(p.characterId));

/** Local-timezone YYYY-MM-DD, matching the dates the user sees in the UI. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Chart-label form of localDay: empty string for undated games. */
const dayLabel = (d: Date | null): string => (d ? localDay(d) : "");

/** Local-timezone YYYY-MM-DD of the Sunday starting this date's week. */
function localWeekStart(date: Date): string {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay()); // back up to Sunday, local time
  return localDay(d);
}

/**
 * Smoothing window shared by every rolling chart in the app — the Overview
 * win-rate curve and every trend on the Execution tab, player and opponent
 * lines alike — and by the titles that name it. One knob: widen it here and
 * they all widen together, which is the only reason they stay consistent.
 *
 * It is also the recency window the Execution tab's tables and KPI strip cover
 * (they read `games.slice(-ROLLING_WINDOW)`), deliberately the same number:
 * every one of those figures is the final point of a chart plotting the same
 * quantity, and the two disagreeing on screen is a bug nobody would spot.
 */
export const ROLLING_WINDOW = 150;

/**
 * Most points a per-game chart draws. The sliding-sum series cost O(1) per
 * game, so what this bounds is the SVG, not the arithmetic.
 *
 * It thins, it does not truncate: the emitted points are spread across the
 * whole filter rather than kept from its tail. Keeping the tail meant a library
 * of any size answered "how am I trending?" with its last 500 games and said so
 * only in a parenthetical — a player with a summer of replays got a chart that
 * started three weeks ago. Every game enters the window either way; this only
 * decides which of the results get drawn.
 */
export const MAX_SERIES_POINTS = 800;

/**
 * Emit every Nth game so `n` of them fit the budget. Anchored to the end, so
 * the newest game is always a point (the move picker promises its last point
 * is the move table's own figure) and the spacing runs back from there.
 */
const seriesStride = (n: number, maxPoints: number): number => Math.max(1, Math.ceil(n / maxPoints));
const emitsAt = (i: number, n: number, stride: number): boolean => (n - 1 - i) % stride === 0;

// ---------- Identity ----------

/**
 * How many games each connect code appears in.
 *
 * This is not identity inference — the user states which accounts are theirs.
 * Guessing doesn't work anyway: in a library where the alt played 40 games, two
 * regular opponents sat above it at 42 and 41, so ranking by frequency would
 * confidently pick the wrong codes. All this does is confirm that a code the
 * user typed actually occurs in the folder, so a typo reads as "no games found"
 * rather than silently producing an empty dashboard.
 *
 * Teams games count too — a doubles-only player still needs an identity.
 */
export function codeGameCounts(records: GameRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rec of records) {
    if (rec.parseError || rec.players.length < 2) continue;
    for (const p of rec.players) {
      if (!p.connectCode) continue;
      counts.set(p.connectCode, (counts.get(p.connectCode) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------- Resolution & filtering ----------

export function resolveGames(records: GameRecord[], myCodes: Set<string>, includeCpuGames = false): ResolvedGame[] {
  const out: ResolvedGame[] = [];
  for (const rec of records) {
    if (rec.parseError || rec.isTeams || rec.players.length !== 2) continue;
    if (!includeCpuGames && hasKnownCpu(rec)) continue;
    if (!INCLUDED_STAGE_ID_SET.has(rec.stageId)) continue;
    if (!playableRoster(rec.players)) continue;
    const meIdx = rec.players.findIndex((p) => p.connectCode && myCodes.has(p.connectCode));
    if (meIdx < 0) continue;
    // meIdx is 0 or 1 (players.length === 2 checked above), so both are in bounds.
    const me = rec.players[meIdx]!;
    const opp = rec.players[1 - meIdx]!;
    // Both sides are the user's own accounts. Whichever we called "me" won,
    // so a real result here would be a coin flip credited to the lower port —
    // treat it as indeterminate, exactly like a sub-30s game (decision 2).
    const selfMatch = opp.connectCode !== null && myCodes.has(opp.connectCode);
    const isWin = selfMatch || rec.winnerIndex === null ? null : rec.winnerIndex === meIdx;
    out.push({ rec, me, opp, isWin, date: rec.playedAt ? new Date(rec.playedAt) : null, selfMatch });
  }
  return out.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}

/**
 * Resolve 2v2 games. Requires a clean 4-player, two-team game: anything odd
 * (3v1, free-for-all with team flags, a missing teamId) is skipped rather than
 * guessed at, since a wrong teammate silently corrupts every team stat.
 */
export function resolveTeamGames(records: GameRecord[], myCodes: Set<string>, includeCpuGames = false): ResolvedTeamGame[] {
  const out: ResolvedTeamGame[] = [];
  for (const rec of records) {
    if (rec.parseError || !rec.isTeams || rec.players.length !== 4) continue;
    if (!includeCpuGames && hasKnownCpu(rec)) continue;
    if (!INCLUDED_STAGE_ID_SET.has(rec.stageId)) continue;
    if (!playableRoster(rec.players)) continue;
    const me = rec.players.find((p) => p.connectCode && myCodes.has(p.connectCode));
    if (!me || me.teamId === null) continue;
    const allies = rec.players.filter((p) => p !== me && p.teamId === me.teamId);
    const opps = rec.players.filter((p) => p.teamId !== null && p.teamId !== me.teamId);
    if (allies.length !== 1 || opps.length !== 2) continue;
    // A second account of the user's on either side — teammate or opponent —
    // means an account was lent out, so who "me" refers to is ambiguous. Same
    // treatment as singles: no result, and kept out of the per-partner splits.
    const mine = (p: PlayerSide) => p.connectCode !== null && myCodes.has(p.connectCode);
    const selfMatch = mine(allies[0]!) || opps.some(mine);
    const isWin = selfMatch || rec.winnerTeamId === null ? null : rec.winnerTeamId === me.teamId;
    out.push({
      rec,
      me,
      teammate: allies[0]!, // allies.length === 1 checked above
      opps: [opps[0]!, opps[1]!], // opps.length === 2 checked above
      isWin,
      date: rec.playedAt ? new Date(rec.playedAt) : null,
      selfMatch,
    });
  }
  return out.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
}

const RANGE_DAYS: Record<Exclude<Filters["range"], "all">, number> = { "7d": 7, "14d": 14, "30d": 30, "90d": 90, "1y": 365 };

export function applyFilters(games: ResolvedGame[], f: Filters): ResolvedGame[] {
  // A picked day overrides the relative range — combining them could only
  // produce "day inside range" (redundant) or "day outside range" (empty).
  let cutoff: number | null = null;
  if (f.day === null && f.range !== "all") cutoff = Date.now() - RANGE_DAYS[f.range] * 86_400_000;
  return games.filter((g) => {
    if (f.day !== null && (!g.date || localDay(g.date) !== f.day)) return false;
    if (cutoff !== null && (!g.date || g.date.getTime() < cutoff)) return false;
    if (f.accountCode !== null && g.me.connectCode !== f.accountCode) return false;
    if (f.myCharacter !== null && g.me.characterId !== f.myCharacter) return false;
    if (f.oppCharacter !== null && g.opp.characterId !== f.oppCharacter) return false;
    if (f.stageId !== null && g.rec.stageId !== f.stageId) return false;
    if (f.opponentCode !== null && g.opp.connectCode !== f.opponentCode) return false;
    if (f.gameTypes !== null && !f.gameTypes.includes(g.rec.gameType)) return false;
    return true;
  });
}

/** Same filters against a 2v2 game; opponent-side predicates match if *either* opponent matches. */
export function applyTeamFilters(games: ResolvedTeamGame[], f: Filters): ResolvedTeamGame[] {
  let cutoff: number | null = null;
  if (f.day === null && f.range !== "all") cutoff = Date.now() - RANGE_DAYS[f.range] * 86_400_000;
  return games.filter((g) => {
    if (f.day !== null && (!g.date || localDay(g.date) !== f.day)) return false;
    if (cutoff !== null && (!g.date || g.date.getTime() < cutoff)) return false;
    if (f.accountCode !== null && g.me.connectCode !== f.accountCode) return false;
    if (f.myCharacter !== null && g.me.characterId !== f.myCharacter) return false;
    if (f.oppCharacter !== null && !g.opps.some((o) => o.characterId === f.oppCharacter)) return false;
    if (f.stageId !== null && g.rec.stageId !== f.stageId) return false;
    if (f.opponentCode !== null && !g.opps.some((o) => o.connectCode === f.opponentCode)) return false;
    if (f.teammateCode !== null && g.teammate.connectCode !== f.teammateCode) return false;
    if (f.gameTypes !== null && !f.gameTypes.includes(g.rec.gameType)) return false;
    return true;
  });
}

// ---------- Aggregations ----------

const winRate = (wins: number, decided: number) => (decided > 0 ? wins / decided : null);

export interface WL {
  games: number;
  wins: number;
  losses: number;
  decided: number;
  winRate: number | null;
}

/** Shared by singles and teams — both carry a nullable isWin. */
type Decidable = { isWin: boolean | null };

export function tally(games: Decidable[]): WL {
  let wins = 0;
  let losses = 0;
  for (const g of games) {
    if (g.isWin === true) wins++;
    else if (g.isWin === false) losses++;
  }
  return { games: games.length, wins, losses, decided: wins + losses, winRate: winRate(wins, wins + losses) };
}

/** Current W/L streak over decided games, most recent last. */
function streakOf(games: Decidable[]): { kind: "W" | "L"; length: number } | null {
  let streak: { kind: "W" | "L"; length: number } | null = null;
  for (let i = games.length - 1; i >= 0; i--) {
    const w = games[i]!.isWin;
    if (w === null) continue;
    const kind = w ? "W" : "L";
    if (!streak) streak = { kind, length: 1 };
    else if (streak.kind === kind) streak.length++;
    else break;
  }
  return streak;
}

export interface OverviewStats extends WL {
  totalKills: number;
  killsPerGame: number | null;
  deathsPerGame: number | null;
  damagePerGame: number | null;
  avgGameSeconds: number | null;
  currentStreak: { kind: "W" | "L"; length: number } | null;
  prevWinRate: number | null; // same-length window immediately before the current one
}

export function overview(games: ResolvedGame[], allResolved: ResolvedGame[], f: Filters): OverviewStats {
  const base = tally(games);
  let kills = 0;
  let deaths = 0;
  let damage = 0;
  let frames = 0;
  // Per-game rates get their own denominator. While a large import is running
  // the dashboard is briefly showing header previews, whose kill and damage
  // counts are zeroes standing in for "not computed yet" — dividing by every
  // game would walk these averages toward zero for the length of the import.
  // Duration comes out of the header, so `frames` still counts every game.
  let measured = 0;
  for (const g of games) {
    frames += g.rec.durationFrames;
    if (!hasFullStats(g.rec)) continue;
    measured++;
    kills += g.me.kills;
    deaths += g.opp.kills;
    damage += g.me.totalDamage;
  }
  const streak = streakOf(games);
  // Prior-window comparison (only meaningful for bounded ranges; a picked day
  // overrides the range, so no prior window exists to compare against).
  let prevWinRate: number | null = null;
  if (f.day === null && f.range !== "all") {
    const days = RANGE_DAYS[f.range];
    const end = Date.now() - days * 86_400_000;
    const start = end - days * 86_400_000;
    const prev = allResolved.filter((g) => g.date && g.date.getTime() >= start && g.date.getTime() < end);
    prevWinRate = tally(applyFilters(prev, { ...f, range: "all" })).winRate;
  }
  return {
    ...base,
    totalKills: kills,
    killsPerGame: measured ? kills / measured : null,
    deathsPerGame: measured ? deaths / measured : null,
    damagePerGame: measured ? damage / measured : null,
    avgGameSeconds: games.length ? frames / 60 / games.length : null,
    currentStreak: streak,
    prevWinRate,
  };
}

export interface NeutralSummaryRow {
  label: string;
  mine: number;
  theirs: number;
  perGame: number;
  oppPerGame?: number;
  minePct?: number | null;
  theirsPct?: number | null;
  share: number | null; // mine / (mine + theirs)
}

/**
 * Aggregate neutral-exchange counts: who's winning neutral, countering, and
 * trading well. `covered` is how many of the given games actually carry the
 * counts — the caller names that number, not the array length, or a window
 * still filling with header previews reads as a full one.
 */
export function neutralSummary(games: ResolvedGame[]): { rows: NeutralSummaryRow[]; techRows: NeutralSummaryRow[]; covered: number } {
  // `share` is a ratio of sums and would survive a header preview, but
  // `perGame` would not: a preview contributes nothing to the numerator and a
  // whole game to the denominator.
  const measured = games.filter((g) => hasFullStats(g.rec));
  const summarize = (defs: { label: string; pick: (p: PlayerSide) => number }[]) => defs.map(({ label, pick }) => {
    let mine = 0;
    let theirs = 0;
    for (const g of measured) {
      mine += pick(g.me) ?? 0;
      theirs += pick(g.opp) ?? 0;
    }
    return {
      label,
      mine,
      theirs,
      perGame: measured.length ? mine / measured.length : 0,
      oppPerGame: measured.length ? theirs / measured.length : 0,
      share: mine + theirs > 0 ? mine / (mine + theirs) : null,
    };
  });
  const rows = summarize([
    { label: "Neutral wins", pick: (p) => p.neutralWins },
    { label: "Counter hits", pick: (p) => p.counterHits },
    { label: "Beneficial trades", pick: (p) => p.beneficialTrades },
  ]);
  const techRows = summarize([
    { label: "Tech in place", pick: (p) => p.techs?.inPlace ?? 0 },
    { label: "Tech in", pick: (p) => p.techs?.toward ?? 0 },
    { label: "Tech away", pick: (p) => p.techs?.away ?? 0 },
  ]);
  const mineGroundTechs = techRows.reduce((sum, row) => sum + row.mine, 0);
  const theirGroundTechs = techRows.reduce((sum, row) => sum + row.theirs, 0);
  return {
    rows,
    techRows: techRows.map((row) => ({
      ...row,
      minePct: mineGroundTechs > 0 ? row.mine / mineGroundTechs : null,
      theirsPct: theirGroundTechs > 0 ? row.theirs / theirGroundTechs : null,
    })),
    covered: measured.length,
  };
}

const TECH_ACTION_LABELS: { key: string; label: string; pick: (p: PlayerSide) => number }[] = [
  { key: "techInPlace", label: "Tech in place", pick: (p) => p.techs?.inPlace ?? 0 },
  { key: "techIn", label: "Tech in", pick: (p) => p.techs?.toward ?? 0 },
  { key: "techAway", label: "Tech away", pick: (p) => p.techs?.away ?? 0 },
];

const ACTION_AVERAGE_LABELS: { key: string; label: string; pick: (p: PlayerSide) => number }[] = [
  ...ACTION_LABELS.map(({ key, label }) => ({ key, label, pick: (p: PlayerSide) => p.actions?.[key] ?? 0 })),
  ...TECH_ACTION_LABELS,
];

export interface ActionAverageRow {
  key: string;
  label: string;
  perGame: number;
  perMinute: number;
  oppPerGame: number;
  oppPerMinute: number;
}

/**
 * Average action counts per game (and per minute, for length-independent
 * comparison). `covered` is the measured-game count behind those averages —
 * see neutralSummary for why the caller needs it rather than `games.length`.
 */
export function actionAverages(games: ResolvedGame[]): { rows: ActionAverageRow[]; covered: number } {
  // Header previews carry zeroed action counts, and both denominators here —
  // game count and total minutes — would otherwise include them.
  const measured = games.filter((g) => hasFullStats(g.rec));
  if (measured.length === 0) return { rows: [], covered: 0 };
  const minutes = measured.reduce((sum, g) => sum + g.rec.durationFrames, 0) / 3600;
  const rows = ACTION_AVERAGE_LABELS.map(({ key, label, pick }) => {
    let mine = 0;
    let theirs = 0;
    for (const g of measured) {
      mine += pick(g.me);
      theirs += pick(g.opp);
    }
    return {
      key,
      label,
      perGame: mine / measured.length,
      perMinute: minutes > 0 ? mine / minutes : 0,
      oppPerGame: theirs / measured.length,
      oppPerMinute: minutes > 0 ? theirs / minutes : 0,
    };
  });
  return { rows, covered: measured.length };
}

const EMPTY_TECH_COUNTS: TechCounts = {
  inPlace: 0,
  toward: 0,
  away: 0,
  missed: 0,
  wallSuccess: 0,
  wallMissed: 0,
};

function playerTechCounts(p: PlayerSide): TechCounts {
  return p.techs ?? EMPTY_TECH_COUNTS;
}

function groundTechSuccess(t: TechCounts): number {
  return t.inPlace + t.toward + t.away;
}

function groundTechAttempts(t: TechCounts): number {
  return groundTechSuccess(t) + t.missed;
}

function wallTechAttempts(t: TechCounts): number {
  return t.wallSuccess + t.wallMissed;
}

function allTechSuccess(t: TechCounts): number {
  return groundTechSuccess(t) + t.wallSuccess;
}

function allTechAttempts(t: TechCounts): number {
  return groundTechAttempts(t) + wallTechAttempts(t);
}

function addTechCounts(total: TechCounts, p: PlayerSide): void {
  const t = playerTechCounts(p);
  total.inPlace += t.inPlace;
  total.toward += t.toward;
  total.away += t.away;
  total.missed += t.missed;
  total.wallSuccess += t.wallSuccess;
  total.wallMissed += t.wallMissed;
}

export interface RollingPoint {
  index: number;
  date: string;
  winRate: number;
}

export function rollingWinRate(games: ResolvedGame[], window = ROLLING_WINDOW): RollingPoint[] {
  const decided = games.filter((g) => g.isWin !== null);
  const out: RollingPoint[] = [];
  let wins = 0;
  for (let i = 0; i < decided.length; i++) {
    const g = decided[i]!;
    if (g.isWin) wins++;
    if (i >= window && decided[i - window]!.isWin) wins--;
    const n = Math.min(i + 1, window);
    if (i + 1 >= Math.min(window, 10)) {
      out.push({
        index: i + 1,
        date: dayLabel(g.date),
        winRate: (wins / n) * 100,
      });
    }
  }
  return out;
}

export interface CharacterRow extends WL {
  characterId: number;
  killsPerGame: number | null;
  deathsPerGame: number | null;
  inputsPerMinute: number | null;
  /** My L-cancel attempts on this character over every game in the filter — no recency window. */
  lCancelAttempts: number;
  lCancelPct: number | null;
}

export function byMyCharacter(games: ResolvedGame[]): CharacterRow[] {
  return groupRows(games, (g) => g.me.characterId);
}

export function byOppCharacter(games: ResolvedGame[]): CharacterRow[] {
  return groupRows(games, (g) => g.opp.characterId);
}

function groupRows(games: ResolvedGame[], key: (g: ResolvedGame) => number): CharacterRow[] {
  const map = new Map<number, ResolvedGame[]>();
  for (const g of games) {
    const k = key(g);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(g);
  }
  return Array.from(map.entries())
    .map(([characterId, gs]) => {
      const t = tally(gs);
      let kills = 0;
      let deaths = 0;
      let inputs = 0;
      let inputMinutes = 0;
      let lcS = 0;
      let lcF = 0;
      // The L-cancel rate is a ratio of sums and a header preview adds 0 to
      // both halves, but the kill/death averages divide by a game count — so
      // that count has to be of games the numbers actually came from.
      let measured = 0;
      for (const g of gs) {
        if (!hasFullStats(g.rec)) continue;
        measured++;
        kills += g.me.kills;
        deaths += g.opp.kills;
        if (g.me.inputsPerMinute !== null) {
          const minutes = g.rec.durationFrames / 3600;
          inputs += g.me.inputsPerMinute * minutes;
          inputMinutes += minutes;
        }
        // Attempt-weighted, never a mean of per-game rates: a 3-aerial game
        // must not swing the row as hard as a 40-aerial one.
        lcS += g.me.lCancelSuccess;
        lcF += g.me.lCancelFail;
      }
      const lcAtt = lcS + lcF;
      return {
        characterId,
        ...t,
        killsPerGame: measured ? kills / measured : null,
        deathsPerGame: measured ? deaths / measured : null,
        inputsPerMinute: inputMinutes > 0 ? inputs / inputMinutes : null,
        lCancelAttempts: lcAtt,
        lCancelPct: lcAtt > 0 ? lcS / lcAtt : null,
      };
    })
    .sort((a, b) => b.games - a.games);
}

export interface MatchupCell extends WL {
  myChar: number;
  oppChar: number;
}

export function matchupMatrix(games: ResolvedGame[]): { myChars: number[]; oppChars: number[]; cells: Map<string, MatchupCell> } {
  const cells = new Map<string, MatchupCell>();
  const myCount = new Map<number, number>();
  const oppCount = new Map<number, number>();
  for (const g of games) {
    const key = `${g.me.characterId}:${g.opp.characterId}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { myChar: g.me.characterId, oppChar: g.opp.characterId, games: 0, wins: 0, losses: 0, decided: 0, winRate: null };
      cells.set(key, cell);
    }
    cell.games++;
    if (g.isWin === true) cell.wins++;
    else if (g.isWin === false) cell.losses++;
    myCount.set(g.me.characterId, (myCount.get(g.me.characterId) ?? 0) + 1);
    oppCount.set(g.opp.characterId, (oppCount.get(g.opp.characterId) ?? 0) + 1);
  }
  for (const cell of cells.values()) {
    cell.decided = cell.wins + cell.losses;
    cell.winRate = winRate(cell.wins, cell.decided);
  }
  const sortDesc = (m: Map<number, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { myChars: sortDesc(myCount), oppChars: sortDesc(oppCount), cells };
}

export interface StageCharCell extends WL {
  stageId: number;
  charId: number;
}

/**
 * Counterpick helper: win rate by stage × character. side="opp" keys on the
 * opponent's character (where do I beat Fox?); side="mine" keys on my own
 * (where does my Falco perform?). Stages sort by legal-list order via games
 * played; characters by games played.
 */
export function stageCharMatrix(
  games: ResolvedGame[],
  side: "opp" | "mine",
): { stages: number[]; chars: number[]; cells: Map<string, StageCharCell> } {
  const cells = new Map<string, StageCharCell>();
  const stageCount = new Map<number, number>();
  const charCount = new Map<number, number>();
  for (const g of games) {
    const charId = side === "opp" ? g.opp.characterId : g.me.characterId;
    const key = `${g.rec.stageId}:${charId}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { stageId: g.rec.stageId, charId, games: 0, wins: 0, losses: 0, decided: 0, winRate: null };
      cells.set(key, cell);
    }
    cell.games++;
    if (g.isWin === true) cell.wins++;
    else if (g.isWin === false) cell.losses++;
    stageCount.set(g.rec.stageId, (stageCount.get(g.rec.stageId) ?? 0) + 1);
    charCount.set(charId, (charCount.get(charId) ?? 0) + 1);
  }
  for (const cell of cells.values()) {
    cell.decided = cell.wins + cell.losses;
    cell.winRate = winRate(cell.wins, cell.decided);
  }
  const sortDesc = (m: Map<number, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { stages: sortDesc(stageCount), chars: sortDesc(charCount), cells };
}

// ---------- Sessions & tilt ----------

export interface Session {
  start: Date;
  end: Date;
  games: ResolvedGame[];
  wins: number;
  losses: number;
  decided: number;
  winRate: number | null;
  minutes: number;
}

/** Group games into play sessions: a new session starts after `gapMinutes` of no games. */
export function computeSessions(games: ResolvedGame[], gapMinutes = 30): Session[] {
  const sessions: Session[] = [];
  let cur: Session | null = null;
  let lastEndMs = 0;
  for (const g of games) {
    if (!g.date) continue;
    const startMs = g.date.getTime();
    const endMs = startMs + (g.rec.durationFrames / 60) * 1000;
    if (!cur || startMs - lastEndMs > gapMinutes * 60_000) {
      cur = { start: g.date, end: new Date(endMs), games: [], wins: 0, losses: 0, decided: 0, winRate: null, minutes: 0 };
      sessions.push(cur);
    }
    cur.games.push(g);
    if (g.isWin === true) cur.wins++;
    else if (g.isWin === false) cur.losses++;
    cur.end = new Date(Math.max(cur.end.getTime(), endMs));
    lastEndMs = endMs;
  }
  for (const s of sessions) {
    s.decided = s.wins + s.losses;
    s.winRate = winRate(s.wins, s.decided);
    s.minutes = (s.end.getTime() - s.start.getTime()) / 60_000;
  }
  return sessions;
}

export interface SessionBucketRow extends WL {
  label: string;
}

/** Win rate by position within a session: does your play degrade as the session drags? */
export function winRateBySessionPosition(sessions: Session[]): SessionBucketRow[] {
  const defs: { label: string; lo: number; hi: number }[] = [
    { label: "Games 1–5", lo: 1, hi: 5 },
    { label: "Games 6–10", lo: 6, hi: 10 },
    { label: "Games 11–15", lo: 11, hi: 15 },
    { label: "Games 16–20", lo: 16, hi: 20 },
    { label: "Games 21+", lo: 21, hi: Infinity },
  ];
  const agg = defs.map(() => ({ games: 0, wins: 0, losses: 0 }));
  for (const s of sessions) {
    s.games.forEach((g, i) => {
      const pos = i + 1;
      const bi = defs.findIndex((d) => pos >= d.lo && pos <= d.hi);
      if (bi < 0) return;
      const a = agg[bi]!; // agg is index-aligned with defs
      a.games++;
      if (g.isWin === true) a.wins++;
      else if (g.isWin === false) a.losses++;
    });
  }
  return defs.map((d, i) => {
    const a = agg[i]!; // agg is index-aligned with defs
    return {
      label: d.label,
      games: a.games,
      wins: a.wins,
      losses: a.losses,
      decided: a.wins + a.losses,
      winRate: winRate(a.wins, a.wins + a.losses),
    };
  });
}

/**
 * Win rate conditioned on the streak you were on entering the game (within the
 * same session). "After 3+ losses" trending below baseline is what tilt looks
 * like in the data. Indeterminate games neither extend nor break a streak.
 */
export function tiltStats(sessions: Session[]): SessionBucketRow[] {
  const defs = ["Session opener", "After a win", "After 2+ wins", "After a loss", "After 2 losses", "After 3+ losses"] as const;
  const agg = new Map(defs.map((d) => [d as string, { games: 0, wins: 0, losses: 0 }]));
  const add = (label: string, isWin: boolean) => {
    const a = agg.get(label)!;
    a.games++;
    if (isWin) a.wins++;
    else a.losses++;
  };
  for (const s of sessions) {
    let kind: "W" | "L" | null = null;
    let run = 0;
    for (const g of s.games) {
      if (g.isWin === null) continue;
      if (kind === null) add("Session opener", g.isWin);
      else if (kind === "W") add(run >= 2 ? "After 2+ wins" : "After a win", g.isWin);
      else add(run >= 3 ? "After 3+ losses" : run === 2 ? "After 2 losses" : "After a loss", g.isWin);
      const k = g.isWin ? "W" : "L";
      run = k === kind ? run + 1 : 1;
      kind = k;
    }
  }
  return defs.map((label) => {
    const a = agg.get(label)!;
    return { label, games: a.games, wins: a.wins, losses: a.losses, decided: a.wins + a.losses, winRate: winRate(a.wins, a.wins + a.losses) };
  });
}

// ---------- Records ----------

export interface GameRef {
  oppCode: string | null;
  oppChar: number;
  date: Date | null;
}

export interface SinglesRecords {
  bestWinStreak: { length: number; end: Date | null } | null;
  worstLossStreak: { length: number; end: Date | null } | null;
  highestDamage: (GameRef & { value: number }) | null;
  fastestWin: (GameRef & { seconds: number }) | null;
  longestGame: (GameRef & { seconds: number }) | null;
  perfectWins: number; // wins with all 4 stocks intact
  bestLCancelDay: { day: string; rate: number; attempts: number } | null;
  busiestDay: { day: string; games: number } | null;
  longestSession: { games: number; start: Date } | null;
  nemesis: { code: string; wins: number; losses: number } | null; // most losses to
  victim: { code: string; wins: number; losses: number } | null; // most wins against
}

const LC_DAY_MIN_ATTEMPTS = 100;

export function singlesRecords(games: ResolvedGame[]): SinglesRecords {
  let bestW: SinglesRecords["bestWinStreak"] = null;
  let bestL: SinglesRecords["worstLossStreak"] = null;
  let kind: "W" | "L" | null = null;
  let run = 0;
  let highestDamage: SinglesRecords["highestDamage"] = null;
  let fastestWin: SinglesRecords["fastestWin"] = null;
  let longestGame: SinglesRecords["longestGame"] = null;
  let perfectWins = 0;
  const lcByDay = new Map<string, { s: number; f: number }>();
  const gamesByDay = new Map<string, number>();
  const byOpp = new Map<string, { wins: number; losses: number }>();

  const ref = (g: ResolvedGame): GameRef => ({ oppCode: g.opp.connectCode, oppChar: g.opp.characterId, date: g.date });

  for (const g of games) {
    const seconds = g.rec.durationFrames / 60;
    if (g.isWin !== null) {
      const k = g.isWin ? "W" : "L";
      run = k === kind ? run + 1 : 1;
      kind = k;
      if (k === "W" && (!bestW || run > bestW.length)) bestW = { length: run, end: g.date };
      if (k === "L" && (!bestL || run > bestL.length)) bestL = { length: run, end: g.date };
    }
    // A header preview reports zero damage, so without this guard the card
    // reads 0 for as long as the preview is the only thing on screen.
    if (hasFullStats(g.rec) && (!highestDamage || g.me.totalDamage > highestDamage.value)) {
      highestDamage = { ...ref(g), value: g.me.totalDamage };
    }
    if (g.isWin === true && (!fastestWin || seconds < fastestWin.seconds)) fastestWin = { ...ref(g), seconds };
    if (!longestGame || seconds > longestGame.seconds) longestGame = { ...ref(g), seconds };
    if (g.isWin === true && g.me.stocksRemaining === 4) perfectWins++;
    if (g.date) {
      const day = localDay(g.date);
      gamesByDay.set(day, (gamesByDay.get(day) ?? 0) + 1);
      const lc = lcByDay.get(day) ?? { s: 0, f: 0 };
      lc.s += g.me.lCancelSuccess;
      lc.f += g.me.lCancelFail;
      lcByDay.set(day, lc);
    }
    if (g.opp.connectCode && g.isWin !== null) {
      const o = byOpp.get(g.opp.connectCode) ?? { wins: 0, losses: 0 };
      if (g.isWin) o.wins++;
      else o.losses++;
      byOpp.set(g.opp.connectCode, o);
    }
  }

  let bestLCancelDay: SinglesRecords["bestLCancelDay"] = null;
  for (const [day, { s, f }] of lcByDay) {
    if (s + f < LC_DAY_MIN_ATTEMPTS) continue;
    const rate = s / (s + f);
    if (!bestLCancelDay || rate > bestLCancelDay.rate) bestLCancelDay = { day, rate, attempts: s + f };
  }
  let busiestDay: SinglesRecords["busiestDay"] = null;
  for (const [day, n] of gamesByDay) {
    if (!busiestDay || n > busiestDay.games) busiestDay = { day, games: n };
  }
  const sessions = computeSessions(games);
  let longestSession: SinglesRecords["longestSession"] = null;
  for (const s of sessions) {
    if (!longestSession || s.games.length > longestSession.games) longestSession = { games: s.games.length, start: s.start };
  }
  let nemesis: SinglesRecords["nemesis"] = null;
  let victim: SinglesRecords["victim"] = null;
  for (const [code, o] of byOpp) {
    if (!nemesis || o.losses > nemesis.losses) nemesis = { code, ...o };
    if (!victim || o.wins > victim.wins) victim = { code, ...o };
  }

  return { bestWinStreak: bestW, worstLossStreak: bestL, highestDamage, fastestWin, longestGame, perfectWins, bestLCancelDay, busiestDay, longestSession, nemesis, victim };
}

export interface TeamsRecords {
  bestWinStreak: { length: number; end: Date | null } | null;
  /** Teammate who friendly-fires me the most (per game, min 5 games). */
  grudge: { code: string; ffPerGame: number; games: number } | null;
  /** Teammate I friendly-fire the most (per game, min 5 games). */
  myTarget: { code: string; ffPerGame: number; games: number } | null;
}

const FF_RECORD_MIN_GAMES = 5;

export function teamsRecords(games: ResolvedTeamGame[]): TeamsRecords {
  let best: TeamsRecords["bestWinStreak"] = null;
  let kind: "W" | "L" | null = null;
  let run = 0;
  const ff = new Map<string, { toMe: number; fromMe: number; games: number }>();
  for (const g of games) {
    if (g.isWin !== null) {
      const k = g.isWin ? "W" : "L";
      run = k === kind ? run + 1 : 1;
      kind = k;
      if (k === "W" && (!best || run > best.length)) best = { length: run, end: g.date };
    }
    const dm = g.rec.dmgMatrix;
    const code = g.teammate.connectCode;
    if (!dm || !code || g.selfMatch) continue;
    const ps = g.rec.players;
    const me = ps.indexOf(g.me);
    const mate = ps.indexOf(g.teammate);
    if (me < 0 || mate < 0) continue;
    const e = ff.get(code) ?? { toMe: 0, fromMe: 0, games: 0 };
    // A malformed (short) matrix would previously have produced NaN via
    // `undefined` arithmetic; `!` keeps that behavior unchanged.
    e.toMe += dm[mate]![me]!;
    e.fromMe += dm[me]![mate]!;
    e.games++;
    ff.set(code, e);
  }
  let grudge: TeamsRecords["grudge"] = null;
  let myTarget: TeamsRecords["myTarget"] = null;
  for (const [code, e] of ff) {
    if (e.games < FF_RECORD_MIN_GAMES) continue;
    const toMe = e.toMe / e.games;
    const fromMe = e.fromMe / e.games;
    if (!grudge || toMe > grudge.ffPerGame) grudge = { code, ffPerGame: toMe, games: e.games };
    if (!myTarget || fromMe > myTarget.ffPerGame) myTarget = { code, ffPerGame: fromMe, games: e.games };
  }
  return { bestWinStreak: best, grudge, myTarget };
}

// ---------- Moves ----------

export interface MoveRow {
  key: string;
  label: string;
  attempts: number | null; // null = not tracked for this move (specials, throws)
  attemptsPerGame: number | null;
  landed: number;
  landedPerGame: number;
  damage: number;
  dmgPerGame: number;
  dmgShare: number | null;
  avgDmgPerHit: number | null;
  kills: number;
  killShare: number | null;
  avgKillPct: number | null;
  openings: number;
  openingShare: number | null;
  dmgPerOpening: number | null;
  lCancelAttempts: number; // whiffs included; aerials only, 0 elsewhere
  lCancelPct: number | null;
}

/**
 * v11/v12 records can carry move-attempt counts without the later tech schema,
 * while older move rows have no attempt fields at all. Current records are
 * known-capable even when every tracked move was unused; legacy records count
 * only when an actual normal/aerial attempt field proves that capability.
 */
const hasMoveAttemptStats = (game: ResolvedGame, moves: PlayerSide["moveStats"]): boolean =>
  moves !== undefined && (hasCurrentStats(game.rec) || Object.entries(moves).some(([moveId, move]) =>
    move.attempts !== undefined && moveGroupTracksAttempts(moveGroup(Number(moveId)).key)));

/**
 * Aggregate the per-game move stats into one row per move group. `covered` is
 * how many games actually carry move data (rows parsed before the moveStats
 * schema, and all teams games, have none).
 */
export function moveTable(games: ResolvedGame[]): { rows: MoveRow[]; covered: number } {
  const agg = new Map<string, { label: string; landed: number; damage: number; kills: number; killPctSum: number; openings: number; openingDmg: number; lcS: number; lcF: number; attempts: number | null }>();
  let covered = 0;
  let attemptCovered = 0;
  let totalDamage = 0, totalKills = 0, totalOpenings = 0;
  for (const g of games) {
    const ms = g.me.moveStats;
    if (!ms) continue;
    covered++;
    const attemptsAvailable = hasMoveAttemptStats(g, ms);
    if (attemptsAvailable) attemptCovered++;
    for (const [idStr, m] of Object.entries(ms)) {
      const grp = moveGroup(Number(idStr));
      let a = agg.get(grp.key);
      if (!a) {
        a = { label: grp.label, landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lcS: 0, lcF: 0, attempts: null as number | null };
        agg.set(grp.key, a);
      }
      if (attemptsAvailable && m.attempts !== undefined) a.attempts = (a.attempts ?? 0) + m.attempts;
      a.landed += m.landed;
      a.damage += m.damage;
      a.kills += m.kills;
      a.killPctSum += m.killPctSum;
      a.openings += m.openings;
      a.openingDmg += m.openingDmg;
      a.lcS += m.lcSuccess ?? 0;
      a.lcF += m.lcFail ?? 0;
      totalDamage += m.damage;
      totalKills += m.kills;
      totalOpenings += m.openings;
    }
  }
  const rows: MoveRow[] = Array.from(agg.entries())
    .filter(([, a]) => a.landed > 0 || a.lcS + a.lcF > 0)
    .map(([key, a]) => {
      const attempts = moveGroupTracksAttempts(key) && attemptCovered > 0 ? a.attempts ?? 0 : null;
      return {
        key,
        label: a.label,
        attempts,
        attemptsPerGame: attempts !== null ? attempts / attemptCovered : null,
        landed: a.landed,
        landedPerGame: covered ? a.landed / covered : 0,
        damage: a.damage,
        dmgPerGame: covered ? a.damage / covered : 0,
        dmgShare: totalDamage > 0 ? a.damage / totalDamage : null,
        avgDmgPerHit: a.landed ? a.damage / a.landed : null,
        kills: a.kills,
        killShare: totalKills > 0 ? a.kills / totalKills : null,
        avgKillPct: a.kills ? a.killPctSum / a.kills : null,
        openings: a.openings,
        openingShare: totalOpenings > 0 ? a.openings / totalOpenings : null,
        dmgPerOpening: a.openings ? a.openingDmg / a.openings : null,
        lCancelAttempts: a.lcS + a.lcF,
        lCancelPct: a.lcS + a.lcF > 0 ? a.lcS / (a.lcS + a.lcF) : null,
      };
    })
    .sort((a, b) => b.damage - a.damage);
  return { rows, covered };
}

/** One column of the move table, as a key the chart's metric picker passes back. */
export type MoveMetricKey =
  | "attemptsPerGame"
  | "landedPerGame"
  | "dmgPerGame"
  | "dmgShare"
  | "avgDmgPerHit"
  | "killsPerGame"
  | "killShare"
  | "avgKillPct"
  | "lCancelPct";

/**
 * Field layout of the one-game slice `moveMetricSeries` slides a window over.
 * A flat stride rather than objects because the window is a ring buffer: the
 * slot being overwritten is the game leaving the window, and reading its two
 * numbers back out is the whole subtraction step.
 */
const MV = {
  attempts: 0,
  attemptGames: 1, // games that actually carry the attempt-count schema
  landed: 2,
  damage: 3,
  kills: 4,
  killPctSum: 5,
  lCancelSuccess: 6,
  lCancelTotal: 7,
  games: 8, // games carrying move data at all, the other per-game denominators
  allDamage: 9, // whole arsenal, for the share columns
  allKills: 10,
} as const;
const MV_STRIDE = 11;

/**
 * Each move-table column as a numerator/denominator pair, so a windowed value
 * is a ratio of sliding sums. The denominators differ on purpose: per-game
 * rates divide by the games that carry their schema (attempts exclude older
 * rows without attempt counters), shares by that window's whole-arsenal total,
 * and the quality columns (avg damage, avg kill %, L-cancel) by their own event
 * count — so an unavailable measurement never becomes a fabricated zero.
 */
const MOVE_METRICS: Record<MoveMetricKey, { num: number; den: number; scale: number }> = {
  attemptsPerGame: { num: MV.attempts, den: MV.attemptGames, scale: 1 },
  landedPerGame: { num: MV.landed, den: MV.games, scale: 1 },
  dmgPerGame: { num: MV.damage, den: MV.games, scale: 1 },
  dmgShare: { num: MV.damage, den: MV.allDamage, scale: 100 },
  avgDmgPerHit: { num: MV.damage, den: MV.landed, scale: 1 },
  killsPerGame: { num: MV.kills, den: MV.games, scale: 1 },
  killShare: { num: MV.kills, den: MV.allKills, scale: 100 },
  avgKillPct: { num: MV.killPctSum, den: MV.kills, scale: 1 },
  lCancelPct: { num: MV.lCancelSuccess, den: MV.lCancelTotal, scale: 100 },
};

/** Values for every selected move at one sampled point in the rolling series. */
export interface MultiMoveMetricPoint {
  index: number;
  date: string;
  /** Same order as the `moveKeys` passed to `moveMetricSeriesMany`. */
  values: (number | null)[];
}

/**
 * Write one game's contribution for every selected move into `out`. The replay
 * move table is walked once regardless of how many lines the chart is showing.
 */
function moveSlices(
  g: ResolvedGame,
  keyIndex: ReadonlyMap<string, number>,
  moveCount: number,
  out: Float64Array,
  side: "me" | "opp" = "me",
): void {
  out.fill(0);
  let gameCount = 0, allDamage = 0, allKills = 0;
  const ms = g[side].moveStats;
  if (ms) {
    gameCount = 1;
    const attemptsAvailable = hasMoveAttemptStats(g, ms);
    for (const idStr in ms) {
      const m = ms[Number(idStr)];
      if (!m) continue;
      allDamage += m.damage;
      allKills += m.kills;
      const moveIndex = keyIndex.get(moveGroup(Number(idStr)).key);
      if (moveIndex === undefined) continue;
      const base = moveIndex * MV_STRIDE;
      if (m.attempts !== undefined) {
        out[base + MV.attempts] = out[base + MV.attempts]! + m.attempts;
      }
      out[base + MV.landed] = out[base + MV.landed]! + m.landed;
      out[base + MV.damage] = out[base + MV.damage]! + m.damage;
      out[base + MV.kills] = out[base + MV.kills]! + m.kills;
      out[base + MV.killPctSum] = out[base + MV.killPctSum]! + m.killPctSum;
      out[base + MV.lCancelSuccess] = out[base + MV.lCancelSuccess]! + (m.lcSuccess ?? 0);
      out[base + MV.lCancelTotal] =
        out[base + MV.lCancelTotal]! + (m.lcSuccess ?? 0) + (m.lcFail ?? 0);
    }
    if (attemptsAvailable) {
      for (let moveIndex = 0; moveIndex < moveCount; moveIndex++) {
        out[moveIndex * MV_STRIDE + MV.attemptGames] = 1;
      }
    }
  }
  for (let moveIndex = 0; moveIndex < moveCount; moveIndex++) {
    const base = moveIndex * MV_STRIDE;
    out[base + MV.games] = gameCount;
    out[base + MV.allDamage] = allDamage;
    out[base + MV.allKills] = allKills;
  }
}

/**
 * One move's move-table column, recomputed over the trailing `window` games
 * ending at each game — so the final point is the figure the Move effectiveness
 * table itself shows, and the line behind it is how that figure got there.
 *
 * Single pass, and only a window's worth of slices is held (the ring buffer
 * above), which is what keeps it cheap on a 30k-game library even though the
 * picker refits it on every dropdown change. Tracked attempts use every
 * attempt-capable game carrying move data as their denominator, so a window
 * where the move was not initiated correctly reads zero without treating an
 * older schema as zero. `null` is reserved for an unavailable denominator or
 * a column the move does not report, and the chart draws those as gaps.
 */
export function moveMetricSeries(
  games: ResolvedGame[],
  moveKey: string,
  metric: MoveMetricKey,
  window = ROLLING_WINDOW,
  maxPoints = MAX_SERIES_POINTS,
): RollingExecutionPoint[] {
  return moveMetricSeriesMany(games, [moveKey], metric, window, maxPoints).map((point) => ({
    index: point.index,
    date: point.date,
    value: point.values[0] ?? null,
  }));
}

/**
 * Several moves plotted against the same metric and rolling window. This stays
 * single-pass over the games and each game's move table; selecting another
 * line adds only its small ring-buffer slice and output value.
 */
export function moveMetricSeriesMany(
  games: ResolvedGame[],
  moveKeys: readonly string[],
  metric: MoveMetricKey,
  window = ROLLING_WINDOW,
  maxPoints = MAX_SERIES_POINTS,
  side: "me" | "opp" = "me",
): MultiMoveMetricPoint[] {
  const keys = [...new Set(moveKeys)];
  if (keys.length === 0) return [];
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  const { num, den, scale } = MOVE_METRICS[metric];
  const w = Math.max(1, Math.floor(window));
  const stride = seriesStride(games.length, maxPoints);
  const moveCount = keys.length;
  // The ring only needs the selected numerator and denominator for each move;
  // `slice` holds the full one-game aggregate while that pair is chosen.
  const ring = new Float64Array(w * moveCount * 2);
  const slice = new Float64Array(moveCount * MV_STRIDE);
  const numSums = new Float64Array(moveCount);
  const denSums = new Float64Array(moveCount);
  const out: MultiMoveMetricPoint[] = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i]!;
    moveSlices(g, keyIndex, moveCount, slice, side);
    for (let moveIndex = 0; moveIndex < moveCount; moveIndex++) {
      const ringBase = ((i % w) * moveCount + moveIndex) * 2;
      // That slot still holds the game about to leave the window; drop it first.
      if (i >= w) {
        numSums[moveIndex] = numSums[moveIndex]! - ring[ringBase]!;
        denSums[moveIndex] = denSums[moveIndex]! - ring[ringBase + 1]!;
      }
      const sliceBase = moveIndex * MV_STRIDE;
      const nextNum = slice[sliceBase + num]!;
      const nextDen = slice[sliceBase + den]!;
      ring[ringBase] = nextNum;
      ring[ringBase + 1] = nextDen;
      numSums[moveIndex] = numSums[moveIndex]! + nextNum;
      denSums[moveIndex] = denSums[moveIndex]! + nextDen;
    }
    if (!emitsAt(i, games.length, stride)) continue;
    out.push({
      index: i + 1,
      date: dayLabel(g.date),
      values: keys.map((_, moveIndex) =>
        metric === "attemptsPerGame" && !moveGroupTracksAttempts(keys[moveIndex]!)
          ? null
          : denSums[moveIndex]! > 0 ? (numSums[moveIndex]! / denSums[moveIndex]!) * scale : null,
      ),
    });
  }
  return out;
}

export interface MoveImpactRow {
  key: string;
  label: string;
  /** Mean usage: share of landed hits (moves) or count per minute (actions). */
  avgShare: number;
  usageKind?: "share" | "perMinute"; // undefined = share
  n: number; // decided games with move data
  highWins: number;
  highN: number;
  lowWins: number;
  lowN: number;
  winRateHigh: number | null;
  winRateLow: number | null;
  delta: number | null; // high-usage win rate minus low-usage win rate
}

/** Median-split usage samples into heavy/light halves and compare win rates. */
function splitImpact(samples: { share: number; isWin: boolean }[]): Omit<MoveImpactRow, "key" | "label" | "avgShare" | "usageKind"> {
  const sorted = [...samples].sort((a, b) => a.share - b.share);
  const half = Math.floor(sorted.length / 2);
  const low = sorted.slice(0, half);
  const high = sorted.slice(sorted.length - half);
  const lowWins = low.filter((s) => s.isWin).length;
  const highWins = high.filter((s) => s.isWin).length;
  const winRateLow = low.length ? lowWins / low.length : null;
  const winRateHigh = high.length ? highWins / high.length : null;
  return {
    n: samples.length,
    highWins,
    highN: high.length,
    lowWins,
    lowN: low.length,
    winRateHigh,
    winRateLow,
    delta: winRateHigh !== null && winRateLow !== null ? winRateHigh - winRateLow : null,
  };
}

/**
 * Does leaning on a move correlate with winning? Usage is measured as the
 * move's share of your landed hits that game (compositional, so "winners just
 * land more of everything" doesn't pollute it), then games are median-split
 * into heavy vs light usage and the win rates compared. Correlational — a
 * negative delta is a lead, not a verdict.
 */
export function moveImpact(games: ResolvedGame[], minGames = 40): MoveImpactRow[] {
  const perMove = new Map<string, { label: string; samples: { share: number; isWin: boolean }[]; shareSum: number }>();
  const eligible: { totals: number; ms: NonNullable<ResolvedGame["me"]["moveStats"]>; isWin: boolean }[] = [];
  for (const g of games) {
    if (g.isWin === null || !g.me.moveStats) continue;
    let total = 0;
    for (const m of Object.values(g.me.moveStats)) total += m.landed;
    if (total === 0) continue;
    eligible.push({ totals: total, ms: g.me.moveStats, isWin: g.isWin });
  }
  if (eligible.length < minGames) return [];
  // Every eligible game contributes a share to every move (0 when unused) —
  // "didn't use it at all" is the most informative low-usage sample there is.
  const keys = new Map<string, string>();
  for (const e of eligible) {
    for (const idStr of Object.keys(e.ms)) {
      const grp = moveGroup(Number(idStr));
      keys.set(grp.key, grp.label);
    }
  }
  for (const [key, label] of keys) {
    perMove.set(key, { label, samples: [], shareSum: 0 });
  }
  for (const e of eligible) {
    const byKey = new Map<string, number>();
    for (const [idStr, m] of Object.entries(e.ms)) {
      const grp = moveGroup(Number(idStr));
      byKey.set(grp.key, (byKey.get(grp.key) ?? 0) + m.landed);
    }
    for (const [key, entry] of perMove) {
      const share = (byKey.get(key) ?? 0) / e.totals;
      entry.samples.push({ share, isWin: e.isWin });
      entry.shareSum += share;
    }
  }
  const rows: MoveImpactRow[] = [];
  for (const [key, entry] of perMove) {
    rows.push({
      key,
      label: entry.label,
      avgShare: entry.shareSum / entry.samples.length,
      ...splitImpact(entry.samples),
    });
  }
  return rows.sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
}

/**
 * Same heavy-vs-light analysis for defensive/movement actions, normalized per
 * minute of game time (length is the confound there, not total volume).
 */
export function actionImpact(games: ResolvedGame[], minGames = 40): MoveImpactRow[] {
  const samples = new Map<keyof ActionCounts, { share: number; isWin: boolean }[]>();
  for (const { key } of ACTION_LABELS) samples.set(key, []);
  let n = 0;
  for (const g of games) {
    if (g.isWin === null || g.rec.durationFrames <= 0) continue;
    // A header preview would enter a zero action-rate sample on both sides of
    // the win/loss split and count toward minGames while it did it.
    if (!hasFullStats(g.rec)) continue;
    const minutes = g.rec.durationFrames / 3600;
    n++;
    for (const { key } of ACTION_LABELS) {
      samples.get(key)!.push({ share: (g.me.actions?.[key] ?? 0) / minutes, isWin: g.isWin });
    }
  }
  if (n < minGames) return [];
  return ACTION_LABELS.map(({ key, label }) => {
    const s = samples.get(key)!;
    return {
      key: `act:${key}`,
      label,
      avgShare: s.reduce((sum, x) => sum + x.share, 0) / s.length,
      usageKind: "perMinute" as const,
      ...splitImpact(s),
    };
  }).sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
}

// ---------- Sets ----------

export interface GameSet {
  oppCode: string;
  oppName: string | null;
  games: ResolvedGame[];
  wins: number;
  losses: number;
  /** Who reached SET_TARGET_WINS. Always decisive — a Bo3 cannot be tied. */
  result: "W" | "L";
  start: Date | null;
  end: Date | null;
}

/** Game wins that take a set. Sets are always best of three. */
export const SET_TARGET_WINS = 2;

/**
 * Group consecutive games against the same opponent (within `gapMinutes`) into
 * best-of-three sets.
 *
 * Replays carry no set metadata, so this is inferred: a set runs until one side
 * reaches SET_TARGET_WINS, and the next game against that same opponent opens
 * the next set. An opponent change or a gap longer than `gapMinutes` also ends
 * the block.
 *
 * Only a set someone actually won is returned. A trailing 1–0 or 1–1 is a set
 * still in progress — scoring it by margin would invent a result the games
 * never produced, and would be the majority-of-a-block rule this replaced.
 * That rule made five straight games one 2–3 "set"; they are two sets.
 *
 * Indeterminate games (`isWin === null` — under 30s, or two of the user's own
 * accounts) sit inside the set without counting toward the two.
 */
export function computeSets(games: ResolvedGame[], gapMinutes = 20): GameSet[] {
  const sets: GameSet[] = [];
  let cur: GameSet | null = null;
  let lastEndMs = 0;
  const decided = (s: GameSet) => s.wins >= SET_TARGET_WINS || s.losses >= SET_TARGET_WINS;
  const flush = () => {
    if (cur && decided(cur)) {
      cur.result = cur.wins > cur.losses ? "W" : "L";
      sets.push(cur);
    }
    cur = null;
  };
  for (const g of games) {
    if (!g.opp.connectCode || !g.date) continue;
    const startMs = g.date.getTime();
    if (
      !cur ||
      cur.oppCode !== g.opp.connectCode ||
      startMs - lastEndMs > gapMinutes * 60_000 ||
      decided(cur) // previous set is over; this game starts the next one
    ) {
      flush();
      cur = { oppCode: g.opp.connectCode, oppName: null, games: [], wins: 0, losses: 0, result: "W", start: g.date, end: g.date };
    }
    cur.games.push(g);
    cur.oppName = g.opp.displayName ?? cur.oppName;
    if (g.isWin === true) cur.wins++;
    else if (g.isWin === false) cur.losses++;
    cur.end = g.date;
    lastEndMs = startMs + (g.rec.durationFrames / 60) * 1000;
  }
  flush();
  return sets;
}

export interface SetsSummary {
  sets: number;
  wins: number;
  losses: number;
  setWinRate: number | null;
  avgGames: number | null;
  /** Sets where you dropped game 1 — how often you still took the set. */
  afterG1Loss: { wins: number; total: number };
  /** Sets that went the distance (2–1) — your record when it's close. */
  deciders: { wins: number; total: number };
}

export function setsSummary(sets: GameSet[]): SetsSummary {
  let wins = 0, losses = 0, totalGames = 0;
  const afterG1Loss = { wins: 0, total: 0 };
  const deciders = { wins: 0, total: 0 };
  for (const s of sets) {
    totalGames += s.games.length;
    if (s.result === "W") wins++;
    else losses++;
    const firstDecided = s.games.find((g) => g.isWin !== null);
    if (firstDecided?.isWin === false) {
      afterG1Loss.total++;
      if (s.result === "W") afterG1Loss.wins++;
    }
    // Bo3: a one-game margin is 2–1, i.e. it went to a third game.
    if (Math.abs(s.wins - s.losses) === 1) {
      deciders.total++;
      if (s.result === "W") deciders.wins++;
    }
  }
  return {
    sets: sets.length,
    wins,
    losses,
    setWinRate: winRate(wins, wins + losses),
    avgGames: sets.length ? totalGames / sets.length : null,
    afterG1Loss,
    deciders,
  };
}

// ---------- Share card ----------

export interface StatCardData {
  /** The dominant account in view — the only one when the account filter is set. */
  code: string | null;
  name: string | null;
  /** Every account of the user's present in these games, most-played first. */
  codes: string[];
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  hours: number;
  firstDate: Date | null;
  lastDate: Date | null;
  mainChar: { id: number; games: number } | null;
  topOppChar: { id: number; games: number } | null;
  favStage: { id: number; games: number; winRate: number | null } | null;
  /**
   * Lowest win rate among stages with a real sample. Null when nothing clears
   * the gate, or when it would name the same stage as `favStage` — one stage
   * being both your best and your worst is a non-statement.
   */
  worstStage: { id: number; games: number; winRate: number | null } | null;
  /** Best and worst matchup by opponent character, gated the same way. */
  bestMatchup: MatchupPick | null;
  worstMatchup: MatchupPick | null;
  /** Mean game length in seconds across the games in view. */
  avgSeconds: number | null;
  /**
   * Most-played opponent by connect code. Carries both records: players talk
   * about a rivalry in sets, and the games are the context for it.
   */
  rival: {
    code: string;
    name: string | null;
    games: number;
    wins: number;
    losses: number;
    setWins: number;
    setLosses: number;
  } | null;
  distinctOpponents: number;
  bestWinStreak: number | null;
  busiestDay: { day: string; games: number } | null;
}

export interface MatchupPick {
  id: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}

/**
 * Decided games a stage or matchup needs before the card will crown it. Low
 * enough that a normal library fills the cells, high enough that a 2–0 can't
 * claim "best matchup".
 */
const MIN_CARD_SAMPLE = 10;

/** Everything the shareable profile card needs, in one pass over the games. */
export function statCardData(games: ResolvedGame[]): StatCardData {
  const base = tally(games);
  let frames = 0;
  let first: Date | null = null, last: Date | null = null;
  // Identity is per-account, not per-latest-game: with a main and an alt in one
  // folder, "whichever played most recently" would flip the card's name and
  // code around at random. Count each account instead and let the dominant one
  // title the card — which, under the account filter, is the only one present.
  const mine = new Map<string, { games: number; name: string | null }>();
  const myChars = new Map<number, number>();
  // Opponent characters carry a record, not just a count: the most-faced one
  // and the best/worst matchup all come off this one map.
  const oppChars = new Map<number, { games: number; wins: number; losses: number }>();
  const stages = new Map<number, { games: number; wins: number; losses: number }>();
  const opps = new Map<string, { name: string | null; games: number; wins: number; losses: number }>();
  const days = new Map<string, number>();
  let bestStreak = 0, run = 0;

  for (const g of games) {
    frames += g.rec.durationFrames;
    if (g.date) {
      if (!first || g.date < first) first = g.date;
      if (!last || g.date > last) last = g.date;
      const day = localDay(g.date);
      days.set(day, (days.get(day) ?? 0) + 1);
    }
    if (g.me.connectCode) {
      const m = mine.get(g.me.connectCode) ?? { games: 0, name: null };
      m.games++;
      m.name = g.me.displayName ?? m.name; // latest tag wins; they change over time
      mine.set(g.me.connectCode, m);
    }
    myChars.set(g.me.characterId, (myChars.get(g.me.characterId) ?? 0) + 1);
    const oc = oppChars.get(g.opp.characterId) ?? { games: 0, wins: 0, losses: 0 };
    oc.games++;
    if (g.isWin === true) oc.wins++;
    else if (g.isWin === false) oc.losses++;
    oppChars.set(g.opp.characterId, oc);
    const st = stages.get(g.rec.stageId) ?? { games: 0, wins: 0, losses: 0 };
    st.games++;
    if (g.isWin === true) st.wins++;
    else if (g.isWin === false) st.losses++;
    stages.set(g.rec.stageId, st);
    if (g.opp.connectCode && !g.selfMatch) {
      const o = opps.get(g.opp.connectCode) ?? { name: null, games: 0, wins: 0, losses: 0 };
      o.games++;
      o.name = g.opp.displayName ?? o.name;
      if (g.isWin === true) o.wins++;
      else if (g.isWin === false) o.losses++;
      opps.set(g.opp.connectCode, o);
    }
    if (g.isWin === true) { run++; if (run > bestStreak) bestStreak = run; }
    else if (g.isWin === false) run = 0;
  }

  const top = <K,>(m: Map<K, number>): [K, number] | null =>
    m.size ? [...m.entries()].sort((a, b) => b[1] - a[1])[0]! : null;
  const mainChar = top(myChars);
  let topOppChar: StatCardData["topOppChar"] = null;
  for (const [id, o] of oppChars) {
    if (!topOppChar || o.games > topOppChar.games) topOppChar = { id, games: o.games };
  }
  // Best/worst matchup share the stage gate, so a 2–0 can't take the crown.
  let bestMatchup: MatchupPick | null = null;
  let worstMatchup: MatchupPick | null = null;
  for (const [id, o] of oppChars) {
    const decided = o.wins + o.losses;
    if (decided < MIN_CARD_SAMPLE) continue;
    const wr = winRate(o.wins, decided);
    if (wr === null) continue;
    const entry: MatchupPick = { id, games: o.games, wins: o.wins, losses: o.losses, winRate: wr };
    if (!bestMatchup || wr > bestMatchup.winRate) bestMatchup = entry;
    if (!worstMatchup || wr < worstMatchup.winRate) worstMatchup = entry;
  }
  // Only one matchup qualified, so it is trivially both. Report it once.
  if (bestMatchup && worstMatchup && bestMatchup.id === worstMatchup.id) worstMatchup = null;
  // Home turf = best win rate among stages with a real sample (10+ decided
  // games), so a 2-0 stage can't claim it; most-played is the fallback.
  let favStage: StatCardData["favStage"] = null;
  let worstStage: StatCardData["worstStage"] = null;
  let mostPlayed: StatCardData["favStage"] = null;
  for (const [id, s] of stages) {
    const wr = winRate(s.wins, s.wins + s.losses);
    const entry = { id, games: s.games, winRate: wr };
    if (!mostPlayed || s.games > mostPlayed.games) mostPlayed = entry;
    if (s.wins + s.losses < MIN_CARD_SAMPLE || wr === null) continue;
    if (!favStage || wr > (favStage.winRate ?? -1)) favStage = entry;
    if (!worstStage || wr < (worstStage.winRate ?? 2)) worstStage = entry;
  }
  favStage = favStage ?? mostPlayed;
  // favStage falls back to most-played so the card is never empty; the worst
  // stage gets no such fallback, and must not echo whatever favStage landed on.
  if (worstStage && favStage && worstStage.id === favStage.id) worstStage = null;
  // Set records per opponent, off the same best-of-three grouping the Sets
  // panel uses, so the card and that view can never disagree.
  const setRecord = new Map<string, { wins: number; losses: number }>();
  for (const s of computeSets(games)) {
    const r = setRecord.get(s.oppCode) ?? { wins: 0, losses: 0 };
    if (s.result === "W") r.wins++;
    else r.losses++;
    setRecord.set(s.oppCode, r);
  }
  let rival: StatCardData["rival"] = null;
  for (const [c, o] of opps) {
    if (!rival || o.games > rival.games) {
      const sr = setRecord.get(c);
      rival = { code: c, ...o, setWins: sr?.wins ?? 0, setLosses: sr?.losses ?? 0 };
    }
  }
  let busiestDay: StatCardData["busiestDay"] = null;
  for (const [day, n] of days) {
    if (!busiestDay || n > busiestDay.games) busiestDay = { day, games: n };
  }

  const codes = [...mine.entries()].sort((a, b) => b[1].games - a[1].games).map(([c]) => c);
  const primary = codes[0] ?? null;

  return {
    code: primary,
    name: primary ? (mine.get(primary)?.name ?? null) : null,
    codes,
    games: base.games,
    wins: base.wins,
    losses: base.losses,
    winRate: base.winRate,
    hours: frames / 60 / 3600,
    firstDate: first,
    lastDate: last,
    mainChar: mainChar ? { id: mainChar[0], games: mainChar[1] } : null,
    topOppChar,
    favStage,
    worstStage,
    bestMatchup,
    worstMatchup,
    avgSeconds: base.games > 0 ? frames / 60 / base.games : null,
    rival,
    distinctOpponents: opps.size,
    bestWinStreak: bestStreak || null,
    busiestDay,
  };
}

export interface StageRow extends WL {
  stageId: number;
}

export function byStage(games: ResolvedGame[]): StageRow[] {
  const map = new Map<number, ResolvedGame[]>();
  for (const g of games) {
    if (!map.has(g.rec.stageId)) map.set(g.rec.stageId, []);
    map.get(g.rec.stageId)!.push(g);
  }
  return Array.from(map.entries())
    .map(([stageId, gs]) => ({ stageId, ...tally(gs) }))
    .sort((a, b) => b.games - a.games);
}

export interface OpponentRow extends WL {
  code: string;
  displayName: string | null;
  lastPlayed: Date | null;
  topCharacter: number;
}

export function byOpponent(games: ResolvedGame[]): OpponentRow[] {
  const map = new Map<string, ResolvedGame[]>();
  for (const g of games) {
    if (g.selfMatch) continue; // your own alt is not an opponent
    const code = g.opp.connectCode;
    if (!code) continue;
    if (!map.has(code)) map.set(code, []);
    map.get(code)!.push(g);
  }
  return Array.from(map.entries())
    .map(([code, gs]) => {
      const chars = new Map<number, number>();
      let name: string | null = null;
      let last: Date | null = null;
      for (const g of gs) {
        chars.set(g.opp.characterId, (chars.get(g.opp.characterId) ?? 0) + 1);
        name = g.opp.displayName ?? name;
        if (g.date && (!last || g.date > last)) last = g.date;
      }
      const topCharacter = Array.from(chars.entries()).sort((a, b) => b[1] - a[1])[0]![0]; // gs is never empty
      return { code, displayName: name, lastPlayed: last, topCharacter, ...tally(gs) };
    })
    .sort((a, b) => b.games - a.games);
}

export interface ExecutionPoint {
  index: number;
  date: string;
  lCancel: number | null;
  techSuccess: number | null;
  opk: number | null;
  dpo: number | null;
  ipm: number | null;
  oppLCancel: number | null;
  oppTechSuccess: number | null;
  oppOpk: number | null;
  oppDpo: number | null;
  oppIpm: number | null;
}

export function executionTrend(games: ResolvedGame[], window = ROLLING_WINDOW): ExecutionPoint[] {
  // Point spacing is deliberately decoupled from the window: widening the
  // smoothing must not thin the chart out. One point per tenth of a window
  // keeps the density these charts have always had.
  const stride = Math.max(1, Math.floor(window / 10));
  const out: ExecutionPoint[] = [];
  for (let i = 0; i < games.length; i++) {
    if ((i + 1) % stride !== 0 && i !== games.length - 1) continue;
    const slice = games.slice(Math.max(0, i - window + 1), i + 1);
    let lcS = 0, lcF = 0, opkSum = 0, opkN = 0, dpoSum = 0, dpoN = 0, ipmSum = 0, ipmN = 0;
    let oLcS = 0, oLcF = 0, oOpkSum = 0, oOpkN = 0, oDpoSum = 0, oDpoN = 0, oIpmSum = 0, oIpmN = 0;
    let techS = 0, techA = 0, oTechS = 0, oTechA = 0;
    for (const g of slice) {
      lcS += g.me.lCancelSuccess;
      lcF += g.me.lCancelFail;
      oLcS += g.opp.lCancelSuccess;
      oLcF += g.opp.lCancelFail;
      const mt = playerTechCounts(g.me);
      const ot = playerTechCounts(g.opp);
      techS += allTechSuccess(mt);
      techA += allTechAttempts(mt);
      oTechS += allTechSuccess(ot);
      oTechA += allTechAttempts(ot);
      if (g.me.openingsPerKill !== null) { opkSum += g.me.openingsPerKill; opkN++; }
      if (g.me.damagePerOpening !== null) { dpoSum += g.me.damagePerOpening; dpoN++; }
      if (g.me.inputsPerMinute !== null) { ipmSum += g.me.inputsPerMinute; ipmN++; }
      if (g.opp.openingsPerKill !== null) { oOpkSum += g.opp.openingsPerKill; oOpkN++; }
      if (g.opp.damagePerOpening !== null) { oDpoSum += g.opp.damagePerOpening; oDpoN++; }
      if (g.opp.inputsPerMinute !== null) { oIpmSum += g.opp.inputsPerMinute; oIpmN++; }
    }
    out.push({
      index: i + 1,
      date: dayLabel(games[i]!.date),
      lCancel: lcS + lcF > 0 ? (lcS / (lcS + lcF)) * 100 : null,
      techSuccess: techA > 0 ? (techS / techA) * 100 : null,
      opk: opkN ? opkSum / opkN : null,
      dpo: dpoN ? dpoSum / dpoN : null,
      ipm: ipmN ? ipmSum / ipmN : null,
      oppLCancel: oLcS + oLcF > 0 ? (oLcS / (oLcS + oLcF)) * 100 : null,
      oppTechSuccess: oTechA > 0 ? (oTechS / oTechA) * 100 : null,
      oppOpk: oOpkN ? oOpkSum / oOpkN : null,
      oppDpo: oDpoN ? oDpoSum / oDpoN : null,
      oppIpm: oIpmN ? oIpmSum / oIpmN : null,
    });
  }
  return out;
}

export type ExecMetricKey = "lCancel" | "groundTechSuccess" | "wallTechSuccess" | "opk" | "dpo" | "ipm";

/**
 * Each execution metric expressed as a numerator/denominator pair so windowed
 * averages compose by summing: L-cancel is a ratio of counts (success over
 * attempts), the others are means over games where the value is known.
 */
const EXEC_METRICS: Record<ExecMetricKey, { num: (p: PlayerSide) => number; den: (p: PlayerSide) => number; scale: number }> = {
  lCancel: { num: (p) => p.lCancelSuccess, den: (p) => p.lCancelSuccess + p.lCancelFail, scale: 100 },
  groundTechSuccess: { num: (p) => groundTechSuccess(playerTechCounts(p)), den: (p) => groundTechAttempts(playerTechCounts(p)), scale: 100 },
  wallTechSuccess: { num: (p) => playerTechCounts(p).wallSuccess, den: (p) => wallTechAttempts(playerTechCounts(p)), scale: 100 },
  opk: { num: (p) => p.openingsPerKill ?? 0, den: (p) => (p.openingsPerKill !== null ? 1 : 0), scale: 1 },
  dpo: { num: (p) => p.damagePerOpening ?? 0, den: (p) => (p.damagePerOpening !== null ? 1 : 0), scale: 1 },
  ipm: { num: (p) => p.inputsPerMinute ?? 0, den: (p) => (p.inputsPerMinute !== null ? 1 : 0), scale: 1 },
};

export interface ExecutionSummary {
  games: number;
  lCancel: number | null;
  groundTechSuccess: number | null;
  wallTechSuccess: number | null;
  groundTechInPlace: number | null;
  groundTechIn: number | null;
  groundTechAway: number | null;
  opk: number | null;
  dpo: number | null;
  ipm: number | null;
}

/**
 * Averages over the most recent `window` games (KPI strip on Execution).
 * The default is the shared window, so the strip agrees with the trend charts
 * and tables beside it; coach.ts passes its own narrower one deliberately.
 */
export function executionSummary(games: ResolvedGame[], window = ROLLING_WINDOW): ExecutionSummary {
  const slice = games.slice(Math.max(0, games.length - window));
  const value = (key: ExecMetricKey): number | null => {
    const { num, den, scale } = EXEC_METRICS[key];
    let n = 0, d = 0;
    for (const g of slice) { n += num(g.me); d += den(g.me); }
    return d > 0 ? (n / d) * scale : null;
  };
  const techs: TechCounts = { ...EMPTY_TECH_COUNTS };
  for (const g of slice) addTechCounts(techs, g.me);
  const groundSuccess = groundTechSuccess(techs);
  const groundAttempts = groundTechAttempts(techs);
  const wallAttempts = wallTechAttempts(techs);
  const pctOf = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null);
  return {
    games: slice.length,
    lCancel: value("lCancel"),
    groundTechSuccess: pctOf(groundSuccess, groundAttempts),
    wallTechSuccess: pctOf(techs.wallSuccess, wallAttempts),
    groundTechInPlace: pctOf(techs.inPlace, groundSuccess),
    groundTechIn: pctOf(techs.toward, groundSuccess),
    groundTechAway: pctOf(techs.away, groundSuccess),
    opk: value("opk"),
    dpo: value("dpo"),
    ipm: value("ipm"),
  };
}

export interface RollingExecutionPoint {
  index: number;
  date: string;
  value: number | null;
  oppValue?: number | null;
}

/**
 * Rolling `window`-game average of one execution metric. Single-pass sliding
 * sums (no per-point slicing); the line spans every game in the filter, thinned
 * to MAX_SERIES_POINTS.
 */
export function rollingExecutionSeries(
  games: ResolvedGame[],
  metric: ExecMetricKey,
  window = ROLLING_WINDOW,
  maxPoints = MAX_SERIES_POINTS,
): RollingExecutionPoint[] {
  const { num, den, scale } = EXEC_METRICS[metric];
  const stride = seriesStride(games.length, maxPoints);
  const out: RollingExecutionPoint[] = [];
  let numSum = 0, denSum = 0, oppNumSum = 0, oppDenSum = 0;
  for (let i = 0; i < games.length; i++) {
    const g = games[i]!;
    numSum += num(g.me);
    denSum += den(g.me);
    oppNumSum += num(g.opp);
    oppDenSum += den(g.opp);
    if (i >= window) {
      const old = games[i - window]!;
      numSum -= num(old.me);
      denSum -= den(old.me);
      oppNumSum -= num(old.opp);
      oppDenSum -= den(old.opp);
    }
    if (!emitsAt(i, games.length, stride)) continue;
    out.push({
      index: i + 1,
      date: dayLabel(g.date),
      value: denSum > 0 ? (numSum / denSum) * scale : null,
      oppValue: oppDenSum > 0 ? (oppNumSum / oppDenSum) * scale : null,
    });
  }
  return out;
}

export interface GameSeriesPoint {
  index: number;
  date: string;
  [metric: string]: number | string;
}

/**
 * Trailing `window`-game mean of arbitrary picked metrics. Raw per-game counts
 * swing far too hard to read a trend off, so these are smoothed like
 * executionTrend's rates — but as counts per game, not ratios. Sliding sums
 * keep it single-pass; the window is computed over every game and the emitted
 * points are thinned to MAX_SERIES_POINTS across the whole filter. The first
 * `window` games of all average however many games exist, matching
 * rollingExecutionSeries.
 */
export function perGameSeries(
  games: ResolvedGame[],
  picks: { key: string; value: (g: ResolvedGame) => number }[],
  window = ROLLING_WINDOW,
  maxPoints = MAX_SERIES_POINTS,
): GameSeriesPoint[] {
  const stride = seriesStride(games.length, maxPoints);
  const sums = new Float64Array(picks.length);
  const out: GameSeriesPoint[] = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i]!;
    const old = i >= window ? games[i - window]! : null;
    for (let p = 0; p < picks.length; p++) {
      const pick = picks[p]!;
      sums[p] = sums[p]! + pick.value(g) - (old ? pick.value(old) : 0);
    }
    if (!emitsAt(i, games.length, stride)) continue;
    const n = Math.min(i + 1, window);
    const point: GameSeriesPoint = { index: i + 1, date: dayLabel(g.date) };
    for (let p = 0; p < picks.length; p++) point[picks[p]!.key] = sums[p]! / n;
    out.push(point);
  }
  return out;
}

export interface ModeRow extends WL {
  mode: GameType | "overall";
  killsPerGame: number | null;
  deathsPerGame: number | null;
  avgGameSeconds: number | null;
}

/** Overall + one row per game mode present in the data. */
export function byMode(games: ResolvedGame[]): ModeRow[] {
  const mk = (mode: ModeRow["mode"], gs: ResolvedGame[]): ModeRow => {
    let kills = 0;
    let deaths = 0;
    let frames = 0;
    // See overview(): kill/death averages need a denominator of games that
    // carry the counts, while duration comes from the header and does not.
    let measured = 0;
    for (const g of gs) {
      frames += g.rec.durationFrames;
      if (!hasFullStats(g.rec)) continue;
      measured++;
      kills += g.me.kills;
      deaths += g.opp.kills;
    }
    return {
      mode,
      ...tally(gs),
      killsPerGame: measured ? kills / measured : null,
      deathsPerGame: measured ? deaths / measured : null,
      avgGameSeconds: gs.length ? frames / 60 / gs.length : null,
    };
  };
  const order: GameType[] = ["ranked", "unranked", "direct", "offline", "unknown"];
  const rows: ModeRow[] = [mk("overall", games)];
  for (const mode of order) {
    const gs = games.filter((g) => g.rec.gameType === mode);
    if (gs.length > 0) rows.push(mk(mode, gs));
  }
  return rows;
}

export interface AccountRow extends WL {
  code: string;
  killsPerGame: number | null;
  deathsPerGame: number | null;
  topCharacter: number | null;
  lastPlayed: Date | null;
}

/**
 * One row per account of the user's that appears in the filtered set. Sorted by
 * games descending, so the main floats to the top without depending on the
 * configured order — which is about display, not volume.
 */
export function byAccount(games: ResolvedGame[]): AccountRow[] {
  const map = new Map<
    string,
    { gs: ResolvedGame[]; kills: number; deaths: number; measured: number; chars: Map<number, number>; last: Date | null }
  >();
  for (const g of games) {
    const code = g.me.connectCode;
    if (!code) continue; // offline games carry no code to attribute to an account
    let e = map.get(code);
    if (!e) {
      e = { gs: [], kills: 0, deaths: 0, measured: 0, chars: new Map(), last: null };
      map.set(code, e);
    }
    e.gs.push(g);
    if (hasFullStats(g.rec)) {
      e.measured++;
      e.kills += g.me.kills;
      e.deaths += g.opp.kills;
    }
    e.chars.set(g.me.characterId, (e.chars.get(g.me.characterId) ?? 0) + 1);
    if (g.date && (!e.last || g.date > e.last)) e.last = g.date;
  }
  return Array.from(map.entries())
    .map(([code, e]) => {
      let topCharacter: number | null = null;
      let topCount = 0;
      for (const [id, n] of e.chars) {
        if (n > topCount) {
          topCharacter = id;
          topCount = n;
        }
      }
      return {
        code,
        ...tally(e.gs),
        killsPerGame: e.measured ? e.kills / e.measured : null,
        deathsPerGame: e.measured ? e.deaths / e.measured : null,
        topCharacter,
        lastPlayed: e.last,
      };
    })
    .sort((a, b) => b.games - a.games);
}

// ---------- Teams (2v2) ----------

export interface TeamOverviewStats extends WL {
  // Stock counts come from end-of-game state, the only per-player data slippi-js
  // yields for 4-player games (its stats engine — kills, damage, conversions —
  // is singles-only, so those fields are always 0 in teams records).
  stocksTakenPerGame: number | null;
  stocksLostPerGame: number | null;
  avgGameSeconds: number | null;
  currentStreak: { kind: "W" | "L"; length: number } | null;
  distinctTeammates: number;
}

const START_STOCKS = 4; // standard ruleset; replays don't reliably carry startStocks

export function teamOverview(games: ResolvedTeamGame[]): TeamOverviewStats {
  let taken = 0;
  let lost = 0;
  let stockGames = 0;
  let frames = 0;
  const mates = new Set<string>();
  for (const g of games) {
    frames += g.rec.durationFrames;
    mates.add(g.teammate.connectCode ?? `port:${g.teammate.port}`);
    const rem = [g.opps[0], g.opps[1], g.me, g.teammate].map((p) => p.stocksRemaining);
    if (rem.every((r) => r !== null)) {
      taken += START_STOCKS - rem[0]! + (START_STOCKS - rem[1]!);
      lost += START_STOCKS - rem[2]! + (START_STOCKS - rem[3]!);
      stockGames++;
    }
  }
  return {
    ...tally(games),
    stocksTakenPerGame: stockGames ? taken / stockGames : null,
    stocksLostPerGame: stockGames ? lost / stockGames : null,
    avgGameSeconds: games.length ? frames / 60 / games.length : null,
    currentStreak: streakOf(games),
    distinctTeammates: mates.size,
  };
}

export interface TeammateRow extends WL {
  code: string;
  displayName: string | null;
  topCharacter: number;
  stocksTakenPerGame: number | null; // team stocks taken; per-player kills don't exist for teams
  lastPlayed: Date | null;
}

/** Win rate with each teammate. Offline games without connect codes are skipped. */
export function byTeammate(games: ResolvedTeamGame[]): TeammateRow[] {
  const map = new Map<
    string,
    { gs: ResolvedTeamGame[]; chars: Map<number, number>; name: string | null; last: Date | null; taken: number; stockGames: number }
  >();
  for (const g of games) {
    if (g.selfMatch) continue; // your own alt is not a partner
    const code = g.teammate.connectCode;
    if (!code) continue;
    let e = map.get(code);
    if (!e) {
      e = { gs: [], chars: new Map(), name: null, last: null, taken: 0, stockGames: 0 };
      map.set(code, e);
    }
    e.gs.push(g);
    e.chars.set(g.teammate.characterId, (e.chars.get(g.teammate.characterId) ?? 0) + 1);
    e.name = g.teammate.displayName ?? e.name;
    if (g.date && (!e.last || g.date > e.last)) e.last = g.date;
    if (g.opps[0].stocksRemaining !== null && g.opps[1].stocksRemaining !== null) {
      e.taken += START_STOCKS - g.opps[0].stocksRemaining + (START_STOCKS - g.opps[1].stocksRemaining);
      e.stockGames++;
    }
  }
  return Array.from(map.entries())
    .map(([code, e]) => ({
      code,
      displayName: e.name,
      topCharacter: Array.from(e.chars.entries()).sort((a, b) => b[1] - a[1])[0]![0], // e.gs is never empty
      stocksTakenPerGame: e.stockGames ? e.taken / e.stockGames : null,
      lastPlayed: e.last,
      ...tally(e.gs),
    }))
    .sort((a, b) => b.games - a.games);
}

export interface TeamCharacterRow extends WL {
  characterId: number;
}

export function teamsByMyCharacter(games: ResolvedTeamGame[]): TeamCharacterRow[] {
  return teamCharRows(games, (g) => [g.me.characterId]);
}

/**
 * Games in which the enemy duo included each character. A game is counted once
 * per *distinct* opposing character, so a double-Fox team counts once for Fox.
 */
export function teamsByOppCharacter(games: ResolvedTeamGame[]): TeamCharacterRow[] {
  return teamCharRows(games, (g) => Array.from(new Set(g.opps.map((o) => o.characterId))));
}

function teamCharRows(games: ResolvedTeamGame[], keys: (g: ResolvedTeamGame) => number[]): TeamCharacterRow[] {
  const map = new Map<number, { games: number; wins: number; losses: number }>();
  for (const g of games) {
    for (const c of keys(g)) {
      let row = map.get(c);
      if (!row) {
        row = { games: 0, wins: 0, losses: 0 };
        map.set(c, row);
      }
      row.games++;
      if (g.isWin === true) row.wins++;
      else if (g.isWin === false) row.losses++;
    }
  }
  return Array.from(map.entries())
    .map(([characterId, r]) => ({
      characterId,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      decided: r.wins + r.losses,
      winRate: winRate(r.wins, r.wins + r.losses),
    }))
    .sort((a, b) => b.games - a.games);
}

export function teamsByStage(games: ResolvedTeamGame[]): StageRow[] {
  const map = new Map<number, ResolvedTeamGame[]>();
  for (const g of games) {
    if (!map.has(g.rec.stageId)) map.set(g.rec.stageId, []);
    map.get(g.rec.stageId)!.push(g);
  }
  return Array.from(map.entries())
    .map(([stageId, gs]) => ({ stageId, ...tally(gs) }))
    .sort((a, b) => b.games - a.games);
}

// ---------- Teams damage & friendly fire ----------
// All of these read the per-game dmgMatrix/killMatrix (attacker→victim in
// rec.players order); games parsed before schema v7 don't have them and the
// v7 upgrade wipes the cache, so a null matrix only means a malformed 2v2.

/** Positions of me/teammate/opps within rec.players, for matrix lookups. */
function teamIdx(g: ResolvedTeamGame): { me: number; mate: number; opps: [number, number] } | null {
  const ps = g.rec.players;
  const me = ps.indexOf(g.me);
  const mate = ps.indexOf(g.teammate);
  const o0 = ps.indexOf(g.opps[0]);
  const o1 = ps.indexOf(g.opps[1]);
  if (me < 0 || mate < 0 || o0 < 0 || o1 < 0) return null;
  return { me, mate, opps: [o0, o1] };
}

interface DmgTotals {
  games: number;
  myDmg: number;
  mateDmg: number;
  myFF: number;
  mateFF: number;
  myKills: number;
  mateKills: number;
  myFFKills: number;
  mateFFKills: number;
  myTaken: number;
  mateTaken: number;
}

function emptyTotals(): DmgTotals {
  return { games: 0, myDmg: 0, mateDmg: 0, myFF: 0, mateFF: 0, myKills: 0, mateKills: 0, myFFKills: 0, mateFFKills: 0, myTaken: 0, mateTaken: 0 };
}

function accumulate(t: DmgTotals, g: ResolvedTeamGame): void {
  const dm = g.rec.dmgMatrix;
  const km = g.rec.killMatrix;
  if (!dm || !km) return;
  const ix = teamIdx(g);
  if (!ix) return;
  const [a, b] = ix.opps;
  t.games++;
  // 4x4 matrices with indices from teamIdx (all in 0..3); a malformed (short)
  // matrix would previously have produced NaN via `undefined` arithmetic, and
  // `!` keeps that behavior unchanged.
  t.myDmg += dm[ix.me]![a]! + dm[ix.me]![b]!;
  t.mateDmg += dm[ix.mate]![a]! + dm[ix.mate]![b]!;
  t.myFF += dm[ix.me]![ix.mate]!;
  t.mateFF += dm[ix.mate]![ix.me]!;
  t.myKills += km[ix.me]![a]! + km[ix.me]![b]!;
  t.mateKills += km[ix.mate]![a]! + km[ix.mate]![b]!;
  t.myFFKills += km[ix.me]![ix.mate]!;
  t.mateFFKills += km[ix.mate]![ix.me]!;
  t.myTaken += dm[a]![ix.me]! + dm[b]![ix.me]!;
  t.mateTaken += dm[a]![ix.mate]! + dm[b]![ix.mate]!;
}

export interface TeamsDamageOverview {
  games: number; // games carrying matrices (clean 2v2s parsed on schema v7+)
  myDmgPerGame: number | null;
  mateDmgPerGame: number | null;
  dmgShare: number | null; // my share of the team's damage to enemies
  myFFPerGame: number | null; // damage I dealt to my teammate
  mateFFPerGame: number | null; // damage my teammate dealt to me
  myFFKills: number;
  mateFFKills: number;
  myKillsPerGame: number | null;
  mateKillsPerGame: number | null;
  killShare: number | null;
  focusShare: number | null; // share of enemy damage that was aimed at me
}

function toOverview(t: DmgTotals): TeamsDamageOverview {
  const per = (v: number) => (t.games ? v / t.games : null);
  const share = (mine: number, theirs: number) => (mine + theirs > 0 ? mine / (mine + theirs) : null);
  return {
    games: t.games,
    myDmgPerGame: per(t.myDmg),
    mateDmgPerGame: per(t.mateDmg),
    dmgShare: share(t.myDmg, t.mateDmg),
    myFFPerGame: per(t.myFF),
    mateFFPerGame: per(t.mateFF),
    myFFKills: t.myFFKills,
    mateFFKills: t.mateFFKills,
    myKillsPerGame: per(t.myKills),
    mateKillsPerGame: per(t.mateKills),
    killShare: share(t.myKills, t.mateKills),
    focusShare: share(t.myTaken, t.mateTaken),
  };
}

export function teamsDamageOverview(games: ResolvedTeamGame[]): TeamsDamageOverview {
  const t = emptyTotals();
  for (const g of games) accumulate(t, g);
  return toOverview(t);
}

export interface TeammateDamageRow extends TeamsDamageOverview {
  code: string;
  displayName: string | null;
}

/** Damage/FF splits per teammate. Offline games without connect codes are skipped. */
export function byTeammateDamage(games: ResolvedTeamGame[]): TeammateDamageRow[] {
  const map = new Map<string, { t: DmgTotals; name: string | null }>();
  for (const g of games) {
    if (g.selfMatch) continue; // your own alt is not a partner
    const code = g.teammate.connectCode;
    if (!code) continue;
    let e = map.get(code);
    if (!e) {
      e = { t: emptyTotals(), name: null };
      map.set(code, e);
    }
    accumulate(e.t, g);
    e.name = g.teammate.displayName ?? e.name;
  }
  return Array.from(map.entries())
    .map(([code, e]) => ({ code, displayName: e.name, ...toOverview(e.t) }))
    .filter((r) => r.games > 0)
    .sort((a, b) => b.games - a.games);
}

export interface TeamsDamageWeek {
  week: string;
  games: number;
  myDmg: number; // per-game averages within the week
  mateDmg: number;
  myFF: number;
  mateFF: number;
}

/** Weekly per-game averages of damage and friendly fire, for the time series. */
export function teamsDamageByWeek(games: ResolvedTeamGame[]): TeamsDamageWeek[] {
  const map = new Map<string, DmgTotals>();
  for (const g of games) {
    if (!g.date) continue;
    const key = localWeekStart(g.date);
    let t = map.get(key);
    if (!t) {
      t = emptyTotals();
      map.set(key, t);
    }
    accumulate(t, g);
  }
  return Array.from(map.entries())
    .filter(([, t]) => t.games > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, t]) => ({
      week,
      games: t.games,
      myDmg: t.myDmg / t.games,
      mateDmg: t.mateDmg / t.games,
      myFF: t.myFF / t.games,
      mateFF: t.mateFF / t.games,
    }));
}

export interface TeamsExecutionRow {
  who: "Me" | "Teammate";
  lCancelPct: number | null;
  techSuccessPct: number | null;
  ipm: number | null;
  wavedashesPerGame: number | null;
  dashDancesPerGame: number | null;
  grabSuccessPct: number | null;
}

/** Execution comparison (me vs teammate) over teams games. */
export function teamsExecution(games: ResolvedTeamGame[]): TeamsExecutionRow[] {
  const mk = () => ({ lcS: 0, lcF: 0, techS: 0, techA: 0, ipmSum: 0, ipmGames: 0, wd: 0, dd: 0, grabS: 0, grabs: 0, games: 0 });
  const me = mk();
  const mate = mk();
  for (const g of games) {
    // lCancelPct and grabSuccessPct are ratios of sums and would be unmoved by
    // a header preview; the wavedash and dash-dance averages divide by
    // `agg.games`, which the preview would inflate.
    if (!hasFullStats(g.rec)) continue;
    for (const [agg, p] of [
      [me, g.me],
      [mate, g.teammate],
    ] as const) {
      agg.games++;
      agg.lcS += p.lCancelSuccess;
      agg.lcF += p.lCancelFail;
      const tech = playerTechCounts(p);
      agg.techS += allTechSuccess(tech);
      agg.techA += allTechAttempts(tech);
      if (p.inputsPerMinute !== null) {
        agg.ipmSum += p.inputsPerMinute;
        agg.ipmGames++;
      }
      agg.wd += p.actions.wavedashes;
      agg.dd += p.actions.dashDances;
      agg.grabS += p.grabSuccess;
      agg.grabs += p.actions.grabs;
    }
  }
  const row = (who: TeamsExecutionRow["who"], a: ReturnType<typeof mk>): TeamsExecutionRow => ({
    who,
    lCancelPct: a.lcS + a.lcF > 0 ? a.lcS / (a.lcS + a.lcF) : null,
    techSuccessPct: a.techA > 0 ? a.techS / a.techA : null,
    ipm: a.ipmGames ? a.ipmSum / a.ipmGames : null,
    wavedashesPerGame: a.games ? a.wd / a.games : null,
    dashDancesPerGame: a.games ? a.dd / a.games : null,
    grabSuccessPct: a.grabs > 0 ? a.grabS / a.grabs : null,
  });
  return [row("Me", me), row("Teammate", mate)];
}

export interface WeekBar {
  week: string;
  games: number;
}

export function gamesPerWeek(games: ResolvedGame[]): WeekBar[] {
  const map = new Map<string, number>();
  for (const g of games) {
    if (!g.date) continue;
    const key = localWeekStart(g.date);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, games]) => ({ week, games }));
}
