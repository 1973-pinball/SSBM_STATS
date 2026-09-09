import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildTournamentPredictionBacktestBundle,
  serializeTournamentPredictionBacktestModule,
} from "../build-tournament-backtest-data.mjs";

const GENERATED_PATH = new URL("../../src/lib/tournamentPredictionBacktestData.ts", import.meta.url);
const MODEL_IDS = [
  "regularized-bt-recent-form",
  "higher-seed",
  "glicko2",
  "recency-elo",
  "dynamic-bradley-terry",
  "neutral",
];
const SHA256 = /^[a-f0-9]{64}$/;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => String(a).localeCompare(String(b), "en");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compare)
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const artifactBody = (value) => JSON.stringify(canonical(value)) + "\n";
const artifactDigest = (value) => digest(artifactBody(value));

function generatedJsonLiteral(source) {
  const marker = "export const TOURNAMENT_PREDICTION_BACKTEST =";
  const declaration = source.indexOf(marker);
  assert.notEqual(declaration, -1, "generated backtest export is missing");
  const start = source.indexOf("{", declaration + marker.length);
  assert.notEqual(start, -1, "generated backtest JSON object is missing");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail("generated backtest JSON object is unterminated");
}

function collectKeys(value, result = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectKeys(child, result);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      result.push(key);
      collectKeys(child, result);
    }
  }
  return result;
}

async function writeArtifact(root, relative, body) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
}

function fixtureModel(id) {
  return {
    id,
    outerEvents: 1,
    scoredOuterEvents: 1,
    fallbackOuterEvents: [],
    outerSets: 10,
    selectionModes: {
      fixed: 1,
      innerSelected: 0,
      innerUnavailableDefault: 0,
      warmupDefault: 0,
    },
    eventMacro: { logLoss: 0.6, brier: 0.2, accuracy: 0.7, auc: 0.75 },
    pooled: { coverage: 0.8 },
    innerSelectedVersusDefault: {
      events: 0,
      pairedEventBootstrap95: {
        betterWhen: "negative",
        logLoss: { estimate: null, interval95: null, status: "not-available" },
        brier: { estimate: null, interval95: null, status: "not-available" },
      },
    },
  };
}

