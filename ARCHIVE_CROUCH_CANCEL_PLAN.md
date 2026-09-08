# Archive Crouch-Cancel Benchmark Plan

Goal: publish a new Nikki public-archive dataset whose action rollups include `crouchCancels`, so Venue, Tournament, and Pro dotted/reference lines show real values instead of dashes.

## Preconditions

- Pull the production code containing app release `0.4.5`.
- Use Node 22 and run `npm install` if dependencies changed locally.
- Keep the local Nikki archive cache and service-role env on the laptop; raw replay files never enter the repo.

## Build

1. Rebuild the derived archive with a fresh immutable dataset id:

   ```bash
   npm run archive:build -- --data-as-of 2026-09-08 --version v8
   ```

2. Confirm the generated export contains crouch-cancel action counts:

   ```bash
   rg '"crouchCancels"' ~/.cache/SSBM_DASHBOARD_nikki_archive/public-export
   ```

3. Spot-check the manifest totals and storage size against the previous published dataset.

## Load And Publish

1. Dry-run the load:

   ```bash
   npm run archive:load -- --dry-run
   ```

2. Publish after the dry run is clean:

   ```bash
   npm run archive:load -- --publish
   ```

3. If Community comparisons should expose the new key at the same time, apply `supabase/community.sql` and run:

   ```sql
   select public.refresh_community_snapshot();
   ```

4. Verify production by opening Execution and Move Atlas, choosing `Crouch cancels`, and confirming Venue, Tournament, and Pro references render for a matchup with published samples.
