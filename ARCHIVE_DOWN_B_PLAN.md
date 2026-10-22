# Archive Down B benchmark refresh

Down B initiation counts require a new full replay parse. The published archive
from before stats version 4 contains numeric `attempts: 0` placeholders for
special moves. Those are not measurements and cannot be backfilled from landed
hits or damage. Until a refreshed dataset is published, Down B attempt and
outcome comparisons correctly remain unavailable for Venue, Tournament, and Pros.

The same parser supports local replay imports and the archive. Every character's
Down B can have measured initiations. Outcome counts are limited to moves whose
opponent damage can be attributed to a particular use. A completed **no-hit** use
includes shielded and defensive uses; it is not an exact whiff. Do not label the
result as a whiff percentage or infer it by subtracting landed hits from attempts.

## Source requirements

Use the complete original Nikki archive cache, including downloaded bundles,
extracted replay folders, and the previous curation report. Raw replay bytes stay
on the source machine. Default cache locations are:

- macOS: `~/Library/Caches/SSBM_DASHBOARD_nikki_archive`
- Windows/Linux: `~/.cache/SSBM_DASHBOARD_nikki_archive`
- Override either with `NIKKI_ARCHIVE_CACHE_ROOT`.

The checked-in event, series, and verified player registries remain the identity
sources. Do not substitute personal replays or synthetic stats for archive games.
The complete cache is not present on the Windows development machine as of
October 22, 2026. The original runbook identifies a macOS cache. The public bundle
metadata links to `https://replays.nikki.sh/`, which opens the public OneDrive
folder in a normal browser. Single-file Download works without signing in;
Copy link requests sign-in. Windows' built-in `tar` can extract these 7z bundles.

The published `nikki-2026-09-08-v8` dataset contains 68 bundles, 66,151,744,566
compressed bytes, and 161,510 replay files. The current public folder has 67 of
those bundle stems: `ootb5` (816,744,003 compressed bytes; 1,545 replay files) is
missing, while a new `supernova-2026.7z` is present. Exact backfill requires the
missing original bundle. Adding/removing source events requires a reviewed new
curation population, updated registries, and honest dataset provenance.

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

1. For each original source bundle, run the current parser against its extracted
   folder. Keep results separate from the old version-3 parse:

   ```bash
   node scripts/analyze-nikki-bundle.mjs \
     --bundle ORIGINAL-BUNDLE.7z \
     --dir /path/to/extracted/ORIGINAL-BUNDLE \
     --output /path/to/cache/results-v4/ORIGINAL-BUNDLE.json \
     --workers 8
   ```

2. Verify replay, parsed, failed, and duplicate totals against the prior complete
   run. Successful records must have `statsVersion: 4`. Do not silently omit an
   unavailable bundle. If the source population changes, regenerate and review
   curation with `scripts/curate-nikki-archive.mjs` before building.

3. Build a fresh immutable dataset id, retaining the source data's actual
   `data-as-of` date and choosing an unused dataset version. For the existing
   September 8 source snapshot, `v9` is the next candidate after published `v8`:

   ```bash
   npm run archive:build -- \
     --results /path/to/cache/results-v4 \
     --downloads /path/to/cache/downloads \
     --curation /path/to/cache/archive-curation.json \
     --output /path/to/cache/public-export-v9 \
     --data-as-of 2026-09-08 \
     --version v9
   ```

   The builder rejects old stats versions and incomplete/invalid outcome
   triples. `metrics.moves["21"].attemptGames` counts games with an explicit
   initiation measurement, including games with zero uses. `outcomeGames` counts
   games with all three outcome fields: `hitAttempts`, `noHitAttempts`, and
   `incompleteAttempts`. Outcome fields may be absent for utility/delayed moves
   even when attempts are measured. No-hit percentage uses
   `noHitAttempts / (hitAttempts + noHitAttempts)`, excluding unfinished uses.

4. Run `node scripts/verify-archive-move-coverage.mjs`, inspect
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
