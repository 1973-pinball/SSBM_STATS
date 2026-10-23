# Archive special-move benchmark refresh

Stats version 6 adds independently measured Neutral B (18), Side B (19), and
Up B (20) to the existing Down B (21) archive metrics. The locally validated
immutable revision is `nikki-2026-09-08-v10`; confirm that ID is unused before publication.
The published stats-v4/v9 export and its parse results remain unchanged. Stats 6
also requires a complete, immutable finalized-frame history before counting
special attempts or outcomes; malformed prefixes must not become measured games.

## Measurements and compatibility

Every character has an audited initiation definition for each special direction.
Tracking is singles-only. Replay gaps, incomplete prefixes, and unsupported
character forms can leave a move's attempt coverage unavailable. A numeric zero
is measured only when the parser explicitly provides an `attempts` field.
Stats-v4 Down B measurements retain their schema compatibility; the v6 refresh
withdraws only replay-proven measurements from incomplete or rewritten frame
histories. Stats-v4 placeholders for the other three directions are not measurements.

Each move has its own `attemptGames` and `outcomeGames` denominator. Outcome
coverage additionally requires the complete `hitAttempts`, `noHitAttempts`, and
`incompleteAttempts` partition. Characters and directions involving unsupported
projectile, delayed, utility, grab, copy, or transformation attribution retain
attempts without claiming an outcome rate. The detector's capability table is
the source of truth for each character/direction.

- Attempts/game = attempts divided by attempt-tracked player sides.
- No-hit uses/game = no-hit uses divided by outcome-tracked player sides.
- No-hit rate = no-hit uses divided by hit plus no-hit uses.

Incomplete uses are excluded from the last denominator. No-hit includes shield
contact and defensive uses; it is not an exact whiff rate. Never derive outcomes
by subtracting landed hits from attempts. A multi-hit use can land several hits
while contributing one hit use.

## Immutable inputs and expected population

Use the 67 available original bundles already downloaded in the archive cache.
The user approved excluding the unavailable `ootb5`; the new Supernova 2026
bundle is outside the reviewed snapshot. Do not add or remove another source.
Raw replays stay local. The retained compressed inputs total 65,335,000,563 bytes
and 159,965 replay files.

`source-audit-2026-10-22.json` remains byte-for-byte immutable, with SHA-256
`8f5a891b991081a3c8dc10e1f01e122ff95f2535f16d59bec1ec5cc86b8db59a`.
Keep `results-v4/`, `backfill-v4/`, `public-export-v9/`, and the superseded
`results-v5/` and `backfill-v5/` staging evidence intact. Write progress notes and
new reports separately.

The full verifier requires the same successfully parsed and curated population:

| Measure | Expected |
| --- | ---: |
| Successfully parsed / failed files | 158,884 / 1,081 |
| Duplicate copies / unique games | 354 / 158,530 |
| Venue / conservative tournament games | 151,021 / 24,055 |
| Public named-player games / all sides in those games | 695 / 1,554 |
| Actual named players / named player sides | 27 / 817 |
| Venue singles / doubles player sides | 285,506 / 33,072 |
| Conservative singles / doubles player sides | 43,868 / 8,484 |
| Named singles / doubles player sides | 702 / 115 |

These are regression checks, not values to copy into new results. The independent
verifier reconstructs curation, identities, and all global character/matchup
special counters from the new local parse, then compares them with the export.
It also requires positive attempt coverage for all 26 singles characters and
four directions in both community populations, plus positive outcome coverage
for supported moves with at least 25 game sides. Individual unknown games remain
valid; a whole cohort with unavailable coverage fails for explicit investigation
instead of silently passing as a zero or a complete lack of measurements.

## Reparse and build

Freeze the parser before starting the full run. Backfill receipts bind each
installed result to the audit and these parser inputs: `parse.ts`,
`specialMoves.ts`, the compatible `downBSpecial.ts`, `types.ts`,
`replayMetadata.ts`, the analyzer, the archive coverage helper, and the lockfile.
Changing any of them invalidates reuse. The runner detects changes before and
after every bundle.

