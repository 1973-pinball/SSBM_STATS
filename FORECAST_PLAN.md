# Tournament Forecast Research Plan

> Status: **in progress — the strict 2018–2025 historical corpus, source and identity audits, six-model suite, 24-configuration nested out-of-sample tuning, accepted retrospective double-elimination pilot, Riptide path explorer, and public six-model backtest visualization shipped in v0.4.6 are complete**. A generic probabilistic full-field simulator and final model-family decision remain open; snapshot-safe historical title validation is optional follow-on evidence, and automatic public refresh stays last. Research sources and full reports stay local; only reviewed aggregate or public-data derivatives may be bundled into the app. Do not upload forecast data or model output to Supabase until tournament-level validation supports productization.

## Goal

Build and evaluate models that forecast an upcoming Melee major using results from prior majors. The research pipeline remains local, while v0.4.6 publishes only a reviewed sanitized derivative that explains each model, shows honest out-of-sample performance, and illustrates reproducible event predictions.

The first live case study is Riptide 2026, but the pipeline must work for any major rather than learning Riptide-specific rules.

See the [concise prediction TODO and acceptance checklist](docs/predictions-todo.md)
for the current status of all ten roadmap items.

## Data sources

- **Liquipedia snapshot already in the repository:** canonical major names, dates, tiers, winners, and runner-ups.
- **Start.gg:** entrants, seeds, completed sets, scores, bracket rounds, placements, and the official bracket for an upcoming event.
- **Nikki replay archive:** optional explanatory replay-derived features for safely identified players. These features enter a predictive model only if leakage-safe backtests show an out-of-sample improvement.

Start.gg ingestion requires a developer token stored locally in an ignored `.env.forecast.local` file. No credential belongs in source control.

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
   Exercise the tournament simulator against reviewed historical brackets and retain the retrospective-source caveat. Immutable pre-event snapshots are optional follow-on evidence if confirmatory title-odds claims are later required.

8. **Upcoming-event simulator**
   Support two forecast modes:

   - A provisional field simulation before the official bracket is published
   - An exact double-elimination simulation after entrants, seeds, and bracket positions are official

9. **Reports and model decision**
   Produce an internal report that compares methodology, validation results, calibration, historical forecasts, and the current upcoming-event prediction. Keep assumptions and forecast cutoffs visible.

10. **Storage and portability**
    Measure the actual local dataset and model-output sizes, estimate Supabase table and index storage, and document clean-clone versus exact-research transfer. Do not upload research artifacts during this phase.

## Validation rules

- Every historical prediction must use a strict pre-event cutoff.
- Model selection must be based on chronological out-of-sample performance, not training fit.
- Hyperparameters must be selected only inside earlier inner whole-event folds;
  outer target events may score a frozen choice but may never choose it.
- Keep proven pre-event seed evidence separate from explicitly availability-
  assumed sensitivity results. Never merge or relabel the latter as snapshot-safe.
- Seeds are a strong real-world baseline and must be included in every comparison.
- Report uncertainty and calibration, not only the most likely winner.
- More complex features stay out unless they improve leakage-safe out-of-sample results.
- If no model reliably beats both the neutral and seed baselines, label the forecaster experimental and do not productize it.

## Expected storage

The strict 84-event canonical JSON is **379,603,382 bytes**. After the expanded
evaluation, tuning checkpoints, retained local cache, raw evidence, historical
generations, reports, and target-event work total **2,813,648,522 logical
bytes**. The measured value
replaces the original 10–50 MB planning guess; an ordinary GitHub blob cannot
hold the canonical file.

Assumption-based database scenarios, including one 74,891-row prediction run
and a separate 30% allowance, are **687,367,783**, **973,927,220**, and
**1,260,507,956 bytes** for the 1×/1.5×/2× payload cases. These are planning
budgets, not measured PostgreSQL sizes or confidence bounds. No schema,
connection, or upload has been created.

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

The registry, acquisition, canonical dataset, source-readiness gate, and
identity/outcome audit are complete for the selected 2018–2025 scope. This is
not all-years coverage: 85 of the broader registry's 211 offline majors are
mapped, and one scoped event is quarantined rather than trained on.

