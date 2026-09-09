# Tournament prediction roadmap

> Updated 2026-09-09. `[x]` means the current acceptance target is complete;
> `[ ]` means work remains. Every open item is explicitly marked **IN PROGRESS**
> or **NOT STARTED**.

## Ten-item roadmap

- [ ] **1. Major registry — IN PROGRESS.** Five majors are API-verified; expand
  toward the 211 offline majors while retaining the 16 online exclusions.
- [x] **2. Start.gg downloader — COMPLETE for the current research slice.**
  Historical downloads, cached provenance, fail-closed pagination, and the
  Riptide preview-shard fallback are implemented. New events still need normal
  source review.
- [ ] **3. Canonical local dataset — IN PROGRESS.** The five-event dataset has
  4,502 players and 8,208 eligible sets. Add more chronological history without
  mixing unfinished target-event rows into training.
- [ ] **4. Cleaning and identity resolution — IN PROGRESS.** Current public-ID
  audits pass; broader coverage and cross-phase progression audits remain.
- [x] **5. Six-model suite — COMPLETE.** Neutral, higher seed, recency Elo,
  Glicko-2, dynamic Bradley-Terry, and regularized Bradley-Terry + seed + form
  are implemented with deterministic predictions.
- [ ] **6. Evaluation framework — IN PROGRESS.** Four event-held-out folds,
  6,244 predictions, scorecards, and calibration exist. Event-cluster
  uncertainty and a final model-selection rule remain.
- [ ] **7. Historical major backtests — NOT STARTED.** Produce leakage-safe
  tournament-level winner/top-eight forecasts and score them against outcomes.
- [ ] **8. Upcoming-event simulator — IN PROGRESS.** Pairwise reporting and the
  website's deterministic Riptide Top-16/Top-8 seed scenario exist. A validated
  full-field double-elimination simulator with title/top-eight probabilities
  does not.
- [ ] **9. Reports and decision — IN PROGRESS.** Local comparisons, calibration,
  matchup Markdown, and the website path explorer exist. Historical tournament
  backtests and the proceed/revise/stop recommendation remain.
- [x] **10. Storage report — COMPLETE for the current snapshot.** Retained local
  research files measure 296,338,685 logical bytes; refresh this measurement as
  source coverage grows.

## Current website slice

- [x] Bundle the reviewed Riptide snapshot and generated predictions with the
  app; do not fetch Start.gg at runtime.
- [x] Provide tournament and six-model selectors with a short model explanation.
- [x] Redraw one deterministic Top-16 qualification scenario and its projected
  Top-8 double-elimination path when the model changes.
- [x] Show both players' raw conditional set estimates and a projected path
  winner; label the neutral model's seed advancement as a display tie-break.
- [x] Keep the missing-pool, provisional-preview, and “not title odds” warnings
  visible next to the graphic.
- [ ] Add additional reviewed tournament catalogs so the tournament selector
  offers more than the current Riptide snapshot.
- [ ] Add a reviewed refresh-and-redeploy workflow, or a privacy-compatible
  public feed, so website predictions can follow live Riptide results. The
  current website bundle is static; the local Markdown report remains the
  refreshable in-event tool.
- [ ] Replace the seed scenario only after the full field and cross-phase graph
  can be validated; then add simulated title/top-eight probabilities.

## Acceptance criteria

The current website slice is accepted when its bundled catalog reproduces from
hash-pinned local inputs, all six models start from the same documented seed
scenario, changing selectors redraws every downstream matchup, build/tests/lint
pass, and no replay-derived data or credential is transmitted.

Roadmap item 8 is complete only when a full official field can be routed through
validated winner/loser/reset edges, simulated probabilistically, and checked by
historical tournament backtests. A deterministic path pick or raw matchup
probability must never be presented as championship odds.
