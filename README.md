# SSBM Stats

[ssbmstats.com](https://ssbmstats.com/) turns local `.slp` and `.slpz` replays into a Melee stats dashboard with matchup, opponent, stage, session, execution, teams, and coaching views.

Everything is parsed and cached in your browser; raw replay files never leave your device. Optional Google sign-in syncs parsed stats only, and Community contribution is a separate, default-off choice.

No replays? Try the demo or browse the public Community, Tournament Predictions,
and Liquipedia views.

## Release 0.4.9 — Interaction analysis

- **Ledge and out of shield:** choice frequency and follow-up hit/grab outcomes,
  including sequences such as ledgedashes, wavedashes, and jump → aerial.
- **Recoveries and edgeguards:** high/low recovery routes, ledge and stage
  returns, edgeguard tactics, and observed stock-loss outcomes.
- **Before openings taken:** preceding actions and ensuing damage or stock loss,
  providing context without claiming verified whiffs or unavoidable punishes.
- **Archive estimates:** experimental Tournament and Pro Tournament comparisons
  matching character, opponent character, and stage across 11,141 public games,
  including 1,883 Pro appearances from 98 mapped players, with visible samples.
- **Replay-audited detection:** longer ledgedash sequence recognition, platform
  shield drops, and input-supported wavedash landings.
- **Automatic recent-game analysis:** update older replays in the filtered
  150-game window when local files are accessible, while keeping existing stats
  usable. Coverage notes distinguish pending analysis from unavailable data.
- **OOS wavedashes:** distinguish jump → air dodge → landing from jumps, and
  keep measured zero-use Wavedash rows visible.
- **C-stick input:** an experimental OOS column shows observed stick input,
  without claiming buffering or which control caused the action.
- **Recovery hits:** show attempts hit after the initial launch by route,
  including experimental Tournament and Pro Tournament comparisons.
- **Player card:** show the filtered second-most-played character beneath Main.
- **Custom ranges:** choose inclusive local start/end dates with calendar
  controls or typed entry, for singles and teams.

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

After **Add replay files**, an import report shows files parsed or already
scanned, recorded game dates, and why inspected games did not match your accounts
or filters. When the exact selected file version remains in the cache, the
report can inspect it without reparsing. A newer file's modified date does not
necessarily mean its recorded game date is newer.

## Community and tournament benchmarks

The Community section compares your local character stats against three samples:

- **SSBMStats Community** — privacy-thresholded aggregates from users who explicitly opted in. Headline medians retain their player-balanced estimator.
- **Tournament** — eligible event-venue recordings from [Nikki's public Slippi archive](https://replays.nikki.sh/), including conservative tournament sets, counted once. This is the former broad Venue population, not the sum of the old columns.
- **Pro Tournament** — evidence-backed named-player sides in conservative tournament games, with an optional named-player comparison. Historical ranking evidence is retained; this is not a sample of the current Top 100.

Matchup, Stage, and Move Atlas use the same side-by-side columns. Community character controls default to the user's most-played character; every Atlas comparison column is sortable, and Move Atlas sorting follows the currently selected measure. The shared My games lookback defaults to the 150 most recent matching games and scopes only the user's column, while benchmark columns retain their full published samples. Stage Atlas defaults to an all-opponents aggregate. Move Atlas defaults to Landed / game and a 1-tracked-attempt-per-game minimum applied to the user's available attempt rates. Recorded specials (including Down B) and throws remain visible with untracked attempts shown as dashes. The measure selector also compares damage share, kills, average kill percent, openings per game, and damage per opening across the same sources. A full execution/action comparison sits directly beneath the move table with its own 1-action-per-game minimum. Move and action differences shade the user's cell on a continuous red-above/blue-below scale against the consolidated Tournament sample; unavailable comparisons remain unhighlighted. In the all-opponents Stage view, SSBM Stats remains blank until a privacy-safe character-by-stage aggregate is published rather than summing suppressed matchup cells. Win-rate coloring uses the same blue-low/red-high direction throughout. The compact participation card advances from a 25-user milestone to 100, and the Metrics Guide keeps each section in an independent collapsed disclosure.

The rolling execution, Move Trend, and Actions charts show these samples as fixed horizontal references; they are aggregate benchmarks, not historical time series. Each chart has an optional opponent overlay that is off by default, and the Actions chart shows one selected action at a time. In the current-form tables, Actions retains the opponent per-game rate and adds Tournament and Pro Tournament per-game comparisons. Move effectiveness compares the selected measure with SSBMStats Community, Tournament, and Pro Tournament samples while retaining damage share, kill share, and L-cancel. It defaults to Landed / game and shares its measure with Move Trend; other measures include attempts, damage per game or hit, damage share, kills per game, kill share, average kill percent, and L-cancel. Special moves compare measured attempts and supported outcomes using per-move coverage; unsupported or unmeasured values remain unavailable. Openings adds the archive columns for openings per game. The user's selected move measure, action/game, and opening/game cells use the same continuous comparison heatmap. The full execution table compares tech, L-cancel, input, and available action rates across the same sources; a dash is retained when a source does not publish the required denominator. Matchup Atlas separates the user's local game count from win rate, defaults to Games descending, and can sort by any benchmark column. The Tournament Predictions tab sits before Liquipedia; its Public Replay Archive is collapsed by default and can be browsed by series or event after expansion. Selecting a named pro limits the Event menu to that player's published evidence-backed mappings and automatically selects their most-observed character for the event. Its tech KPI includes the in-place/in/away split, while the adjacent execution panel ranks the selected character's four largest moves by damage share.

The rebuilt `nikki-2026-09-08-v11` snapshot was published on 2026-11-03. It retains v10's 158,530 unique parsed games, 151,021 broad usable games (318,578 player-games), and 24,055 conservative games. Reviewed identity evidence expands the main Pro singles cohort from 702 to 1,883 player-games across 98 players and 1,338 distinct games. The all-format named subset has 1,420 games and 1,998 identified sides, including the unchanged 115 doubles sides. A character, matchup, stage, or measured-metric filter can show fewer appearances. Supplemental aliases apply only to already-conservative singles games; ambiguous identities remain anonymous. Existing Ampp membership retains its regional-ranking basis, while new aliases require historical/current global Top 100 evidence.

The new revision pools Pro counters before sparse individual-player cells are suppressed, preserving contributions that the legacy client-side sum could lose. It also publishes exact distinct-player counts and all-character move aggregates. Older published revisions remain readable. The additive Pro-rollup schema upgrade and v11 publication are complete; see the [rebuild and release guide](docs/benchmark-baselines-release.md).

Raw `.slp` files, source paths, unresolved tags, connect codes, and private user identifiers are not published. The archive contains only derived game/player statistics and rollups, in tables separate from private user-sync data.

Diamond/Master source investigation and remaining ranked-tier work are tracked
in the [benchmark baseline roadmap](docs/benchmark-baselines-roadmap.md).

## Tournament Predictions

Release 0.4.6 adds a bundled Tournament Predictions view with a tournament
selector, six model choices and explanations, a deterministic Riptide 2026
Top-16/Top-8 path illustration, and an interactive out-of-sample comparison.
The comparison covers 83 held-out events and 74,891 realized sets from the
accepted 2018–2025 corpus. **Strict history** excludes historical seed values
whose pre-event availability was not established; **Seed sensitivity** shows
the separate exploratory result when those seeds are assumed available.

Coverage is the share of held-out sets where a model had its full required
pre-event inputs, not its accuracy. All eligible sets remain in scoring, with
model-specific fallback behavior when coverage is missing. The results are
retrospective and not snapshot-verified title-odds evidence. The current
Riptide graphic is a reviewed seed scenario rather than a full-field Monte Carlo
simulation, and future event refreshes are manual; an automatic sanitized
Start.gg feed is deliberately deferred.

See the [prediction roadmap](docs/predictions-todo.md),
[research methodology](docs/forecast-research.md), and
[new-computer handoff guide](docs/forecast-handoff.md) for scope and setup.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
npm run test:forecast
```

Requires Node 22. Run `git config core.hooksPath .githooks` once per clone. Use `npm run verify:slpz -- <replay-folder> [count]` to compare local `.slp`/`.slpz` pairs; replay fixtures are never committed.

## Experimental interaction analysis

Execution's **Interactions** panel describes your choices and what followed in
the most recent 150 singles games after the global filters. It appears directly
above **Move impact — volume vs wins**. It includes:

- **Ledge and out of shield:** option frequency and the first damaging hit or
  grab within 30 frames (0.5 seconds). Sequences can develop for up to 30 frames
  from ledge and 15 frames from shield, distinguishing ledgedashes and jump →
  aerial. Confirmed recent shield contact and
  other shield exits have separate samples; unresolved outcomes are excluded
  from rates, and same-frame trades count in both contact columns.
- **Recoveries:** high, low, mixed, or unclassified routes after an observed
  offstage launch. Reaching ledge is separate from returning to stage: a return
  requires landing and 30 frames inside stage bounds without damage, a grab, or
  other disabled states. Intentional offstage trips and uninterrupted launch
  KOs do not count as attempts. Recovery geometry supports Battlefield, Final
  Destination, Dream Land, Fountain of Dreams, Yoshi's Story, and explicitly
  frozen Pokémon Stadium; unfrozen or unknown Stadium geometry is unavailable.
- **Edgeguards:** opportunities, observed tactics, and opponent outcomes across
  the recovery. Stock-loss rate uses completed contests. Uncontested deaths
  remain separate; a death during a contest does not prove its cause.
- **Before openings taken:** the preceding meaningful action within 30 frames,
  followed by the episode's damage and stock-loss outcome. Follow-up hits stay
  together until stock loss or 45 frames outside damage/capture/knockdown/tech
  states. This does not establish a whiff or an unavoidable punish.

New full parses include these summaries. Older compatible game stats remain
usable while the latest 150 filtered singles are analyzed automatically in the
background. Only matching files are re-read, using connected folders with
existing read permission or files selected during this visit. **Analyze these
games** is a manual reconnect/retry, and **Select replay files** handles missing
or disconnected sources. Cloud summaries alone cannot supply raw frames.
Automatic analysis attempts each older game once per visit; explicit reconnect
or retry can try again. Frame processing stays on the device, raw frames are
discarded, and only derived summaries are saved and eligible for the existing
optional cloud sync.

Coverage is shown separately for each family. Missing observations stay
unavailable, and fewer than 20 resolved examples are marked as small samples.
The rules are experimental and require review against real replays before firm
coaching claims. The Metrics Guide contains their full definitions.

**Archive estimates** compare the selected measure with Tournament and Pro
Tournament observations. They follow the exact **Me / Vs / Stage** filters
across all dates in the sample; date, mode, account, and named-opponent filters
apply only to your column. Missing matchups remain unavailable rather than
falling back to a broader sample. Rates pool opportunities, not players.

The reproducible sample preserves the original draws of up to 100 singles
games per eligible audited bundle, selected independently by deterministic hash
from the Venue and conservative Tournament populations. The displayed Tournament
cohort is their deduplicated union: 6,327 + 4,640 - 869 shared games = **10,098
games / 20,196 player-games**. Pro Tournament includes every vetted named-player
side in conservative games across those bundles, independently of the cap.
Eligible venue recordings need not have individual bracket-set proof.

The whole reference covers 11,141 unique games across 66 eligible bundles.
Pro Tournament contains **1,883 player appearances across 1,338 games from 98
mapped players**. Its supplemental event-specific aliases require public result
and global Top 100 ranking evidence; these identities remain probable. The main
archive rebuild now shares that resolver, while the bundled interaction sample
keeps its frozen membership. Consolidation reused all verified stats-v9 parses.

The two displayed cohorts can overlap; headings show player-games, not unique
players. Event coverage, repeated players, and per-bundle caps affect the sample.
It is not a population estimate, a player- or character-balanced benchmark, or
a skill ranking. SSBMStats Community estimates are unavailable for these metrics.
The schema-2, encoding-v3 artifact preserves missing measurements separately
from zero and rejects the older cohort meanings.

See the [sample methodology](docs/interaction-benchmark-sample.md),
[184-game defensive audit](docs/defensive-interaction-audit.md), and
[32-game recovery/opening-context audit](docs/recovery-interaction-audit.md).
These audits inspect replay states and inputs; they do not claim independent
video annotation or a measured accuracy rate.

## Benchmark filtering and community samples

Matchup Atlas and Stage Atlas show each column's qualifying sample under its
heading, matching Move Atlas. Win-rate sample totals count decided results in
the displayed rows; community counts are approximate, and suppressed samples
remain unavailable.

Execution's Tournament and Pro Tournament references follow both **Me** and **Vs**.
For example, Marth vs Jigglypuff compares your moves, openings, actions, and execution
against that exact matchup across all stages and dates. Missing matchup metrics
stay unavailable; SSBMStats Community remains an explicitly labeled all-opponent reference.
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
