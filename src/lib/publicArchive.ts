import { supabase } from "./supabase";
import type { ActionCounts } from "./types";

const PAGE_SIZE = 1_000;

export type ArchivePopulation = "broad" | "conservative";
export type ArchiveFormat = "singles" | "doubles";
export type ArchiveScope = "community" | "series" | "tournament" | "player" | "set";
export type ArchiveTarget =
  | { kind: "series"; id: string }
  | { kind: "event"; id: string };

export interface ArchiveDataset {
  id: string;
  label: string;
  source_url: string;
  source_label: string;
  license_url: string | null;
  compressed_bytes: number;
  archive_count: number;
  replay_file_count: number;
  parsed_replay_count: number;
  unique_game_count: number;
  broad_game_count: number;
  conservative_game_count: number;
  parser_version: string;
  curation_version: string;
  data_as_of: string;
  notes: string | null;
  published_at: string;
}

export interface ArchiveSeries {
  id: string;
  canonical_name: string;
  source_url: string | null;
  notes: string | null;
}

export interface ArchiveTournament {
  id: string;
  dataset_id: string;
  series_id: string | null;
  canonical_name: string;
  year: number | null;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  online: boolean | null;
  is_tournament: boolean;
  event_source_url: string | null;
  event_source_label: string | null;
  source_confidence: "verified" | "probable" | "unverified";
  notes: string | null;
}

export interface ArchiveMoveMetrics {
  attempts: number;
  landed: number;
  damage: number;
  kills: number;
  killPctSum: number;
  openings: number;
  openingDmg: number;
  lCancelSuccess: number;
  lCancelFail: number;
}

export interface ArchiveRateDistribution {
  qualifiedPlayers: number;
  equalWeightMean: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
}

export interface ArchivePlayerBalancedMetrics {
  lCancel: ArchiveRateDistribution;
  techSuccess: ArchiveRateDistribution;
}

export interface ArchiveMetrics {
  durationFrames: number;
  damageTotal: number;
  neutralWins: number;
  openingsPerKillSum: number;
  openingsPerKillSamples: number;
  damagePerOpeningSum: number;
  damagePerOpeningSamples: number;
  inputsPerMinuteSum: number;
  inputsPerMinuteSamples: number;
  lCancelSuccess: number;
  lCancelFail: number;
  techInPlace: number;
  techToward: number;
  techAway: number;
  techMissed: number;
  wallTechSuccess: number;
  wallTechMissed: number;
  actions: ActionCounts;
  playerBalanced: ArchivePlayerBalancedMetrics | null;
  moves: Record<string, ArchiveMoveMetrics> | null;
}

export interface ArchiveRollup {
  rollup_key: string;
  dataset_id: string;
  scope: ArchiveScope;
  population: ArchivePopulation;
  series_id: string | null;
  tournament_id: string | null;
  set_id: string | null;
  player_id: string | null;
  format: ArchiveFormat | null;
  character_id: number | null;
  opponent_character_id: number | null;
  stage_id: number | null;
  game_count: number;
  win_rate_game_count: number;
  wins: number;
  identified_player_count: number | null;
  player_balanced_sample_count: number | null;
  metrics: ArchiveMetrics;
  stats_version: number;
}

export interface ArchivePlayer {
  id: string;
  display_name: string;
  normalized_name: string;
  liquipedia_url: string | null;
  country_code: string | null;
  active: boolean | null;
}

export interface ArchivePlayerRanking {
  player_id: string;
  ranking_series: string;
  edition_label: string;
  edition_year: number;
  rank: number;
  source_url: string;
}

export interface ArchiveProOption extends ArchivePlayer {
  observed_character_ids: number[];
  observed_game_count: number;
  primary_character_id: number;
  latest_ranking: ArchivePlayerRanking;
  best_rank: number;
}

export function archiveRankingLabel(ranking: ArchivePlayerRanking): string {
  const series = ranking.ranking_series === "SSBMRank" || ranking.ranking_series === "MPGR"
    ? ""
    : `${ranking.ranking_series} `;
  return `${series}#${ranking.rank} ${ranking.edition_year}`;
}

export interface ArchivePlayerEventAvailability {
  tournament_id: string;
  series_id: string | null;
  character_id: number;
  game_count: number;
}

