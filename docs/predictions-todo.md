# Tournament prediction roadmap

> Updated 2026-09-09. `[x]` means the current acceptance target is complete;
> `[ ]` means meaningful work remains. Research data stays local under the
> ignored `.forecast/` directory unless a separate transfer is created.

Machine migration and clean-checkout setup are documented in the
[forecast handoff guide](forecast-handoff.md).

## Ten-item roadmap

- [x] **1. Major registry — COMPLETE for the 2018–2025 scope.** All 85 selected
  offline Melee singles majors are API-verified: 14/12/2/6/16/12/13/10 by year.
  The broader registry contains 211 offline majors, so earlier/later expansion
  remains optional follow-on work rather than hidden coverage.
- [x] **2. Start.gg downloader — COMPLETE for the scope.** All 85 mapped bundles
  were acquired with authenticated request/response provenance. Eighty-four are
  source-ready; GOML 2022 is retained but quarantined because Start.gg still
  reports an active event, unresolved sets, and incomplete standings. Superseded
  Eggdog and Nounsvitational preliminary-stage bundles remain outside the corpus
  as audit evidence; their championship stages are the canonical sources.
- [x] **3. Canonical local dataset — COMPLETE for the accepted corpus.** Strict
  dataset `e21eb6bf8d91b295b875ab11959e1beddae937d7816e5c7da1a2f13db3f6371d`
  contains 84 events, 18,421 players, 20,578 aliases, 44,022 entrants, 58,318
  seeds, 196,820 source set rows, 77,270 eligible played sets, and 44,001
  standings. It is 379,603,382 bytes.
- [x] **4. Cleaning and identity resolution — COMPLETE for the accepted
  corpus.** There are no duplicate/conflicting set rows, event/entrant conflicts,
  invalid seeds, or invalid standings. One anonymous entrant has no sets and one
  duplicate-registration identity has only DQ outcomes. All 84 historical
  winner/runner-up pairs reconcile: 74 directly and 10 through provenance-safe,
  advisory corroboration. No tag-based identity merge changes model input.
- [x] **5. Six-model suite — COMPLETE.** Neutral, higher seed, recency Elo,
  Glicko-2, dynamic Bradley–Terry, and regularized Bradley–Terry + seed + recent
  form are implemented with deterministic predictions. A frozen 24-candidate
  grid covers the four tunable families without changing the two baselines.
- [x] **6. Evaluation framework — COMPLETE for set-level tuning evidence.**
  Eighty-three chronological whole-event folds produce 74,891 held-out set
  predictions, calibration, coverage, nested inner-only hyperparameter
  selection, and deterministic 10,000-replicate paired event-cluster
  uncertainty. Strict-seed and separately labeled seed-assumed modes are
  complete; no target event enters its training or tuning history.
- [x] **7. Historical major backtests — COMPLETE FOR THE ACCEPTED RETROSPECTIVE
  SCOPE.** The
  reviewed Scuffed World Tour 2022 double-elimination pilot validates routing,
  resets, simulation, and scoring. Strict mode correctly finds zero eligible
  tournament targets because every stored bracket/seed snapshot was first
  observed after its event. Scuffed is therefore an exploratory pipeline check,
  not an unbiased title-probability backtest. The owner accepts that limitation;
  prospective snapshot collection is not a blocker for this release.
- [ ] **8. Upcoming-event simulator — PILOT COMPLETE; EXPANSION OPEN.** The
  reviewed double-elimination engine, pairwise reporting, and deterministic
  Riptide seed scenario work. A generic event registry, official full-field
  routing, multi-phase progression, live changes, and validated title/top-eight
  odds remain.
- [ ] **9. Reports and decision — IN PROGRESS.** The expanded comparison run is
  `6541f6da58ca5bb2975ae9b3668ac518b6ff541fb0469f311429c5b854573249`.
  The nested tuning conclusion is **revise before productizing**: retain the
  stable Elo/Glicko/dynamic-BT settings for research, keep regularized BT on its
  defaults until convergence is repaired. See
  the [compact tuning result](forecast-tuning-results.md). Final family selection
  still waits for broader simulator coverage and a deliberate product decision.
- [x] **10. Storage report — COMPLETE and refreshed after tuning.** The canonical
  JSON is 379,603,382 bytes; retained local research state is 2,813,648,522
  logical bytes. Assumption-based database scenarios with 30% headroom are
  687,367,783 / 973,927,220 / 1,260,507,956 bytes. These are not measured
  PostgreSQL sizes, and nothing was uploaded.

## Current model evidence

### Older fixed-model, set-weighted comparison

