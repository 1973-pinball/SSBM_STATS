# Benchmark baseline rebuild and release

## Status and results

As of 2026-11-03, the implementation and local verification are complete for
Tournament consolidation and Pro identity expansion. Main archive v11 is staged
locally; v10 is still the published main revision. Database publication and the
site release are separate operations. The new UI remains compatible with v10.

| Measure | Published v10 | Staged v11 |
| --- | ---: | ---: |
| Unique parsed games | 158,530 | 158,530 |
| Tournament eligible games (former broad population) | 151,021 | 151,021 |
| Conservative games | 24,055 | 24,055 |
| Mapped players | 27 | 98 |
| Pro singles player-games | 702 | 1,883 |
| Pro doubles player-games | 115 | 115 |

The v11 Pro singles sample contains 1,338 distinct games. All formats contain
1,420 named games and 1,998 named sides. A player-game is one player side, not a
distinct game. Filtered tables can show smaller counts, and win-rate headers
count decided results in the displayed cells. Measurements with incomplete
coverage use their own denominators.

The build reuses all 67 retained bundles and stats-v6 results. The shared identity
resolver adds 1,181 reviewed sides, with no side overlap or identity conflicts.
Existing Ampp membership retains its regional-ranking evidence; supplemental
aliases require historical/current global Top 100 evidence and conservative
singles membership. Exact event, alias, slot, and character evidence remain
required. All 48,030 non-Pro field rollups are unchanged.

The 365 new `scope=pro` rollups pool eligible sides before sparse-cell suppression.
The client checks a whole-format Pro marker before using them; absent cells stay
unavailable. Only older revisions without the marker use the legacy per-player
aggregation. All-character Pro cells include move metrics and exact distinct
player counts. Rollup `game_count` counts player sides, as in the existing API.

## Rebuild from the existing local cache

Run from the repository root with Node 22. The cache is outside Git and contains
raw inputs and private working evidence; do not commit or upload it. On Windows:

```powershell
$archiveCache = Join-Path $env:USERPROFILE '.cache/SSBM_DASHBOARD_nikki_archive'
node scripts/build-nikki-public-archive.mjs --results "$archiveCache/results-v6" --downloads "$archiveCache/downloads" --curation "$archiveCache/archive-curation-v6.json" --source-audit "$archiveCache/source-audit-2026-10-22.json" --exclude-bundles ootb5 --supplemental-identities scripts/data/interaction-pro-overrides.json --data-as-of 2026-09-08 --version v11 --output "$archiveCache/public-export-v11"
node scripts/verify-archive-pro-rebuild.mjs --cache "$archiveCache" --report "$archiveCache/pro-v11-verification.json"
node scripts/load-public-archive.mjs --dir "$archiveCache/public-export-v11" --dry-run
```

Use a new version and output directory for changes after publication. Keep the
source date `2026-09-08`: identity additions do not make the replay population
newer. The verified v11 content SHA-256 is:

```text
081e7a273ff42c93a09d3e72d5ea216caaea24d80e507299e7a43d601020eb94
```

The independent verifier checks source totals, public dates/parser versions,
every mapped side, old confidence/evidence, source hashes, unchanged field
rollups, all new Pro counters, move coverage, and distinct counts. The loader
dry run independently verifies NDJSON counts and the content fingerprint.

## Interaction consolidation

The original Venue and conservative draws are independent capped samples, so
they must be unioned before aggregation. The consolidated Tournament sample is
6,327 + 4,640 - 869 = 10,098 games / 20,196 sides. The Pro sample remains
1,338 games / 1,883 sides. The two displayed cohorts can overlap.

All 11,141 cached parses were reused without changing detectors or source
selection. Schema 2 / encoding 3 rejects the old cohort meanings. Reproduce with:

```powershell
node scripts/build-interaction-benchmarks.mjs --cache "$archiveCache" --per-bundle 100 --pro-evidence "$archiveCache/interaction-pro-evidence.local.json" --cached-only true
node scripts/verify-interaction-benchmark-receipt.mjs --cache "$archiveCache" --pro-evidence "$archiveCache/interaction-pro-evidence.local.json" --verify-files true
```

Cached-only mode fails when fingerprints differ or a parse is missing. It never
silently reparses. Parser fingerprints cover source bytes, including line
endings; the local line-ending proof records restoration of the original LF
bytes in two detector files, with no logical changes. See the
[interaction report](interaction-benchmark-sample.md) for coverage and sampling.

## Publish the archive

1. Apply [archive-pro-rollups-upgrade.sql](../supabase/archive-pro-rollups-upgrade.sql)
   through the project's SQL administrator connection. It is additive and
   transactional. Fresh installations use the full
   [public-archive.sql](../supabase/public-archive.sql). The existing service-role
   REST key can load data but cannot run this DDL migration. A read-only live
   check on 2026-11-03 found v10 published and the capability RPC absent.
   The migration installs a service-role-only capability RPC; pooled exports
   require a successful response before the loader writes any rows. Legacy
   exports do not require this capability, and dry runs remain entirely local.
2. Run the loader below. It stages derived rows, then the publication RPC verifies
   counts and publishes the new revision atomically. Published revisions remain
   immutable. Interrupted staging can be resumed with the same verified export.
3. Verify the live dataset fingerprint and whole-format Pro rows, then check the
   UI's exact character/matchup/stage filters and named-player list.

```powershell
node scripts/load-public-archive.mjs --dir "$archiveCache/public-export-v11" --publish
```

Credentials are read from the existing ignored local environment file. Never
put the service-role key in a Vite/browser variable, command line, or commit.
Publication sends derived NDJSON only, never replay archives or working evidence.

```sql
select id, published, data_as_of, content_sha256
from public.archive_datasets where id = 'nikki-2026-09-08-v11';

select format, game_count as player_game_count, identified_player_count
from public.archive_rollups
where dataset_id = 'nikki-2026-09-08-v11' and scope = 'pro'
  and character_id is null and opponent_character_id is null and stage_id is null;

select g.format, count(distinct g.game_key) as distinct_pro_games
from public.archive_games g join public.archive_game_players p using (game_key)
where g.dataset_id = 'nikki-2026-09-08-v11' and p.player_id is not null
group by g.format;
```

Expect singles `player_game_count=1883`, `identified_player_count=98`, and
`distinct_pro_games=1338`; doubles have `player_game_count=115` and
`distinct_pro_games=82`.
Do not reinterpret a missing measured metric as zero.

## Code validation and release

```powershell
npm run lint
npm run verify:benchmarks
npm run verify:moves
npm run verify:interactions
npm run build
```

Benchmark checks include pooled-before-suppression regression fixtures, exact
filters, legacy compatibility, rendered columns and rates, identity conflicts,
and a real PostgreSQL-compatible PGlite schema/migration/RLS exercise. CI runs
the benchmark suite alongside the existing checks. The local preview uses the
staged v11 export and synthetic user data; it is not proof of live publication.

Use a PR into protected `main` and wait for both required `build` and `Vercel`
checks. Production deployment follows merge. Ranked baselines are tracked in
the [roadmap](benchmark-baselines-roadmap.md); no Diamond/Master benchmark is
published by this archive release.
