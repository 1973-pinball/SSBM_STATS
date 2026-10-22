import type { CommunityMoveRow } from "./community";
import { moveGroup, moveGroupTracksAttempts } from "./melee";
import type { ArchiveMoveMetrics, ArchiveRollup } from "./publicArchive";
import type { MoveMetricKey, MoveRow } from "./stats";

export function groupedArchiveMove(row: ArchiveRollup | null, moveKey: string): ArchiveMoveMetrics | null {
  let aggregate: ArchiveMoveMetrics | null = null;
  for (const [moveId, value] of Object.entries(row?.metrics.moves ?? {})) {
    if (moveGroup(Number(moveId)).key !== moveKey) continue;
    aggregate ??= {
      attempts: 0, landed: 0, damage: 0, kills: 0, killPctSum: 0,
      openings: 0, openingDmg: 0, lCancelSuccess: 0, lCancelFail: 0,
    };
    aggregate.attempts += value.attempts;
    aggregate.landed += value.landed;
    aggregate.damage += value.damage;
    aggregate.kills += value.kills;
    aggregate.killPctSum += value.killPctSum;
    aggregate.openings += value.openings;
    aggregate.openingDmg += value.openingDmg;
    aggregate.lCancelSuccess += value.lCancelSuccess;
    aggregate.lCancelFail += value.lCancelFail;
    for (const key of ["attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"] as const) {
      if (value[key] !== undefined) aggregate[key] = (aggregate[key] ?? 0) + value[key];
    }
  }
  return aggregate;
}

/** Percentages use 0–100, matching moveMetricSeriesMany's chart values. */
export function localMoveMetric(move: MoveRow | undefined, metric: MoveMetricKey, coveredGames: number): number | null {
  if (!move) return null;
  if (metric === "killsPerGame") return coveredGames > 0 ? move.kills / coveredGames : null;
  if (metric === "dmgShare" || metric === "killShare" || metric === "lCancelPct" || metric === "noHitRate") {
    const value = move[metric];
    return value === null ? null : value * 100;
  }
  return move[metric];
}

export function localMoveSample(move: MoveRow | undefined, metric: MoveMetricKey): string | undefined {
  if (move?.key !== "down-b") return undefined;
  if (metric === "attemptsPerGame") return move.attemptGames > 0 ? `${move.attemptGames.toLocaleString()} tracked games` : "Refresh replays to track attempts";
  if (metric === "noHitPerGame") return move.outcomeGames > 0 ? `${move.outcomeGames.toLocaleString()} outcome-tracked games` : "Outcome tracking unavailable";
  if (metric === "noHitRate") return move.outcomeGames > 0 ? `${(move.outcomeAttempts ?? 0).toLocaleString()} completed uses` : "Outcome tracking unavailable";
  return undefined;
}

export function archiveMoveSample(row: ArchiveRollup | null, moveKey: string, metric: MoveMetricKey): string | undefined {
  if (moveKey !== "down-b" || !row) return undefined;
  const move = groupedArchiveMove(row, moveKey);
  if (metric === "attemptsPerGame") return (move?.attemptGames ?? 0) > 0 ? `${move!.attemptGames!.toLocaleString()} tracked games` : "Archive reparse needed";
  if (metric === "noHitPerGame" || metric === "noHitRate") {
    if (!(move?.outcomeGames && move.outcomeGames > 0)) return (move?.attemptGames ?? 0) > 0 ? "Outcome tracking unavailable" : "Archive reparse needed";
    return metric === "noHitRate" ? `${((move.hitAttempts ?? 0) + (move.noHitAttempts ?? 0)).toLocaleString()} completed uses` : `${move.outcomeGames.toLocaleString()} outcome-tracked games`;
  }
  return undefined;
}

/** Highlighting must use the same capable-game sample as the displayed rate. */
export function localMoveComparisonGames(move: MoveRow, metric: MoveMetricKey, coveredGames: number): number {
  if (metric === "attemptsPerGame") return move.attemptGames;
  if (metric === "noHitPerGame" || metric === "noHitRate") return move.outcomeGames;
  return coveredGames;
}

export function archiveMoveComparisonGames(row: ArchiveRollup | null, moveKey: string, metric: MoveMetricKey): number {
  if (!row) return 0;
  const move = groupedArchiveMove(row, moveKey);
  if (moveKey === "down-b" && metric === "attemptsPerGame") return move?.attemptGames ?? 0;
  if (metric === "noHitPerGame" || metric === "noHitRate") return move?.outcomeGames ?? 0;
  return row.game_count;
}

