# Tournament Forecast Research Plan

> Status: **in progress — six-model diagnostics, the refreshable Riptide pairwise report, and a bundled website seed-scenario explorer are complete**. Historical tournament backtests and a validated full-field simulator are not complete. Research sources and full reports stay local; only the reviewed public-data derivative is bundled into the app. Do not upload forecast data or model output to Supabase until chronological out-of-sample results show that the system is useful.

## Goal

Build and evaluate models that forecast an upcoming Melee major using results from prior majors. The initial output is an internal research tool: it should explain each model, show honest in-sample and out-of-sample performance, and produce reproducible event predictions.

The first live case study will be the next Riptide, but the pipeline must work for any major rather than learning Riptide-specific rules.

See the [concise prediction TODO and acceptance checklist](docs/predictions-todo.md)
for the current status of all ten roadmap items.

## Data sources

- **Liquipedia snapshot already in the repository:** canonical major names, dates, tiers, winners, and runner-ups.
- **Start.gg:** entrants, seeds, completed sets, scores, bracket rounds, placements, and the official bracket for an upcoming event.
- **Nikki replay archive:** optional explanatory replay-derived features for safely identified players. These features enter a predictive model only if leakage-safe backtests show an out-of-sample improvement.

Start.gg ingestion will require a developer token stored locally in an ignored `.env.forecast.local` file. No credential belongs in source control.

## Build roadmap

1. **Major registry**
   Match the bundled Liquipedia major list to the corresponding Start.gg tournaments and events. Record source IDs, dates, tier, format, and mapping confidence.

2. **Start.gg downloader**
   Download entrants, seeds, full completed-set results, scores, rounds, bracket structure, and final standings. Cache source responses locally so experiments are reproducible and do not repeatedly hit the API.

3. **Canonical local dataset**
   Normalize events, players, aliases, entrants, seeds, sets, and standings into a compact local research dataset. Preserve source identifiers and provenance on every record.

4. **Cleaning and identity resolution**
   Remove byes, DQs, unfinished sets, and duplicates. Resolve player aliases conservatively, report ambiguous mappings, and keep unresolved players anonymous rather than guessing.

5. **Model suite**
   Evaluate models of increasing complexity:

   - Neutral 50/50 baseline
   - Higher-seed baseline
   - Recency-weighted Elo
   - Glicko-2
   - Dynamic Bradley-Terry
   - Regularized Bradley-Terry with recent-form features

6. **Evaluation framework**
   Report both fit and generalization quality:

   - In-sample accuracy, Brier score, log loss, AUC, and calibration
   - Chronological out-of-sample versions of the same metrics
   - Prediction coverage and exclusions
   - Performance against the neutral and seed baselines

7. **Historical major backtests**
   Forecast each historical major using only information available before that event. Record predicted winner probabilities, top-eight probabilities, calibration, and realized outcomes.

8. **Upcoming-event simulator**
   Support two forecast modes:

   - A provisional field simulation before the official bracket is published
   - An exact double-elimination simulation after entrants, seeds, and bracket positions are official

9. **Local comparison report**
   Produce an internal report that compares methodology, validation results, calibration, historical forecasts, and the current upcoming-event prediction. Keep assumptions and forecast cutoffs visible.

10. **Storage report**
    Measure the actual local dataset and model-output sizes, then estimate Supabase table and index storage. Do not upload anything during this phase.

## Validation rules

- Every historical prediction must use a strict pre-event cutoff.
- Model selection must be based on chronological out-of-sample performance, not training fit.
- Seeds are a strong real-world baseline and must be included in every comparison.
- Report uncertainty and calibration, not only the most likely winner.
- More complex features stay out unless they improve leakage-safe out-of-sample results.
- If no model reliably beats both the neutral and seed baselines, label the forecaster experimental and do not productize it.

## Expected storage

The first pass should contain tens of thousands of sets and a few thousand player/entrant rows. A compact local dataset is expected to be roughly **10–50 MB**, with a future indexed Postgres/Supabase version likely remaining **under 100 MB**. These are planning estimates; the storage report will replace them with measured figures after ingestion.

