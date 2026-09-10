import { chronologicalFolds, eventTimeBounds, scorePredictions } from "./evaluation.mjs";
import { actualResult, BASIC_MODEL_OPTIONS, fitBasicModels, initialSeedIndex } from "./baselines.mjs";
import { DYNAMIC_BRADLEY_TERRY_OPTIONS, fitDynamicBradleyTerryModel } from "./dynamic-bradley-terry.mjs";
import { GLICKO2_OPTIONS, fitGlicko2Model } from "./glicko2.mjs";
import { REGULARIZED_BT_OPTIONS, fitRegularizedBradleyTerryModel } from "./regularized-bradley-terry.mjs";
import { createHash } from "node:crypto";
import { markdownText as safeText } from "./markdown.mjs";

const byId = (a, b) => a.id.localeCompare(b.id, "en");
export const MODEL_IDS = ["neutral", "higher-seed", "recency-elo", "glicko2",
  "dynamic-bradley-terry", "regularized-bt-recent-form"];
const TUNABLE_OPTIONS = Object.freeze({
  "recency-elo": BASIC_MODEL_OPTIONS,
  glicko2: GLICKO2_OPTIONS,
  "dynamic-bradley-terry": DYNAMIC_BRADLEY_TERRY_OPTIONS,
  "regularized-bt-recent-form": REGULARIZED_BT_OPTIONS,
});
const SIDE_RULE = "forecast-side-v1:";
const COMPARISON_METRICS = ["accuracy", "brier", "logLoss"];
const BOOTSTRAP_REPLICATES = 10_000;
const BOOTSTRAP_SEED = 0x5eedc0de;
const MIN_SELECTION_CLUSTERS = 5;

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

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function validateModelOptionsById(value = {}) {
  if (!plainObject(value)) throw new TypeError("Model options must be an object keyed by model ID");
  const unknownModels = Object.keys(value).filter((id) => !Object.hasOwn(TUNABLE_OPTIONS, id)).sort();
  if (unknownModels.length) throw new TypeError(`Unknown or fixed model option target: ${unknownModels.join(", ")}`);
  const validated = {};
  for (const [id, options] of Object.entries(value)) {
    if (!plainObject(options)) throw new TypeError(`Options for ${id} must be an object`);
    const allowed = TUNABLE_OPTIONS[id];
    const unknownOptions = Object.keys(options).filter((key) => !Object.hasOwn(allowed, key)).sort();
    if (unknownOptions.length) throw new TypeError(`Unknown ${id} option: ${unknownOptions.join(", ")}`);
    validated[id] = { ...options };
  }
  return validated;
}

export function fitModelSuite({ events, sets, cutoff, seedIndex, basicOptions, modelOptionsById = {} }) {
  if (basicOptions != null && modelOptionsById?.["recency-elo"] != null) {
    throw new TypeError("Use either basicOptions or modelOptionsById.recency-elo, not both");
  }
  const options = validateModelOptionsById(modelOptionsById);
  const recencyOptions = basicOptions == null
    ? options["recency-elo"] : validateModelOptionsById({ "recency-elo": basicOptions })["recency-elo"];
  const input = { events, sets, cutoff };
  return [
    ...fitBasicModels({ ...input, seedIndex, options: recencyOptions }),
    fitGlicko2Model({ ...input, options: options.glicko2 }),
    fitDynamicBradleyTerryModel({ ...input, options: options["dynamic-bradley-terry"] }),
    fitRegularizedBradleyTerryModel({ ...input, seedIndex,
      options: options["regularized-bt-recent-form"] }),
  ];
}

// Mulberry32 is small, fully specified and deterministic across JS runtimes
// because every state transition is an explicit unsigned 32-bit operation.
// The seed is fixed reporting policy, not a value searched for favorable bounds.
function fixedBootstrapRandom(seed = BOOTSTRAP_SEED) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(values, probability) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex];
  const upper = ordered[upperIndex];
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (position - lowerIndex);
}

/**
 * Paired target-set differences are reduced to one sum per held-out event
 * before resampling. Bootstrap work therefore scales with events rather than
 * hundreds of thousands of individual sets. Sampling the same event indices
 * for every model preserves both pairing and the existing set-weighted scores.
 */
