import type { ActionCounts, ResolvedGame } from "./types";
import { INCLUDED_CHARACTER_ID_SET } from "./config";
import { executionSummary, moveTable } from "./stats";
import { supabase } from "./supabase";
import { gameKey } from "./dedupe";

export const COMMUNITY_CONSENT_VERSION = "2026-08-24";
export const COMMUNITY_MIN_CONTRIBUTORS = 1;
export const COMMUNITY_MIN_PLAYERS = 25;
export const COMMUNITY_MIN_GAMES = 100;
export const COMMUNITY_LOOKBACK_DAYS = [30, 90, 180, 365, null] as const;

export type CommunityLookbackDays = (typeof COMMUNITY_LOOKBACK_DAYS)[number];

interface CommunityLookbackRow {
  /** null is the unbounded, all-history ("Max") cohort. */
  lookbackDays: CommunityLookbackDays;
}

interface CommunitySampleSize {
  /** Unique connect-code participants across both sides, coarsened at publication. */
  players?: number;
  /** Distinct games; a mirror supplies two player samples but only one game. */
  uniqueGames?: number;
}

export interface CommunityMatchupRow extends CommunityLookbackRow, CommunitySampleSize {
  characterId: number;
  opponentCharacterId: number;
  stageId: number; // 0 = every legal stage
  gameType: string; // "all" or a GameType
  games: number;
  contributors: number;
  wins: number;
  winRate: number;
}

/** All opponents combined before applying publication thresholds. */
export type CommunityCharacterStageRow = Omit<CommunityMatchupRow, "opponentCharacterId">;

export interface CommunityBenchmarkRow extends CommunitySampleSize {
  characterId: number; // -1 = every character
  games: number;
  contributors: number;
  lCancel: Quartiles | null;
  openingsPerKill: Quartiles | null;
  damagePerOpening: Quartiles | null;
  inputsPerMinute: Quartiles | null;
}

export interface Quartiles {
  p25: number;
  p50: number;
  p75: number;
}

export interface CommunityMoveRow extends CommunityLookbackRow, CommunitySampleSize {
  characterId: number;
  moveKey: string;
  characterGames: number;
  contributors: number;
  attempts: number | null;
  attemptGames: number;
  landed: number;
  damage: number;
  kills: number;
  killPctSum: number;
  openings: number;
  openingDamage: number;
  lCancelSuccess: number;
  lCancelFail: number;
}

export interface CommunityExecutionRow extends CommunityLookbackRow, CommunitySampleSize {
  characterId: number; // -1 = every character
  games: number;
  contributors: number;
  lCancelSuccess: number | null;
  groundTechSuccess: number | null;
  groundTechInPlace: number | null;
  groundTechIn: number | null;
  groundTechAway: number | null;
  actionCounts: ActionCounts | null;
  techInPlaceCount: number | null;
  techInCount: number | null;
  techAwayCount: number | null;
}

export interface CommunityMonthRow extends CommunitySampleSize {
  month: string;
  playerGames: number;
  contributors: number;
  averageDurationSeconds: number;
  ranked: number;
  unranked: number;
  direct: number;
  offline: number;
}

export interface CommunityCharacterRow extends CommunitySampleSize {
  characterId: number;
  playerGames: number;
  contributors: number;
  wins: number;
  decided: number;
  winRate: number | null;
}

export interface CommunityStageRow extends CommunitySampleSize {
  stageId: number;
  playerGames: number;
  contributors: number;
  averageDurationSeconds: number;
}

export interface CommunitySnapshot {
  refreshedAt: string;
  contributorCount: number;
  playerGameCount: number;
  minContributors: number;
  minPlayers: number;
  minGames: number;
  matchups: CommunityMatchupRow[];
  characterStages: CommunityCharacterStageRow[];
  benchmarks: CommunityBenchmarkRow[];
  moves: CommunityMoveRow[];
  execution: CommunityExecutionRow[];
  months: CommunityMonthRow[];
  characters: CommunityCharacterRow[];
  stages: CommunityStageRow[];
  demo?: boolean;
}

interface SnapshotPayload {
  matchups?: CommunityMatchupRow[];
  characterStages?: CommunityCharacterStageRow[];
  benchmarks?: CommunityBenchmarkRow[];
  moves?: CommunityMoveRow[];
  execution?: CommunityExecutionRow[];
  months?: CommunityMonthRow[];
  characters?: CommunityCharacterRow[];
  stages?: CommunityStageRow[];
}