Initial measurement: the full canonical Riptide 2025 snapshot is **3,649,255 bytes**
for 1,719 bracket rows, 489 entrants, 609 seeds and provenance. This includes
excluded bracket rows; cache/raw copies and model output are separate. The
original multi-event and Postgres estimates were unvalidated planning guesses,
not storage limits. The latest five-event canonical snapshot is **48,117,350
bytes**, and retained local research files total **256,432,778 logical bytes**
(including cache, raw responses, older snapshots and reports). Hypothetical
database capacity scenarios with a 30% operating allowance span **81,448,141 to
148,466,074 bytes**; these are assumption-based budgets, not measured Postgres
sizes or confidence bounds. After the six-model reports and an unverified
upcoming-event source snapshot, retained local research files total **267,115,628
logical bytes**; the current 1×/1.5×/2× hypothetical database budgets are
**83,514,164**, **118,029,517** and **152,598,119 bytes**. The original
under-100-MB guess is not a safe cap. After the complete Riptide preview bundle
and refreshable matchup artifacts, retained local files total **296,338,685
logical bytes**; the hypothetical database budgets are unchanged because the
unfinished target bundle is not part of the historical schema projection.

## Deliverables before broader productization

- Reproducible source-to-dataset pipeline
- Data quality and identity-resolution report
- Side-by-side model methodology guide
- In-sample and chronological out-of-sample scorecard
- Calibration plots and baseline comparisons
- Historical major backtest report
- Upcoming-event forecast with assumptions and cutoff
- Measured local size and projected Supabase storage
- Recommendation to proceed, revise, or stop

## Current state

The repository's early Nikki-archive Bradley-Terry experiment and bracket simulator
remain separate and unchanged. The new local research CLI is implemented at
scripts/forecast.mjs; see [setup and methodology](docs/forecast-research.md).

### Roadmap status — 2026-09-09

The local pipeline is verified on multiple 2025 majors. This does not mean
completed all-major coverage or evidence of forecasting usefulness.

| # | Item | Status | Remaining acceptance work |
|---|---|---|---|
| 1 | Major registry | In progress: 5 API-verified majors | Expand coverage of 211 offline majors; 16 online rows retained/excluded |
| 2 | Start.gg downloader | Implemented; five historical events plus a complete 2,773-row Riptide 2026 observed-response bundle | Expand source coverage; preserve fail-closed completeness and preview-shard checks |
| 3 | Canonical local dataset | Five-event historical snapshot saved: 4,502 players, 8,208 eligible sets; upcoming event retained separately | Expand historical source coverage; do not mix unfinished target rows into training |
| 4 | Cleaning and identity resolution | Five-event audit complete; current Riptide report resolves 565 public identities with zero invalid source rows | Continue source audits; exact simulator must validate opaque cross-phase routing |
| 5 | Model suite | Six of six planned models implemented and compared | Broader data, nested training-only tuning, uncertainty and selection decision |
| 6 | Evaluation framework | Core implemented: four chronological holdouts, 6,244 test sets and calibration charts | Event-cluster uncertainty and selection criteria |
| 7 | Historical major backtests | Tournament-level backtests not started; set-level diagnostic framework implemented | Historical title/top-eight forecasts and tournament probability evaluation |
| 8 | Upcoming-event simulator | In progress: 216 refreshable pairwise forecasts plus a bundled deterministic Top-16/Top-8 seed-scenario explorer | Provisional full-field and exact double-elimination title/top-eight simulation; graph/reset validation |
| 9 | Local comparison report | Six-model comparison, stable Riptide matchup Markdown, and a website tournament/model path explorer saved | Add reviewed tournaments and website refresh flow; complete historical tournament forecasts and the final proceed/revise/stop recommendation |
| 10 | Storage report | Refreshed: 296,338,685 local logical bytes; projection report complete | Refresh as data grows; scenarios remain unvalidated until a schema is measured |