| Model | Accuracy | Brier ↓ | Log loss ↓ | AUC | Coverage |
|---|---:|---:|---:|---:|---:|
| Regularized BT + seed + recent form | 76.45% | 0.1576 | 0.4753 | 0.8511 | 49.36% |
| Higher seed | 75.09% | 0.1809 | 0.5470 | 0.7767 | 90.89% |
| Glicko-2 | 69.94% | 0.1891 | 0.5561 | 0.7902 | 49.36% |
| Recency Elo | 69.28% | 0.2079 | 0.6019 | 0.7804 | 49.36% |
| Dynamic Bradley–Terry | 63.20% | 0.2117 | 0.6070 | 0.7165 | 49.36% |
| Neutral 50/50 | 50.00% | 0.2500 | 0.6931 | 0.5000 | 100.00% |

Versus the higher-seed baseline, regularized BT improves accuracy by 1.36
percentage points (descriptive event-bootstrap 95% interval 0.19 to 2.72),
Brier by −0.0233 (−0.0257 to −0.0210), and log loss by −0.0716 (−0.0785 to
−0.0638). The bootstrap is event-clustered and paired, but it is not a
confirmatory superiority test or an individual-forecast confidence interval.

### Nested out-of-sample tuning

Strict mode cannot use the 58,318 historical seeds because none was observed in
a captured pre-event snapshot. Glicko-2 therefore has the strongest stable
history-only event-macro proper scores. The seed-assumed sensitivity is separate
and must not be read as snapshot-verified evidence.

| Model | Strict log loss ↓ | Strict Brier ↓ | Seed-assumed log loss ↓ | Seed-assumed Brier ↓ |
|---|---:|---:|---:|---:|
| Regularized BT + seed + form | 0.5629 | 0.1903 | **0.5085** | **0.1689** |
| Higher seed | 0.6931 | 0.2500 | 0.5503 | 0.1824 |
| Glicko-2 | **0.5525** | **0.1876** | 0.5525 | 0.1876 |
| Recency Elo | 0.5823 | 0.1972 | 0.5823 | 0.1972 |
| Dynamic Bradley–Terry | 0.5936 | 0.2051 | 0.5936 | 0.2051 |
| Neutral | 0.6931 | 0.2500 | 0.6931 | 0.2500 |

Within-family nested tuning improves Elo, Glicko-2, and dynamic BT on log loss
and Brier with descriptive 95% intervals below zero. Regularized BT's tuning
intervals cross zero in the seed-assumed mode and its optimizer still needs
neutral fallbacks. Its large sensitivity lift comes from seed availability, not
a reliable hyperparameter gain. Full settings, intervals, and hashes are in the
[six-model tuning report](forecast-tuning-results.md).

## Corpus acceptance record

- The explicit corpus contract contains 85 reviewed decisions: 84 included,
  one `source-ambiguous`, and zero unresolved.
- `npm run forecast -- normalize --strict-corpus` and
  `npm run forecast -- corpus --strict-corpus` pass against the same dataset,
  contract, source-readiness evidence, and SHA-256 identifiers.
- Four accepted events have 21 entrants without a final-standing row. Those
  observations are disclosed; they do not invalidate the completed brackets or
  create fabricated standings.
- Raw byes, DQs, and unfinished rows remain available for bracket auditing but
  cannot train a model. Historical standings and Liquipedia outcomes are
  post-event labels only.

## Next work, in order

1. Repair regularized-BT convergence, freeze the change, and repeat the same
   nested protocol without widening the grid from observed outer-fold results.
2. Generalize the upcoming-event registry and simulator so a reviewed event can
   populate the UI with one command.
3. Add reviewed bracket-route contracts for more single-phase events, then
   multi-phase majors; report route coverage rather than silently dropping them.
4. Generalize the validated engine to upcoming official brackets and live
   refreshes, preserving conditional grand-final reset behavior.
5. Generate retrospective tournament-level title/top-eight diagnostics if that
   additional evidence becomes worth the routing work.
6. Make the final model-family decision and regenerate the reviewed
   website catalog.
7. Add the automatic sanitized public feed last.

## Website status

- [x] Tournament and six-model selectors with short explanations.
- [x] Deterministic Riptide Top-16/Top-8 path explorer and pairwise estimates.
- [x] Compact 83-event set-level backtest visualization with strict-history and
  historical-seed sensitivity modes, exact scores, tuning status, and all six
  model families. Selecting a row redraws the bracket with that model.
- [x] Public-data-only bundled catalog; no Start.gg token, raw source bundle,
  replay record, or connect code enters the browser.
- [ ] Replace the static seed scenario with validated probabilistic title and
  top-eight odds only after route coverage and historical backtests pass.
- [ ] Add a reviewed refresh/redeploy path, or a privacy-compatible public feed,
  for live tournament updates.
- [ ] Address the remaining prediction-view accessibility review items before
  calling the website slice finished.

## Acceptance boundary

Roadmap item 8 is complete only when an official full field can be routed
through validated winner/loser/reset edges, simulated probabilistically, and
checked by historical tournament backtests. A deterministic favorite path or a
raw matchup probability must never be presented as championship odds.