const normalizeLookbackDays = (value: unknown): CommunityLookbackDays =>
  value === 30 || value === 90 || value === 180 || value === 365 ? value : null;

const withLookback = <T extends { lookbackDays?: unknown }>(row: T): T & CommunityLookbackRow => ({
  ...row,
  // Snapshots published before lookback cohorts existed are the Max cohort.
  lookbackDays: normalizeLookbackDays(row.lookbackDays),
});

const emptyLegacyActionCounts = (): ActionCounts => ({
  rolls: 0,
  airDodges: 0,
  spotDodges: 0,
  wavedashes: 0,
  wavelands: 0,
  dashDances: 0,
  ledgeGrabs: 0,
  grabs: 0,
} as ActionCounts);

const emptyActionCounts = (): ActionCounts => ({
  ...emptyLegacyActionCounts(),
  crouchCancels: 0,
  grabs: 0,
});

const normalizeExecution = (row: CommunityExecutionRow): CommunityExecutionRow => ({
  ...withLookback(row),
  actionCounts: row.actionCounts
    ? { ...("crouchCancels" in row.actionCounts ? emptyActionCounts() : emptyLegacyActionCounts()), ...row.actionCounts }
    : null,
  techInPlaceCount: row.techInPlaceCount === null || row.techInPlaceCount === undefined ? null : Number(row.techInPlaceCount),
  techInCount: row.techInCount === null || row.techInCount === undefined ? null : Number(row.techInCount),
  techAwayCount: row.techAwayCount === null || row.techAwayCount === undefined ? null : Number(row.techAwayCount),
});

export async function fetchCommunitySnapshot(): Promise<CommunitySnapshot | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("community_snapshot")
    .select("refreshed_at, contributor_count, player_game_count, min_contributors, min_players, min_games, payload")
    .eq("snapshot_id", "current")
    .maybeSingle();
  if (error) throw error;
  if (!data) return {
    refreshedAt: new Date(0).toISOString(),
    contributorCount: 0,
    playerGameCount: 0,
    minContributors: COMMUNITY_MIN_CONTRIBUTORS,
    minPlayers: COMMUNITY_MIN_PLAYERS,
    minGames: COMMUNITY_MIN_GAMES,
    matchups: [], characterStages: [], benchmarks: [], moves: [], execution: [], months: [], characters: [], stages: [],
  };
  const payload = (data.payload ?? {}) as SnapshotPayload;
  return {
    refreshedAt: data.refreshed_at as string,
    contributorCount: Number(data.contributor_count ?? 0),
    playerGameCount: Number(data.player_game_count ?? 0),
    minContributors: Number(data.min_contributors ?? COMMUNITY_MIN_CONTRIBUTORS),
    minPlayers: Number(data.min_players ?? COMMUNITY_MIN_PLAYERS),
    minGames: Number(data.min_games ?? COMMUNITY_MIN_GAMES),
    matchups: (payload.matchups ?? []).map(withLookback).filter((r) => playable(r.characterId) && playable(r.opponentCharacterId)),
    characterStages: (payload.characterStages ?? []).map(withLookback).filter((r) => playable(r.characterId)),
    benchmarks: (payload.benchmarks ?? []).filter((r) => playable(r.characterId)),
    moves: (payload.moves ?? []).map(withLookback).filter((r) => playable(r.characterId)),
    execution: (payload.execution ?? []).map(normalizeExecution).filter((r) => playable(r.characterId)),
    months: payload.months ?? [],
    characters: (payload.characters ?? []).filter((r) => playable(r.characterId)),
    stages: payload.stages ?? [],
  };
}

/**
 * The aggregate is computed server-side over every synced game, including ones
 * pushed by clients built before the roster allowlist existed, so a "Char 31"
 * row can still arrive over the wire. `-1` is the deliberate every-character
 * bucket the benchmark rows use, not a character id.
 */
const playable = (characterId: number): boolean => characterId === -1 || INCLUDED_CHARACTER_ID_SET.has(characterId);

/** null means signed out; false is the default for a signed-in account with no row. */
export async function getCommunityConsent(): Promise<boolean | null> {
  if (!supabase) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;
  const { data, error } = await supabase
    .from("community_consent")
    .select("enabled, consent_version")
    .maybeSingle();
  if (error) throw error;
  // Consent agreed under superseded terms reads as off, because that is what it
  // now is: refresh_community_snapshot gates on this same version, so those rows
  // stopped contributing the moment the constant moved. Reporting it as still on
  // would show a switch that does not match what the aggregate actually does.
  // Flipping the toggle back on re-consents under the current terms.
  if (data?.consent_version !== COMMUNITY_CONSENT_VERSION) return false;
  return Boolean(data.enabled);
}