export function archiveMoveBenchmark(row: ArchiveRollup | null, moveKey: string, metric: MoveMetricKey): number | null {
  const move = groupedArchiveMove(row, moveKey);
  if (!row || row.game_count <= 0 || !move) return null;
  if (metric === "attemptsPerGame") {
    if (moveKey === "down-b") return (move.attemptGames ?? 0) > 0 ? move.attempts / move.attemptGames! : null;
    if (!moveGroupTracksAttempts(moveKey)) return null;
    return move.attempts === 0 && move.landed > 0 ? null : move.attempts / row.game_count;
  }
  if (metric === "noHitPerGame" || metric === "noHitRate") {
    if (moveKey !== "down-b" || !(move.outcomeGames && move.outcomeGames > 0)
      || move.hitAttempts === undefined || move.noHitAttempts === undefined || move.incompleteAttempts === undefined) return null;
    const denominator = metric === "noHitPerGame" ? move.outcomeGames : move.hitAttempts + move.noHitAttempts;
    return denominator > 0 ? move.noHitAttempts / denominator * (metric === "noHitRate" ? 100 : 1) : null;
  }
  if (metric === "landedPerGame") return move.landed / row.game_count;
  if (metric === "dmgPerGame") return move.damage / row.game_count;
  if (metric === "dmgShare") return row.metrics.damageTotal > 0 ? 100 * move.damage / row.metrics.damageTotal : null;
  if (metric === "avgDmgPerHit") return move.landed > 0 ? move.damage / move.landed : null;
  if (metric === "killsPerGame") return move.kills / row.game_count;
  if (metric === "killShare") {
    const total = Object.values(row.metrics.moves ?? {}).reduce((sum, value) => sum + value.kills, 0);
    return total > 0 ? 100 * move.kills / total : null;
  }
  if (metric === "avgKillPct") return move.kills > 0 ? move.killPctSum / move.kills : null;
  const attempts = move.lCancelSuccess + move.lCancelFail;
  return attempts > 0 ? 100 * move.lCancelSuccess / attempts : null;
}

export function communityMoveBenchmark(rows: CommunityMoveRow[], moveKey: string, metric: MoveMetricKey): number | null {
  // The privacy-thresholded community feed does not publish per-use outcomes.
  if (metric === "noHitPerGame" || metric === "noHitRate") return null;
  const moves = rows.filter((row) => row.moveKey === moveKey);
  if (moves.length === 0) return null;
  const gamesByCharacter = new Map<number, number>();
  for (const row of rows) {
    gamesByCharacter.set(row.characterId, Math.max(gamesByCharacter.get(row.characterId) ?? 0, row.characterGames));
  }
  // Unpublished character/move cells are unknown, not zero. A per-game rate
  // needs the selected move for every character counted in its denominator.
  const isPerGameMetric = metric === "attemptsPerGame" || metric === "landedPerGame"
    || metric === "dmgPerGame" || metric === "killsPerGame";
  if (isPerGameMetric && new Set(moves.map((move) => move.characterId)).size < gamesByCharacter.size) return null;
  const characterGames = [...gamesByCharacter.values()].reduce((sum, games) => sum + games, 0);
  if (characterGames <= 0) return null;
  const attempts = !moveGroupTracksAttempts(moveKey) || moves.some((move) => move.attempts === null)
    ? null
    : moves.reduce((sum, move) => sum + (move.attempts ?? 0), 0);
  const landed = moves.reduce((sum, move) => sum + move.landed, 0);
  const damage = moves.reduce((sum, move) => sum + move.damage, 0);
  const kills = moves.reduce((sum, move) => sum + move.kills, 0);
  const killPctSum = moves.reduce((sum, move) => sum + move.killPctSum, 0);
  const lCancelSuccess = moves.reduce((sum, move) => sum + move.lCancelSuccess, 0);
  const lCancelFail = moves.reduce((sum, move) => sum + move.lCancelFail, 0);
  if (metric === "attemptsPerGame") return attempts === null ? null : attempts / characterGames;
  if (metric === "landedPerGame") return landed / characterGames;
  if (metric === "dmgPerGame") return damage / characterGames;
  if (metric === "dmgShare") {
    const total = rows.reduce((sum, row) => sum + row.damage, 0);
    return total > 0 ? 100 * damage / total : null;
  }
  if (metric === "avgDmgPerHit") return landed > 0 ? damage / landed : null;
  if (metric === "killsPerGame") return kills / characterGames;
  if (metric === "killShare") {
    const total = rows.reduce((sum, row) => sum + row.kills, 0);
    return total > 0 ? 100 * kills / total : null;
  }
  if (metric === "avgKillPct") return kills > 0 ? killPctSum / kills : null;
  const lCancelAttempts = lCancelSuccess + lCancelFail;
  return lCancelAttempts > 0 ? 100 * lCancelSuccess / lCancelAttempts : null;
}
