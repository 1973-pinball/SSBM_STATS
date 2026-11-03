# Benchmark baseline roadmap

Updated 2026-11-03. Tournament consolidation and the main Pro rebuild are
implemented and verified. The v11 archive was published on 2026-11-03 after
the additive schema migration; v10 remains available as an immutable revision. A bounded ranked pilot is implemented and
audited; full ingestion awaits its parser and source-evidence gates. The goal is one consistent set
of comparisons across Community, Execution, Move/Matchup/Stage Atlas,
Interactions, and Insights. See the [release guide](benchmark-baselines-release.md)
for reproducible rebuilds, validation, and the database prerequisite.

## Comparison groups

| Display name | Membership | First release |
| --- | --- | --- |
| Diamond Slippi | Player sides labelled Diamond in the audited ranked source | After ranked pilot passes |
| Master Slippi | Player sides labelled Master in the audited ranked source | After ranked pilot passes |
| Platinum Slippi | Player sides labelled Platinum in the same source | Supported additional tier |
| SSBMStats Community | Existing consenting users and publishable aggregate cells | Preserve existing consent and thresholds |
| Tournament | Deduplicated union of the existing Venue and Tournament populations | Implemented; former broad sample for full archive, union for sampled interactions |
| Pro Tournament | Evidence-backed named-player sides in conservative tournament games | Reconciled and published as v11 |

The ranked labels describe a historical source sample. Do not imply current
rank, a particular season, divisions, or a separate Grandmaster population
unless the release evidence establishes them. Pro Tournament may overlap
Tournament; the columns must not be added together.

Tournament includes eligible event-venue recordings without set-level proof.
Keep the existing exclusions for known non-tournament sources and labelled
friendlies. Describe this scope in the source detail, rather than suggesting
every included game was a verified bracket game.

## Ranked replay source

