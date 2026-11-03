import type { ArchiveRollup } from "./publicArchive";

/** Shared display definitions; source-specific storage and estimators stay explicit. */
export const BENCHMARK_COHORTS = {
  diamond: {
    label: "Diamond Slippi",
    description: "Historical anonymized ranked recordings labelled Diamond in the source. Rank timing, season, dates, and unique players are unknown.",
  },
  master: {
    label: "Master Slippi",
    description: "Historical anonymized ranked recordings labelled Master in the source. Rank timing, season, dates, and unique players are unknown.",
  },
  community: {
    label: "SSBMStats Community",
    description: "Opt-in player contributions with publication thresholds. Headline medians and pooled rates are labelled separately.",
  },
  tournament: {
    label: "Tournament",
    description: "Eligible tournament-venue recordings, including games without verified bracket-set identity. The former Venue and Tournament samples are combined without counting a player-game twice.",
  },
  pro: {
    label: "Pro Tournament",
    description: "Appearances by identified players with ranking evidence in conservative tournament games. Historical ranking evidence and per-metric coverage apply; this sample overlaps Tournament.",
  },
} as const;

export type BenchmarkCohortId = keyof typeof BENCHMARK_COHORTS;

export const BENCHMARK_LABELS = {
  diamond: BENCHMARK_COHORTS.diamond.label,
  master: BENCHMARK_COHORTS.master.label,
  community: BENCHMARK_COHORTS.community.label,
  tournament: BENCHMARK_COHORTS.tournament.label,
  pro: BENCHMARK_COHORTS.pro.label,
} as const;

/** Counter view shared by formatters, without inventing archive membership. */
export type BenchmarkMetricRow = Pick<ArchiveRollup,
  "character_id" | "opponent_character_id" | "stage_id" | "game_count" |
  "win_rate_game_count" | "wins" | "identified_player_count" | "stats_version" | "metrics"> & {
  unavailableMoveAttempts?: ReadonlySet<string>;
};

export const RANKED_SOURCE_DESCRIPTION = "Diamond Slippi and Master Slippi are historical source-labelled recordings from a selected convenience sample. Rank timing, season, replay dates, and unique-player counts are unknown. Comparisons use measured player-games and opportunity counts; they are not player-balanced averages, current ladder statistics, or skill percentiles.";
