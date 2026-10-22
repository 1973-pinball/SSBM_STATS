/** Coverage carried alongside Down B totals in a derived public archive. */
export const ARCHIVE_STATS_VERSION = 4;
export const DOWN_B_OUTCOME_FIELDS = ["hitAttempts", "noHitAttempts", "incompleteAttempts"];

const count = (value) => Number.isInteger(value) && value >= 0;

export function hasDownBOutcomeCounts(move) {
  return count(move?.attempts)
    && DOWN_B_OUTCOME_FIELDS.every((field) => count(move?.[field]))
    && move.hitAttempts + move.noHitAttempts + move.incompleteAttempts === move.attempts;
}

export function assertArchiveDownBMeasurements(record, label) {
  if (record.statsVersion !== ARCHIVE_STATS_VERSION) {
    throw new Error(`${label} requires archive stats v${ARCHIVE_STATS_VERSION}; re-run analyze-nikki-bundle.mjs before exporting`);
  }
  for (const player of record.players) {
    for (const [moveId, move] of Object.entries(player.moveStats ?? {})) {
      if (moveId === "21" && move.attempts !== undefined && !count(move.attempts)) {
        throw new Error(`${label} has invalid Down B initiation counts; re-run analyze-nikki-bundle.mjs before exporting`);
      }
      if (!DOWN_B_OUTCOME_FIELDS.some((field) => move[field] !== undefined)) continue;
      if (record.isTeams || moveId !== "21" || !hasDownBOutcomeCounts(move)) {
        throw new Error(`${label} has invalid Down B outcome counts; re-run analyze-nikki-bundle.mjs before exporting`);
      }
    }
  }
}

export function addArchiveDownBOutcomes(target, move) {
  if (count(move?.attempts)) target.attemptGames = (target.attemptGames ?? 0) + 1;
  if (!hasDownBOutcomeCounts(move)) return;
  target.outcomeGames = (target.outcomeGames ?? 0) + 1;
  for (const field of DOWN_B_OUTCOME_FIELDS) {
    target[field] = (target[field] ?? 0) + move[field];
  }
}
