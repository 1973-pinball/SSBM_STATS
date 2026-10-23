# Archive Down B benchmark refresh

This records the completed stats-v4/v9 refresh. For the current parser and the
all-four-special rebuild workflow, use [Archive special-move benchmark refresh](ARCHIVE_SPECIAL_MOVES_PLAN.md).
The v4 commands below describe the historical run; current analyzer/build defaults
and validation require stats version 5.

Down B initiation counts require a new full replay parse. The published archive
from before stats version 4 contains numeric `attempts: 0` placeholders for
special moves. Those are not measurements and cannot be backfilled from landed
hits or damage. In those older datasets, Down B attempt and outcome comparisons
correctly remain unavailable for Venue, Tournament, and Pros.

The refreshed `nikki-2026-09-08-v9` dataset was published on October 22, 2026:
67 original bundles, 159,965 replay files, 158,884 successful parses, and 158,530
unique games, excluding only `ootb5`. All 27 named Pro players remain. Independent
reconciliation passed for 829 global and 640 matchup aggregates, and the live
Atlas and Execution rates and coverage notes matched the verified export.

The same parser supports local replay imports and the archive. Every character's
Down B can have measured initiations. Outcome counts are limited to moves whose
opponent damage can be attributed to a particular use. A completed **no-hit** use
includes shielded and defensive uses; it is not an exact whiff. Do not label the
result as a whiff percentage or infer it by subtracting landed hits from attempts.

## Source requirements

Use the reviewed source population, its downloaded bundles and extracted replay
folders, and a newly generated curation report. Raw replay bytes stay on the
source machine. Default cache locations are:

- macOS: `~/Library/Caches/SSBM_DASHBOARD_nikki_archive`
- Windows/Linux: `~/.cache/SSBM_DASHBOARD_nikki_archive`
- Override either with `NIKKI_ARCHIVE_CACHE_ROOT`.

The checked-in event, series, and verified player registries remain the identity
sources. Do not substitute personal replays or synthetic stats for archive games.
The original runbook identifies a macOS cache. On October 22, 2026, all 67 retained
original bundles were reacquired and byte-verified in the Windows cache; `ootb5`
still requires the laptop copy. The public bundle metadata links to
`https://replays.nikki.sh/`, which opens the public OneDrive
folder in a normal browser. Single-file Download works without signing in;
Copy link requests sign-in. Windows' built-in `tar` can extract these 7z bundles.

