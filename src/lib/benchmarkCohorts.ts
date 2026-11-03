/** Shared display definitions; source-specific storage and estimators stay explicit. */
export const BENCHMARK_COHORTS = {
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
    description: "Evidence-backed ranked-player appearances in conservative tournament games. Historical ranking evidence and per-metric coverage apply; this sample overlaps Tournament.",
  },
} as const;

export type BenchmarkCohortId = keyof typeof BENCHMARK_COHORTS;

export const BENCHMARK_LABELS = {
  community: BENCHMARK_COHORTS.community.label,
  tournament: BENCHMARK_COHORTS.tournament.label,
  pro: BENCHMARK_COHORTS.pro.label,
} as const;