function pairedEventClusterUncertainty(folds, models) {
  const baselineModelId = "higher-seed";
  const clusters = folds.map((fold) => {
    const baseline = fold.models.find((model) => model.id === baselineModelId);
    if (!baseline || !Number.isSafeInteger(baseline.scores.n) || baseline.scores.n < 1) {
      throw new Error(`Missing higher-seed scores for held-out event ${fold.eventId}`);
    }
    const differenceSums = {};
    for (const model of fold.models) {
      if (model.scores.n !== baseline.scores.n) {
        throw new Error(`Model ${model.id} is not scored on the same target sets as higher-seed for event ${fold.eventId}`);
      }
      differenceSums[model.id] = Object.fromEntries(COMPARISON_METRICS.map((metric) => {
        const value = model.scores[metric];
        const reference = baseline.scores[metric];
        if (!Number.isFinite(value) || !Number.isFinite(reference)) {
          throw new Error(`Missing ${metric} score for paired comparison in event ${fold.eventId}`);
        }
        return [metric, (value - reference) * baseline.scores.n];
      }));
    }
    return { eventId: fold.eventId, sets: baseline.scores.n, differenceSums };
  });
  const targetSets = clusters.reduce((total, cluster) => total + cluster.sets, 0);
  const samples = new Map(models.map((model) => [model.id,
    Object.fromEntries(COMPARISON_METRICS.map((metric) => [metric, new Float64Array(BOOTSTRAP_REPLICATES)]))]));
  const random = fixedBootstrapRandom();
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate++) {
    let sampledSets = 0;
    const totals = new Map(models.map((model) => [model.id, { accuracy: 0, brier: 0, logLoss: 0 }]));
    for (let draw = 0; draw < clusters.length; draw++) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      sampledSets += cluster.sets;
      for (const model of models) {
        const source = cluster.differenceSums[model.id];
        const target = totals.get(model.id);
        for (const metric of COMPARISON_METRICS) target[metric] += source[metric];
      }
    }
    for (const model of models) {
      const total = totals.get(model.id);
      const target = samples.get(model.id);
      for (const metric of COMPARISON_METRICS) target[metric][replicate] = total[metric] / sampledSets;
    }
  }
  const comparisons = models.map((model) => {
    const differenceSums = clusters.reduce((totals, cluster) => {
      for (const metric of COMPARISON_METRICS) totals[metric] += cluster.differenceSums[model.id][metric];
      return totals;
    }, { accuracy: 0, brier: 0, logLoss: 0 });
    const modelSamples = samples.get(model.id);
    return {
      id: model.id,
      name: model.name,
      versusModelId: baselineModelId,
      targetEvents: clusters.length,
      targetSets,
      differences: Object.fromEntries(COMPARISON_METRICS.map((metric) => [metric, {
        estimate: differenceSums[metric] / targetSets,
        interval95: {
          lower: quantile(modelSamples[metric], 0.025),
          upper: quantile(modelSamples[metric], 0.975),
        },
        betterWhen: metric === "accuracy" ? "positive" : "negative",
      }])),
    };
  });
  const enoughClusters = clusters.length >= MIN_SELECTION_CLUSTERS;
  const candidateModelIds = enoughClusters ? comparisons
    .filter((model) => model.id !== baselineModelId
      && model.differences.accuracy.interval95.lower > 0
      && model.differences.brier.interval95.upper < 0
      && model.differences.logLoss.interval95.upper < 0)
    .map((model) => model.id) : [];
  const selectionStatus = !enoughClusters
    ? "insufficient-event-clusters"
    : candidateModelIds.length === 0
      ? "no-model-clears-all-three-descriptive-intervals"
      : candidateModelIds.length === 1
        ? "one-model-clears-all-three-descriptive-intervals"
        : "multiple-models-clear-all-three-descriptive-intervals";
  return {
    baselineModelId,
    targetEvents: clusters.length,
    targetSets,
    method: {
      name: "paired-event-cluster-percentile-bootstrap",
      confidenceLevel: 0.95,
      quantiles: [0.025, 0.975],
      quantileInterpolation: "linear between adjacent ordered replicates",
      replicates: BOOTSTRAP_REPLICATES,
      clusterUnit: "held-out target event",
      pairing: "Every model and higher-seed use the same target sets and reporting orientation within each event.",
      aggregation: "Per-event metric-difference sums and set counts are combined into the existing set-weighted estimand.",
      resampling: "Sample target events with replacement, drawing the observed number of event clusters per replicate.",
      difference: "model minus higher-seed; positive accuracy and negative Brier/log-loss differences favor the model",
      prng: {
        algorithm: "mulberry32",
        seed: BOOTSTRAP_SEED,
        seedHex: "0x5eedc0de",
        fixed: true,
        tuned: false,
      },
      interpretation: "Descriptive event-cluster bootstrap intervals, not confidence in an individual forecast or proof of model superiority.",
    },
    models: comparisons,
    selectionDiagnostic: {
      status: selectionStatus,
      automaticSelection: false,
      selectedModel: null,
      baselineModelId,
      minimumEventClusters: MIN_SELECTION_CLUSTERS,
      observedEventClusters: clusters.length,
      candidateModelIds,
      rule: "A diagnostic candidate must have all three 95% intervals strictly favor it over higher-seed; at least five held-out event clusters are required.",
      limitation: "This conservative screen has no multiplicity adjustment and is not a confirmatory superiority test or productization decision.",
    },
  };
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
  const outOfSampleModels = MODEL_IDS.map((id) => ({
    id, name: names.get(id), scores: scoreModel(aggregate.get(id)),
  }));
  const uncertainty = pairedEventClusterUncertainty(foldResults, outOfSampleModels);

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
      "Paired event-cluster bootstrap intervals are descriptive diagnostics with no multiplicity adjustment, not proof or a confirmatory superiority test.",
      "No title/top-eight simulation is implemented yet.",
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
    outOfSample: { models: outOfSampleModels, folds: foldResults, uncertainty },
  };
  return { report, predictions };
}