| # | Item | Status | Remaining acceptance work |
|---|---|---|---|
| 1 | Major registry | Complete for 2018–2025: all 85 selected offline singles majors are API-verified (14/12/2/6/16/12/13/10 by year); 16 online events are retained and excluded | Broader optional expansion remains 85 of 211 offline majors mapped |
| 2 | Start.gg downloader | Complete for scope: all 85 acquired with hash-checked provenance; 84 ready and one quarantined | Continue fail-closed refresh support as upstream data changes |
| 3 | Canonical local dataset | Complete: strict 84-event dataset with 18,421 players, 44,022 entrants, and 77,270 eligible sets | Keep future generations contract- and source-gated |
| 4 | Cleaning and identity resolution | Complete for accepted corpus: zero structural conflicts and all 84 winner/runner-up outcomes reconciled, including 10 advisory corroborations | Do not turn tag history into model identity joins; route audits belong to simulator work |
| 5 | Model suite | Complete: six of six planned models and a frozen 24-configuration tuning grid implemented | Repair regularized-BT convergence before considering a wider grid |
| 6 | Evaluation framework | Complete for set-level tuning: 83 chronological outer folds, inner-only selection, 74,891 predictions, calibration, coverage, and paired event-cluster uncertainty | Optional snapshot-verified title metrics require pre-event evidence and are outside the current release scope |
| 7 | Historical major backtests | Complete for the accepted retrospective scope: engine and Scuffed pipeline pilot pass; strict mode has zero snapshot-valid historical targets and that limitation is accepted | Optional only: add pre-event snapshots if confirmatory title-odds claims are later required |
| 8 | Upcoming-event simulator | Reviewed DE pilot, pairwise forecasts, and deterministic Riptide seed-scenario explorer exist | Generic event registry, probabilistic full-field simulation, multi-phase routing, title/Top-8 odds, and live refresh |
| 9 | Reports and model decision | In progress: compact tuning report and public six-model backtest visualization complete; current decision is revise before productizing | Final family selection after simulator expansion; then rebuild reviewed website forecasts |
| 10 | Storage and portability | Complete after tuning: 379,603,382-byte dataset, 2,813,648,522 retained local bytes, and clean-clone/private-transfer instructions | Validate against a real schema only if a cloud design is later approved |

### 2018–2025 corpus expansion checkpoint — accepted dataset

- The tracked cohort is every bundled offline Melee singles major dated from
  2018 through 2025: **85 events**, with yearly counts **14, 12, 2, 6, 16, 12,
  13, and 10**. All 85 have exact API-verified Start.gg mappings. The registry
  also retains **16 online events** from this period as explicit exclusions;
  they are never eligible for the offline training corpus.
- `scripts/data/forecast-corpus-contract.json` freezes the scope and requires a
  reviewed terminal disposition for each event. `npm run forecast -- corpus`
  writes content-addressed contract, canonical-coverage, and source-readiness
  reports. `npm run forecast -- corpus --strict-corpus` fails until every event
  has a reviewed disposition and every included source is ready.
- `npm run forecast -- normalize --corpus` normalizes only the contract cohort;
  `npm run forecast -- normalize --strict-corpus` additionally enforces complete
  contract and included-source readiness. The accepted contract contains 84
  included events, one source-ambiguous event (GOML 2022), and zero unresolved
  decisions. Both strict corpus commands pass.
- Source readiness independently validates file type and path, SHA-256 digest,
  JSON shape, source IDs, reconciled connection counts, completed-event state,
  pagination/request provenance, and registry mapping. Fewer standings than
  entrants are recorded for review rather than treated as fabricated missing
  rows; impossible counts and duplicate or foreign entrant references fail.
- Two legacy Start.gg failures now have narrow, auditable recoveries. For EVO
  2018, the API advertises `PhaseGroup.startAt` but errors when it is resolved
  through the official phase-group connection, so that collection omits only
  the unreliable field while nested set phase-group metadata retains it. For
  CEO 2018, unstable event-wide `STANDARD` ordering repeated a set ID across
  pages, so the downloader replaced the collection with complete, disjoint
  official phase-group shards and still enforces membership, totals, and
  uniqueness. A true duplicate or incomplete shard union remains fatal.
- Normalization writes a hash-addressed advisory historical-outcome report. Of
  84 events, 74 match directly and 10 retain raw review signals that are fully
  corroborated through authoritative IDs, event-local aliases, or a validated
  championship-final path. There are zero unresolved outcome pairs. The audit
  never assigns or merges identities and never changes training eligibility.

### Milestone 1 — local data foundation

- CLI commands: registry, corpus, map, download, normalize, evaluate,
  bracket-report, storage, and status. Bulk acquisition uses
  `download --all-mapped`; corpus review uses `corpus [--strict-corpus]` and
  `normalize --corpus` or `normalize --strict-corpus`.
- Local token file is ignored; cache and output live only under ignored .forecast/.
- Downloaded queries and completed bundles are hash-checked; offline repeats are reproducible.
- Canonical identities use public source IDs, never tag matching; excluded sets remain auditable.
- The registry was generated from 227 bundled majors: 211 offline and 16
  excluded online. The selected 2018–2025 offline cohort contains 85 events,
  all API-verified, with yearly counts 14/12/2/6/16/12/13/10.
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

### Milestone 8 — strict 2018–2025 corpus and expanded model evidence

- All 85 scoped offline majors have API-verified mappings and downloaded source
  bundles. The contract includes 84 and quarantines GOML 2022 as
  `source-ambiguous`; it has zero unresolved decisions. Eggdog Invitational and
  Nounsvitational 2024 use their separate championship-stage events rather than
  the incomplete preliminary events first discovered.
