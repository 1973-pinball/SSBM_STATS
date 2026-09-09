# Archive Crouch-Cancel Benchmark Plan

Goal: publish a new Nikki public-archive dataset whose action rollups include `crouchCancels`, so Venue, Tournament, and Pro dotted/reference lines show real values instead of dashes.

## Preconditions

- Pull app release `0.4.6` or later; it contains the stats-version and
  publication safeguards required by this runbook.
- Use Node 22 and run `npm install` if dependencies changed locally.
- Keep the local Nikki archive cache and service-role env on the laptop; raw replay files never enter the repo.

## Build

1. Re-parse every source bundle with `scripts/analyze-nikki-bundle.mjs`. Results
   produced before archive stats version 3 do not contain crouch-cancel counts and
   must not be reused. Keep the new results in a separate directory until their
   replay, parsed, and failure totals match the previous complete run.

   The archive builder rejects a result unless every successful record reports
   the current stats version and a non-negative integer `actions.crouchCancels`.
   This prevents an old result from silently becoming a zero-valued benchmark.

2. Rebuild the derived archive with a fresh immutable dataset id, explicitly
   pointing it at the newly parsed result directory:

   ```bash
   npm run archive:build -- \
     --results ~/Library/Caches/SSBM_DASHBOARD_nikki_archive/results-v3 \
     --output ~/Library/Caches/SSBM_DASHBOARD_nikki_archive/public-export \
     --data-as-of 2026-09-08 \
     --version v8
   ```

3. Confirm the generated export contains crouch-cancel action counts:

   ```bash
   rg '"crouchCancels"' ~/Library/Caches/SSBM_DASHBOARD_nikki_archive/public-export
   ```

4. Spot-check the manifest totals, parser failures, duplicate count, and table
   counts against the previous published dataset. Confirm Venue (`community` /
   `broad`), Tournament (`community` / `conservative`), and Pro (`player` /
   `conservative`) rollups all contain nonzero crouch-cancel totals.

## Load And Publish

1. Dry-run the load:

   ```bash
   npm run archive:load -- --dry-run
   ```

2. Publish after the dry run is clean:

   ```bash
   npm run archive:load -- --publish
   ```

   `publish_archive_dataset` has a 60-second function-local statement timeout so
   the atomic publication of the rollup table is not cut off by the service-role
   default. If publication fails, confirm the dataset remains unpublished before
   retrying; never flip the dataset row independently of its child tables.

3. If Community comparisons should expose the new key at the same time, apply `supabase/community.sql` and run:

   ```sql
   select public.refresh_community_snapshot();
   ```

4. Verify production by opening Execution and Move Atlas, choosing `Crouch cancels`, and confirming Venue, Tournament, and Pro references render for a matchup with published samples.
