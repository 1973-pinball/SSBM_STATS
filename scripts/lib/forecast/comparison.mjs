import { chronologicalFolds, eventTimeBounds, scorePredictions } from "./evaluation.mjs";
import { actualResult, fitBasicModels, initialSeedIndex } from "./baselines.mjs";
import { fitDynamicBradleyTerryModel } from "./dynamic-bradley-terry.mjs";
import { fitGlicko2Model } from "./glicko2.mjs";
import { fitRegularizedBradleyTerryModel } from "./regularized-bradley-terry.mjs";
import { createHash } from "node:crypto";

const byId = (a, b) => a.id.localeCompare(b.id, "en");
const MODEL_IDS = ["neutral", "higher-seed", "recency-elo", "glicko2",
  "dynamic-bradley-terry", "regularized-bt-recent-form"];
const SIDE_RULE = "forecast-side-v1:";

// Reporting only: one observation per match, independent of outcome and seed.
// The fixed salt is versioned and must never be searched/tuned for performance.
export function swapReportingSides(setId) {
  return (createHash("sha256").update(SIDE_RULE + setId).digest()[0] & 1) === 1;
}

function scoreModel(rows) {
  return {
    ...scorePredictions(rows),
    covered: rows.filter((r) => r.covered).length,
    coverage: rows.length ? rows.filter((r) => r.covered).length / rows.length : null,
    knownBothPlayers: rows.filter((r) => r.knownPlayers === 2).length,
    knownOnePlayer: rows.filter((r) => r.knownPlayers === 1).length,
    unknownBothPlayers: rows.filter((r) => r.knownPlayers === 0).length,
  };
}

function fitModelSuite({ events, sets, cutoff, seedIndex, basicOptions }) {
  const input = { events, sets, cutoff };
  return [
    ...fitBasicModels({ ...input, seedIndex, options: basicOptions }),
    fitGlicko2Model(input),
    fitDynamicBradleyTerryModel(input),
    fitRegularizedBradleyTerryModel({ ...input, seedIndex }),
  ];
}

/**
 * Diagnostic comparison only. Hyperparameters are fixed, not selected on these
 * test folds. Forecasts are frozen across each target event. A historical seed
 * baseline is explicitly conditional on an unverified availability assumption.
 */
