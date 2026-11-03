import { useEffect, useState } from "react";
import type { ArchiveMetrics, ArchiveMoveMetrics } from "./publicArchive";
import type { BenchmarkMetricRow } from "./benchmarkCohorts";
import type { InteractionSummary } from "./interactionSummary";
import { isInteractionSummary } from "./interactionBenchmarks";
import { ACTION_LABELS, CURRENT_STATS_VERSION, INTERACTION_STATS_VERSION } from "./types";
import { moveGroup } from "./melee";

export const RANKED_TIERS = ["diamond", "master"] as const;
export type RankedTier = typeof RANKED_TIERS[number];
export interface RankedScope { characterId: number | null; opponentCharacterId: number | null; stageId: number | null }
export interface RankedMeasurementCoverage { playerGames: number; durationFrames: number }
export interface RankedCoverage {
  statsPlayerGames: number; statsDurationFrames: number;
  actionPlayerGames: number; actionDurationFrames: number;
  movePlayerGames: number; moveDurationFrames: number;
  metrics: Record<string, RankedMeasurementCoverage>;
  actions: Record<string, RankedMeasurementCoverage>;
  moves: Record<string, Record<string, RankedMeasurementCoverage>>;
}
export interface RankedBenchmarkRow extends RankedScope {
  tier: RankedTier;
  playerGames: number; distinctGames: number; decidedPlayerGames: number; wins: number;
  uniquePlayers: null;
  metrics: Omit<ArchiveMetrics, "moves"> & { moves: Record<string, Omit<ArchiveMoveMetrics, "attempts"> & { attempts?: number }> | null };
  coverage: RankedCoverage;
  interactions: InteractionSummary;
}
interface RankedShardIndex {
  tier: string; characterId: number | null; path: string; encoding: "gzip"; sha256: string; bytes: number; rows: number;
}
export interface RankedManifest {
  schemaVersion: 1; datasetId: string; statsVersion: number; interactionStatsVersion: number; generatedAt: string;
  rankTiming: "unknown"; rankSeason: null; rankDate: null; uniquePlayers: null;
  source: { repository: string; revision: string; url: string; selectionMethod: string; archives: { path: string; bytes: number; sha256: string }[]; sourceManifestSha256: string };
  tiers: Partial<Record<RankedTier, { playerGames: number; distinctGames: number; decidedPlayerGames: number; wins: number }>>;
  shards: RankedShardIndex[];
  qualityGates: string[];
}
export interface RankedShard {
  schemaVersion: 1; datasetId: string; statsVersion: number; interactionStatsVersion: number;
  tier: RankedTier; characterId: number | null; rows: RankedBenchmarkRow[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const characterDimension = (value: unknown): value is number | null => value === null || (count(value) && value < 26);
const stageDimension = (value: unknown): value is number | null => value === null || (typeof value === "number" && [2, 3, 8, 28, 31, 32].includes(value));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const versions = (value: Record<string, unknown>) => value.schemaVersion === 1 && value.statsVersion === CURRENT_STATS_VERSION && value.interactionStatsVersion === INTERACTION_STATS_VERSION;
const validCounts = (value: Record<string, unknown>) => ["playerGames", "distinctGames", "decidedPlayerGames", "wins"].every(key => count(value[key]))
  && Number(value.distinctGames) <= Number(value.playerGames) && Number(value.wins) <= Number(value.decidedPlayerGames) && Number(value.decidedPlayerGames) <= Number(value.playerGames);

export function parseRankedManifest(raw: unknown): RankedManifest | null {
  if (!object(raw) || !versions(raw) || typeof raw.datasetId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(raw.datasetId)
    || typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))
    || raw.rankTiming !== "unknown" || raw.rankSeason !== null || raw.rankDate !== null || raw.uniquePlayers !== null
    || !object(raw.source) || !Array.isArray(raw.shards) || !object(raw.tiers)
    || !Array.isArray(raw.qualityGates) || !raw.qualityGates.every(value => typeof value === "string")) return null;
  const source = raw.source;
  if (!["repository", "revision", "selectionMethod"].every(key => typeof source[key] === "string" && source[key])
    || typeof source.url !== "string" || !/^https:\/\//.test(source.url) || !hash(source.sourceManifestSha256) || !Array.isArray(source.archives)) return null;
  if (!source.archives.every(item => object(item) && typeof item.path === "string" && count(item.bytes) && hash(item.sha256))) return null;
  for (const [tier, totals] of Object.entries(raw.tiers)) if (!["diamond", "master", "platinum"].includes(tier) || !object(totals) || !validCounts(totals)) return null;
  const seen = new Set<string>();
  for (const shard of raw.shards) {
    if (!object(shard) || !["diamond", "master", "platinum"].includes(String(shard.tier)) || !characterDimension(shard.characterId)
      || typeof shard.path !== "string" || !shard.path.startsWith("/ranked/" + raw.datasetId + "/")
      || !/^\/ranked\/[a-z0-9._-]+\/[a-z0-9._-]+\.json\.gz$/i.test(shard.path) || shard.encoding !== "gzip"
      || !count(shard.bytes) || shard.bytes <= 0 || !count(shard.rows) || !hash(shard.sha256)) return null;
    const key = shard.tier + ":" + shard.characterId;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return raw as unknown as RankedManifest;
}
function validCoverage(value: unknown, games: number): value is RankedCoverage {
  if (!object(value)) return false;
  for (const group of ["stats", "action", "move"]) {
    if (!count(value[group + "PlayerGames"]) || Number(value[group + "PlayerGames"]) > games || !count(value[group + "DurationFrames"])) return false;
  }
  const measurement = (item: unknown) => object(item) && count(item.playerGames) && item.playerGames <= games && count(item.durationFrames);
  return object(value.metrics) && Object.values(value.metrics).every(measurement)
    && object(value.actions) && Object.values(value.actions).every(measurement)
    && object(value.moves) && Object.values(value.moves).every(item => object(item) && Object.values(item).every(measurement));
}
function validMetrics(value: unknown, games: number): boolean {
  if (!object(value) || value.playerBalanced !== null || !object(value.actions)) return false;
  const fields = ["durationFrames", "damageTotal", "neutralWins", "openingsPerKillSum", "openingsPerKillSamples", "damagePerOpeningSum", "damagePerOpeningSamples", "inputsPerMinuteSum", "inputsPerMinuteSamples", "lCancelSuccess", "lCancelFail", "techInPlace", "techToward", "techAway", "techMissed", "wallTechSuccess", "wallTechMissed"];
  if (!fields.every(key => finite(value[key])) || !Object.values(value.actions).every(count)) return false;
  if (value.moves === null) return true;
  if (!object(value.moves)) return false;
  return Object.entries(value.moves).every(([id, move]) => /^\d+$/.test(id) && object(move)
    && ["landed", "damage", "kills", "killPctSum", "openings", "openingDmg", "lCancelSuccess", "lCancelFail"].every(key => finite(move[key]))
    && Object.values(move).every(finite)
    && (move.attemptGames === undefined || Number(move.attemptGames) <= games)
    && (move.outcomeGames === undefined || Number(move.outcomeGames) <= games));
}
/** Schema v1 accepts full base-stat observations only. Partial move attempt and
 * outcome coverage remains explicit, while shared action/move rates can safely
 * use the full base denominator. A future partial-base export needs a new schema. */
function completeBaseCoverage(coverage: RankedCoverage, metrics: Record<string, unknown>, games: number): boolean {
  const complete = (value: RankedMeasurementCoverage | undefined) => value?.playerGames === games && value.durationFrames === metrics.durationFrames;
  return (["stats", "action", "move"] as const).every(group => coverage[`${group}PlayerGames`] === games && coverage[`${group}DurationFrames`] === metrics.durationFrames)
    && ["damageTotal", "neutralWins", "lCancel", "tech", "wallTech"].every(key => complete(coverage.metrics[key]))
    && ACTION_LABELS.every(({ key }) => complete(coverage.actions[key]))
    && ["openingsPerKill", "damagePerOpening", "inputsPerMinute"].every(key => coverage.metrics[key]?.playerGames === metrics[`${key}Samples`]);
}
export function parseRankedShard(raw: unknown, manifest: RankedManifest, tier: RankedTier, characterId: number | null): RankedShard | null {
  if (!object(raw) || !versions(raw) || raw.datasetId !== manifest.datasetId || raw.tier !== tier || raw.characterId !== characterId || !characterDimension(characterId) || !Array.isArray(raw.rows)) return null;
  const seen = new Set<string>();
  for (const row of raw.rows) {
    if (!object(row) || row.tier !== tier || row.characterId !== characterId || !characterDimension(row.opponentCharacterId) || !stageDimension(row.stageId)
      || !validCounts(row) || row.uniquePlayers !== null || !validMetrics(row.metrics, Number(row.playerGames))
      || !validCoverage(row.coverage, Number(row.playerGames)) || !isInteractionSummary(row.interactions)
      || !completeBaseCoverage(row.coverage, row.metrics as Record<string, unknown>, Number(row.playerGames))
      || row.interactions.games !== row.playerGames) return null;
    const key = row.opponentCharacterId + ":" + row.stageId;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return raw as unknown as RankedShard;
}
let manifestPromise: Promise<RankedManifest> | null = null;
const shardPromises = new Map<string, Promise<RankedBenchmarkRow[]>>();
export function fetchRankedManifest(): Promise<RankedManifest> {
  manifestPromise ??= fetch("/ranked/manifest.json", { cache: "no-cache" }).then(async response => {
    if (!response.ok) throw new Error("Ranked benchmarks are temporarily unavailable.");
    const manifest = parseRankedManifest(await response.json() as unknown);
    if (!manifest) throw new Error("Ranked benchmarks do not match this analysis version.");
    return manifest;
  }).catch((error: unknown) => { manifestPromise = null; throw error; });
  return manifestPromise;
}
export async function fetchRankedBenchmarkRows(tier: RankedTier, characterId: number | null): Promise<RankedBenchmarkRow[]> {
  const manifest = await fetchRankedManifest();
  const index = manifest.shards.find(item => item.tier === tier && item.characterId === characterId);
  if (!index) return [];
  const key = manifest.datasetId + ":" + tier + ":" + characterId;
  let promise = shardPromises.get(key);
  if (!promise) {
    promise = fetch(index.path, { cache: "force-cache" }).then(async response => {
      if (!response.ok) throw new Error("Ranked benchmark sample could not be loaded.");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== index.bytes) throw new Error("Ranked benchmark size verification failed.");
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== index.sha256) throw new Error("Ranked benchmark integrity verification failed.");
      const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      const data = parseRankedShard(JSON.parse(text) as unknown, manifest, tier, characterId);
      if (!data || data.rows.length !== index.rows) throw new Error("Ranked benchmark sample is incompatible.");
      return data.rows;
    }).catch((error: unknown) => { shardPromises.delete(key); throw error; });
    shardPromises.set(key, promise);
  }
  return promise;
}
/** Null dimensions select published aggregate cells; missing exact cells stay missing. */
export function selectRankedBenchmarkRow(rows: readonly RankedBenchmarkRow[], scope: RankedScope): RankedBenchmarkRow | null {
  return rows.find(row => row.characterId === scope.characterId && row.opponentCharacterId === scope.opponentCharacterId && row.stageId === scope.stageId) ?? null;
}
export function rankedMetricRow(row: RankedBenchmarkRow | null, family: "stats" | "action" | "move" = "stats"): BenchmarkMetricRow | null {
  if (!row || row.coverage[family + "PlayerGames" as "statsPlayerGames"] <= 0) return null;
  const groupAttemptCoverage = new Map<string, boolean>();
  const moves = row.metrics.moves === null ? null : Object.fromEntries(Object.entries(row.metrics.moves).map(([id, move]) => {
    const key = moveGroup(Number(id)).key;
    // Jab 2/3/rapid-jab landed IDs share the attempts measured on Jab 1.
    // An unmeasured member must not hide the measured group initiation count.
    groupAttemptCoverage.set(key, (groupAttemptCoverage.get(key) ?? false)
      || (move.attempts !== undefined && (row.coverage.moves[id]?.attempts?.playerGames ?? 0) > 0));
    return [id, { ...move, attempts: move.attempts ?? 0 }];
  }));
  const unavailableMoveAttempts = new Set([...groupAttemptCoverage].filter(([, measured]) => !measured).map(([key]) => key));
  return {
    character_id: row.characterId, opponent_character_id: row.opponentCharacterId, stage_id: row.stageId,
    game_count: row.coverage[family + "PlayerGames" as "statsPlayerGames"], win_rate_game_count: row.decidedPlayerGames, wins: row.wins,
    identified_player_count: null, stats_version: CURRENT_STATS_VERSION, unavailableMoveAttempts,
    metrics: { ...row.metrics, durationFrames: row.coverage[family + "DurationFrames" as "statsDurationFrames"], moves },
  };
}
export interface RankedBenchmarkState {
  characterId: number | null; manifest: RankedManifest | null;
  rows: Record<RankedTier, RankedBenchmarkRow[]>; loading: boolean; error: string | null;
}
const emptyState = (characterId: number | null): RankedBenchmarkState => ({ characterId, manifest: null, rows: { diamond: [], master: [] }, loading: true, error: null });
export function useRankedBenchmarkRows(characterId: number | null): RankedBenchmarkState {
  const [state, setState] = useState(() => emptyState(characterId));
  useEffect(() => {
    let alive = true;
    setState(emptyState(characterId));
    void fetchRankedManifest().then(manifest => { if (alive) setState(previous => ({ ...previous, manifest })); }).catch(() => {});
    void Promise.allSettled(RANKED_TIERS.map(tier => fetchRankedBenchmarkRows(tier, characterId))).then(results => {
      if (!alive) return;
      const available = (result: PromiseSettledResult<RankedBenchmarkRow[]> | undefined) => result?.status === "fulfilled" ? result.value : [];
      setState(previous => ({ ...previous, loading: false,
        rows: { diamond: available(results[0]), master: available(results[1]) },
        error: results.some(result => result.status === "rejected") ? "Some ranked comparisons could not be loaded. Reload to retry." : null,
      }));
    });
    return () => { alive = false; };
  }, [characterId]);
  return state.characterId === characterId ? state : emptyState(characterId);
}
export function useRankedBenchmarks(scope: RankedScope) {
  const state = useRankedBenchmarkRows(scope.characterId);
  return { ...state, diamond: selectRankedBenchmarkRow(state.rows.diamond, scope), master: selectRankedBenchmarkRow(state.rows.master, scope) };
}
export const rankedSampleLabel = (row: RankedBenchmarkRow | null): string => row ? row.playerGames.toLocaleString() + " player-games" : "No matching sample";