The candidate is Fizzi's anonymized Slippi ranked collections, credited by
[Slippi-AI](https://github.com/vladfi1/slippi-ai#acknowledgements).
[HAL's raw replay list](https://github.com/ericyuegu/hal#raw-replays) links six
original dumps whose filenames total 850,155 replays. These are source counts,
not an audited count of unique, usable dashboard games.

A convenient mirror is
[erickfm/melee-ranked-replays](https://huggingface.co/datasets/erickfm/melee-ranked-replays).
It distributes raw replays by character and rank pair, including Platinum,
Diamond, and Master. The same game can appear in both characters' folders;
rank pairs in filenames are sorted and cannot establish player-port order.
Record the upstream release terms and attribution; the mirror is labelled MIT
by its redistributor. Inventory actual files and pin a revision before selecting
downloads. The original roadmap entry has not been recovered; these links are
the verified starting point for the new source audit.

[HAL's replay indexer](https://raw.githubusercontent.com/ericyuegu/hal/main/hal/data/index.py)
documents empty metadata in anonymized recordings and recovery of frame counts
from frames. Its data pipeline retains per-player game-start labels. The pilot
must verify those labels, date availability, and terminal-frame evidence against
our parser. It must not weaken existing completeness guards simply to increase
measured counts. Missing dates and repeated anonymous labels also mean the
normal timestamp/player-based game identity cannot be assumed safe.

Use raw replays for this work. A processed machine-learning corpus may filter
gameplay or omit inputs needed for dashboard metrics. No claim of player-balanced
averages or unique-player counts is possible from repeated anonymous tier labels.

## Expand Pro Tournament from Nikki

The existing source is [Nikki's public archive](https://replays.nikki.sh/).
The local cache already contains all 67 retained compressed bundles, totaling
65,335,000,563 bytes, and 67 stats-v6 result files. A complete redownload is not
needed to reuse that population. Check hashes and receipts before rebuilding;
download missing, changed, or newly selected bundles only after a fresh inventory.

The rebuilt main archive now reconciles with the interaction cohort:

| Pipeline | Mapped players | Singles player-games |
| --- | ---: | ---: |
| Published main archive v10 | 27 | 702 |
| Published main archive v11 | 98 | 1,883 |
| Shipped interaction reference | 98 | 1,883 |

The interaction reference covers 1,338 distinct Pro games and includes reviewed
supplemental identity evidence at GENESIS X3, GENESIS X2, Battle of BC 8, and
Full Bloom 2025. Its 1,883 appearances are cohort membership; individual metrics
can have fewer measured appearances. See
[the interaction source report](interaction-benchmark-sample.md).

The local evidence union has 1,181 additional player sides, no duplicate sides
or identity conflicts, and all 1,181 sides already have stats-v6 records and move
data in the cache. Rebuilding membership and aggregates can therefore reach
1,883 named singles appearances without redownloading or reparsing this corpus.
That is not a promise that every metric will have 1,883 measured games.
Reconcile the existing `nikki-player-overrides.json` and
`interaction-pro-overrides.json` through one
shared resolver. Preserve event scope, exact normalized aliases, explicit
game/slot/character mappings, conflicting-identity rejection, ranking evidence,
and probable versus verified confidence. Do not promote venue games to bracket
games merely because a familiar name appears. Supplemental rules apply only
to the already-conservative singles population reviewed for interactions; do
not extend them to doubles. Public game keys contain the dataset revision, so
resolve evidence using stable raw game identity and player slots before
generating the new revision's public keys.

The rebuild retains the existing eligibility definition: supplemental mappings
require historical/current global Top 100 evidence, while the legacy directory
also includes the regional-ranked Ampp mapping. The implemented migration retains
the existing published membership, exposes its ranking basis, and keeps the global
Top 100 rule for new supplemental aliases. A strict global-only Pro policy would
be a separate, documented membership change: 97 players and 1,878 singles
player-games, with Ampp still available as a named comparison.

For baseline stats, rebuild from the compatible cached parse results first.
Reparse only for changed detectors, incompatible measurements, or new source
files; identity additions alone do not require reading every frame again.
Keep the full archive and the interaction sample's source/metric versions explicit.
Publish a new immutable revision after validation; leave v10 intact.

Further growth is separate from this first expansion: audit Nikki's current
listing, review new event bundles, resolve more aliases with public event/results
evidence, and match anonymous stream sets using exact replay/set evidence where
possible. Restore Out of the Blue 5 through
[issue 3](https://github.com/1973-pinball/SSBM_STATS/issues/3) when its source is
available. The existing audit records Supernova 2026 as outside the frozen
population; its inclusion requires a new source inventory. Current remote
availability and the gain from new events remain to be measured.

## Implementation work

### 1 Establish a common cohort contract

- [ ] Define source-independent cohort IDs, labels, snapshot/parser versions,
  tier or identity evidence, supported filters, estimator, and metric coverage.
  Keep ranked source storage separate from the archive's `broad|conservative`
  population enum and private community tables.
- [x] Standardize comparable ratios as pooled numerator/denominator rates and
  per-game measures as totals over measured player-games where the source
  provides those counters. Preserve explicitly labelled Community medians and
  other existing distributions separately; do not relabel them as pooled means.
- [ ] Show source, historical date/season status, matching player-games, measured
  opportunities, and distinct players only when the source can establish them.
  Unsupported metrics remain unavailable, not zero or a broader-filter fallback.

Primary surfaces: `src/lib/publicArchive.ts`, `src/lib/community.ts`,
`src/lib/interactionBenchmarks.ts`, and a new shared cohort adapter/registry.

### 2 Expand the main Pro archive and consolidate Tournament

- [x] Share and reconcile the two identity registries; produce an independent
  per-player/event/character membership diff and duplicate/conflict report.
- [x] Rebuild main Pro rollups and public player availability from cached inputs,
  retaining measured-game coverage for moves and execution metrics.
- [x] Aggregate pooled Pro matchup/stage cells before applying sparse-cell
  publication rules. Summing already-suppressed individual-player cells can
  discard contributions that would form a usable pooled Pro sample.
- [x] For full archive metrics, use the existing broad population as Tournament:
  conservative Tournament is already a subset. Never add the two rollups.
- [x] For interactions, union the independently selected Venue and Tournament
  games before aggregating, using unique game/slot membership. Their sampled
  sets overlap but are not nested. Rebuild from local receipts; the published
  aggregate JSON cannot recover overlap.
- [x] Update the cohort codec/version and independent receipt verifier as needed;
  pin manifests and preserve reproducible source selection.

Primary surfaces: `scripts/build-nikki-public-archive.mjs`,
`scripts/lib/interaction-pro-evidence.mjs`,
`scripts/build-interaction-benchmarks.mjs`,
`src/lib/interactionBenchmarkCodec.mjs`, archive exports, and their verifiers.

### 3 Run a bounded ranked pilot

The [reproducible pilot and coverage report](ranked-source-pilot.md) audits four
pinned shards totaling 13.7 MB: 13 unique games, 15 Master sides and 11 Diamond
sides. All dates and rank timing remain unknown. Four games fail bounded versus
retained parser parity; nine games pass the provisional gate. No ranked rows
were published. The sample lacks real dittos and duplicate character-shard
copies, so the following unchecked gates remain required.

- [ ] Audit a small source sample spanning same-tier and mixed-tier matches,
  multiple characters, dittos, missing metadata, and incomplete recordings.
- [x] Resolve tier per actual player slot. Master versus Diamond contributes
  one Master side and one Diamond side. Keep unknown or conflicting tiers out.
- [ ] Deduplicate by replay content and a validated game identity across source
  archives and character shards. Verify that anonymous names do not merge
  unrelated matches or manufacture unique-player counts.
- [ ] Verify character-ID conversion, terminal/rollback handling, metric parity,
  and coverage with the dashboard parser. Do not copy external ML filters that
  discard deaths or recoveries relevant to these benchmarks.
- [x] Record rank timing as unknown unless the source establishes game-time or
  export-time rank. Preserve unavailable dates rather than substituting a
  download timestamp. Report bytes/game, extraction space, throughput, and
  eligible counts before estimating a full run.

Deliverable: a source manifest, reproducible ingestion prototype, coverage
matrix, and a measured storage/runtime estimate. This gate determines whether
the first ranked release can support only baseline stats or interactions too.

### 4 Publish ranked aggregates and integrate comparisons

- [ ] Build resumable, versioned tier aggregates for character, opponent, and
  stage dimensions using only supported measurements. Publish derived counters;
  retain raw replays and working identity data locally.
- [ ] Select storage after the pilot: existing archive-style paginated aggregate
  tables are a candidate; avoid shipping the raw corpus or a huge app JSON.
- [ ] Apply the same labels and cohort selection to Community, Execution,
  Move/Matchup/Stage Atlas, Interactions, chart reference lines, and Insights.
  Include comparison highlighting and coach recommendations, which currently
  prefer conservative Tournament and fall back to Venue.
- [ ] Preserve Community's existing 25-contributor/100-player-game publication
  thresholds. Community interactions, wall-tech rates, and special outcome
  triples require separate aggregate/schema work if full parity is wanted;
  they do not appear automatically through this consolidation.
- [ ] Update the Metrics Guide, README, source disclosures, sample labels, and
  stale-data/error behavior. Ranked benchmarks are a historical recording sample,
  not skill percentiles or an estimate of all current ladder players.

Primary UI surfaces: `Community.tsx`, `ArchiveCommunityBenchmark.tsx`,
`CommunityArchiveAtlas.tsx`, `Views.tsx`, `Interactions.tsx`, `Insights.tsx`,
`src/lib/coach.ts`, and `scripts/lib/metrics-data.mjs`.

## Acceptance and release order

- [x] Main Tournament counts equal the old broad counts; sampled interaction
  Tournament equals an independently reconstructed union of player sides.
- [x] Shared Pro membership reconciles against both old pipelines. Explain every
  added/removed side, preserve confidence, and verify per-metric denominators.
  Under retained eligibility, expect 98 players, 1,338 singles games and 1,883
  singles sides; all-format named totals are 1,420 games and 1,998 sides. The
  115 doubles sides and overall Venue/Tournament populations remain unchanged.
- [ ] Mixed-tier assignment, duplicate shards, anonymous identities, missing
  dates, incomplete frames, exact filters, and unavailable-versus-zero all have
  focused checks using real source evidence and appropriate regression fixtures.
- [ ] Run benchmark filter, Atlas selection, interaction codec/receipt and archive
  export checks; run Community checks if its schema changes; pass the production
  build and inspect the final tables/charts before publication.

The shared labels and current-cohort adapters are implemented. The full ranked
source contract remains open until the pilot establishes rank timing, identity,
dates, and measurement coverage. The interaction artifact is schema 2 / encoding
3: Tournament contains 10,098 games and 20,196 sides after removing 869 games
shared by the old draws. All Pro counters and all cached parse results are
unchanged. Main v11 adds 365 pooled Pro cells while preserving all 48,030 field
rollups. Local build, lint, benchmark, move, interaction, and independent source
receipt checks pass. Main archive v11 is published; the site changes deploy through
[PR 10](https://github.com/1973-pinball/SSBM_STATS/pull/10).

Remaining order: finish the protected-branch site rollout, then resolve the
ranked pilot's missing-end and heavy-rollback parity
failures and extend its ditto/duplicate coverage; then choose the ranked storage
and ingestion scope from measured coverage. Bulk ranked download and current-rank
claims are not implied by the pilot.
