import { hasFullStats, INTERACTION_STATS_VERSION, needsInteractionAnalysis } from "./types";
import type { ResolvedGame } from "./types";
import type { ChoiceOutcomes } from "./defensiveInteractions";
import type { EdgeguardOutcomes, RecoveryOutcomes } from "./recoveryInteractions";
import type { PunishOutcome } from "./punishContext";

export interface InteractionSummary {
  games: number;
  defenseGames: number;
  recoveryGames: number;
  punishGames: number;
  ledge: Record<string, ChoiceOutcomes>;
  oos: Record<string, ChoiceOutcomes>;
  shieldExits: Record<string, ChoiceOutcomes>;
  recoveries: Record<string, RecoveryOutcomes>;
  edgeguards: Record<string, EdgeguardOutcomes>;
  beforeOpening: Record<string, PunishOutcome>;
}

export interface InteractionAnalysisCoverage {
  needsAnalysis: number;
  unavailable: { defense: number; recovery: number; punish: number };
}

/** Separate older saved stats from recordings that cannot supply a metric after analysis. */
export function interactionAnalysisCoverage(games: readonly ResolvedGame[]): InteractionAnalysisCoverage {
  const result: InteractionAnalysisCoverage = { needsAnalysis: 0, unavailable: { defense: 0, recovery: 0, punish: 0 } };
  for (const game of games) {
    if (game.rec.isTeams || game.rec.parseError !== undefined || !hasFullStats(game.rec)) continue;
    if (needsInteractionAnalysis(game.rec)) {
      result.needsAnalysis++;
      continue;
    }
    for (const family of ["defense", "recovery", "punish"] as const) {
      if ((game.rec.statsVersion ?? 0) < INTERACTION_STATS_VERSION || !game.me[family]) result.unavailable[family]++;
    }
  }
  return result;
}

const CHOICE_FIELDS = ["attempts", "punished", "hit", "traded", "noHit", "incomplete"] as const;
const RECOVERY_FIELDS = ["attempts", "reachedLedge", "returned", "died", "incomplete"] as const;
const EDGEGUARD_FIELDS = ["opportunities", "contested", "completedContests", "stocksTaken", "opponentReturned", "uncontestedDeaths", "incomplete"] as const;
const PUNISH_FIELDS = ["openings", "damage", "kills", "incomplete"] as const;

function addRows<K extends string>(
  target: Record<string, Record<K, number>>,
  source: Partial<Record<string, Record<K, number>>>,
  fields: readonly K[],
): void {
  for (const [key, counts] of Object.entries(source)) {
    if (!counts) continue;
    const out = target[key] ??= Object.fromEntries(fields.map((field) => [field, 0])) as Record<K, number>;
    for (const field of fields) out[field] += counts[field];
  }
}

/** Aggregate only the supplied current-form window. Missing measurements never add zeros to coverage. */
export function interactionSummary(games: readonly ResolvedGame[]): InteractionSummary {
  const result: InteractionSummary = {
    games: 0, defenseGames: 0, recoveryGames: 0, punishGames: 0,
    ledge: {}, oos: {}, shieldExits: {}, recoveries: {}, edgeguards: {}, beforeOpening: {},
  };
  for (const game of games) {
    if (game.rec.isTeams || game.rec.parseError !== undefined || !hasFullStats(game.rec)) continue;
    result.games++;
    if ((game.rec.statsVersion ?? 0) < INTERACTION_STATS_VERSION) continue;
    const { defense, recovery, punish } = game.me;
    if (defense) {
      result.defenseGames++;
      addRows(result.ledge, defense.ledge, CHOICE_FIELDS);
      addRows(result.oos, defense.oos, CHOICE_FIELDS);
      addRows(result.shieldExits, defense.shieldExits, CHOICE_FIELDS);
    }
    if (recovery) {
      result.recoveryGames++;
      addRows(result.recoveries, recovery.recoveries, RECOVERY_FIELDS);
      addRows(result.edgeguards, recovery.edgeguards, EDGEGUARD_FIELDS);
    }
    if (punish) {
      result.punishGames++;
      addRows(result.beforeOpening, punish.beforeOpening, PUNISH_FIELDS);
    }
  }
  return result;
}

/** Denominators stay visible in the UI; a measured zero is distinct from no resolved opportunity. */
export function interactionRate(count: number, denominator: number): number | null {
  return denominator > 0 ? count / denominator : null;
}