async function writeModeFixture(root, id, allowHistoricalSeeds) {
  const evidenceMode = {
    id,
    label: id === "strict-seeds" ? "Strict fixture" : "Assumed fixture",
    allowHistoricalSeeds,
    snapshotVerified: false,
  };
  const datasetSha256 = "a".repeat(64);
  const datasetSemanticSha256 = "b".repeat(64);
  const implementationSha256 = "c".repeat(64);
  const tuningSpecFileSha256 = "d".repeat(64);
  const tuningSpecSemanticSha256 = "e".repeat(64);
  const outcomeReconciliationSha256 = "f".repeat(64);
  const implementation = { sha256: implementationSha256 };
  const tuningSpec = {
    fileSha256: tuningSpecFileSha256,
    semanticSha256: tuningSpecSemanticSha256,
  };
  const outcomeReconciliation = {
    sha256: outcomeReconciliationSha256,
    datasetSha256,
    allReconciled: true,
  };
  const forecasts = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-set-forecasts-v1",
    evidenceMode,
    implementation,
    tuningSpec,
    sourceIdentity: { targetOutcomesIncluded: false },
    selectedModel: null,
    productize: false,
    uploads: false,
    events: [{
      selections: MODEL_IDS.map((modelId, index) => ({
        modelId,
        selectedCandidateId: `${modelId}-default`,
        options: { setting: index + 1 },
      })),
    }],
  };
  const forecastsBody = artifactBody(forecasts);
  const forecastSha256 = digest(forecastsBody);
  const evaluation = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-tuning-evaluation-v1",
    sourceDatasetSha256: datasetSha256,
    sourceDatasetSemanticSha256: datasetSemanticSha256,
    implementation,
    tuningSpec,
    outcomeReconciliation,
    forecastSha256,
    selectedModel: null,
    productize: false,
    uploads: false,
    coverage: { outerEvents: 1, outerSets: 10 },
    objective: { scoringUnit: "eligible realized target set" },
    models: MODEL_IDS.map(fixtureModel),
    outerFolds: [{
      models: MODEL_IDS.map((modelId) => ({
        id: modelId,
        defaultCandidateId: `${modelId}-default`,
      })),
    }],
  };
  const evaluationBody = artifactBody(evaluation);
  const evaluationSha256 = digest(evaluationBody);
  const manifestBase = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-model-tuning-manifest-v1",
    status: "exploratory-not-confirmatory",
    sourceDatasetSha256: datasetSha256,
    sourceDatasetSemanticSha256: datasetSemanticSha256,
    implementation,
    tuningSpec,
    outcomeReconciliation,
    evidenceMode,
    forecastSha256,
    evaluationSha256,
    warnings: ["Fixture caveat."],
    selectedModel: null,
    productize: false,
    uploads: false,
  };
  const runSha256 = artifactDigest(manifestBase);
  const engineManifest = { ...manifestBase, runSha256 };
  const engineManifestBody = artifactBody(engineManifest);
  const engineManifestSha256 = digest(engineManifestBody);
  const reportBody = `Evidence mode: **${id}**\nForecast SHA-256: \`${forecastSha256}\`\nEvaluation SHA-256: \`${evaluationSha256}\`\n`;
  const reportSha256 = digest(reportBody);
  const runDirectory = `tuning/runs/${forecastSha256}`;
  const pointer = {
    schemaVersion: 1,
    kind: "nested-rolling-origin-tuning-pointer-v1",
    runHash: digest(JSON.stringify({
      forecastSha256,
      evaluationSha256,
      reportSha256,
      engineManifestSha256,
    })),
    runSha256,
    status: "exploratory-not-confirmatory",
    sourceDatasetSha256: datasetSha256,
    sourceDatasetSemanticSha256: datasetSemanticSha256,
    implementation,
    tuningSpec,
    evidenceMode,
    outcomeReconciliation,
    forecastSha256,
    evaluationSha256,
    reportSha256,
    engineManifestSha256,
    forecasts: `${runDirectory}/forecasts.json`,
    evaluation: `${runDirectory}/evaluation-${evaluationSha256}.json`,
    report: `${runDirectory}/report-${reportSha256}.md`,
    engineManifest: `${runDirectory}/manifest-${engineManifestSha256}.json`,
    selectedModel: null,
    productize: false,
    uploads: false,
  };

  await Promise.all([
    writeArtifact(root, pointer.forecasts, forecastsBody),
    writeArtifact(root, pointer.evaluation, evaluationBody),
    writeArtifact(root, pointer.report, reportBody),
    writeArtifact(root, pointer.engineManifest, engineManifestBody),
    writeArtifact(root, `latest-tuning-${id}.json`, `${JSON.stringify(pointer)}\n`),
  ]);
  return { pointer, reportBody };
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "ssbm-backtest-data-"));
  const strict = await writeModeFixture(root, "strict-seeds", false);
  const assumed = await writeModeFixture(root, "availability-assumed", true);
  return { root, strict, assumed };
}

const generatedSource = await readFile(GENERATED_PATH, "utf8");
const generatedBundle = JSON.parse(generatedJsonLiteral(generatedSource));

