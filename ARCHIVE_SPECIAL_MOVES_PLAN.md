# Archive special-move benchmark refresh

Stats version 5 adds independently measured Neutral B (18), Side B (19), and
Up B (20) to the existing Down B (21) archive metrics. The planned immutable
revision is `nikki-2026-09-08-v10`; confirm that ID is unused before publication.
The published stats-v4/v9 export and its parse results remain unchanged.

## Measurements and compatibility

Every character has an audited initiation definition for each special direction.
Tracking is singles-only. Replay gaps, incomplete prefixes, and unsupported
character forms can leave a move's attempt coverage unavailable. A numeric zero
is measured only when the parser explicitly provides an `attempts` field.
Stats-v4 Down B measurements remain valid; stats-v4 attempt placeholders for
the other three directions are not measurements.

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
Keep `results-v4/`, `backfill-v4/`, and `public-export-v9/` intact. Write progress
notes and new reports separately.

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
  /path/to/cache/results-v5 /path/to/cache/archive-curation-v5.json

node scripts/build-nikki-public-archive.mjs \
  --results /path/to/cache/results-v5 \
  --downloads /path/to/cache/downloads \
  --curation /path/to/cache/archive-curation-v5.json \
  --source-audit /path/to/cache/source-audit-2026-10-22.json \
  --exclude-bundles ootb5 \
  --output /path/to/cache/public-export-v10 \
  --data-as-of 2026-09-08 --version v10
```

The runner defaults to separate `results-v5/` and `backfill-v5/` paths. Its state
and receipts carry stats version 5 and all four move IDs. It extracts at most one
next archive while the current bundle parses, with no more than two owned
extraction directories and eight parser workers. Originals are retained; only
its marked staging is cleaned after validation. Check state for 67 completed
bundles, no pending sources, and no orchestration failures.

## Validate before publication

```bash
node scripts/verify-archive-move-coverage.mjs

node scripts/verify-archive-special-export.mjs \
  --dir /path/to/cache/public-export-v10 \
  --results /path/to/cache/results-v5 \
  --audit /path/to/cache/source-audit-2026-10-22.json \
  --report /path/to/cache/specials-v10-verification.json

node scripts/verify-archive-specials-baseline.mjs \
  --before /path/to/cache/public-export-v9 \
  --after /path/to/cache/public-export-v10

node scripts/report-archive-special-spot-check.mjs \
  --dir /path/to/cache/public-export-v10 \
  --verification /path/to/cache/specials-v10-verification.json \
  --report /path/to/cache/specials-v10-spot-check.json
```

The baseline check compares every public side and rollup, permitting only the new
18/19/20 usage fields and stats-version change. Existing Down B and other metrics
must remain equal. The spot check uses the production selectors and formatters
for all 26 characters and four directions, including Venue, Tournament, aggregate
Pro, and representative named Pro rows. Each rate and comparison sample is also
calculated directly from that move's counters. It performs no network writes.

Inspect `qa.json` → `moveCoverage.specials`; `moveCoverage.downB` is a compatible
alias for group 21. The old Down B verifier and spot check remain available for
the immutable v9 export.

A local CEO 2024 sample has passed the v5 analyzer, curation, export privacy and
coverage checks, independent aggregation, and 324 production-selector/display
checks. All 46 replays parsed. All 92 player sides retained Down B coverage;
91 had new-direction coverage, while one transformed Zelda/Sheik side remained
unavailable. The sample contains no approved named-player games and does not
replace full Pro verification.

After all checks pass, use the established archive loader's dry run and atomic
publication flow, then check the live Atlas and Execution against the spot-check
report. Existing published revisions and Tournament Predictions remain tied to
their original dataset and content hash.