The published `nikki-2026-09-08-v8` dataset contains 68 bundles, 66,151,744,566
compressed bytes, and 161,510 replay files. The current public folder has 67 of
those bundle stems: `ootb5` (816,744,003 compressed bytes; 1,545 replay files) is
missing, while a new `supernova-2026.7z` is present. On October 22, 2026 the user
approved a new immutable revision containing **all 67 available original bundles,
excluding `ootb5` and adding no new events**. The retained original population is
65,335,000,563 compressed bytes and 159,965 replay files. Parsed, failed, duplicate,
usable-game, and named-player totals must be measured by the new run; they cannot
be copied from the previous revision. Track restoration of Out of the Blue 5 in
[GitHub issue #3](https://github.com/1973-pinball/SSBM_STATS/issues/3).

Keep the checked-in historical registries intact. The builder filters public
event and series rows to the included sources and ignores identity rules for an
explicitly omitted event. Every retained exact-game identity rule must still
match. All eleven players with Out of the Blue 5 alias evidence also have approved
evidence at other retained events, but confirm actual surviving mapped games and
the named-player directory after the complete rebuild; evidence alone is not a
guarantee that every prior player remains represented.

A local CEO 2024 sample was downloaded and verified against the published byte
count (24,379,928). Its 46 replays parse successfully with stats version 4 and
Down B attempt coverage for all 92 player sides across seven observed characters.
The local-only sample export passes curation, builder, and privacy checks;
all its published move rollups were compared with the per-game parse totals.
It has 627 measured initiations, with outcome coverage on 66 player sides
(156 hit uses and 452 completed no-hit uses). Utility-only uses remain outside
the outcome totals. There are no verified Pro identities in this sample, so it
does not validate a live Pro benchmark or replace the complete archive refresh.
The local source audit is in the cache as
`source-audit-2026-10-22.json` and contains the 68 expected public bundle rows and
their matched source filenames.

## Reparse and build

The resumable local runner can process completed downloads as they arrive:

```bash
node scripts/backfill-nikki-archive.mjs \
  --cache /path/to/cache \
  --audit /path/to/cache/source-audit-2026-10-22.json \
  --workers 8 --watch true
```

It validates source sizes, archive members, replay counts, stats versions, and
outcome totals before installing each result. One next archive extracts while
the current bundle parses, with at most two owned staging directories and eight
parser workers. Originals stay in `downloads/`;
only its marked extraction staging is removed after a successful parse. Resume
receipts bind results to the parser and immutable source-audit hashes. Keep the
audit and parser inputs unchanged during a run; save progress notes separately.
Its `backfill-v4/state.json` records completion, failures, and the active stage.

1. For each of the 67 retained original source bundles, run the current parser against its extracted
   folder. Keep results separate from the old version-3 parse:

   ```bash
   node scripts/analyze-nikki-bundle.mjs \
     --bundle ORIGINAL-BUNDLE.7z \
     --dir /path/to/extracted/ORIGINAL-BUNDLE \
     --output /path/to/cache/results-v4/ORIGINAL-BUNDLE.json \
     --workers 8
   ```

2. Successful records must have `statsVersion: 4`. Check the 159,965 retained
   replay-file count, then regenerate curation from exactly those 67 results:

   ```bash
   node scripts/curate-nikki-archive.mjs /path/to/cache/results-v4 /path/to/cache/archive-curation-v4.json
   ```

   Inspect parsed, failed, and duplicate totals. Do not mix the old full-population
   curation with this subset, omit another source, or add Supernova 2026.

3. Build a fresh immutable dataset id, retaining the source data's actual
   `data-as-of` date and choosing an unused dataset version. For the existing
   September 8 source snapshot, `v9` is the next candidate after published `v8`:

   ```bash
   npm run archive:build -- \
     --results /path/to/cache/results-v4 \
     --downloads /path/to/cache/downloads \
     --curation /path/to/cache/archive-curation-v4.json \
     --source-audit /path/to/cache/source-audit-2026-10-22.json \
     --exclude-bundles ootb5 \
     --output /path/to/cache/public-export-v9 \
     --data-as-of 2026-09-08 \
     --version v9
   ```

   The source-audit option checks that the result set is exactly the original
   68-bundle list minus `ootb5`, with unchanged per-bundle replay and compressed
   byte counts. Extra downloads do not enter the export or its byte total. The
   manifest and QA report record `sourcePopulation`; the existing dataset notes
   disclose the excluded event in the live Atlas and archive Sources panel.

   The builder also rejects old stats versions and incomplete/invalid outcome
   triples. `metrics.moves["21"].attemptGames` counts games with an explicit
   initiation measurement, including games with zero uses. `outcomeGames` counts
   games with all three outcome fields: `hitAttempts`, `noHitAttempts`, and
   `incompleteAttempts`. Outcome fields may be absent for utility/delayed moves
   even when attempts are measured. No-hit percentage uses
   `noHitAttempts / (hitAttempts + noHitAttempts)`, excluding unfinished uses.

4. Run the independent full-export verifier before publication:

   ```bash
   node scripts/verify-archive-down-b-export.mjs \
     --dir /path/to/cache/public-export-v9 \
     --results /path/to/cache/results-v4 \
     --audit /path/to/cache/source-audit-2026-10-22.json \
     --report /path/to/cache/down-b-v9-verification.json
   ```

   It checks the exact source cohort, actual retained named-player coverage,
   identity evidence, public row completeness, and every global character and
   eligible matchup comparison against independently reconstructed totals.
   Anonymous Venue games are reconstructed from the local derived parse files;
   they are intentionally absent from the public per-game export.

   Generate expected live table values with the production selectors and formatters:

   ```bash
   node scripts/report-archive-down-b-spot-check.mjs \
     --dir /path/to/cache/public-export-v9 \
     --verification /path/to/cache/down-b-v9-verification.json \
     --report /path/to/cache/down-b-v9-spot-check.json
   ```

   The report includes Venue, Tournament, and aggregate Pro rows for Fox, Falco,
   Peach, Marth, and Bowser, plus named Moky, Magi, and lloD comparisons. It checks
   the completed export fingerprint and performs no network requests or writes
   to the public database. Use its rates and coverage notes for the live UI check.

   Also run `node scripts/verify-archive-move-coverage.mjs`, inspect
   `qa.json` → `moveCoverage.downB`, and compare the manifest and privacy checks
   with the old export. Spot-check community/broad, community/conservative, and
   player/conservative rollups for several characters, including an unused
   measured move and an attempt-only utility move. Matchup-specific rollups must
   carry the same coverage schema.

## Publish and verify

Use the established archive service-role configuration on the source machine;
do not include credentials or local identity candidates in an export.

```bash
npm run archive:load -- --dir /path/to/cache/public-export-v9 --dry-run
npm run archive:load -- --dir /path/to/cache/public-export-v9 --publish
```

Publication must use the existing atomic `publish_archive_dataset` path. Verify
the new dataset is the live catalog selection, then check Move Atlas and
Execution with Venue and Pro comparisons. Compare displayed attempts/game with
`attempts / attemptGames`; compare no-hit rates with the completed-use formula
above. Confirm an old dataset's missing coverage still displays “—”.

Compare new per-player conservative counts against the prior dataset, especially
Ginger, Hungrybox, Jmook, Joshman, Krudo, Magi, moky, Ossify, Spark, Wizzrobe, and
Zain. Their Out of the Blue games must disappear; other verified events and exact
identity matches must remain. No `ootb5` tournament, bundle, game, set, or rollup
may appear under the new dataset id. The previous published revision remains
immutable and available for its existing consumers.

This archive refresh does not regenerate the bundled Tournament Predictions
research data or publish a new forecast. Existing forecasts remain tied to their
original dataset/hash. Any future forecast using this cohort must be rebuilt from
the new export; never relabel an old forecast as belonging to the new revision.
