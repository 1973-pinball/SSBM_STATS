# Local tournament forecast research

This document covers the local research pipeline in
[FORECAST_PLAN.md](../FORECAST_PLAN.md). Source downloads, normalized datasets,
evaluation reports, and refreshable Markdown stay local and never touch personal
replay files or Supabase. Reviewed, public-data-only projection and aggregate
backtest bundles can be generated into the dashboard for the Predictions
explorer; the models remain experimental and no family has been selected for
production.

For a new-computer setup, including exact `.forecast/` transfer and a clean
rebuild alternative, see [Continue forecast work on another computer](forecast-handoff.md).

## Setup

Use the repository's Node 22 runtime. No new dependencies are needed.
Create a personal token in [Start.gg Developer Settings](https://www.start.gg/admin/profile/developer).
Put this line in the repository-root **.env.forecast.local**, replacing the placeholder:

~~~dotenv
STARTGG_TOKEN=your-token-here
~~~

That file is ignored by Git. Do not use a VITE_ variable, paste credentials into
chat, or put them on the command line. The CLI reads only STARTGG_TOKEN.
The process environment, if set, takes precedence over the local file.
On macOS, open the file with:

~~~sh
open -a TextEdit .env.forecast.local
~~~

The downloader sends authenticated, read-only GraphQL queries only to
https://api.start.gg/gql/alpha. It rejects redirects, suppresses remote error
payloads, checks for token reflections before caching, and never stores request
headers. See the official [authentication](https://developer.start.gg/docs/authentication/)
and [rate-limit](https://developer.start.gg/docs/rate-limits/) documentation.

## First run

~~~sh
npm run forecast -- registry
npm run forecast -- map --major "Riptide 2025" --year 2025 --event tournament/riptide-2025-4/event/melee-singles
npm run forecast -- download --event tournament/riptide-2025-4/event/melee-singles
npm run forecast -- normalize
npm run forecast -- status
~~~

The bundled snapshot is the registry source. All its majors stay auditable,
including online events, but only offline ones can enter the research dataset.
Its dates are **end dates**, not suitable pre-event cutoffs.

The tracked mappings include all 85 scoped 2018–2025 offline majors. New URLs
outside that reviewed scope should remain candidates until reviewed. The map
command checks the tournament title, source IDs, Melee game
identity, singles/venue metadata, and dates against the major. It records a
verified mapping only after those checks pass. A differing tournament title
requires a reviewed mapping file rather than automatic fuzzy acceptance.

Repeat map for other majors. Once reviewed mappings exist:

~~~sh
npm run forecast -- download --all-mapped
npm run forecast -- normalize --strict-corpus
npm run forecast -- evaluate
npm run forecast -- tune
npm run forecast -- tune --allow-unverified-historical-seeds
npm run predictions:backtest-data
npm run forecast -- storage
~~~

The accepted contract currently includes 84 events and quarantines GOML 2022
as `source-ambiguous`; zero scoped decisions are unresolved. The strict dataset
hash is `e21eb6bf8d91b295b875ab11959e1beddae937d7816e5c7da1a2f13db3f6371d`.
Run `npm run forecast -- corpus --strict-corpus` to reproduce the contract,
dataset-coverage, and authenticated source-readiness gate.

## Refreshable Riptide matchup report

The local Riptide report refreshes the public Start.gg bracket, refits the
current regularized Bradley-Terry + seed + recent-form model on the verified
historical dataset, and atomically replaces one stable Markdown file:

~~~sh
nice -n 10 npm run forecast:riptide
~~~

Open **.forecast/riptide-2026-4-matchups.md** once and rerun that command to
refresh the same file. The compact board shows one summary row per pool, sorted
from highest to lowest model estimate, plus the 12 closest calls; it links to
**.forecast/riptide-2026-4-all-matchups.md** for
the dense one-row-per-match table. A failed or partial source download leaves
the previous reports intact. The report predicts only matchups that are actually determined:
direct root-phase seed pairings, plus winner/loser feeders after the referenced
set has a valid completed result. It does not treat populated preview entrants
or later-phase seed projections as known future opponents.

As of the first complete September 7 source bundle, all 2,773 bracket rows are
synthetic Start.gg previews and the event state is `CREATED`. The Markdown file
therefore labels all 216 determined matchups provisional: 45 direct-seed rows
and 171 rows resolved from two completed auto-advance byes.

The displayed number is an estimated set win chance, not a confidence interval.
The adjacent empirical-reliability value reports how often favorites in that
probability band won across the current 6,244 held-out historical sets. Those
buckets are descriptive, not Riptide-specific guarantees. This remains a
pairwise experimental report; it does not simulate title or top-eight odds.

There is no automatic all-major search yet. Five 2025 majors now have verified
API mappings: Riptide, GENESIS X2, Battle of BC 7, GOML: Forever and Supernova.
Use status to inspect which source events have finished downloading.
Older majors may not exist on Start.gg. Leave them unmapped; do not invent IDs or
replace missing set history with the Liquipedia winner/runner-up.

## Website prediction bundle

After refreshing and reviewing the local artifacts, regenerate the tracked
dashboard catalog with:

~~~sh
npm run predictions:build
npm run predictions:backtest-data
~~~

The builder hash-checks the selected historical dataset, evaluation report, and
upcoming-event source bundle before writing
**src/lib/tournamentPredictionData.ts**. The second command hash-checks the two
mode-specific nested-tuning results and writes the aggregate-only
**src/lib/tournamentPredictionBacktestData.ts** comparison bundle. The browser
receives only the small public prediction catalog and aggregate backtest data:
public player IDs/names, seeds, model descriptions, held-out aggregate scores,
projected matchups, and source provenance. It receives no per-set forecast row,
API token, raw Start.gg response bundle, local path, personal replay record, or
connect code. The dashboard makes no runtime Start.gg or Supabase request for
this bundled view, so it continues to work offline.

The current catalog contains one Riptide 2026 scenario and all six evaluated
models. It advances model favorites through the published Top-16 and Top-8
routing while assuming current seeds 1–16 reach their matching Top-16 slots.
This is a deterministic path illustration, not a full-field Monte Carlo model,
confirmed later-round bracket, title probability, or confidence interval. Five
root pools have no source set rows in the current snapshot, covering 88 entrants;
the UI discloses that limitation. See
[Predictions TODO](predictions-todo.md) for the remaining acceptance work.

## Cache and reproducibility

Every paginated connection is fetched: entrants, sets, standings, phase seeds,
and phase groups. Unfinished bracket rows are collected too; they are excluded
from training later, not silently removed from the source.

The ordinary Supernova set query failed at page 401 after 10,000 rows, despite
reporting 12,870 total rows. Large-event acquisition now detects totals above
10,000 on the first page and partitions sets using the complete official
phase-group list. Initial shards contain at most 32 groups and split recursively
if a shard is still oversized. Every row must belong to its requested groups,
set IDs must be globally unique, and the final union must equal the original
event total. An oversized single group or any mismatch fails closed.
The partial ordinary-event prefix is not reused. Shard groups and counts are
recorded in source provenance; existing smaller-event queries/hashes are unchanged.

Future events can also contain thousands of synthetic `preview_` sets whose
event-wide `STANDARD` ordering is unstable at page boundaries. If and only if
that exact preview-ID condition is detected, acquisition retries as one complete
official phase group per shard and requires the disjoint union to equal the
event-wide total. Real duplicate IDs still fail closed.

Requests are serialized at 1.1 seconds apart (including concurrent callers),
with small pages, timeouts, bounded retries, and Retry-After handling.
The CLI reports checked page counts, and downloads events one at a time. To
reduce competition with interactive apps, prefix a command with nice -n 10.
Unsupported optional bracket fields are recorded explicitly using cached
schema introspection. Missing required fields, GraphQL errors, changed page
totals, short pages, or duplicate page IDs stop the run; they do not produce a
completed partial-event bundle.

Successful query envelopes contain query/variables, fetch time, and content
hashes. Subsequent identical requests use cache by default, without requiring a
token. Use **--offline** to prohibit requests or **--refresh** to explicitly
replace cached responses. A failed refresh leaves the previous good response.
Detected changes in collection totals or duplicate/missing IDs stop pagination;
refresh the whole event before retrying. Same-count edits or corrected outcomes
cannot all be detected without server-side snapshot/version support. A completed
bundle is a reproducible collection of observed responses, not a guaranteed
single-instant snapshot of Start.gg. Fetch times remain in provenance.

~~~sh
npm run forecast -- download --all-mapped --offline
npm run forecast -- download --event tournament/riptide-2025-4/event/melee-singles --refresh
~~~

Fetched-at values come from cached responses, so an offline repeat returns the
same bundle. Each complete raw bundle is saved under its SHA-256; refreshing
retains older complete bundles. The download index selects one current snapshot
per event. Normalization verifies bundle hashes and identity before use.
Dataset generations are content-addressed too; latest.json updates only after
the generation is written. Concurrent CLI writers are not supported: run one
ingestion process per research root.

## Local files

All research and source artifacts are inside the ignored **.forecast/**
directory. The tracked derivatives are the reviewed website catalog and the
sanitized aggregate backtest bundle described above:

| Path | Content |
|---|---|
| registry.json | Full major registry, mappings, exclusion counts and attribution |
| mappings.json | Locally verified Start.gg mapping decisions |
| cache/ | Successful, hash-checked GraphQL responses and schema observations |
| raw/ | Immutable completed source bundles, addressed by content hash |
| downloads.json | Current source bundle for each downloaded event |
| datasets/&lt;hash&gt;/dataset.json | Canonical records and provenance |
| datasets/&lt;hash&gt;/quality.json | Exclusions, duplicates and identity issues |
| datasets/&lt;hash&gt;/registry.json | Registry used for that normalization |
| datasets/&lt;hash&gt;/corpus-&lt;hash&gt;.json | Frozen corpus decision and canonical-coverage audit |
| datasets/&lt;hash&gt;/corpus-source-readiness-&lt;hash&gt;.json | Authenticated source-readiness evidence |
| datasets/&lt;hash&gt;/outcome-reconciliation-&lt;hash&gt;.json | Advisory winner/runner-up identity reconciliation |
| latest.json | Dataset pointer, counts, SHA-256 and exact serialized byte size |
| corpus-reports/ | Content-addressed contract, coverage, and source-readiness reports |
| latest-corpus.json | Strict-corpus report pointer and readiness flags |
| reports/&lt;hash&gt;/comparison.json | Initial model scores, methodology, folds and calibration bins |
| reports/&lt;hash&gt;/comparison.md | Human-readable local diagnostic comparison |
| reports/&lt;hash&gt;/predictions.json | Per-set held-out probabilities and coverage flags |
| reports/&lt;hash&gt;/calibration.svg | Held-out calibration with descriptive intervals and bin counts |
| reports/&lt;hash&gt;/calibration-in-sample.svg | Retrospective calibration, explicitly not validation |
| latest-evaluation.json | Diagnostic-report pointer, run hash and source dataset hash |
| tuning/runs/&lt;forecast-hash&gt;/ | Content-addressed nested forecasts, evaluation, report and manifest for one evidence mode |
| tuning/event-forecasts/ | Pre-outcome per-target candidate forecast checkpoints used by resumable tuning |
| tuning/resume/ | Resume indexes for completed nested folds |
| latest-tuning-strict-seeds.json | Strict pre-event seed-evidence tuning pointer |
| latest-tuning-availability-assumed.json | Explicit unverified-historical-seed sensitivity pointer |
| latest-tuning.json | Convenience pointer to whichever tuning mode completed last; not sufficient to identify both modes |
| upcoming/&lt;hash&gt;/matchups.json | Auditable status for every current source bracket row plus fixed-match probabilities |
| upcoming/&lt;hash&gt;/matchups.md | Immutable compact Markdown board for that matchup snapshot |
| upcoming/&lt;hash&gt;/matchups-full.md | Immutable dense one-row-per-match table |
| riptide-2026-4-matchups.md | Stable compact board atomically replaced by `npm run forecast:riptide` |
| riptide-2026-4-all-matchups.md | Stable detailed table linked from the compact board |
| latest-bracket-report.json | Current matchup-report pointer, source/model/dataset hashes and local-only flags |
| storage-reports/&lt;hash&gt;/storage.json | Measured file inventory and explicit database capacity scenarios |
| storage-reports/&lt;hash&gt;/storage.md | Human-readable local storage report |
| latest-storage.json | Storage-report pointer and dataset hash |
| src/lib/tournamentPredictionData.ts | Tracked, reviewed public upcoming-event prediction catalog |
| src/lib/tournamentPredictionBacktestData.ts | Tracked, generated six-model aggregate UI bundle; no per-set rows or credentials |

An alternate **--root DIR** must be outside the checkout. In-repo output is
restricted to .forecast, preventing accidental public/ or source-bundle writes.
Do not copy research output into public/, src/, or cloud upload directories.
The manifest byte count is only dataset serialization, **not** total disk usage
or a Postgres estimate. The separate storage command measures the full retained
research directory and labels database projections as unvalidated assumptions.

## Mapping overrides

Pass **--mappings FILE** to replace the tracked candidate mapping file.
Local mappings override matching candidate rows; duplicate/conflicting IDs are
rejected. A reviewed row has this shape (the IDs below are synthetic examples):

~~~json
{
  "schemaVersion": 1,
  "mappings": [{
    "majorName": "Exact bundled major name",
    "year": 2025,
    "eventSlug": "tournament/example/event/melee-singles",
    "eventId": "123",
    "tournamentId": "456",
    "confidence": "verified",
    "evidenceUrl": "https://www.start.gg/tournament/example/event/melee-singles",
    "notes": "Explain the source evidence, including any naming discrepancy."
  }]
}
~~~

Exploratory download of an explicit event slug is allowed, but an unverified
or non-major event is excluded from normalization. A metadata mismatch for a
verified mapping is a hard failure. Neither path quietly marks the source valid.

## Canonical data and cleaning

The [Start.gg glossary](https://developer.start.gg/docs/glossary/) defines the
source hierarchy: tournament → event → phase → phase group (pool) → set → game.
A participant is tournament-specific; an entrant is event-specific and may be a
team. Neither is interchangeable with the persistent player identity. A seed
describes initial position in a phase/pool; a standing describes current or final
placement. The normalized collections preserve those distinctions.

Players use stable Start.gg player IDs. Tags are aliases, never join keys.
Missing public player IDs create event/entrant-scoped anonymous identities;
same-name players are not merged. Tag collisions, renames and identity conflicts
are reported in quality.json. When one public player has multiple entrants in
the same event, multipleEntrantsPerPlayerEvent flags the shared identity without
collapsing distinct registrations. Supernova 2025 has one such pair; both
entrants have only DQ outcomes, so neither contributes eligible training sets.

Canonical collections are events, players, aliases, entrants, seeds, sets and
standings, with original IDs and references to source provenance. Bracket slots,
available prerequisites, phases and phase groups remain attached. Source
observations are not a promise that every bracket can be simulated exactly;
the future simulator must validate its complete graph and reset rules.

**Only sets with eligible: true may train a model.** Excluded sets remain in the
dataset, with reasons, for audit and bracket inspection. The gates cover byes,
DQs, unfinished results, missing/invalid scores or winners, conflicting source
rows, non-singles/online/non-Melee events, and self-matches. Repeated identical
set IDs collapse; conflicting copies are excluded instead of choosing a winner.
Missing required source collections fail fast rather than becoming empty tables.

## Leakage boundaries

- Event chronology stores reported event/tournament start and end times, not
  guaranteed actual play times. Evaluation holds out the **entire
  target event by ID**, with **training event end < target cutoff**, excluding
  unknown-end/overlapping events. Use the earlier tournament start as a
  conservative cutoff until a schedule-specific cutoff is validated. In the
  Riptide sample, 130 eligible sets completed before the nominal event.startAt.
  Those are still target-event outcomes, never training data.
- A reported event end is not enough if a result was entered later. If any
  eligible training set has a reported completion at or after a target cutoff,
  the entire training event is excluded from that fold. Missing completion times
  still rely on the explicit event/tournament end; historical corrections cannot
  be proven to have been available before a cutoff without archived observations.
  GENESIS X2 includes a result entered three days after its reported end.
- Source timestamps must not become match-duration features: 608 of the 923
  eligible Riptide sets have identical startedAt/completedAt values, consistent
  with score-reporting timestamps rather than measured match times.
  One source set completed nine seconds before its prerequisite. Historical
  rating updates need validated dependency order or a documented batch method,
  not naive sorting by completion time.
- Final standings and the Liquipedia winner/runner-up are **outcomes only**.
- Seeds remain phase-specific. A later-phase reseed may reflect earlier rounds.
  The seed baseline chooses eligible initial-phase seeds and reports
  missing coverage instead of substituting placement.
- Source phaseOrder is not necessarily bracket chronology: in the first live
  Riptide snapshot, Top 8 has a lower value than R2 Pools. Validate progression
  routing and phase participation rather than sorting stages by that field.
- Historical seeds fetched after an event carry availability
  **unverified-historical** and usableAsPreEventFeature **null**. They are neither
  proven pre-event features nor silently discarded. Any historical seed baseline
  using them must disclose its availability assumption. A valid seed actually
  observed before the event is marked true; an invalid one is false.
- Nested tuning keeps each outer target event wholly out of training. Candidate
  hyperparameters are selected only from completed inner folds made from earlier,
  non-overlapping events; target outcomes never participate in selection.
- Each candidate forecast is durably checkpointed before the corresponding
  target outcomes are accessed. Training events must end before the target
  cutoff, and an event with any eligible completion at or after that cutoff is
  excluded rather than partially admitted.
- Tests enforce target-outcome invariance: changing a target result cannot change
  that target's forecast or any earlier forecast. They also cover input-order
  invariance, overlapping-event exclusion, and post-event metadata changes.
- Do not derive recent form, aliases, model hyperparameters, bracket assumptions,
  or player coverage using future events when implementing backtests.

## Initial model diagnostics

Once at least two non-overlapping eligible events are normalized:

~~~sh
nice -n 10 npm run forecast -- evaluate
nice -n 10 npm run forecast -- evaluate --strict-seeds
~~~

The first command compares all six planned models: neutral 50/50, a higher-seed
baseline whose confidence is calibrated using only training outcomes,
recency-weighted event-batch Elo, event-period Glicko-2, dynamic
Bradley-Terry, and regularized Bradley-Terry with initial-seed and recent-form
features. The seed baseline selects an unambiguous full-field phase with
unique ranks 1 through the entrant count and no known incoming progression;
it never sorts by phaseOrder or substitutes final placement.

Default seed comparisons explicitly assume the historical seed snapshot reflects
information available before the event. Strict mode instead requires source
observation provenance before the conservative tournament/event cutoff; the
normalized usableAsPreEventFeature flag alone is insufficient. Missing seeds
fall back to 50/50 and reduce reported seed coverage.

Elo uses initial rating zero, K=32, scale=400 and a two-year age half-life on
event update weights. It is an explicit **event-batch variant**, not conventional
sequential per-set Elo: all deltas within a training event use its opening
ratings and apply together, avoiding unreliable match timestamp order. Ratings
are frozen throughout the target event. Fixed settings are exploratory, not
hyperparameters selected using these test events.
Unseen players start at rating zero: both-unseen matchups predict 50/50, while
one-known-player matchups need not. Coverage counts both players previously seen.
Set-level scores are conditional on the actual realized matchups; this does not
yet predict which matches the bracket will produce.

Reports include a full-corpus retrospective in-sample fit and separate rolling
whole-event test folds, with accuracy, Brier score, log loss, AUC, ten calibration
bins and coverage. Exact 50/50 predictions receive half-credit accuracy. Log loss
alone clips probabilities at epsilon=1e-15. Bin Wilson intervals are descriptive,
not tournament forecast uncertainty.
Static SVG charts display both held-out and retrospective calibration, with
bin sample sizes and empty bins omitted. They need no extra plotting dependency.
The reported side is chosen by a fixed low bit of SHA-256 over
forecast-side-v1: plus the set ID, independently of outcomes and seeds. On a
swapped row, both probability and outcome are complemented; player/entrant order
is swapped consistently, with source order and a flag retained for audit.
Training/source records are unchanged and each set is counted once. This keeps
accuracy/Brier/log loss unchanged apart from floating-point rounding, while
making AUC/calibration independent of the source's favored first-slot convention.
The rule was introduced after observing source-slot imbalance in a three-event
diagnostic; its salt was not tuned for balance or model performance. Approximate
balance is not guaranteed, and event dependence remains.

Each report is content-addressed with its dataset hash and an implementation
fingerprint. The expanded report also contains a deterministic paired
event-cluster percentile bootstrap: 10,000 fixed-seed replicates compare each
model with higher seed on the same target sets and report descriptive 95%
intervals for accuracy, Brier, and log-loss differences. This is not an
individual-forecast interval or a confirmatory superiority test. Reports retain
`productize:false` and `selectedModel:null`; no title/top-eight validation exists
yet. The older Nikki-based tournament-forecast scripts remain separate and
unmodified; their readiness checks do not validate this system.

### Nested out-of-sample hyperparameter tuning

The completed nested rolling-origin run compares 24 frozen configurations over
83 whole-event outer folds and 74,891 held-out sets. After a 16-event warm-up,
each outer fold selects settings using only completed earlier inner event folds.
Selection minimizes event-macro log loss and applies a paired one-standard-error
rule that prefers the default-nearest setting. The strict and seed-assumed runs
remain separate evidence modes.

| Model | Strict log loss / Brier | Seed-assumed log loss / Brier |
|---|---:|---:|
| Neutral | 0.6931 / 0.2500 | 0.6931 / 0.2500 |
| Higher seed | 0.6931 / 0.2500 | 0.5503 / 0.1824 |
| Recency Elo | 0.5823 / 0.1972 | 0.5823 / 0.1972 |
| Glicko-2 | **0.5525 / 0.1876** | 0.5525 / 0.1876 |
| Dynamic Bradley-Terry | 0.5936 / 0.2051 | 0.5936 / 0.2051 |
| Regularized BT + seed + form | 0.5629 / 0.1903 | **0.5085 / 0.1689** |

The stable research settings are Elo **K=64, 730-day half-life**, Glicko-2
**initial RD=500**, and dynamic Bradley-Terry **730-day half-life, ridge=1**.
Their strict tuned-versus-frozen log-loss intervals are wholly below zero.
Regularized Bradley-Terry's primary tuning intervals cross zero in both evidence
modes and some folds hit optimizer or history-availability fallbacks, so it keeps
its frozen defaults pending an optimizer repair and retest. Its large seed-assumed
lift is evidence about historical seed availability, not reliable tuning gain.

These are retrospective realized-matchup diagnostics, not snapshot-verified
bracket or title backtests. No model family is selected and `productize` remains
false. Full settings, paired intervals, hashes, and decisions are in
[Six-model out-of-sample tuning results](forecast-tuning-results.md).

### Feature-expanded regularized Bradley-Terry model

The user's proposed model combining player history, seed and opponent identity
is implemented as the regularized Bradley–Terry extension. Its match-level
logistic predictor compares L2-regularized categorical player abilities, an
initial-seed log ratio, and pre-event recency-decayed opponent-adjusted form.
Player IDs are categorical identities, never numeric measurements. Opponent
identity enters through the opposing player's learned ability and history.

Start with regularized player strength/history, then test adding seeds, then
character-matchup features only if a reliable pre-event source is available.
Use the same chronological target folds for comparisons; select penalties and
other tuning choices using earlier training events only. Swapping players must
complement the probability, not introduce a first-bracket-slot advantage.
The feature scales and coefficients are learned only from each fold's training
sets. Nested tuning tested a frozen one-at-a-time penalty and form-decay grid,
but its primary log-loss improvement was not stable; the regularized model
therefore retains its frozen defaults until optimizer reliability is improved
and the grid is retested. This is the sixth planned model, not a seventh model,
and remains experimental.

Character choices actually observed during the target event are future
information for a pre-event forecast. Past character profiles can also be stale
or incomplete and need coverage reporting, missing-value handling and switching
uncertainty. The current dataset has no character-selection collection.
Predict each possible pairwise matchup first; the separate bracket simulator
must combine possible paths to title/top-eight probabilities, rather than
feeding the realized future opponent path into a pre-event model.

The [BradleyTerry2 methodology](https://stat.ethz.ch/CRAN/web/packages/BradleyTerry2/vignettes/BradleyTerry.html)
describes player and contest covariates; the
[glmnet authors' vignette](https://hastie.su.domains/Papers/Glmnet_Vignette.pdf)
describes regularized logistic fitting. These support the model family, not a
claim that these particular Melee features will improve prediction.

Start.gg exposes set.games[].selections[].character when character choices were
reported ([set game data](https://developer.start.gg/docs/examples/queries/set-game-data/)).
Winner-only reporting is also supported, so a completed set does not guarantee
game/character coverage ([reporting options](https://developer.start.gg/docs/examples/mutations/report-set/)).
A future feasibility screen should sample deterministic eligible sets across
early, middle and final phases of several training majors, checking two-sided
entrant attribution and reconciliation against set scores. Do not infer players
from selection-array order. No authenticated character-data sampling or new
character ingestion has been performed yet.

## Storage measurement and projections

~~~sh
nice -n 10 npm run forecast -- storage
~~~

Run this after ingestion/evaluation finishes, with no other CLI writer running.
It checks the canonical dataset hash and, when present, the selected evaluation
hash and dataset relationship. Stale evaluation output fails closed instead of
mixing generations. Without an evaluation, only dataset storage is projected.

The inventory measures logical file bytes and filesystem allocated blocks for
all cache, raw, dataset and report generations; it does not read file contents
for that inventory. Symlinks and temporary writes are refused. Its own storage
reports are excluded to avoid self-counting. No files are deleted or uploaded.

Database scenarios assume one canonical collection entry per row and one selected
prediction run, excluding cache/raw duplication. For each table, report measured
UTF-8 JSON payload bytes, then show payload factors of 1×/1.5×/2×, an assumed
64-byte per-row overhead budget, two indexes budgeted at 64 bytes per entry,
8 KiB page rounding, and a separate 30% operating allowance. These factors are
planning choices, **not** measured JSONB expansion, confidence bounds, or a promise
of actual Supabase capacity. No schema or cloud connection has been created.

Actual storage depends on column types, page packing and indexes
([PostgreSQL page layout](https://www.postgresql.org/docs/18/storage-page-layout.html)),
and compression/out-of-line storage
([TOAST](https://www.postgresql.org/docs/18/storage-toast.html)). A later approved
schema can be measured using pg_table_size, pg_indexes_size and
pg_total_relation_size
([database size functions](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE)).
The current scenarios exclude WAL, backups, replicas, catalogs, quality/report
documents and future prediction runs. Do not extrapolate selected-event averages
to all 211 offline majors: field sizes and overlapping player identities vary.

Current expanded measurement: the canonical JSON is **379,603,382 bytes** and
retained local research state is **2,813,648,522 logical bytes**. The
1×/1.5×/2× planning scenarios with 30% headroom are **687,367,783**,
**973,927,220**, and **1,260,507,956 bytes**. These replace the initial small-
sample estimates; they still are not measured database sizes.

## Verification

~~~sh
npm run test:forecast
npm run lint
npm run build
~~~

The current fixture suite contains **224 tests**. Tests use synthetic fixtures
and mocked network responses, never credentials or live events. Coverage
includes cache/offline replay, pagination failures,
credential suppression, registry gates, source hashes, identities, cleaning,
determinism, and CLI source-to-dataset integration. CI runs this fixture suite.
The first live authenticated acceptance check passed on Riptide 2025: 489
entrants, 1,719 bracket rows and 923 eligible played sets. The source and
normalized dataset hashes reproduced exactly offline. Two completed non-bye
sets lack numeric scores and remain excluded; no scores were invented from
their W/L text. One tag collision remains two distinct player identities. Eligible
outcomes cover 465 of 489 entrants; all 489 initial-phase seeds are retained
separately from 120 advancement-phase seeds. The 977 non-bye source outcomes
reconcile to double elimination with a grand finals reset, but exact graph and
simulator validation remain outstanding. These observations are not evidence of
forecasting performance.

Liquipedia-derived registry content is attributed to Liquipedia contributors
under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), with source
links and snapshot date preserved. The bundled source is never rewritten here.