- The strict canonical dataset is
  `e21eb6bf8d91b295b875ab11959e1beddae937d7816e5c7da1a2f13db3f6371d`:
  84 events, 18,421 players, 20,578 aliases, 44,022 entrants, 58,318 seeds,
  196,820 source set rows, 77,270 eligible sets, and 44,001 standings. Both
  strict corpus commands pass with authenticated source provenance.
- Dataset structure has zero duplicate/conflicting set rows, event conflicts,
  entrant conflicts, invalid seeds, or invalid standings. One anonymous entrant
  has no set rows, and one duplicated registration has only DQ outcomes.
- The outcome report preserves ten review signals—six Cody Schwab/iBDW tag-
  history cases, three Zain homonyms, and malformed Summit 14 standings—but
  corroborates all of them through authoritative IDs and constrained source
  evidence. All 84 events reconcile and none of this advisory evidence changes
  model input.
- Eighty-three rolling whole-event folds produce 74,891 held-out set forecasts.
  Regularized Bradley–Terry + seed + recent form leads with 76.45% accuracy,
  0.1576 Brier, 0.4753 log loss, and 0.8511 AUC. A deterministic paired
  10,000-replicate event-cluster bootstrap makes it the only model whose 95%
  descriptive intervals favor it over higher seed on accuracy, Brier, and log
  loss. This is not yet tournament-title validation or automatic selection.
- The updated evaluation run is
  `6541f6da58ca5bb2975ae9b3668ac518b6ff541fb0469f311429c5b854573249`.
  The updated storage report is
  `b2e2db921b93f2bd291b616a338fc2a2c3d626491b2b5d933fdacaca15ed4f33`.
  The later bracket and tuning milestones below raised retained local research
  state to **2,813,648,522 logical bytes**; no data or model output was uploaded.

### Milestone 9 — historical double-elimination backtest pilot

- A leakage-safe tournament-backtest engine now holds out an entire target
  event, audits its double-elimination graph, freezes pairwise predictions, and
  can score probabilistic title and Top-8 outcomes when a qualifying pre-event
  bracket snapshot exists.
- Scuffed World Tour 2022's reviewed 16-player, single-phase graph exercises the
  pipeline end to end. It is an exploratory reconstruction, not confirmatory
  evidence: its available bracket and seed data were observed after the event.
- Strict snapshot gating therefore admits **zero historical target events**.
  No title-calibration result or tournament-level model ranking is claimed. The
  owner accepts this retrospective limitation for the current scope, so Roadmap
  item 7 is complete without making a confirmatory title-odds claim.

### Milestone 10 — nested tuning and public comparison evidence

- The frozen 24-configuration grid was evaluated with nested chronological
  whole-event validation: inner earlier-event folds select hyperparameters and
  83 outer folds score 74,891 held-out sets. The strict tuning run is
  `194fcc586f1e95a984fa0f1e5e54abe01143d11b21bb599a0b4e3aa6a0a135d4`;
  the explicitly availability-assumed seed sensitivity run is
  `3f6d9ef3b13becea3501df2afab2783bc94f42412d6edd05948563afb4a31115`.
- Stable strict selections are Elo `K=64`, 730-day window (67/67 mature
  selections); Glicko-2 initial `RD=500` (67/67); and dynamic Bradley–Terry
  730-day window with ridge `1` (66/67). Their tuned event-macro log loss is
  **0.5823**, **0.5525**, and **0.5936**, respectively, and each improves on its
  frozen default with paired event-cluster intervals excluding zero.
- Regularized Bradley–Terry selected ability L2 `1` in all 30 mature folds where
  optimization was available, but 37 mature selection folds were unavailable
  and six outer forecasts required neutral fallback. Its strict tuning gain is
  not reliable enough to widen the grid or select the family. Under the
  non-snapshot-safe seed sensitivity it reaches **0.5085 log loss / 0.1689
  Brier**, but the tuning delta itself is unclear and the lift is chiefly seed
  availability, not evidence that would be valid in strict history.
- A sanitized aggregate evidence bundle now drives the Tournament Predictions
  UI's six-model comparison, strict/sensitivity toggle, metric ranking, coverage,
  tuning notes, and selected settings. It contains no row-level identities and
  remains explicitly retrospective rather than a tournament-title backtest.
- Release v0.4.6 publishes that reviewed bundle and UI on `main`; a clean clone
  can build the same public result without the ignored research workspace.
- Retained local research state is **2,813,648,522 logical bytes**. No model
  family has been selected for product use; the decision remains **revise**.
- Next priorities, in order, are optimizer reliability, a generic manual
  upcoming-event registry, complete route and full-field simulator support with
  live refresh, an explicit model-family decision, and only then an automatic
  sanitized public feed. Pre-event snapshot collection is optional rather than
  a release blocker.