export function compareBasicModels(dataset, { minTrainingEvents = 1, allowHistoricalSeeds = true, modelOptions = {} } = {}) {
  const plan = chronologicalFolds(dataset, { minTrainingEvents });
  if (!plan.folds.length) throw new Error("No chronological test folds; ingest at least two eligible, non-overlapping majors");
  const seedIndex = initialSeedIndex(dataset, { allowHistorical: allowHistoricalSeeds });
  const aggregate = new Map(MODEL_IDS.map((id) => [id, []]));
  const predictions = [];
  const foldResults = [];
  const names = new Map();
  for (const fold of plan.folds) {
    const models = fitModelSuite({ events: fold.trainingEvents, sets: fold.trainingSets,
      cutoff: fold.cutoff, seedIndex, basicOptions: modelOptions });
    const rowsByModel = new Map(MODEL_IDS.map((id) => [id, []]));
    for (const set of fold.targetSets) {
      const swapped = swapReportingSides(set.id);
      const actual = swapped ? 1 - actualResult(set) : actualResult(set);
      const row = { eventId: fold.targetEvent.id, setId: set.id,
        playerIds: swapped ? [...set.playerIds].reverse() : [...set.playerIds],
        entrantIds: swapped ? [...set.entrantIds].reverse() : [...set.entrantIds],
        sourcePlayerIds: [...set.playerIds], sourceEntrantIds: [...set.entrantIds], sourceSidesSwapped: swapped,
        actual, cutoff: fold.cutoff, models: {} };
      for (const model of models) {
        const sourcePrediction = model.predict(set);
        const prediction = { ...sourcePrediction, p: swapped ? 1 - sourcePrediction.p : sourcePrediction.p };
        names.set(model.id, model.name);
        const scored = { p: prediction.p, actual, covered: prediction.covered, knownPlayers: prediction.knownPlayers };
        rowsByModel.get(model.id).push(scored);
        aggregate.get(model.id).push(scored);
        row.models[model.id] = prediction;
      }
      predictions.push(row);
    }
    foldResults.push({
      eventId: fold.targetEvent.id, eventName: fold.targetEvent.major?.name ?? fold.targetEvent.name,
      cutoff: fold.cutoff, cutoffSources: fold.cutoffSources,
      trainingEventIds: fold.trainingEvents.map((e) => e.id),
      coverage: fold.coverage,
      excludedTrainingEvents: fold.exclusions.trainingEvents,
      models: models.map((model) => ({ id: model.id, name: model.name,
        methodology: model.methodology, scores: scoreModel(rowsByModel.get(model.id)) })),
    });
  }

  // A single full-corpus retrospective fit, not an aggregate of repeatedly
  // overlapping fold-training sets. It is explicitly NOT predictive validation.
  const eligibleSetEvents = new Set(dataset.sets.filter((s) => s.eligible).map((s) => s.eventId));
  const fitEvents = dataset.events.filter((event) => {
    const bounds = eventTimeBounds(event);
    return event.eligible && eligibleSetEvents.has(event.id) && bounds.cutoff != null
      && bounds.trainingEnd != null && bounds.trainingEnd >= bounds.cutoff;
  }).sort(byId);
  const fitIds = new Set(fitEvents.map((e) => e.id));
  const fitSets = dataset.sets.filter((s) => s.eligible && fitIds.has(s.eventId)).sort(byId);
  if (!fitEvents.length) throw new Error("No completed eligible events for the retrospective fit");
  const fitCutoff = fitSets.reduce((latest, set) => Number.isFinite(set.timestamps?.completedAt)
    ? Math.max(latest, set.timestamps.completedAt) : latest,
  Math.max(...fitEvents.map((e) => eventTimeBounds(e).trainingEnd))) + 1;
  const inSample = fitModelSuite({ events: fitEvents, sets: fitSets, cutoff: fitCutoff,
    seedIndex, basicOptions: modelOptions })
    .map((model) => ({ id: model.id, name: model.name, methodology: model.methodology,
      scores: scoreModel(fitSets.map((set) => {
        const prediction = model.predict(set);
        const swapped = swapReportingSides(set.id);
        return { ...prediction, p: swapped ? 1 - prediction.p : prediction.p,
          actual: swapped ? 1 - actualResult(set) : actualResult(set) };
      })) }));

  const report = {
    schemaVersion: 1, kind: "model-suite-diagnostics-v1",
    status: "experimental-not-validated", productize: false, selectedModel: null,
    completeModelSuite: true,
    pendingModels: [],
    warnings: [
      "All six planned model implementations are compared; no model has been selected or validated for product use.",
      "Sparse selected-major coverage is not a representative all-major backtest.",
      "Every target event is entirely held out; training event end and any reported eligible-set completion must precede the conservative target cutoff.",
      "Ratings are frozen throughout each target event; this is a pre-event forecast, not live bracket updating.",
      "Set scores are conditional on realized matchups; which matches occur is not forecast by this diagnostic.",
      "A fixed outcome-independent hash chooses the reported player side; AUC/calibration no longer target the source's first bracket slot.",
      "Unseen-player behavior differs by model and is disclosed in each methodology; prediction coverage requires both players in training.",
      "Historical source responses can contain later corrections; archived pre-event source versions are not available.",
      allowHistoricalSeeds
        ? "Seed predictions assume historical full-field seeding was available before the cutoff; this is unverified."
        : "Seed predictions use only observations proven before the conservative cutoff; missing seeds fall back to 0.5.",
      "Calibration Wilson intervals describe binomial rates, not event-cluster-adjusted confidence or forecast uncertainty.",
      "No title/top-eight simulation or statistical superiority test is implemented yet.",
    ],
    policy: plan.policy,
    reportingOrientation: { version: SIDE_RULE, rule: "swap source sides iff SHA256(version + set.id)[0] has its low bit set",
      scope: "reporting only; same side for all models; one observation per set; source order retained in predictions",
      methodologicalRevision: "Chosen after observing first-slot outcome imbalance; salt not tuned for class balance or model scores",
      limitation: "Approximately balanced orientation is not guaranteed; no event dependence or forecast uncertainty is removed" },
    coverage: plan.coverage,
    excludedTargets: plan.exclusions.targets,
    seeds: { allowHistorical: allowHistoricalSeeds, events: seedIndex.reports },
    inSample: { description: "Retrospective fit on each included eligible set once; not generalization evidence",
      cutoff: fitCutoff, events: fitEvents.length, sets: fitSets.length, models: inSample },
    outOfSample: { models: MODEL_IDS.map((id) => ({ id, name: names.get(id), scores: scoreModel(aggregate.get(id)) })),
      folds: foldResults },
  };
  return { report, predictions };
}