### Milestone 1 — local data foundation

- CLI commands: registry, map, download, normalize, status.
- Local token file is ignored; cache and output live only under ignored .forecast/.
- Downloaded queries and completed bundles are hash-checked; offline repeats are reproducible.
- Canonical identities use public source IDs, never tag matching; excluded sets remain auditable.
- Initial registry was generated from 227 bundled majors: 211 offline and 16 excluded online.
- One Riptide 2025 event URL is recorded as a candidate, not a verified source mapping.
- Credential-free tests and CI wiring cover cache, pagination, registry, cleaning and CLI integration.
- No forecast data or model output uploaded. No predictive usefulness claimed.

### Milestone 2 — first authenticated source-to-dataset run

- Riptide 2025 Melee Singles: Start.gg event **1285893**, tournament **744261**.
- Downloaded 489 entrants/players, 1,719 bracket rows, 489 standings, 609 phase
  seeds and 22 phase groups across four phases.
- 923 eligible played sets; 796 excluded rows retained for audit and bracket
  reconstruction. Exclusion reasons overlap: 742 bye/empty-slot rows, 52 DQs,
  and two completed non-bye sets with no numeric scores.
- Eligible outcomes cover 465 of the 489 entrants; 24 have no eligible played sets.
- One normalized-tag collision (two distinct public player IDs) remains separate.
  No anonymous players, duplicate set copies or entrant identity conflicts in this event.
- Champion Zain and runner-up Cody Schwab agree with the bundled Liquipedia row.
  All 977 non-bye source outcomes reconcile to double elimination with a grand
  finals reset; this checks result counts, not simulator/graph correctness.
- Both offline source re-download and re-normalization reproduced the original
  SHA-256 hashes with networking prohibited for the verification run.
- All 609 seeds remain marked unverified-historical; fetching them after the
  event does not prove they were available before it.
- Source phaseOrder values are not chronological (Top 8 appears before R2
  Pools); future simulation must validate bracket routing, not trust that order.
- 130 eligible sets completed before the nominal event.startAt, and 608 have
  identical startedAt/completedAt values. Future backtests must hold out the
  entire target event by ID, use a conservative tournament-start cutoff until
  schedule timing is validated, and never treat these timestamps as durations.
  One set is timestamped nine seconds before its prerequisite, so raw completion
  time is not sufficient to order historical Elo updates either.
- 74 fixture tests and lint pass. Token file is Git-ignored, permissions 600;
  all 155 current research files were checked without finding the credential.
- Data remains local under .forecast/; no forecast or model output was published.

### Milestone 3 — first chronological model diagnostics and measured storage

- Four complete events: GENESIS X2, Battle of BC 7, GOML: Forever and Riptide
  2025. Supernova remains outside the dataset while its 10,000-row API result
  window is addressed; incomplete cached pages are never accepted as an event.
- Canonical snapshot: 2,336 stable public player identities, 2,349 aliases,
  2,698 event entrants, 3,410 phase seeds and 12,354 bracket rows. Of those rows,
  4,917 are eligible; excluded rows remain available for audit.
- No anonymous players, duplicate source sets or identity conflicts in this
  snapshot. There are 37 normalized-tag collision groups and 13 identities with
  multiple observed aliases; neither condition is resolved by guessing names.
- All four champion/runner-up pairs match the bundled Liquipedia outcomes.
  Battle of BC contributes 658 eligible sets, 928 byes and 60 DQs; its 718
  non-bye outcomes reconcile to 359 entrants with two losses and undefeated Zain.
- Whole-event holdouts yield 2,953 predictions over three target events.
  GENESIS is the initial training event. Models remain frozen throughout targets.
- Initial held-out scores (not model selection): neutral Brier 0.2500/log loss
  0.6931; historical-seed baseline 0.1504/0.4785; recency event-batch Elo
  0.2341/0.6605. Elo has prior observations for both players in only 10.7% of
  target sets; broader training coverage is needed.
