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
  }
  return aggregate;
}

/** Percentages use 0–100, matching moveMetricSeriesMany's chart values. */
export function localMoveMetric(move: MoveRow | undefined, metric: MoveMetricKey, coveredGames: number): number | null {
  if (!move) return null;
  if (metric === "killsPerGame") return coveredGames > 0 ? move.kills / coveredGames : null;
  if (metric === "dmgShare" || metric === "killShare" || metric === "lCancelPct") {
    const value = move[metric];
    return value === null ? null : value * 100;
  }
  return move[metric];
}

export function archiveMoveBenchmark(row: ArchiveRollup | null, moveKey: string, metric: MoveMetricKey): number | null {
  const move = groupedArchiveMove(row, moveKey);
  if (!row || row.game_count <= 0 || !move) return null;
  if (metric === "attemptsPerGame") {
    if (!moveGroupTracksAttempts(moveKey)) return null;
    return move.attempts === 0 && move.landed > 0 ? null : move.attempts / row.game_count;
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
