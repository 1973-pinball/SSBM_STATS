import { gameKey } from "./dedupe";
import type { DiscoveredFile } from "./pool";
import type { GameRecord } from "./types";
import { needsInteractionAnalysis, needsParserRepair } from "./types";

/** A moved/cloud copy shares an attempt with the same saved analysis version. */
export function interactionAnalysisAttemptKey(record: GameRecord): string {
  return JSON.stringify([gameKey(record), record.statsVersion ?? null]);
}

/**
 * Input is the already filtered, deduplicated personal library, oldest first.
 * Bound the visible sample before removing current/attempted records: completed
 * upgrades must not cause progressively older games to enter the parse queue.
 */
export function automaticInteractionTargets(
  chronologicalRecords: readonly GameRecord[],
  attemptedKeys: ReadonlySet<string>,
  limit = 150,
): GameRecord[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return chronologicalRecords.slice(-limit).filter(record =>
    !record.isTeams && record.players.length === 2
      && (needsInteractionAnalysis(record) || needsParserRepair(record))
      && !attemptedKeys.has(interactionAnalysisAttemptKey(record)),
  );
}

export interface MatchedInteractionAnalysisFiles {
  /** Only these file identities may have their seen markers removed/reparse. */
  files: DiscoveredFile[];
  /** Saved target IDs, including targets matched through a cached local alias. */
  matchedRequestedIds: Set<string>;
}

/**
 * Match only requested games. An exact file ID needs no alias lookup; moved
 * paths require a cached content identity. Filenames/sizes alone never prove
 * a match, and missing mappings do not expand this into a whole-library parse.
 */
export function matchInteractionAnalysisFiles(
  targets: readonly GameRecord[],
  discoveredFiles: readonly DiscoveredFile[],
  cachedRecords: readonly GameRecord[],
): MatchedInteractionAnalysisFiles {
  const filesById = new Map(discoveredFiles.map(file => [file.id, file]));
  const targetsByGame = new Map<string, GameRecord[]>();
  for (const target of targets) {
    const key = gameKey(target);
    const group = targetsByGame.get(key);
    if (group) group.push(target);
    else targetsByGame.set(key, [target]);
  }

  const selected = new Map<string, DiscoveredFile>();
  const usedFileIds = new Set<string>();
  // Reserve exact matches first so an alias cannot take another target's file.
  for (const [key, group] of targetsByGame) {
    const file = group.map(target => filesById.get(target.id))
      .find(candidate => candidate !== undefined && !usedFileIds.has(candidate.id));
    if (file) {
      selected.set(key, file);
      usedFileIds.add(file.id);
    }
  }

  // Conflicting cached identities for one file are insufficient alias evidence.
  const cachedKeysById = new Map<string, string | null>();
  for (const record of cachedRecords) {
    if (!filesById.has(record.id) || record.parseError !== undefined) continue;
    const key = gameKey(record);
    const previous = cachedKeysById.get(record.id);
    cachedKeysById.set(record.id, previous === undefined || previous === key ? key : null);
  }
  // Stable ordering makes duplicate local copies independent of directory order.
  for (const [id, key] of [...cachedKeysById].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (key === null || !targetsByGame.has(key) || selected.has(key) || usedFileIds.has(id)) continue;
    selected.set(key, filesById.get(id)!);
    usedFileIds.add(id);
  }

  const files: DiscoveredFile[] = [];
  const matchedRequestedIds = new Set<string>();
  for (const [key, group] of targetsByGame) {
    const file = selected.get(key);
    if (!file) continue;
    files.push(file);
    for (const target of group) matchedRequestedIds.add(target.id);
  }
  return { files, matchedRequestedIds };
}