- Seed coverage is 100% under the disclosed historical-availability assumption,
  but 0% under strict pre-cutoff observation requirements. The strict seed
  sensitivity report therefore falls back to 50/50 everywhere.
- Late reported completions now exclude the entire training event when they
  reach a target cutoff. Source timestamps still cannot prove the availability
  of subsequent corrections. No target outcomes enter training.
- A fixed outcome-independent SHA-256 side rule is applied for reporting only,
  after detecting a first-source-slot win imbalance. The salt was not tuned;
  source order is retained. Each match is counted once, and side-symmetric
  accuracy/Brier/log loss are unchanged.
- Canonical JSON: **24,027,153 bytes**. Measured retained local files at this
  checkpoint: **101,098,001 logical bytes**, including partial Supernova cache,
  prior generations and both seed-mode reports. Hypothetical table/index budgets
  including a 30% allowance span **40,724,071–74,089,268 bytes** across explicit
  1×/1.5×/2× payload-factor scenarios; these are not Postgres measurements or
  confidence bounds. No cloud schema, connection or upload was created.
- Dataset SHA-256: 7209deea750c2768c56fe8dfc5dc0f33ab8bc407ccf9b01900af1c4b01921bec.
  Default comparison run: 674ed4c0906daed6d1b2053934e20478cc217d195a21d823c4bfc13cf7d2dbe4.
  The current artifact paths are in .forecast/latest-evaluation.json and
  .forecast/latest-storage.json. All outputs remain experimental and local.

### Milestone 4 — complete five-event checkpoint and large-event pagination

- Supernova 2025 is now complete: 2,422 entrants, 146 phase groups and 12,870
  unique bracket rows. Queries split by official phase-group IDs avoid the
  event-wide 10,000-row API window; shard counts and the final union reconcile.
  Offline reproduction yields the same source hash, and smaller-event source
  bundles retain their original hashes. This is a reproducible set of observed
  responses, not a guaranteed atomic snapshot of the upstream service.
- Supernova contributes 3,291 eligible sets. Excluded rows include 8,028
  byes/empty placeholders, 1,443 DQs and 108 completed non-DQ sets lacking
  numeric scores. All 4,842 completed two-entrant outcomes reconcile to double
  elimination without a reset. Zain/Cody Schwab match the Liquipedia outcome.
- One public player ID is attached to two Supernova entrants. Both registrations
  have only DQ outcomes and contribute no eligible sets. The quality report
  flags the shared identity while preserving the distinct entrant records.
  Three cross-phase seed-progression references connect different entrants;
  these must not be assumed identity-preserving simulator edges. Source set
  timestamps also contain reversed prerequisite ordering.
- The complete dataset contains five events, 4,502 player identities, 4,528
  aliases, 5,120 entrants, 6,416 phase seeds and 25,224 bracket rows: 8,208 eligible
  and 17,016 excluded. There are no anonymous players or duplicate source sets;
  95 normalized-tag collision groups and 26 multi-alias identities remain
  separate/linked by public IDs, never guessed from names.
- Four whole-event holdouts yield 6,244 test sets. Held-out Brier/log loss:
  neutral **0.2500/0.6931**, historical-seed baseline **0.1892/0.5691**, recency
  event-batch Elo **0.2353/0.6628**. Both players have prior Elo observations in
  only **9.1%** of target sets. Seed coverage remains 100% under the disclosed
  historical-availability assumption and 0% in strict observation mode.
  These diagnostics do not select a model or establish forecasting usefulness.
- Canonical JSON is **48,117,350 bytes**. Retained local research files measure
  **256,432,778 logical bytes**, including older immutable generations. The
  assumption-based database scenarios with 30% allowance are **81,448,141**,
  **114,941,133** and **148,466,074 bytes**, not measured database storage.
- The proposed player-history + seed logistic model is documented as the
  planned regularized Bradley-Terry extension, not a seventh model and not yet
  implemented. Character features require a historical coverage check; no
  character-selection data has been ingested. Bracket-path probabilities remain
  a separate simulator task, with no realized future opponents as model input.