```bash
node scripts/backfill-nikki-archive.mjs \
  --cache /path/to/cache \
  --audit /path/to/cache/source-audit-2026-10-22.json \
  --workers 8 --watch false

node scripts/curate-nikki-archive.mjs \
  /path/to/cache/results-v6 /path/to/cache/archive-curation-v6.json

node scripts/build-nikki-public-archive.mjs \
  --results /path/to/cache/results-v6 \
  --downloads /path/to/cache/downloads \
  --curation /path/to/cache/archive-curation-v6.json \
  --source-audit /path/to/cache/source-audit-2026-10-22.json \
  --exclude-bundles ootb5 \
  --output /path/to/cache/public-export-v10 \
  --data-as-of 2026-09-08 --version v10
```

The runner defaults to separate `results-v6/` and `backfill-v6/` paths. Its state
and receipts carry stats version 6 and all four move IDs. It extracts at most one
next archive while the current bundle parses, with no more than two owned
extraction directories and eight parser workers. Originals are retained; only
its marked staging is cleaned after validation. Check state for 67 completed
bundles, no pending sources, and no orchestration failures.

## Validate before publication

```bash
node scripts/verify-archive-move-coverage.mjs

node scripts/verify-archive-completeness-corrections.mjs \
  --cache /path/to/cache \
  --diagnostics /path/to/cache/specials-v6-completeness-full-diagnoses.local.json \
  --output /path/to/cache/specials-v6-completeness-corrections.local.json

node scripts/verify-archive-special-export.mjs \
  --dir /path/to/cache/public-export-v10 \
  --results /path/to/cache/results-v6 \
  --audit /path/to/cache/source-audit-2026-10-22.json \
  --corrections /path/to/cache/specials-v6-completeness-corrections.local.json \
  --correction-rollups /path/to/cache/specials-v10-correction-rollups.local.json \
  --report /path/to/cache/specials-v10-verification.json

node scripts/verify-archive-specials-baseline.mjs \
  --before /path/to/cache/public-export-v9 \
  --after /path/to/cache/public-export-v10 \
  --corrections /path/to/cache/specials-v10-correction-rollups.local.json

node scripts/report-archive-special-spot-check.mjs \
  --dir /path/to/cache/public-export-v10 \
  --verification /path/to/cache/specials-v10-verification.json \
  --report /path/to/cache/specials-v10-spot-check.json
```

The baseline check compares every public side and rollup, permitting new
18/19/20 usage fields, the stats-version change, and exact replay-proven Down B
coverage withdrawals. The correction audit compares all bounded-parser records
against immutable v4 inputs, requires raw replay hashes and positive finalized
frame evidence for every changed side, and preserves all other derived fields.
The independent export verifier applies those exact sides through curation and
deduplication to derive each allowed rollup delta. Landed, damage, kills, public
per-game values, and all populations must remain equal; blanket Down B exceptions
are prohibited. The spot check uses the production selectors and formatters
for all 26 characters and four directions, including Venue, Tournament, aggregate
Pro, and representative named Pro rows. Each rate and comparison sample is also
calculated directly from that move's counters. All 36 observed named-player
character rows and the 15 populated aggregate Pro characters are checked against
independent raw-rollup sums, including distinct players and coverage. Supported
measurements need positive coverage in Pro cohorts with at least 25 game sides;
smaller unavailable samples are listed explicitly. It performs no network writes.

Inspect `qa.json` → `moveCoverage.specials`; `moveCoverage.downB` is a compatible
alias for group 21. The old Down B verifier and spot check remain available for
the immutable v9 export.

A local CEO 2024 sample has passed the stats6 analyzer with all 46 replays parsed.
Every prior bounded-derived field remained identical to the corrected stats5
sample except its version. All 92 player sides retain Down B coverage; 91 have
new-direction coverage, while one transformed Zelda/Sheik side remains unavailable.
The stats6 sample also passed curation, export checks, independent aggregation,
and 324 production-selector/display checks. This sample contains no approved
named-player games and does not replace full Pro verification.

The earlier move definitions passed a frame-level coverage audit of 382 real singles
games across 24 characters, with no unexplained gaps. Young Link's bow starts at
animation counter 1.33, unlike the usual 1.0; the detector handles that specific
startup speed. Fox/Falco Side B outcomes were checked against 41 modern replay
damage frames and the afterimage's owner-state lifetime. Sheik Up B and Peach
Side B expose attempts only because their explosions can persist independently
of the fighter's activation. Synthetic tests cover all 26 characters, including
the characters absent from that real-replay sample.