export interface ArchiveForecastEvent {
  id: string;
  canonical_name: string;
  series_id: string | null;
  start_date: string;
  entrant_source_url: string;
  bracket_source_url: string | null;
  simulation_count: number;
  data_cutoff: string;
  notes: string | null;
  published_at: string;
}

export interface ArchiveForecastPlayer {
  forecast_event_id: string;
  player_id: string;
  seed: number | null;
  title_probability: number;
  top_8_probability: number;
  interval_low: number | null;
  interval_high: number | null;
  confidence: "low" | "medium" | "high";
}

export interface ArchiveForecast extends ArchiveForecastEvent {
  players: Array<ArchiveForecastPlayer & { player: ArchivePlayer }>;
}

export interface ArchiveCatalog {
  dataset: ArchiveDataset | null;
  series: ArchiveSeries[];
  tournaments: ArchiveTournament[];
}

interface PageResponse {
  data: unknown[] | null;
  error: { message: string } | null;
}

async function readAll<T>(readPage: (from: number, to: number) => Promise<PageResponse>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const response = await readPage(from, from + PAGE_SIZE - 1);
    if (response.error) throw new Error(response.error.message);
    const page = (response.data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function requireArchiveClient() {
  if (!supabase) throw new Error("Public archive data is unavailable because Supabase is not configured.");
  return supabase;
}

export async function fetchLatestArchiveDataset(): Promise<ArchiveDataset | null> {
  const client = requireArchiveClient();
  const latest = await client
    .from("archive_datasets")
    .select("id,label,source_url,source_label,license_url,compressed_bytes,archive_count,replay_file_count,parsed_replay_count,unique_game_count,broad_game_count,conservative_game_count,parser_version,curation_version,data_as_of,notes,published_at")
    .eq("published", true)
    .order("data_as_of", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw new Error(latest.error.message);
  return latest.data ? latest.data as unknown as ArchiveDataset : null;
}

export async function fetchArchiveCatalog(): Promise<ArchiveCatalog> {
  const client = requireArchiveClient();
  const dataset = await fetchLatestArchiveDataset();
  if (!dataset) return { dataset: null, series: [], tournaments: [] };

  const [series, tournaments] = await Promise.all([
    readAll<ArchiveSeries>(async (from, to) => {
      const response = await client
        .from("archive_tournament_series")
        .select("id,canonical_name,source_url,notes")
        .eq("published", true)
        .order("canonical_name")
        .range(from, to);
      return response as unknown as PageResponse;
    }),
    readAll<ArchiveTournament>(async (from, to) => {
      const response = await client
        .from("archive_tournaments")
        .select("id,dataset_id,series_id,canonical_name,year,start_date,end_date,location,online,is_tournament,event_source_url,event_source_label,source_confidence,notes")
        .eq("published", true)
        .eq("dataset_id", dataset.id)
        .order("year", { ascending: false })
        .order("canonical_name")
        .range(from, to);
      return response as unknown as PageResponse;
    }),
  ]);

  const publicTournaments = tournaments.filter((tournament) =>
    tournament.is_tournament && tournament.source_confidence !== "unverified");
  const tournamentSeries = new Set(publicTournaments.map((tournament) => tournament.series_id).filter(Boolean));
  return {
    dataset,
    series: series.filter((item) => tournamentSeries.has(item.id)),
    tournaments: publicTournaments,
  };
}

interface TargetableQuery {
  eq(column: string, value: string | number | boolean): TargetableQuery;
  is(column: string, value: null): TargetableQuery;
  not(column: string, operator: string, value: null): TargetableQuery;
  order(column: string): TargetableQuery;
  range(from: number, to: number): PromiseLike<PageResponse>;
}

function targetQuery(query: TargetableQuery, target: ArchiveTarget): TargetableQuery {
  if (target.kind === "event") return query.eq("tournament_id", target.id);
  return query.eq("series_id", target.id).is("tournament_id", null);
}

export interface ArchiveRollupQuery {
  datasetId: string;
  target: ArchiveTarget;
  population: ArchivePopulation;
  format: ArchiveFormat;
  playerId?: string | null;
}

export async function fetchArchiveRollups(filters: ArchiveRollupQuery): Promise<ArchiveRollup[]> {
  const client = requireArchiveClient();
  return readAll<ArchiveRollup>(async (from, to) => {
    let query = client
      .from("archive_rollups")
      .select("rollup_key,dataset_id,scope,population,series_id,tournament_id,set_id,player_id,format,character_id,opponent_character_id,stage_id,game_count,win_rate_game_count,wins,identified_player_count,player_balanced_sample_count,metrics,stats_version")
      .eq("published", true)
      .eq("dataset_id", filters.datasetId)
      .eq("scope", filters.playerId ? "player" : filters.target.kind === "event" ? "tournament" : "series")
      .eq("population", filters.playerId ? "conservative" : filters.population)
      .eq("format", filters.format);
    let targetted = targetQuery(query as unknown as TargetableQuery, filters.target);
    if (filters.playerId) targetted = targetted.eq("player_id", filters.playerId);
    const response = await targetted.order("rollup_key").range(from, to);
    return response as unknown as PageResponse;
  });
}

interface ObservedPlayerRollup {
  player_id: string;
  character_id: number;
  game_count: number;
}

async function fetchPublishedPlayerDirectory(): Promise<[ArchivePlayer[], ArchivePlayerRanking[]]> {
  const client = requireArchiveClient();
  return Promise.all([
    readAll<ArchivePlayer>(async (from, to) => {
      const response = await client
        .from("archive_players")
        .select("id,display_name,normalized_name,liquipedia_url,country_code,active")
        .eq("published", true)
        .order("display_name")
        .range(from, to);
      return response as unknown as PageResponse;
    }),
    readAll<ArchivePlayerRanking>(async (from, to) => {
      const response = await client
        .from("archive_player_rankings")
        .select("player_id,ranking_series,edition_label,edition_year,rank,source_url")
        .eq("published", true)
        .order("edition_year", { ascending: false })
        .order("rank")
        .range(from, to);
      return response as unknown as PageResponse;
    }),
  ]);
}

function proOptions(
  players: ArchivePlayer[],
  rankings: ArchivePlayerRanking[],
  observed: ObservedPlayerRollup[],
): ArchiveProOption[] {
  const rankingsByPlayer = new Map<string, ArchivePlayerRanking[]>();
  for (const ranking of rankings) {
    const list = rankingsByPlayer.get(ranking.player_id) ?? [];
    list.push(ranking);
    rankingsByPlayer.set(ranking.player_id, list);
  }
  const observedByPlayer = new Map<string, Map<number, number>>();
  for (const row of observed) {
    const chars = observedByPlayer.get(row.player_id) ?? new Map<number, number>();
    chars.set(row.character_id, (chars.get(row.character_id) ?? 0) + row.game_count);
    observedByPlayer.set(row.player_id, chars);
  }

  const options: ArchiveProOption[] = [];
  for (const player of players) {
    const playerRankings = rankingsByPlayer.get(player.id);
    const characters = observedByPlayer.get(player.id);
    if (!playerRankings?.length || !characters?.size) continue;
    playerRankings.sort((a, b) => b.edition_year - a.edition_year || a.rank - b.rank);
    const latestRanking = playerRankings[0];
    if (!latestRanking) continue;
    const characterEntries = [...characters.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const primaryCharacter = characterEntries[0];
    if (!primaryCharacter) continue;
    options.push({
      ...player,
      observed_character_ids: characterEntries.map(([characterId]) => characterId),
      observed_game_count: characterEntries.reduce((sum, [, count]) => sum + count, 0),
      primary_character_id: primaryCharacter[0],
      latest_ranking: latestRanking,
      best_rank: Math.min(...playerRankings.map((ranking) => ranking.rank)),
    });
  }
  return options.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export async function fetchArchivePlayerEventAvailability(
  datasetId: string,
  playerId: string,
  format: ArchiveFormat,
): Promise<ArchivePlayerEventAvailability[]> {
  const client = requireArchiveClient();
  return readAll<ArchivePlayerEventAvailability>(async (from, to) => {
    const response = await client
      .from("archive_rollups")
      .select("tournament_id,series_id,character_id,game_count")
      .eq("published", true)
      .eq("dataset_id", datasetId)
      .eq("scope", "player")
      .eq("population", "conservative")
      .eq("format", format)
      .eq("player_id", playerId)
      .not("tournament_id", "is", null)
      .is("set_id", null)
      .not("character_id", "is", null)
      .is("opponent_character_id", null)
      .is("stage_id", null)
      .order("tournament_id")
      .range(from, to);
    return response as unknown as PageResponse;
  });
}

export async function fetchArchiveProOptions(
  datasetId: string,
  target: ArchiveTarget,
  format: ArchiveFormat,
): Promise<ArchiveProOption[]> {
  const client = requireArchiveClient();
  const [[players, rankings], observed] = await Promise.all([
    fetchPublishedPlayerDirectory(),
    readAll<ObservedPlayerRollup>(async (from, to) => {
      let query = client
        .from("archive_rollups")
        .select("player_id,character_id,game_count")
        .eq("published", true)
        .eq("dataset_id", datasetId)
        .eq("scope", "player")
        .eq("population", "conservative")
        .eq("format", format)
        .not("player_id", "is", null)
        .not("character_id", "is", null)
        .is("opponent_character_id", null)
        .is("stage_id", null);
      const targetted = targetQuery(query as unknown as TargetableQuery, target);
      const response = await targetted.order("player_id").range(from, to);
      return response as unknown as PageResponse;
    }),
  ]);
  return proOptions(players, rankings, observed);
}

export interface ArchiveCommunityBenchmarks {
  broad: ArchiveRollup | null;
  conservative: ArchiveRollup | null;
}

/** Global archive averages, optionally scoped to a character and opponent; separate from opt-in contributor quartiles. */
export async function fetchArchiveCommunityBenchmarks(
  datasetId: string,
  characterId: number | null,
  format: ArchiveFormat = "singles",
  opponentCharacterId: number | null = null,
): Promise<ArchiveCommunityBenchmarks> {
  const client = requireArchiveClient();
  const rows = await readAll<ArchiveRollup>(async (from, to) => {
    let query = client
      .from("archive_rollups")
      .select("rollup_key,dataset_id,scope,population,series_id,tournament_id,set_id,player_id,format,character_id,opponent_character_id,stage_id,game_count,win_rate_game_count,wins,identified_player_count,player_balanced_sample_count,metrics,stats_version")
      .eq("published", true)
      .eq("dataset_id", datasetId)
      .eq("scope", "community")
      .in("population", ["broad", "conservative"])
      .eq("format", format)
      .is("stage_id", null) as unknown as TargetableQuery;
    query = opponentCharacterId === null
      ? query.is("opponent_character_id", null)
      : query.eq("opponent_character_id", opponentCharacterId);
    // Character rows carry per-move metrics; the prebuilt all-character row
    // deliberately does not. Sum the disjoint character rows so an unfiltered
    // Execution view can still show honest move benchmarks.
    const response = await (characterId === null ? query.not("character_id", "is", null) : query.eq("character_id", characterId))
      .order("rollup_key")
      .range(from, to);
    return response as unknown as PageResponse;
  });
  const benchmarkRows = characterId === null ? aggregateCommunityCharacterRows(rows, datasetId, format) : rows;
  return {
    broad: benchmarkRows.find((row) => row.population === "broad") ?? null,
    conservative: benchmarkRows.find((row) => row.population === "conservative") ?? null,
  };
}

/** Publicly ranked identities with a published global player rollup; private identity candidates never enter this list. */
export async function fetchArchiveCommunityProOptions(
  datasetId: string,
  format: ArchiveFormat = "singles",
): Promise<ArchiveProOption[]> {
  const client = requireArchiveClient();
  const [[players, rankings], observed] = await Promise.all([
    fetchPublishedPlayerDirectory(),
    readAll<ObservedPlayerRollup>(async (from, to) => {
      const response = await client
        .from("archive_rollups")
        .select("player_id,character_id,game_count")
        .eq("published", true)
        .eq("dataset_id", datasetId)
        .eq("scope", "player")
        .eq("population", "conservative")
        .eq("format", format)
        .not("player_id", "is", null)
        .not("character_id", "is", null)
        .is("series_id", null)
        .is("tournament_id", null)
        .is("opponent_character_id", null)
        .is("stage_id", null)
        .order("player_id")
        .range(from, to);
      return response as unknown as PageResponse;
    }),
  ]);
  return proOptions(players, rankings, observed);
}

export async function fetchArchiveCommunityProBenchmark(
  datasetId: string,
  playerId: string,
  characterId: number,
  format: ArchiveFormat = "singles",
): Promise<ArchiveRollup | null> {
  const client = requireArchiveClient();
  const response = await client
    .from("archive_rollups")
    .select("rollup_key,dataset_id,scope,population,series_id,tournament_id,set_id,player_id,format,character_id,opponent_character_id,stage_id,game_count,win_rate_game_count,wins,identified_player_count,player_balanced_sample_count,metrics,stats_version")
    .eq("published", true)
    .eq("dataset_id", datasetId)
    .eq("scope", "player")
    .eq("population", "conservative")
    .eq("format", format)
    .eq("player_id", playerId)
    .eq("character_id", characterId)
    .is("series_id", null)
    .is("tournament_id", null)
    .is("opponent_character_id", null)
    .is("stage_id", null)
    .limit(1)
    .maybeSingle();
  if (response.error) throw new Error(response.error.message);
  return response.data ? response.data as unknown as ArchiveRollup : null;
}

/** Character, matchup, and stage rows used by the Community atlases. */
export async function fetchArchiveCommunityAtlasRows(
  datasetId: string,
  characterId: number,
  format: ArchiveFormat = "singles",
): Promise<ArchiveRollup[]> {
  const client = requireArchiveClient();
  return readAll<ArchiveRollup>(async (from, to) => {
    const response = await client
      .from("archive_rollups")
      .select("rollup_key,dataset_id,scope,population,series_id,tournament_id,set_id,player_id,format,character_id,opponent_character_id,stage_id,game_count,win_rate_game_count,wins,identified_player_count,player_balanced_sample_count,metrics,stats_version")
      .eq("published", true)
      .eq("dataset_id", datasetId)
      .eq("scope", "community")
      .in("population", ["broad", "conservative"])
      .eq("format", format)
      .eq("character_id", characterId)
      .is("series_id", null)
      .is("tournament_id", null)
      .is("set_id", null)
      .is("player_id", null)
      .order("rollup_key")
      .range(from, to);
    return response as unknown as PageResponse;
  });
}

/** Global character, matchup, and stage rows for one safely resolved ranked player. */
export async function fetchArchivePlayerAtlasRows(
  datasetId: string,
  playerId: string,
  characterId: number,
  format: ArchiveFormat = "singles",
): Promise<ArchiveRollup[]> {
  const client = requireArchiveClient();
  return readAll<ArchiveRollup>(async (from, to) => {
    const response = await client
      .from("archive_rollups")
      .select("rollup_key,dataset_id,scope,population,series_id,tournament_id,set_id,player_id,format,character_id,opponent_character_id,stage_id,game_count,win_rate_game_count,wins,identified_player_count,player_balanced_sample_count,metrics,stats_version")
      .eq("published", true)
      .eq("dataset_id", datasetId)
      .eq("scope", "player")
      .eq("population", "conservative")
      .eq("format", format)
      .eq("player_id", playerId)
      .eq("character_id", characterId)
      .is("series_id", null)
      .is("tournament_id", null)
      .is("set_id", null)
      .order("rollup_key")
      .range(from, to);
    return response as unknown as PageResponse;
  });
}

function emptyArchiveMetrics(): ArchiveMetrics {
  return {
    durationFrames: 0,
    damageTotal: 0,
    neutralWins: 0,
    openingsPerKillSum: 0,
    openingsPerKillSamples: 0,
    damagePerOpeningSum: 0,
    damagePerOpeningSamples: 0,
    inputsPerMinuteSum: 0,
    inputsPerMinuteSamples: 0,
    lCancelSuccess: 0,
    lCancelFail: 0,
    techInPlace: 0,
    techToward: 0,
    techAway: 0,
    techMissed: 0,
    wallTechSuccess: 0,
    wallTechMissed: 0,
    actions: {
      rolls: 0,
      airDodges: 0,
      spotDodges: 0,
      wavedashes: 0,
      wavelands: 0,
      dashDances: 0,
      ledgeGrabs: 0,
      grabs: 0,
    },
    playerBalanced: null,
    moves: null,
  };
}

function addArchiveMetrics(into: ArchiveMetrics, metrics: ArchiveMetrics): void {
  into.durationFrames += metrics.durationFrames;
  into.damageTotal += metrics.damageTotal;
  into.neutralWins += metrics.neutralWins;
  into.openingsPerKillSum += metrics.openingsPerKillSum;
  into.openingsPerKillSamples += metrics.openingsPerKillSamples;
  into.damagePerOpeningSum += metrics.damagePerOpeningSum;
  into.damagePerOpeningSamples += metrics.damagePerOpeningSamples;
  into.inputsPerMinuteSum += metrics.inputsPerMinuteSum;
  into.inputsPerMinuteSamples += metrics.inputsPerMinuteSamples;
  into.lCancelSuccess += metrics.lCancelSuccess;
  into.lCancelFail += metrics.lCancelFail;
  into.techInPlace += metrics.techInPlace;
  into.techToward += metrics.techToward;
  into.techAway += metrics.techAway;
  into.techMissed += metrics.techMissed;
  into.wallTechSuccess += metrics.wallTechSuccess ?? 0;
  into.wallTechMissed += metrics.wallTechMissed ?? 0;
  for (const action of Object.keys(into.actions) as (keyof ActionCounts)[]) {
    into.actions[action] += metrics.actions?.[action] ?? 0;
  }
  if (!metrics.moves) return;
  into.moves ??= {};
  for (const [moveId, move] of Object.entries(metrics.moves)) {
    const aggregate = into.moves[moveId] ?? {
      attempts: 0,
      landed: 0,
      damage: 0,
      kills: 0,
      killPctSum: 0,
      openings: 0,
      openingDmg: 0,
      lCancelSuccess: 0,
      lCancelFail: 0,
    };
    aggregate.attempts += move.attempts;
    aggregate.landed += move.landed;
    aggregate.damage += move.damage;
    aggregate.kills += move.kills;
    aggregate.killPctSum += move.killPctSum;
    aggregate.openings += move.openings;
    aggregate.openingDmg += move.openingDmg;
    aggregate.lCancelSuccess += move.lCancelSuccess;
    aggregate.lCancelFail += move.lCancelFail;
    into.moves[moveId] = aggregate;
  }
}

function aggregateCommunityCharacterRows(
  rows: ArchiveRollup[],
  datasetId: string,
  format: ArchiveFormat,
): ArchiveRollup[] {
  const grouped = new Map<ArchivePopulation, ArchiveRollup>();
  for (const source of rows) {
    let target = grouped.get(source.population);
    if (!target) {
      target = {
        ...source,
        rollup_key: `community-character-aggregate:${datasetId}:${format}:${source.population}:${source.opponent_character_id ?? "all"}`,
        character_id: null,
        game_count: 0,
        win_rate_game_count: 0,
        wins: 0,
        identified_player_count: null,
        player_balanced_sample_count: null,
        metrics: emptyArchiveMetrics(),
      };
      grouped.set(source.population, target);
    }
    target.game_count += source.game_count;
    target.win_rate_game_count += source.win_rate_game_count;
    target.wins += source.wins;
    addArchiveMetrics(target.metrics, source.metrics);
  }
  return [...grouped.values()];
}

/**
 * Aggregate every safely resolved ranked player for one or all characters.
 * This is a player-game sample: when two named pros face each other, both sides belong.
 * An explicit opponent selects that matchup (null selects all opponents).
 * Omit it to retain the full atlas for a character, or the overall row for all characters.
 */
export async function fetchArchiveProAggregateAtlasRows(
  datasetId: string,
  characterId: number | null,
  format: ArchiveFormat = "singles",
  opponentCharacterId?: number | null,
): Promise<ArchiveRollup[]> {
  const client = requireArchiveClient();
  const sourceRows = await readAll<ArchiveRollup>(async (from, to) => {
    let query = client
      .from("archive_rollups")
      .select("rollup_key,dataset_id,scope,population,series_id,tournament_id,set_id,player_id,format,character_id,opponent_character_id,stage_id,game_count,win_rate_game_count,wins,identified_player_count,player_balanced_sample_count,metrics,stats_version")
      .eq("published", true)
      .eq("dataset_id", datasetId)
      .eq("scope", "player")
      .eq("population", "conservative")
      .eq("format", format)
      .not("player_id", "is", null)
      .is("series_id", null)
      .is("tournament_id", null)
      .is("set_id", null) as unknown as TargetableQuery;
    query = characterId === null
      ? query.not("character_id", "is", null).is("stage_id", null)
      : query.eq("character_id", characterId);
    if (opponentCharacterId !== undefined || characterId === null) {
      query = opponentCharacterId == null
        ? query.is("opponent_character_id", null)
        : query.eq("opponent_character_id", opponentCharacterId);
      query = query.is("stage_id", null);
    }
    const response = await query
      .order("rollup_key")
      .range(from, to);
    return response as unknown as PageResponse;
  });

  const grouped = new Map<string, { row: ArchiveRollup; players: Set<string> }>();
  for (const source of sourceRows) {
    const key = `${source.opponent_character_id ?? "all"}:${source.stage_id ?? "all"}`;
    let target = grouped.get(key);
    if (!target) {
      target = {
        row: {
          ...source,
          rollup_key: `pro-aggregate:${datasetId}:${characterId}:${key}`,
          character_id: characterId,
          player_id: null,
          game_count: 0,
          win_rate_game_count: 0,
          wins: 0,
          identified_player_count: 0,
          player_balanced_sample_count: null,
          metrics: emptyArchiveMetrics(),
        },
        players: new Set<string>(),
      };
      grouped.set(key, target);
    }
    if (source.player_id) target.players.add(source.player_id);
    target.row.game_count += source.game_count;
    target.row.win_rate_game_count += source.win_rate_game_count;
    target.row.wins += source.wins;
    addArchiveMetrics(target.row.metrics, source.metrics);
  }
  return [...grouped.values()].map(({ row, players }) => ({
    ...row,
    identified_player_count: players.size,
  }));
}

/** Player-game count behind the broad historical archive benchmark. */
export async function fetchArchivePlayerGameCount(datasetId: string): Promise<number> {
  const client = requireArchiveClient();
  const rows = await readAll<Pick<ArchiveRollup, "game_count">>(async (from, to) => {
    const response = await client
      .from("archive_rollups")
      .select("game_count")
      .eq("published", true)
      .eq("dataset_id", datasetId)
      .eq("scope", "community")
      .eq("population", "broad")
      .is("series_id", null)
      .is("tournament_id", null)
      .is("set_id", null)
      .is("player_id", null)
      .is("character_id", null)
      .is("opponent_character_id", null)
      .is("stage_id", null)
      .order("game_count")
      .range(from, to);
    return response as unknown as PageResponse;
  });
  return rows.reduce((sum, row) => sum + Number(row.game_count), 0);
}

export async function fetchPublishedForecasts(): Promise<ArchiveForecast[]> {
  const client = requireArchiveClient();
  const events = await readAll<ArchiveForecastEvent>(async (from, to) => {
    const response = await client
      .from("archive_forecast_events")
      .select("id,canonical_name,series_id,start_date,entrant_source_url,bracket_source_url,simulation_count,data_cutoff,notes,published_at")
      .eq("published", true)
      .order("start_date")
      .range(from, to);
    return response as unknown as PageResponse;
  });
  if (!events.length) return [];

  const [entries, players] = await Promise.all([
    readAll<ArchiveForecastPlayer>(async (from, to) => {
      const response = await client
        .from("archive_forecast_players")
        .select("forecast_event_id,player_id,seed,title_probability,top_8_probability,interval_low,interval_high,confidence")
        .eq("published", true)
        .order("title_probability", { ascending: false })
        .range(from, to);
      return response as unknown as PageResponse;
    }),
    readAll<ArchivePlayer>(async (from, to) => {
      const response = await client
        .from("archive_players")
        .select("id,display_name,normalized_name,liquipedia_url,country_code,active")
        .eq("published", true)
        .order("display_name")
        .range(from, to);
      return response as unknown as PageResponse;
    }),
  ]);
  const playerById = new Map(players.map((player) => [player.id, player]));
  return events.map((event) => ({
    ...event,
    players: entries
      .filter((entry) => entry.forecast_event_id === event.id && playerById.has(entry.player_id))
      .map((entry) => ({ ...entry, player: playerById.get(entry.player_id)! }))
      .sort((a, b) => b.title_probability - a.title_probability),
  }));
}