test("generated public backtest bundle contains both modes and all six model summaries", () => {
  assert.equal(generatedBundle.schemaVersion, 1);
  assert.equal(generatedBundle.kind, "tournament-prediction-public-backtest-v1");
  assert.equal(generatedBundle.status, "exploratory-not-confirmatory");
  assert.deepEqual(generatedBundle.coverage, {
    events: 83,
    sets: 74891,
    scoringUnit: "eligible realized target set",
  });
  assert.deepEqual(generatedBundle.modes.map((mode) => mode.id),
    ["strict-seeds", "availability-assumed"]);
  assert.deepEqual(generatedBundle.modes.map((mode) => mode.label),
    ["Strict seeds", "Seed availability assumed"]);

  for (const mode of generatedBundle.modes) {
    assert.equal(mode.snapshotVerified, false);
    assert.equal(mode.selectedModel, null);
    assert.equal(mode.productize, false);
    assert.deepEqual(mode.models.map((model) => model.id), MODEL_IDS);
    assert.ok(mode.caveats.length > 0);
    assert.ok(Object.values(mode.sourceHashes).every((value) => SHA256.test(value)));
    for (const model of mode.models) {
      assert.equal(model.outerEvents, 83);
      assert.equal(model.scoredOuterEvents, 83);
      assert.equal(model.outerSets, 74891);
      assert.ok(Object.values(model.eventMacro).every(Number.isFinite));
      assert.ok(model.eventMacro.logLoss >= 0);
      assert.ok(model.eventMacro.brier >= 0 && model.eventMacro.brier <= 1);
      assert.ok(model.eventMacro.accuracy >= 0 && model.eventMacro.accuracy <= 1);
      assert.ok(model.eventMacro.auc >= 0 && model.eventMacro.auc <= 1);
      assert.ok(model.pooledCoverage >= 0 && model.pooledCoverage <= 1);
      assert.equal(Object.values(model.tuning.selectionModes)
        .reduce((sum, count) => sum + count, 0), 83);
      assert.equal(model.tuning.selectedSettings.reduce((sum, row) => sum + row.count, 0), 83);
      assert.ok(Math.abs(model.tuning.selectedSettings
        .reduce((sum, row) => sum + row.frequency, 0) - 1) < 1e-12);
    }
  }

  const strictSeed = generatedBundle.modes[0].models.find((model) => model.id === "higher-seed");
  const assumedSeed = generatedBundle.modes[1].models.find((model) => model.id === "higher-seed");
  assert.equal(generatedBundle.modes[0].allowHistoricalSeeds, false);
  assert.equal(generatedBundle.modes[1].allowHistoricalSeeds, true);
  assert.equal(strictSeed.pooledCoverage, 0);
  assert.deepEqual(strictSeed.eventMacro,
    generatedBundle.modes[0].models.find((model) => model.id === "neutral").eventMacro);
  assert.ok(assumedSeed.pooledCoverage > 0.9);

  const lowest = (mode, metric) => [...mode.models]
    .sort((a, b) => a.eventMacro[metric] - b.eventMacro[metric])[0].id;
  assert.equal(lowest(generatedBundle.modes[0], "logLoss"), "glicko2");
  assert.equal(lowest(generatedBundle.modes[0], "brier"), "glicko2");
  assert.equal(lowest(generatedBundle.modes[1], "logLoss"), "regularized-bt-recent-form");
  assert.equal(lowest(generatedBundle.modes[1], "brier"), "regularized-bt-recent-form");

  for (const modelId of ["neutral", "recency-elo", "glicko2", "dynamic-bradley-terry"]) {
    const strict = generatedBundle.modes[0].models.find((model) => model.id === modelId);
    const assumed = generatedBundle.modes[1].models.find((model) => model.id === modelId);
    assert.deepEqual(strict.eventMacro, assumed.eventMacro, `${modelId} changes across seed modes`);
  }
});

test("generated module is deterministic and contains aggregate data only", async () => {
  const fixture = await fixtureRoot();
  const first = await buildTournamentPredictionBacktestBundle({ forecastRoot: fixture.root });
  const second = await buildTournamentPredictionBacktestBundle({ forecastRoot: fixture.root });
  assert.deepEqual(second, first);
  assert.equal(serializeTournamentPredictionBacktestModule(second),
    serializeTournamentPredictionBacktestModule(first));

  const keys = new Set(collectKeys(generatedBundle));
  for (const forbidden of [
    "candidateEventScores", "cutoff", "eventId", "eventLabel", "outerFolds", "predictions",
    "playerId", "entrantId", "setId",
  ]) assert.equal(keys.has(forbidden), false, `public module leaked ${forbidden}`);
  assert.ok(Buffer.byteLength(generatedSource) < 100_000, "public aggregate module unexpectedly grew large");
});

test("generator rejects a content-hash mismatch", async () => {
  const fixture = await fixtureRoot();
  await writeArtifact(fixture.root, fixture.strict.pointer.report, `${fixture.strict.reportBody}tampered\n`);
  await assert.rejects(
    buildTournamentPredictionBacktestBundle({ forecastRoot: fixture.root }),
    /strict-seeds report hash mismatch/,
  );
});

test("generator rejects an artifact path outside its content-addressed run", async () => {
  const fixture = await fixtureRoot();
  const pointerFile = path.join(fixture.root, "latest-tuning-strict-seeds.json");
  const pointer = JSON.parse(await readFile(pointerFile, "utf8"));
  pointer.forecasts = "../outside.json";
  await writeFile(pointerFile, `${JSON.stringify(pointer)}\n`, "utf8");
  await assert.rejects(
    buildTournamentPredictionBacktestBundle({ forecastRoot: fixture.root }),
    /Invalid strict-seeds forecast path/,
  );
});