- Dataset SHA-256: 90b7c09e4b613a2882fe9618c28da9b880480508113344c1f876aa64afae44a9.
  Default comparison run: 33d232d8662bccce25cfd169b168ed359d0746cd4fdd6d57e8ae660ff2086c72.
  Storage report: 1ef800a3ebaea662995295d078405a59892304a62ef321da527e3c5b43f9114b.
- 124 credential-free tests pass. All forecast data and model reports remain
  local and experimental; no cloud upload or product integration was performed.

### Milestone 5 — complete planned model suite

- All six planned pairwise models now share the same four chronological
  whole-event holdouts and 6,244 target sets: neutral 50/50, historical higher
  seed, recency-weighted event-batch Elo, event-period Glicko-2, dynamic
  Bradley-Terry, and L2-regularized Bradley-Terry with categorical player
  abilities, initial-seed difference and recent opponent-adjusted form.
- Player IDs are categorical identity keys, never numeric magnitudes. All new
  models are deterministic and freeze target-event predictions. Glicko-2 uses
  simultaneous event rating periods; dynamic Bradley-Terry fits event outcomes
  jointly around elapsed-time-decayed prior skills; recent form uses only prior
  event states. None trusts within-event source timestamps.
- Held-out Brier/log loss under the explicitly unverified historical-seed
  assumption: neutral **0.2500/0.6931**; seed **0.1892/0.5691**; Elo
  **0.2353/0.6628**; Glicko-2 **0.2267/0.6436**; dynamic Bradley-Terry
  **0.2435/0.6787**; regularized Bradley-Terry + seed + form
  **0.1775/0.5531**. The combined model improves these two point estimates over
  the seed baseline, but is overconfident in extreme calibration bins and is
  not selected or validated on only five majors.
- In strict seed-observation mode, no historical seeds qualify. The combined
  model then uses player ability and form only, scoring **0.2222 Brier** and
  **0.6324 log loss**. Only 9.1% of held-out sets have both players represented
  in earlier selected majors, so expanding chronological history is the next
  evidence requirement.
- Character is deliberately absent: the current source has no character
  selection collection, and actual target-event choices would leak future
  information. Historical character features remain conditional on a separate
  attribution and coverage audit.
- The September 4 Riptide 2026 source snapshot had 565 entrants but no published
  phases, seeds or bracket rows. That checkpoint was superseded by the complete
  September 7 preview-bracket bundle described in Milestone 6. Upcoming rows
  remain separate from the canonical historical training dataset.
- Default comparison run:
  57d348b1fa4846a4d0e45bce04d35497abbcc7ccd0fff2628421c7666346b313.
  Strict-seed sensitivity run:
  891c06a1489186b2c9ba14572d7f1d112cbfa306d8198db90c7c4b2e305f4621.
  Current storage report:
  43e90fb226b486c03e133e6f8494cbd0bc8afbe5105a142f704cde881c49b0e0.
- 144 credential-free tests pass. Lint and diff checks pass. No result has been
  uploaded, published, selected for product use or incorporated into the web UI.

### Milestone 6 — refreshable Riptide matchup report

- Riptide 2026 now has a complete local observed-response bundle: 565 entrants,
  four phases, 38 unique phase groups, 717 phase seeds, 2,773 unique set rows
  and zero standings. R1 Pools has one unambiguous full-field seed phase with
  ranks 1–565. The raw source SHA-256 is
  `d804b651ddd2fa5d72cd612673e6076fb16eb5701739256d4315d26dafe22796`.
- Every current set ID is a synthetic Start.gg `preview_*` ID and the event state
  is `CREATED`; all pairings are provisional and timestamped. The source bundle
  reconciles every paginated collection but is not an atomic upstream snapshot.
- Event-wide preview pagination repeated identical IDs at unstable page
  boundaries. The downloader now switches only that condition to one complete
  official phase group per shard, validates membership and uniqueness, and
  requires the 38-group union to equal the reported 2,773 rows. Real duplicates
  and incomplete unions still fail closed.