const number = (value, digits = 4) => value == null ? "—" : value.toFixed(digits);
const percent = (value) => value == null ? "—" : (value * 100).toFixed(1) + "%";
const safeText = (value) => String(value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");

export function comparisonMarkdown(report) {
  const elo = report.inSample.models.find((m) => m.id === "recency-elo").methodology;
  const glicko = report.inSample.models.find((m) => m.id === "glicko2").methodology;
  const dynamicBt = report.inSample.models.find((m) => m.id === "dynamic-bradley-terry").methodology;
  const regularizedBt = report.inSample.models.find((m) => m.id === "regularized-bt-recent-form").methodology;
  const table = (models) => [
    "| Model | Sets | Accuracy | Brier ↓ | Log loss ↓ | AUC | Coverage |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...models.map(({ name, scores: s }) => "| " + safeText(name) + " | " + s.n + " | " + percent(s.accuracy)
      + " | " + number(s.brier) + " | " + number(s.logLoss) + " | " + number(s.auc)
      + " | " + percent(s.coverage) + " |"),
  ].join("\n");
  return [
    "# Local forecast comparison — experimental",
    "",
    "No model selected; not validated for product use. Local research only.",
    "",
    "## Chronological event-held-out results",
    "",
    table(report.outOfSample.models),
    "",
    "Coverage means seed availability for the seed baseline, and both players previously seen for the learned player-history models; neutral is always covered.",
    "All models are scored on the same test sets; uncovered predictions still count, using their documented fallback.",
    "Exact 50/50 predictions receive half-credit accuracy. Lower Brier/log loss is better.",
    "A fixed hash of each set ID selects the reported player side, independently of outcomes/seeds. Source order and swap flags remain in predictions.json. This reporting revision followed a source-slot imbalance check; the salt was not tuned.",
    "",
    "![Chronological held-out calibration and bin counts](calibration.svg)",
    "",
    "## Retrospective in-sample fit",
    "",
    report.inSample.description + ".",
    "",
    table(report.inSample.models),
    "",
    "![Retrospective calibration, not validation](calibration-in-sample.svg)",
    "",
    "## Event folds",
    "",
    "| Target | Cutoff (UTC) | Training events | Training sets | Test sets |",
    "|---|---|---:|---:|---:|",
    ...report.outOfSample.folds.map((f) => "| " + safeText(f.eventName) + " | "
      + new Date(f.cutoff * 1000).toISOString() + " | " + f.coverage.trainingEvents + " | "
      + f.coverage.trainingSets + " | " + f.coverage.targetSets + " |"),
    "",
    "## Methodology",
    "",
    "- Neutral: always 50/50.",
    "- Higher seed: select an unambiguous full-field phase, never final standings; confidence is Beta(1,1)-smoothed from training outcomes only, with a 50% lower bound.",
    "- Recency Elo: initial rating zero, base-10 logistic expectation, K=" + elo.k + ", scale=" + elo.scale
      + ", update-weight half-life=" + elo.halfLifeDays + " days. Event-batch updates avoid unreliable within-event timestamps. These settings are exploratory, not optimized.",
    "- Glicko-2: simultaneous event rating periods, initial rating " + glicko.initialRating + ", RD " + glicko.initialRd
      + " and volatility " + glicko.initialVolatility + "; prediction uncertainty uses both players' RDs.",
    "- Dynamic Bradley-Terry: event-joint pairwise fits around elapsed-time-decayed prior skills, with ridge="
      + dynamicBt.ridge + " and half-life=" + dynamicBt.halfLifeDays + " days.",
    "- Regularized Bradley-Terry: categorical player abilities plus training-only standardized initial-seed and pre-event recent-form differences; ability L2="
      + regularizedBt.abilityL2 + " and feature L2=" + regularizedBt.featureL2 + ". Character is not included.",
    "- Predictions remain frozen across the entire target event. Final fit scores above are descriptive only.",
    "- Full methodology parameters, per-event scores, ten-bin calibration and descriptive Wilson intervals are in comparison.json; set-level probabilities are in predictions.json.",
    "",
    "## Limitations and next work",
    "",
    ...report.warnings.map((warning) => "- " + warning),
    "",
    report.pendingModels.length ? "Remaining model suite: " + report.pendingModels.join("; ") + "."
      : "All six planned model families are implemented; selection remains pending broader validation.",
    "",
  ].join("\n");
}