The stats5 full run stopped at its source-change guard after a malformed replay
revealed incomplete finalized history. It was never published. The full stats6
reparse completed all 67 bundles under frozen parser fingerprint
`cc6083652ac2bf22c3ac0eb7e2219e28215bb5721858c433963c19181751951e`;
only matching receipts are eligible for the next immutable export. The final
raw PRE/POST guard has passed the CEO sample with identical positive coverage.
The cumulative raw audit covers 240 source replays with bounded/retained
special-usage agreement throughout. The exact full-corpus comparison identifies
209 replays / 357 sides whose prior Down B usage is withdrawn. Every withdrawal
has original replay hashes and positive terminal/rewrite evidence; no prior
non-usage metric changes. Of those sides, 215 survive the existing curation and
deduplication rules and affect 406 rollups. No named public per-game record changes.

Local validation completed on 2026-10-23 at 12:39 UTC. The export content hash is
`d762c8f1a66b276cf2a7d941ef450bdf5f25e8fc43f67b1811492b9205fce65a`.
All 159,965 source files retain the original 158,884 parsed / 1,081 failed totals;
the 158,530 unique games include 151,021 broad Venue and 24,055 conservative games.
The 27 named players and their 817 mapped sides remain unchanged. Independent
aggregation passed 829 global and 640 matchup checks; the baseline reconciled all
1,554 public sides and 49,193 rollups. All 324 display checks and the loader dry run
passed. Independent source sums matched 52 community selectors, all 36 named
player-character selectors, and all 26 aggregate Pro character selectors. The 15
populated Pro characters retain positive supported coverage; no sparse missing
coverage was reported. Readiness and exact evidence remain local in
`specials-v10-readiness.json`, `specials-v10-verification.json`,
`specials-v10-baseline.json`, and `specials-v10-spot-check.json`.

The reviewed dataset was atomically published on 2026-10-23 at 12:41 UTC.
The published row's content hash matches the export above, and the site selects
v10 as its latest archive. Live Execution checks matched Fox attempts, no-hit
uses per game, and no-hit rates for Venue, Tournament, and aggregate Pro; changing
the opponent filter selected the corresponding matchup sample. Live Move Atlas
checks matched Fox and Marth values and Moky's named-player comparisons, including
tracked-game and completed-use denominators. Fox Neutral B and Marth Down B
correctly display unavailable hit outcomes. Browser verification used synthetic
demo data only for the personal column; archive comparisons were the live data.

The expanded audit also identified same-frame Link Neutral B ground-to-air and
Yoshi Side B landing startup variants. The final stats6 detector supports both:
the reviewed Link replay reports three bow attempts, and the Yoshi replay reports
two Side B attempts with two no-hit outcomes. These are no longer coverage
exclusions. Exact replay names remain in local QA evidence.
Three separately reviewed Neutral B air-to-ground startup cases in the full
corpus first appear above the native startup bound: one Young Link side at
animation counter 2.33 and two Link sides at counter 2. The frozen detector
conservatively leaves those sides' Neutral B usage unavailable; each exact
exclusion is bound to its original replay hash and parser fingerprint in local
QA. Their other three directions remain measured. No zero or numeric attempt
count is inferred for the excluded direction; support for this startup variant
is tracked in [issue #4](https://github.com/1973-pinball/SSBM_STATS/issues/4).
The full-cohort positive-coverage checks remain required; these benchmarks describe
measured samples, not complete coverage of every replay side.

Source-data exclusions are tracked separately. Reviewed replays with missing
opponent post-frame evidence can retain complete own-side attempt measurements
while lacking reliable damage attribution. Their attempt denominator remains
measured, but their outcome denominator and hit/no-hit counters stay unavailable.
This includes zero-use games; missing evidence is not replaced with an inferred
zero outcome partition.

After all checks pass, use the established archive loader's dry run and atomic
publication flow, then check the live Atlas and Execution against the spot-check
report. Existing published revisions and Tournament Predictions remain tied to
their original dataset and content hash.