- The live report contains 216 currently determined unplayed matchups: 45 direct
  seed-vs-seed rows and 171 rows whose two feeder results are completed Start.gg
  auto-advance byes. Populated entrants behind incomplete feeders and opaque
  later-phase seed projections remain unresolved. All 2,773 source rows receive
  a fixed, unresolved, bye, completed or invalid audit status; this snapshot has
  zero invalid rows and zero played rows.
- Each fixed matchup is scored by the regularized Bradley-Terry + seed + recent-
  form model fitted on 8,208 eligible sets from five completed 2025 majors.
  Markdown shows raw estimated set win chance, empirical held-out favorite rate
  for its strength bucket, both players' prior-set counts and feature coverage.
  Historical seed availability remains an explicit post-event-snapshot
  assumption, and extreme probabilities remain overconfident.
- `npm run forecast:riptide` refreshes Start.gg, reconstructs the complete bundle,
  refits locally and atomically replaces `.forecast/riptide-2026-4-matchups.md`.
  The default board is a 27-pool overview with each pool sorted from highest to
  lowest model estimate, plus the 12 closest calls; it links to a separate dense
  216-row matchup table. A failed run leaves both previous
  reports intact. Immutable JSON/Markdown copies and a hash-linked manifest
  preserve every successful report generation.
- The report is pairwise only. It does not invent future opponents, fill the
  bracket with chalk or claim title/top-eight probabilities; the exact double-
  elimination simulator remains Roadmap item 8 acceptance work.
- Refreshed retained local research size is **296,338,685 logical bytes**. The
  unchanged assumption-based 1×/1.5×/2× database budgets are **83,514,164**,
  **118,029,517** and **152,598,119 bytes**. Nothing was uploaded or added to the
  dashboard runtime.
- Current matchup-report run:
  `683713af3606e9bd14fd97230f4a534ec7a3ac1c4570298fb9169c56776fbb2f`.
  Current storage report:
  `baf23d5268f8f3105e73dca7c8461208db7576dc1b877923e513c7371ed47a47`.
  All 153 credential-free forecast tests, lint and diff checks pass.

### Milestone 7 — bundled Riptide seed-scenario website explorer

- The dashboard now has a bundled tournament-prediction catalog and a
  Predictions surface with tournament and model selectors. Riptide 2026 is the
  first bundled tournament; the catalog shape supports additional reviewed
  events without a runtime Start.gg request.
- The model selector exposes all six existing research models and redraws a
  deterministic Top-16 qualification scenario, projected Top-8
  double-elimination path, final, and path winner. Every model starts from the
  same documented seed-projected Top-16 field so model comparisons do not
  silently change their input bracket.
- Match cards show the raw conditional set probability for each player. These
  numbers are neither confidence intervals nor title odds. The displayed
  champion is the result of repeatedly advancing the higher pairwise estimate;
  the neutral model's 50/50 rows use the lower seed number only as an explicit
  display tie-break.
- This is a **seed-projection scenario**, not a source-confirmed full-field
  simulation. The Start.gg event remains a provisional `CREATED` preview, and
  five R1 groups (`J205`, `L204`, `M203`, `M205`, and `M206`) contain no set
  rows in the observed response. Their 88 entrants prevent a complete upstream
  bracket simulation from being claimed.
- Cross-phase progression determines the R1 → R2 → Top 16 → Top 8 sequence;
  the inconsistent source `phaseOrder` values are not used as chronology. A
  future exact simulator must still validate every winner/loser edge and the
  conditional grand-final reset.
- This milestone does not complete Roadmap items 7 or 8: no historical
  tournament-level backtest, probabilistic title/top-eight distribution, or
  validated full-field simulation has been added. The remaining work and its
  acceptance boundary are tracked in
  [the prediction TODO](docs/predictions-todo.md).
- The production build and all **163** credential-free forecast tests pass.
  Desktop and phone-sized browser checks confirm that model changes redraw the
  downstream path; the local page logged no runtime errors.
