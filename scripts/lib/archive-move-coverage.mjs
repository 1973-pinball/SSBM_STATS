/** Per-move measured coverage in derived public archives. */
export const ARCHIVE_STATS_VERSION = 5;
export const ARCHIVE_SPECIAL_MOVE_IDS = [18, 19, 20, 21];
export const SPECIAL_OUTCOME_FIELDS = ["hitAttempts", "noHitAttempts", "incompleteAttempts"];
export const DOWN_B_OUTCOME_FIELDS = SPECIAL_OUTCOME_FIELDS;

const count = (value) => Number.isSafeInteger(value) && value >= 0;
export const hasSpecialAttemptSchema = (moveId, statsVersion) => Number(moveId) === 21
  ? statsVersion >= 4 : [18, 19, 20].includes(Number(moveId)) && statsVersion >= 5;

export function hasSpecialOutcomeCounts(move) {
  return count(move?.attempts)
    && SPECIAL_OUTCOME_FIELDS.every((field) => count(move?.[field]))
    && move.hitAttempts + move.noHitAttempts + move.incompleteAttempts === move.attempts;
}

function validateMeasurements(record, label, moveIds, version) {
  if (record.statsVersion !== version) {
    throw new Error(`${label} requires archive stats v${version}; re-run analyze-nikki-bundle.mjs before exporting`);
  }
  const singles = !record.isTeams && record.players.length === 2;
  for (const player of record.players) {
    for (const [moveId, move] of Object.entries(player.moveStats ?? {})) {
      const special = moveIds.includes(Number(moveId));
      if (special && move.attempts !== undefined && (!singles || !count(move.attempts))) {
        throw new Error(`${label} has invalid special-move initiation counts for move ${moveId}`);
      }
      if (!SPECIAL_OUTCOME_FIELDS.some((field) => move[field] !== undefined)) continue;
      if (!singles || !special || !hasSpecialOutcomeCounts(move)) {
        throw new Error(`${label} has invalid special-move outcome counts for move ${moveId}`);
      }
    }
  }
}

export function assertArchiveSpecialMeasurements(record, label) {
  validateMeasurements(record, label, ARCHIVE_SPECIAL_MOVE_IDS, ARCHIVE_STATS_VERSION);
}

export function addArchiveSpecialOutcomes(target, move, moveId, statsVersion) {
  // Version and explicit counts are both required: v4's other special zeros
  // were placeholders, while its measured Down B counts remain valid.
  if (!hasSpecialAttemptSchema(moveId, statsVersion)) return;
  if (count(move?.attempts)) target.attemptGames = (target.attemptGames ?? 0) + 1;
  if (!hasSpecialOutcomeCounts(move)) return;
  target.outcomeGames = (target.outcomeGames ?? 0) + 1;
  for (const field of SPECIAL_OUTCOME_FIELDS) {
    target[field] = (target[field] ?? 0) + move[field];
  }
}

// Retained for tools that explicitly inspect the immutable stats-v4 archive.
export const hasDownBOutcomeCounts = hasSpecialOutcomeCounts;
export function assertArchiveDownBMeasurements(record, label) {
  validateMeasurements(record, label, [21], 4);
}
export function addArchiveDownBOutcomes(target, move) {
  addArchiveSpecialOutcomes(target, move, 21, 4);
}
