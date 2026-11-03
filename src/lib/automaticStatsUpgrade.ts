import { interactionAnalysisAttemptKey } from "./automaticInteractionAnalysis";
import { dedupeRecords, gameKey } from "./dedupe";
import type { DiscoveredFile } from "./pool";
import { CURRENT_STATS_VERSION, hasFullStats, needsParserRepair, needsStatsRepair, type GameRecord } from "./types";

export const AUTOMATIC_STATS_BATCH_SIZE = 50;
export const statsUpgradeAttemptKey = (record: GameRecord) => JSON.stringify([interactionAnalysisAttemptKey(record), CURRENT_STATS_VERSION]);

export interface StatsUpgradeInventory {
  filesById: ReadonlyMap<string, DiscoveredFile>;
  filesByGame: ReadonlyMap<string, DiscoveredFile>;
  successfulFileIds: ReadonlySet<string>;
}

/** Retain file references and proven aliases, never replay byte buffers. Build
 * once per directory scan so a large repair does not repeatedly walk folders. */
export function createStatsUpgradeInventory(files: readonly DiscoveredFile[], cachedRecords: readonly GameRecord[]): StatsUpgradeInventory {
  const filesById = new Map(files.map(file => [file.id, file]));
  const cachedKeys = new Map<string, string | null>();
  const successfulFileIds = new Set<string>();
  for (const record of cachedRecords) {
    if (!filesById.has(record.id) || record.parseError !== undefined) continue;
    if (hasFullStats(record)) successfulFileIds.add(record.id);
    const key = gameKey(record), previous = cachedKeys.get(record.id);
    cachedKeys.set(record.id, previous === undefined || previous === key ? key : null);
  }
  const filesByGame = new Map<string, DiscoveredFile>();
  for (const [id, key] of [...cachedKeys].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (key !== null && !filesByGame.has(key)) filesByGame.set(key, filesById.get(id)!);
  }
  return { filesById, filesByGame, successfulFileIds };
}

export function needsAutomaticStatsUpgrade(record: GameRecord): boolean {
  // A newer client may have written these rows. Never downgrade after a rollback.
  return (record.statsVersion ?? 0) <= CURRENT_STATS_VERSION
    && (needsParserRepair(record) || needsStatsRepair(record));
}

/** Protect newer-client copies before compatibility-based deduplication can
 * prefer an older row. An app rollback must not schedule a local downgrade. */
export function automaticStatsUpgradeRecords(records: readonly GameRecord[]): GameRecord[] {
  const futureGames = new Set(records.filter(record => (record.statsVersion ?? 0) > CURRENT_STATS_VERSION).map(gameKey));
  return dedupeRecords([...records]).filter(record => !futureGames.has(gameKey(record)) && needsAutomaticStatsUpgrade(record));
}

/** Input is the complete saved library, not a dashboard filter. Missing
 * files are remembered separately from attempted parses, so a new inventory
 * can unblock a returned file without retrying a failed file on every scan. */
export function planAutomaticStatsUpgrade(
  records: readonly GameRecord[],
  inventory: StatsUpgradeInventory,
  attempted: ReadonlySet<string>,
  unavailable: ReadonlySet<string>,
  limit = AUTOMATIC_STATS_BATCH_SIZE,
): { targets: GameRecord[]; files: DiscoveredFile[]; missingKeys: string[] } {
  const targets: GameRecord[] = [], files: DiscoveredFile[] = [], missingKeys: string[] = [];
  if (!Number.isInteger(limit) || limit <= 0) return { targets, files, missingKeys };
  const candidates = automaticStatsUpgradeRecords(records);
  const reservedIds = new Map<string, string | null>();
  for (const record of records) {
    if (!inventory.filesById.has(record.id)) continue;
    const identity = gameKey(record), previous = reservedIds.get(record.id);
    reservedIds.set(record.id, previous === undefined || previous === identity ? identity : null);
  }
  const selectedGames = new Set<string>(), usedFiles = new Set<string>();
  for (let index = candidates.length - 1; index >= 0 && files.length < limit; index--) {
    const record = candidates[index]!;
    const key = statsUpgradeAttemptKey(record), identity = gameKey(record);
    if (attempted.has(key) || unavailable.has(key) || selectedGames.has(identity)) continue;
    selectedGames.add(identity);
    const exact = inventory.filesById.get(record.id), alias = inventory.filesByGame.get(identity);
    const file = exact ?? (alias && (!reservedIds.has(alias.id) || reservedIds.get(alias.id) === identity) ? alias : undefined);
    if (!file || usedFiles.has(file.id)) { missingKeys.push(key); continue; }
    usedFiles.add(file.id); targets.push(record); files.push(file);
  }
  return { targets, files, missingKeys };
}