export async function setCommunityConsent(enabled: boolean): Promise<void> {
  if (!supabase) throw new Error("Cloud sync is not configured.");
  const { error } = await supabase.from("community_consent").upsert(
    { enabled, consent_version: COMMUNITY_CONSENT_VERSION, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}

const quartilesAround = (value: number | null, spread: number): Quartiles | null => value === null ? null : ({
  p25: Math.max(0, value - spread),
  p50: value,
  p75: value + spread,
});

/**
 * Local-only fixture for demo mode. It exercises the complete Community UI
 * without pretending the synthetic games are real contributors.
 */
export function demoCommunitySnapshot(contributedGames: ResolvedGame[]): CommunitySnapshot {
  // Match the public population: two player samples per unique singles game.
  // A mirror match still has two separate sides, including two move denominators.
  const seen = new Set<string>();
  const games: ResolvedGame[] = [];
  for (const game of contributedGames) {
    if (game.selfMatch) continue;
    const key = gameKey(game.rec);
    if (seen.has(key)) continue;
    seen.add(key);
    games.push(game, {
      ...game,
      me: game.opp,
      opp: game.me,
      isWin: game.isWin === null ? null : !game.isWin,
    });
  }
  type MatchAgg = Omit<CommunityMatchupRow, "contributors" | "winRate">;
  const matchups = new Map<string, MatchAgg>();
  const characterStages = new Map<string, Omit<MatchAgg, "opponentCharacterId">>();
  const months = new Map<string, { playerGames: number; seconds: number; ranked: number; unranked: number; direct: number; offline: number }>();
  const chars = new Map<number, { playerGames: number; wins: number; decided: number }>();
  const stages = new Map<number, { playerGames: number; seconds: number }>();

  const refreshedAtMs = Date.now();
  const inLookback = (game: ResolvedGame, lookbackDays: CommunityLookbackDays): boolean =>
    lookbackDays === null || (game.date !== null && game.date.getTime() >= refreshedAtMs - lookbackDays * 86_400_000);

  for (const g of games) {
    const seconds = g.rec.durationFrames / 60;
    const char = chars.get(g.me.characterId) ?? { playerGames: 0, wins: 0, decided: 0 };
    char.playerGames++;
    if (g.isWin !== null) { char.decided++; if (g.isWin) char.wins++; }
    chars.set(g.me.characterId, char);
    const stage = stages.get(g.rec.stageId) ?? { playerGames: 0, seconds: 0 };
    stage.playerGames++; stage.seconds += seconds; stages.set(g.rec.stageId, stage);
    if (g.date) {
      const month = `${g.date.getFullYear()}-${String(g.date.getMonth() + 1).padStart(2, "0")}-01`;
      const m = months.get(month) ?? { playerGames: 0, seconds: 0, ranked: 0, unranked: 0, direct: 0, offline: 0 };
      m.playerGames++; m.seconds += seconds;
      if (g.rec.gameType === "ranked" || g.rec.gameType === "unranked" || g.rec.gameType === "direct" || g.rec.gameType === "offline") m[g.rec.gameType]++;
      months.set(month, m);
    }
    if (g.isWin === null) continue;
    for (const lookbackDays of COMMUNITY_LOOKBACK_DAYS) {
      if (!inLookback(g, lookbackDays)) continue;
      for (const stageId of [0, g.rec.stageId]) for (const gameType of ["all", g.rec.gameType]) {
        const key = `${lookbackDays ?? "max"}:${g.me.characterId}:${g.opp.characterId}:${stageId}:${gameType}`;
        const row = matchups.get(key) ?? { lookbackDays, characterId: g.me.characterId, opponentCharacterId: g.opp.characterId, stageId, gameType, games: 0, wins: 0 };
        row.games++; if (g.isWin) row.wins++; matchups.set(key, row);
        if (stageId !== 0) {
          const stageKey = `${lookbackDays ?? "max"}:${g.me.characterId}:${stageId}:${gameType}`;
          const stageRow = characterStages.get(stageKey) ?? { lookbackDays, characterId: g.me.characterId, stageId, gameType, games: 0, wins: 0 };
          stageRow.games++; if (g.isWin) stageRow.wins++;
          characterStages.set(stageKey, stageRow);
        }
      }
    }
  }

  const benchmarkChars = [-1, ...chars.keys()];
  const benchmarks = benchmarkChars.map((characterId): CommunityBenchmarkRow => {
    const selected = characterId === -1 ? games : games.filter((g) => g.me.characterId === characterId);
    const s = executionSummary(selected, Number.MAX_SAFE_INTEGER);
    return {
      characterId,
      games: selected.length,
      contributors: 64,
      lCancel: quartilesAround(s.lCancel, 7),
      openingsPerKill: quartilesAround(s.opk, 0.35),
      damagePerOpening: quartilesAround(s.dpo, 3.2),
      inputsPerMinute: quartilesAround(s.ipm, 55),
    };
  });

  const moves: CommunityMoveRow[] = [];
  for (const lookbackDays of COMMUNITY_LOOKBACK_DAYS) {
    for (const characterId of chars.keys()) {
      const selected = games.filter((g) => g.me.characterId === characterId && inLookback(g, lookbackDays));
      const table = moveTable(selected);
      for (const row of table.rows) moves.push({
        lookbackDays,
        characterId,
        moveKey: row.key,
        characterGames: table.covered,
        contributors: 48,
        attempts: row.attempts,
        attemptGames: row.attempts === null ? 0 : table.covered,
        landed: row.landed,
        damage: row.damage,
        kills: row.kills,
        killPctSum: (row.avgKillPct ?? 0) * row.kills,
        openings: row.openings,
        openingDamage: (row.dmgPerOpening ?? 0) * row.openings,
        lCancelSuccess: (row.lCancelPct ?? 0) * row.lCancelAttempts,
        lCancelFail: row.lCancelAttempts - (row.lCancelPct ?? 0) * row.lCancelAttempts,
      });
    }
  }

  const execution = COMMUNITY_LOOKBACK_DAYS.flatMap((lookbackDays) =>
    benchmarkChars.map((characterId): CommunityExecutionRow => {
      const selected = games.filter((g) =>
        (characterId === -1 || g.me.characterId === characterId) && inLookback(g, lookbackDays));
      const summary = executionSummary(selected, Number.MAX_SAFE_INTEGER);
      const actionCounts = emptyActionCounts();
      let techInPlaceCount = 0;
      let techInCount = 0;
      let techAwayCount = 0;
      for (const game of selected) {
        for (const action of Object.keys(actionCounts) as (keyof ActionCounts)[]) {
          actionCounts[action] += game.me.actions?.[action] ?? 0;
        }
        techInPlaceCount += game.me.techs?.inPlace ?? 0;
        techInCount += game.me.techs?.toward ?? 0;
        techAwayCount += game.me.techs?.away ?? 0;
      }
      return {
        lookbackDays,
        characterId,
        games: selected.length,
        contributors: 64,
        lCancelSuccess: summary.lCancel,
        groundTechSuccess: summary.groundTechSuccess,
        groundTechInPlace: summary.groundTechInPlace,
        groundTechIn: summary.groundTechIn,
        groundTechAway: summary.groundTechAway,
        actionCounts,
        techInPlaceCount,
        techInCount,
        techAwayCount,
      };
    }),
  );

  const refreshedAt = games.at(-1)?.date?.toISOString() ?? new Date().toISOString();
  return {
    refreshedAt,
    contributorCount: 84,
    playerGameCount: games.length,
    minContributors: COMMUNITY_MIN_CONTRIBUTORS,
    minPlayers: COMMUNITY_MIN_PLAYERS,
    minGames: COMMUNITY_MIN_GAMES,
    demo: true,
    matchups: [...matchups.values()].filter((r) => r.games >= 5).map((r) => ({ ...r, contributors: Math.max(25, Math.min(84, Math.round(r.games / 3))), winRate: r.wins / r.games })),
    characterStages: [...characterStages.values()].filter((r) => r.games >= 5).map((r) => ({ ...r, contributors: Math.max(25, Math.min(84, Math.round(r.games / 3))), winRate: r.wins / r.games })),
    benchmarks,
    moves,
    execution,
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, playerGames: m.playerGames, contributors: 52, averageDurationSeconds: m.seconds / m.playerGames, ranked: m.ranked, unranked: m.unranked, direct: m.direct, offline: m.offline })),
    characters: [...chars.entries()].map(([characterId, c]) => ({ characterId, ...c, contributors: 56, winRate: c.decided ? c.wins / c.decided : null })),
    stages: [...stages.entries()].map(([stageId, s]) => ({ stageId, playerGames: s.playerGames, contributors: 60, averageDurationSeconds: s.seconds / s.playerGames })),
  };
}