const number = (value, digits = 4) => value == null ? "—" : value.toFixed(digits);
const percent = (value) => value == null ? "—" : (value * 100).toFixed(1) + "%";
const signedNumber = (value) => value == null ? "—" : (value >= 0 ? "+" : "") + number(value);
const differenceInterval = (entry) => signedNumber(entry.estimate) + " ["
  + signedNumber(entry.interval95.lower) + ", " + signedNumber(entry.interval95.upper) + "]";

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
  const uncertainty = report.outOfSample.uncertainty;
  const uncertaintySection = uncertainty ? [
    "## Paired event-cluster uncertainty",
    "",
    "Differences are model minus higher-seed on the same held-out target sets. Positive accuracy and negative Brier/log-loss differences favor the listed model.",
    "",
    "| Model | Δ accuracy [95%] | Δ Brier [95%] | Δ log loss [95%] |",
    "|---|---:|---:|---:|",
    ...uncertainty.models.map((model) => "| " + safeText(model.name) + " | "
      + differenceInterval(model.differences.accuracy) + " | "
      + differenceInterval(model.differences.brier) + " | "
      + differenceInterval(model.differences.logLoss) + " |"),
    "",
    uncertainty.method.replicates.toLocaleString("en-US") + " fixed-seed percentile replicates sample "
      + uncertainty.targetEvents + " held-out events with replacement. Computation uses paired per-event contribution sums and preserves the set-weighted estimand.",
    "PRNG: " + uncertainty.method.prng.algorithm + " seed " + uncertainty.method.prng.seedHex
      + ", fixed in advance and not tuned. These are descriptive event-cluster bootstrap intervals, not proof of superiority or confidence in an individual forecast.",
    "Conservative selection diagnostic: **" + safeText(uncertainty.selectionDiagnostic.status) + "**. "
      + (uncertainty.selectionDiagnostic.candidateModelIds.length
        ? "Candidates: " + uncertainty.selectionDiagnostic.candidateModelIds.map(safeText).join(", ") + "."
        : "No candidate IDs.")
      + " No model is selected or productized automatically.",
    "",
  ] : [];
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
    ...uncertaintySection,
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
    ...report.warnings.map((warning) => "- " + safeText(warning)),
    "",
    report.pendingModels.length ? "Remaining model suite: " + report.pendingModels.join("; ") + "."
      : "All six planned model families are implemented; selection remains pending broader validation.",
    "",
  ].join("\n");
}
