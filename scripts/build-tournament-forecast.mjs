#!/usr/bin/env node

/**
 * Fit and validate the private tournament forecast model, then optionally run
 * an explicit bracket and emit Supabase-ready NDJSON. Model internals go only
 * to archive_model_runs, a service-role-only table. Public output rows contain
 * probabilities, uncertainty, and a confidence label—not methodology details.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { computeArchiveContentSha256 } from "./lib/archive-content-hash.mjs";
import {
  DEFAULT_MODEL_OPTIONS,
  MODEL_KIND,
  buildNamedObservations,
  fitBradleyTerry,
  forecastExample,
  readNdjson,
  simulateBracket,
  validateForecastEvent,
  walkForwardValidate,
} from "./lib/tournament-forecast.mjs";

const CACHE_ROOT = process.env.NIKKI_ARCHIVE_CACHE_ROOT ?? path.join(
  homedir(),
  process.platform === "darwin" ? "Library/Caches" : ".cache",
  "SSBM_DASHBOARD_nikki_archive",
);
const defaults = {
  input: path.join(CACHE_ROOT, "public-export"),
  output: path.join(CACHE_ROOT, "forecast-export"),
  event: null,
  cutoff: null,
  validateOnly: false,
  printExample: false,
};

const parseArgs = (argv) => {
  const options = { ...defaults };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--validate-only") options.validateOnly = true;
    else if (arg === "--print-example") options.printExample = true;
    else if (["--input", "--output", "--event", "--cutoff"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    } else {
      throw new Error(
        "Usage: build-tournament-forecast.mjs [--input DIR] [--output DIR] "
        + "[--event FILE] [--cutoff YYYY-MM-DD] [--validate-only] [--print-example]",
      );
    }
  }
  if (!options.validateOnly && !options.printExample && !options.event) {
    throw new Error("Provide --event FILE to forecast a bracket, or use --validate-only");
  }
  return options;
};

const roundMetric = (value) => value === null ? null : Number(value.toFixed(6));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const writeNdjson = async (file, rows) => {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(file, body ? `${body}\n` : "");
};

const options = parseArgs(process.argv);
if (options.printExample) {
  process.stdout.write(`${JSON.stringify(forecastExample, null, 2)}\n`);
  process.exit(0);
}

const requiredFiles = [
  "manifest.json",
  "archive_datasets.ndjson",
  "archive_tournament_series.ndjson",
  "archive_tournaments.ndjson",
  "archive_players.ndjson",
  "archive_games.ndjson",
  "archive_game_players.ndjson",
];
const [manifest, datasetRows, seriesRows, tournaments, players, games, gamePlayers] = await Promise.all([
  JSON.parse(await readFile(path.join(options.input, requiredFiles[0]), "utf8")),
  ...requiredFiles.slice(1).map((name) => readNdjson(path.join(options.input, name))),
]);
if (datasetRows.length !== 1 || datasetRows[0].id !== manifest.datasetId) {
  throw new Error("The public export manifest and archive_datasets row do not agree");
}
if (!/^[0-9a-f]{64}$/.test(manifest.contentSha256 ?? "")
  || datasetRows[0].content_sha256 !== manifest.contentSha256) {
  throw new Error("The public export lacks a matching SHA-256 content fingerprint; rebuild it");
}
const recomputedContentSha256 = await computeArchiveContentSha256({
  dir: options.input,
  datasetRow: datasetRows[0],
});
if (recomputedContentSha256 !== manifest.contentSha256) {
  throw new Error("The public export payload does not match its SHA-256 content fingerprint");
}
for (const [table, rows] of [
  ["archive_tournament_series", seriesRows],
  ["archive_tournaments", tournaments],
  ["archive_players", players],
  ["archive_games", games],
  ["archive_game_players", gamePlayers],
]) {
  const expected = manifest.tableCounts?.[table];
  if (expected !== rows.length) throw new Error(`${table}: manifest says ${expected}, read ${rows.length}`);
}

const event = options.event ? JSON.parse(await readFile(options.event, "utf8")) : null;
const cutoff = options.cutoff ?? event?.dataCutoff ?? datasetRows[0].data_as_of;
if (cutoff > datasetRows[0].data_as_of) {
  throw new Error(`Cutoff ${cutoff} is later than dataset data_as_of ${datasetRows[0].data_as_of}`);
}
if (event && options.cutoff && event.dataCutoff !== options.cutoff) {
  throw new Error("--cutoff must equal the event input's dataCutoff");
}
if (event) {
  validateForecastEvent(event, {
    playerIds: new Set(players.map((row) => row.id)),
    seriesIds: new Set(seriesRows.map((row) => row.id)),
  });
}

const observations = buildNamedObservations({ games, gamePlayers, tournaments, cutoff });
if (observations.length < 2) throw new Error(`Only ${observations.length} eligible named games exist through ${cutoff}`);
const trainingSets = new Set(observations.map((row) => row.setId).filter(Boolean));
const trainingPlayers = new Set(observations.flatMap((row) => [row.a, row.b]));
const validation = walkForwardValidate(observations, { modelOptions: DEFAULT_MODEL_OPTIONS });
const model = fitBradleyTerry(observations, cutoff, DEFAULT_MODEL_OPTIONS);
if (!model) throw new Error("The forecast model could not be fit");
const readinessBlockers = [];
if (observations.length < 100) readinessBlockers.push("fewer than 100 fully named conservative games");
if (trainingPlayers.size < 8) readinessBlockers.push("fewer than 8 players with eligible head-to-head data");
if (validation.predictions < 100) readinessBlockers.push("fewer than 100 walk-forward predictions");
if (validation.brier === null || validation.brier >= validation.baselineBrier) {
  readinessBlockers.push("walk-forward Brier score does not beat the neutral baseline");
}
if (validation.logLoss === null || validation.logLoss >= validation.baselineLogLoss) {
  readinessBlockers.push("walk-forward log loss does not beat the neutral baseline");
}
if (!model.converged) readinessBlockers.push("optimizer did not converge");

const report = {
  datasetId: manifest.datasetId,
  cutoff,
  modelKind: MODEL_KIND,
  eligibleNamedGames: observations.length,
  eligibleNamedSets: trainingSets.size,
  namedPlayers: trainingPlayers.size,
  converged: model.converged,
  iterations: model.iterations,
  effectiveTrainingWeight: roundMetric(model.trainingWeight),
  fittedWeightedLogLoss: roundMetric(model.weightedLogLoss),
  forecastReady: readinessBlockers.length === 0,
  readinessBlockers,
  walkForward: {
    folds: validation.folds,
    predictions: validation.predictions,
    brier: roundMetric(validation.brier),
    logLoss: roundMetric(validation.logLoss),
    baselineBrier: roundMetric(validation.baselineBrier),
    baselineLogLoss: roundMetric(validation.baselineLogLoss),
    knownPlayerCoverage: roundMetric(validation.knownPlayerCoverage),
  },
};

if (options.validateOnly) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(model.converged ? 0 : 2);
}

if (readinessBlockers.length) {
  throw new Error(`Forecast blocked: ${readinessBlockers.join("; ")}. Add verified identity coverage and rerun --validate-only.`);
}

const forecast = simulateBracket({ model, event, randomSeed: event.randomSeed });
const runFingerprint = JSON.stringify({
  datasetId: manifest.datasetId,
  cutoff,
  modelKind: MODEL_KIND,
  modelOptions: DEFAULT_MODEL_OPTIONS,
  forecast: {
    eventId: event.id,
    bracketDigest: digest(JSON.stringify(event.bracket)),
    randomSeed: String(event.randomSeed ?? `${event.id}:${event.dataCutoff}`),
    simulationCount: event.simulationCount,
  },
  observations: observations.map((row) => [
    row.gameKey, row.a, row.b, row.y, row.seriesId, row.day, row.baseWeight,
  ]),
});
const modelRunId = `bt-v1-${digest(runFingerprint).slice(0, 24)}`;
const methodology = {
  version: 1,
  family: "Regularized hierarchical Bradley-Terry logistic model",
  publicVisibility: "private-internal-only",
  eligibility: {
    formats: ["singles"],
    curationTiers: ["verified", "probable"],
    requiresBothPublicPlayerIdentities: true,
    requiresDeterminateWinner: true,
    prohibitsPostCutoffGames: true,
  },
  observationUnit: "Game-level; weights sum to one within each inferred or verified set",
  recency: { kind: "exponential", halfLifeDays: DEFAULT_MODEL_OPTIONS.halfLifeDays },
  shrinkage: {
    playerL2: DEFAULT_MODEL_OPTIONS.playerLambda,
    playerBySeriesL2: DEFAULT_MODEL_OPTIONS.seriesLambda,
  },
  optimizer: {
    kind: "damped diagonal Newton",
    maxIterations: DEFAULT_MODEL_OPTIONS.maxIterations,
    convergenceTolerance: DEFAULT_MODEL_OPTIONS.convergenceTolerance,
    converged: model.converged,
    iterations: model.iterations,
  },
  uncertainty: "Diagonal Laplace parameter draws followed by deterministic-seed nested Monte Carlo bracket simulation; intervals are posterior-draw percentiles.",
  simulation: {
    eventId: event.id,
    bracketDigest: digest(JSON.stringify(event.bracket)),
    randomSeed: String(event.randomSeed ?? `${event.id}:${event.dataCutoff}`),
    simulationCount: event.simulationCount,
    posteriorDrawPolicy: "min(250, max(50, floor(sqrt(simulationCount))))",
  },
  validation: {
    kind: "strictly chronological walk-forward by event day",
    ...report.walkForward,
  },
  limitations: [
    "Player identity must be publicly resolved before a game enters training.",
    "Series effects are strongly shrunk and should not be interpreted as causal venue effects.",
    "Replay dates defer to sourced event dates; year-only events use a conservative year-end fallback.",
    "Bracket probabilities depend on the supplied entrants, seeds, bracket graph, and best-of lengths.",
  ],
};

const modelRows = [{
  id: modelRunId,
  dataset_id: manifest.datasetId,
  dataset_content_sha256: manifest.contentSha256,
  model_kind: MODEL_KIND,
  trained_through: cutoff,
  training_set_count: trainingSets.size,
  training_game_count: observations.length,
  backtest_brier: roundMetric(validation.brier),
  backtest_log_loss: roundMetric(validation.logLoss),
  methodology,
}];
const eventRows = [{
  id: event.id,
  model_run_id: modelRunId,
  canonical_name: event.canonicalName,
  series_id: event.seriesId ?? null,
  start_date: event.startDate,
  entrant_source_url: event.entrantSourceUrl,
  bracket_source_url: event.bracketSourceUrl ?? null,
  simulation_count: event.simulationCount,
  data_cutoff: event.dataCutoff,
  notes: "Experimental estimate from historical public tournament results; probabilities are not guarantees.",
  published: false,
  published_at: null,
}];
const playerRows = forecast.map((row) => ({
  forecast_event_id: event.id,
  player_id: row.playerId,
  seed: row.seed,
  title_probability: row.titleProbability,
  top_8_probability: row.top8Probability,
  interval_low: row.intervalLow,
  interval_high: row.intervalHigh,
  confidence: row.confidence,
  published: false,
}));

await mkdir(options.output, { recursive: true });
await Promise.all([
  writeNdjson(path.join(options.output, "archive_model_runs.ndjson"), modelRows),
  writeNdjson(path.join(options.output, "archive_forecast_events.ndjson"), eventRows),
  writeNdjson(path.join(options.output, "archive_forecast_players.ndjson"), playerRows),
]);
const forecastManifest = {
  schemaVersion: 1,
  datasetId: manifest.datasetId,
  sourceArchiveSha256: manifest.contentSha256,
  sourceArchiveGeneratedAt: manifest.generatedAt,
  sourceArchiveTableCounts: manifest.tableCounts,
  modelRunId,
  forecastEventId: event.id,
  generatedAt: new Date().toISOString(),
  loadOrder: ["archive_model_runs", "archive_forecast_events", "archive_forecast_players"],
  tableCounts: {
    archive_model_runs: modelRows.length,
    archive_forecast_events: eventRows.length,
    archive_forecast_players: playerRows.length,
  },
  report,
};
await writeFile(path.join(options.output, "forecast-manifest.json"), `${JSON.stringify(forecastManifest, null, 2)}\n`);

console.log(JSON.stringify({ ...report, forecastEventId: event.id, modelRunId, output: options.output, players: forecast }, null, 2));
