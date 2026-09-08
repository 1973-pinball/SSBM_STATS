# SSBM Stats

[ssbmstats.com](https://ssbmstats.com/) turns local `.slp` and `.slpz` replays into a Melee stats dashboard with matchup, opponent, stage, session, execution, teams, and coaching views.

Everything is parsed and cached in your browser; raw replay files never leave your device. Optional Google sign-in syncs parsed stats only, and Community contribution is a separate, default-off choice.

No replays? Try the demo or browse the public Community, Tournament, and Liquipedia views.

## How it works

```text
replays → browser workers → IndexedDB → React dashboard
```

The installable PWA works offline, and content-based deduplication prevents copied or moved replays from being counted twice.

Start with **Select replay folder**, then use **Add folder** on the dashboard to
combine more folders without clearing stats or accounts. Each pick includes all
subfolders. Chromium remembers every connected folder, and **Refresh** checks
them all; folders that need permission can be reconnected without blocking the
others. Other browsers support adding folders one at a time and require picking
them again to import new replays. **Change folders** starts over and clears the
local library.

## Community and tournament benchmarks

The Community section compares your local character stats against four separate samples:

- **SSBM Stats** — privacy-thresholded aggregates from users who explicitly opted in.
- **Venue archive** — usable event-associated games from [Nikki's public Slippi archive](https://replays.nikki.sh/).
- **Tournament archive** — the conservative subset linked to verified or probable tournament sets.
- **Pro tournament archive** — the aggregate of published evidence-backed mappings for publicly ranked players, with an optional named-player comparison.

Matchup, Stage, and Move Atlas use the same side-by-side columns. Community character controls default to the user's most-played character; every Atlas comparison column is sortable, and Move Atlas sorting follows the currently selected measure. The shared My games lookback defaults to the 150 most recent matching games and scopes only the user's column, while benchmark columns retain their full published samples. Stage Atlas defaults to an all-opponents aggregate. Move Atlas defaults to a 1-attempt-per-game minimum applied strictly to the user's rate, hiding lower and unavailable attempt rows, and places a full execution/action comparison directly beneath the move table with its own 1-action-per-game minimum. Move and action differences shade the user's cell on a continuous red-above/blue-below scale against Tournament, falling back to Venue when no tournament sample exists. In the all-opponents Stage view, SSBM Stats remains blank until a privacy-safe character-by-stage aggregate is published rather than summing suppressed matchup cells. Win-rate coloring uses the same blue-low/red-high direction throughout. The compact participation card advances from a 25-user milestone to 100, and the Metrics Guide keeps each section in an independent collapsed disclosure.

The rolling execution, Move Trend, and Actions charts show these samples as fixed horizontal references; they are aggregate benchmarks, not historical time series. Each chart has an optional opponent overlay that is off by default, and the Actions chart shows one selected action at a time. In the current-form tables, Actions retains the opponent per-game rate and adds Venue, Tournament, and Pro per-game comparisons. Move effectiveness puts the same three attempted-per-game references beside the user's rate while retaining landed rate, damage share, kill share, and L-cancel; Openings adds the archive columns for openings per game. The user's attempted/game, action/game, and opening/game cells use the same continuous comparison heatmap. The full execution table compares tech, L-cancel, input, and available action rates across the same sources; a dash is retained when a source does not publish the required denominator. Matchup Atlas separates the user's local game count from win rate, defaults to Games descending, and can sort by any benchmark column. The Tournament explorer sits before Liquipedia and can be browsed by series or event. Selecting a named pro limits the Event menu to that player's published evidence-backed mappings and automatically selects their most-observed character for the event. Its tech KPI includes the in-place/in/away split, while the adjacent execution panel ranks the selected character's four largest moves by damage share.

The current `nikki-2026-09-02-v7` snapshot contains 160,075 unique parsed games, of which 152,566 are in the broad usable sample and 25,598 are in the conservative tournament sample. Those 152,566 games represent 321,668 player-games because singles contribute two player appearances and doubles contribute four. Twenty-seven players have publishable identity mappings: Aklo, Ampp, aMSa, Axe, Cody Schwab, Fiction, Ginger, Hungrybox, Jmook, Joshman, KoDoRiN, Krudo, lloD, Magi, Moky, n0ne, Ossify, RapMonster, S2J, Salt, SDJ, SFAT, Shroomed, Soonsay, Spark, Wizzrobe, and Zain. Across the named subset, 819 conservative games contain at least one resolved player, representing 956 named player-game slots (841 singles and 115 doubles). Identity publication uses public event or bracket evidence with narrowly scoped rules: exact replay-label matches for tournament aliases, game-identity fingerprints plus player slots and expected characters for bracket-verified anonymous stream games, and event-and-character rules for the verified two-player Zain–Cody exhibition. Ambiguous identities and deliberately excluded Summit aliases remain anonymous while still contributing to aggregate statistics.

The v7 Supabase-ready export is 120,632,473 bytes (115.04 MiB) of derived NDJSON. Because published versions are immutable and database tuples, JSONB, TOAST, and indexes add overhead, operators should budget roughly 140–200 MB of incremental Supabase storage for this version. Raw archives are not part of that figure.

Raw `.slp` files, source paths, unresolved tags, connect codes, and private user identifiers are not published. The archive contains only derived game/player statistics and rollups, in tables separate from private user-sync data.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
```

Requires Node 22. Run `git config core.hooksPath .githooks` once per clone. Use `npm run verify:slpz -- <replay-folder> [count]` to compare local `.slp`/`.slpz` pairs; replay fixtures are never committed.

## Benchmark filtering and community samples

Matchup Atlas and Stage Atlas show each column's qualifying sample under its
heading, matching Move Atlas. Win-rate sample totals count decided results in
the displayed rows; community counts are approximate, and suppressed samples
remain unavailable.

Execution's Venue, Tournament, and Pro references follow both **Me** and **Vs**.
For example, Marth vs Jigglypuff compares your moves, openings, actions, and execution
against that exact matchup across all stages and dates. Missing matchup metrics
stay unavailable; SSBM Stats remains an explicitly labeled all-opponent reference.
Archive builds retain per-move metrics on matchup rows as well as character rows.
Existing archives need a new versioned build and publication before matchup moves
appear; they cannot be recovered from the older rollups alone.

Community aggregates include both players in each contributed singles game. One
Marth–Fox replay supplies one Marth sample and one Fox sample. A private game-key
index chooses one contributing upload per game, so uploading it from both accounts
does not count either side twice. Opt-out, account changes, and deletion transfer
shared games to another eligible upload or remove them. Participation counts users
with eligible uploads; each published cell requires at least 25 unique players
and 100 distinct games, including opponents. Players are identified by normalized
connect code and unioned across both participants and all contributing sources;
missing codes and display names cannot establish a distinct player. Contributor
totals are informational. Duplicate uploads do not supply additional samples.
The 100-game publication minimum is separate from the 150-game default **My games lookback**, which
limits only the user's local column; Community comparisons use all history.
Both sides of a mirror match retain separate move and attempt denominators.

To upgrade Community, apply `supabase/community.sql` and run
`select public.refresh_community_snapshot();` to rebuild the private caches and
public snapshot. The membership index is private under RLS; public payloads still
exclude identities and individual games. No client replay re-parse is needed.
`node scripts/verify-benchmark-filters.mjs` checks archive selection. The isolated
SQL regression suite is `node scripts/verify-community.mjs`, with
`@electric-sql/pglite` available or `PGLITE_MODULE` set to its module entry point.

## Optional cloud sync

The app stays fully local unless Supabase is configured. To enable self-hosted sync:

1. Apply [`supabase/schema.sql`](supabase/schema.sql) and, optionally, [`supabase/community.sql`](supabase/community.sql). Operators publishing a public replay archive also apply [`supabase/public-archive.sql`](supabase/public-archive.sql); it is not required for private sync.
2. Enable Google authentication in Supabase.
3. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_SITE_URL`.

Only games involving one of the user's own accounts are synced, including both players' parsed stats—never replay files. See [`supabase/AUTH_BRANDING.md`](supabase/AUTH_BRANDING.md) for production OAuth setup.

Projects upgrading from the legacy row-per-game mirror should run
[`supabase/pack-migration.sql`](supabase/pack-migration.sql) repeatedly until no
users remain, deploy the packed
client, confirm [`supabase/pack-verify.sql`](supabase/pack-verify.sql) reports no
missing games, verify a restore, and only then run the destructive
[`supabase/pack-cleanup.sql`](supabase/pack-cleanup.sql) to reclaim the old table.

## Credits

Built with React, TypeScript, [`@slippi/slippi-js`](https://github.com/project-slippi/slippi-js), Dexie, Recharts, and optional Supabase.

Scene-history data comes from [Liquipedia](https://liquipedia.net/smash) under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Character icons are Nintendo/HAL fan-project assets sourced through [slippi-launcher](https://github.com/project-slippi/slippi-launcher) and are not covered by this repository's MIT license.
