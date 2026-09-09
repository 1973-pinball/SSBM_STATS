import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL_IDS } from "../lib/forecast/comparison.mjs";
import { digest, readJson, writeJson } from "../lib/forecast/local.mjs";
import { compileReviewedDoubleElimination } from "../lib/forecast/historical-bracket.mjs";
import {
  buildHistoricalTournamentForecasts,
  extractHistoricalTournamentOutcomes,
  historicalBacktestMarkdown,
  scoreHistoricalTournamentForecasts,
} from "../lib/forecast/historical-backtest.mjs";
import { ROOT } from "../lib/liquipedia-data.mjs";

const phase = (id, seeds) => ({
  id,
  name: "Bracket",
  bracketType: "DOUBLE_ELIMINATION",
  numSeeds: seeds,
  phaseOrder: 1,
  state: "COMPLETED",
});

const OUTCOME_RECONCILIATION = Object.freeze({
  report: "datasets/test/outcome-reconciliation.json",
  sha256: "a".repeat(64),
  allReconciled: true,
});
const forecastDigest = (forecast) => digest(JSON.stringify(forecast) + "\n");

const event = (id, start, end, target = false) => ({
  id,
  name: id,
  eligible: true,
  source: { system: "start.gg", id: id.split(":").at(-1), provenanceIds: [target ? "prov-target" : "prov-training"] },
  chronology: {
    reportedEventStartAt: start,
    reportedTournamentStartAt: start,
    reportedEventEndAt: end,
    reportedTournamentEndAt: end,
  },
  ...(target ? {
    numEntrants: 4,
    phases: [phase(20, 4)],
    phaseGroups: [{
      id: 30,
      bracketType: "DOUBLE_ELIMINATION",
      state: 3,
      phase: phase(20, 4),
    }],
  } : {}),
});

const entrant = (eventId, rawId, playerId) => ({
  id: `startgg:entrant:${rawId}`,
  eventId,
  name: `entrant-${rawId}`,
  playerId,
  playerIds: [playerId],
  participantCount: 1,
  identityConflict: false,
  source: { system: "start.gg", id: String(rawId),
    provenanceIds: [eventId === "startgg:event:2" ? "prov-target" : "prov-training"] },
});

const seed = (eventId, rawId, entrantId, seedNum, phaseId, phaseGroupId, provenanceId) => ({
  id: `startgg:seed:${rawId}`,
  eventId,
  entrantId,
  source: { system: "start.gg", id: String(rawId), provenanceIds: [provenanceId] },
  seedNum,
  phase: phase(phaseId, eventId === "startgg:event:2" ? 4 : 2),
  phaseGroupId: String(phaseGroupId),
  groupSeedNum: seedNum,
  isBye: false,
  progressionSeedId: null,
  availability: "unverified-historical",
  usableAsPreEventFeature: null,
  exclusionReasons: [],
});

const seedSlot = (rawSeedId, slotIndex) => ({
  id: `slot-seed-${rawSeedId}`,
  slotIndex,
  prereqType: "seed",
  prereqId: String(rawSeedId),
  prereqPlacement: null,
  entrantId: `realized-${rawSeedId}`,
  placement: slotIndex + 1,
  standingId: `standing-${rawSeedId}`,
  seed: { id: rawSeedId, seedNum: slotIndex + 1 },
});

const setSlot = (rawSetId, result, slotIndex) => ({
  id: `slot-set-${rawSetId}-${result}`,
  slotIndex,
  prereqType: "set",
  prereqId: String(rawSetId),
  prereqPlacement: result === "winner" ? 1 : 2,
  entrantId: `realized-from-${rawSetId}`,
  placement: slotIndex + 1,
  standingId: `standing-from-${rawSetId}`,
  seed: { id: 999000 + slotIndex, seedNum: slotIndex + 1 },
});

function bracketSet(rawId, round, label, sources, winnerIndex = 0, loserPlacement = null) {
  const entrantIds = ["startgg:entrant:201", "startgg:entrant:202"];
  const playerIds = ["player-1", "player-2"];
  return {
    id: `startgg:set:${rawId}`,
    eventId: "startgg:event:2",
    source: { system: "start.gg", id: String(rawId), provenanceIds: ["prov-target"] },
    entrantIds,
    playerIds,
    scores: winnerIndex ? [1, 3] : [3, 1],
    winnerEntrantId: entrantIds[winnerIndex],
    winnerPlayerId: playerIds[winnerIndex],
    eligible: true,
    timestamps: { completedAt: 240 },
    bracket: {
      round,
      fullRoundText: label,
      identifier: String(rawId),
      displayScore: "realized score",
      wPlacement: label.startsWith("Grand Final") ? 1 : null,
      lPlacement: loserPlacement,
      winnerProgressionSeed: null,
      loserProgressionSeed: null,
      phaseGroup: { id: 30, bracketType: "DOUBLE_ELIMINATION", state: 3 },
      slots: sources,
    },
  };
}

export function historicalFixture() {
  const trainingEvent = event("startgg:event:1", 100, 150);
  const targetEvent = event("startgg:event:2", 200, 260, true);
  const trainingEntrants = [
    entrant(trainingEvent.id, 101, "player-1"),
    entrant(trainingEvent.id, 102, "player-2"),
  ];
  const targetEntrants = [1, 2, 3, 4].map((value) => entrant(targetEvent.id, 200 + value, `player-${value}`));
  const targetSets = [
    bracketSet(301, 1, "Winners Semi-Final", [seedSlot(201, 0), seedSlot(204, 1)], 0, 3),
    bracketSet(302, 1, "Winners Semi-Final", [seedSlot(202, 0), seedSlot(203, 1)], 0, 3),
    bracketSet(303, -1, "Losers Round 1", [setSlot(301, "loser", 0), setSlot(302, "loser", 1)], 0, 4),
    bracketSet(304, 2, "Winners Final", [setSlot(301, "winner", 0), setSlot(302, "winner", 1)], 0, 2),
    bracketSet(305, -2, "Losers Final", [setSlot(304, "loser", 0), setSlot(303, "winner", 1)], 0, 3),
    bracketSet(306, 3, "Grand Final", [setSlot(304, "winner", 0), setSlot(305, "winner", 1)], 1, 2),
    bracketSet(307, 3, "Grand Final Reset", [setSlot(306, "winner", 0), setSlot(306, "loser", 1)], 0, 2),
  ];
  const dataset = {
    schemaVersion: 1,
    events: [trainingEvent, targetEvent],
    provenance: [
      { id: "prov-training", fetchedAt: "1970-01-01T00:01:00.000Z" },
      { id: "prov-target", fetchedAt: "1970-01-01T00:08:20.000Z" },
    ],
    players: [1, 2, 3, 4].map((value) => ({ id: `player-${value}` })),
    aliases: [],
    entrants: [...trainingEntrants, ...targetEntrants],
    seeds: [
      seed(trainingEvent.id, 101, trainingEntrants[0].id, 1, 10, 11, "prov-training"),
      seed(trainingEvent.id, 102, trainingEntrants[1].id, 2, 10, 11, "prov-training"),
      ...targetEntrants.map((row, index) => seed(targetEvent.id, 201 + index, row.id, index + 1, 20, 30, "prov-target")),
    ],
    sets: [{
      id: "startgg:set:101",
      eventId: trainingEvent.id,
      source: { system: "start.gg", id: "101", provenanceIds: ["prov-training"] },
      eligible: true,
      entrantIds: trainingEntrants.map((row) => row.id),
      playerIds: trainingEntrants.map((row) => row.playerId),
      winnerEntrantId: trainingEntrants[0].id,
      winnerPlayerId: trainingEntrants[0].playerId,
      scores: [3, 1],
      timestamps: { completedAt: 140 },
    }, ...targetSets],
    standings: targetEntrants.map((row, index) => ({
      id: `standing-${index + 1}`,
      eventId: targetEvent.id,
      entrantId: row.id,
      placement: index + 1,
      exclusionReasons: [],
    })),
  };
  const review = {
    eventId: targetEvent.id,
    disposition: "included",
    fieldSize: 4,
    initialPhaseId: "20",
    phaseGroupId: "30",
    grandFinalSetId: "startgg:set:306",
    resetRule: "if-lower-side-wins-grand-final",
    structuralSha256: "0".repeat(64),
  };
  review.structuralSha256 = compileReviewedDoubleElimination(dataset, review).structuralSha256;
  return { dataset, contract: { schemaVersion: 1, id: "test-routes-v1", events: [review] } };
}

test("target outcomes and realized slot identities cannot change a historical forecast", () => {
  const { dataset, contract } = historicalFixture();
  const options = { simulations: 256, randomSeed: 1234, allowUnverifiedHistoricalFeatures: true };
  const forecast = buildHistoricalTournamentForecasts(dataset, contract, options);
  assert.equal(forecast.status, "exploratory-pipeline-validation");
  assert.equal(forecast.productize, false);
  assert.equal(forecast.uploads, false);
  assert.deepEqual(forecast.modelIds, MODEL_IDS);
  assert.equal(forecast.events.length, 1);
  assert.ok(!forecast.events[0].trainingEventIds.includes(forecast.events[0].eventId));
  assert.deepEqual(forecast.events[0].models.map((model) => model.id), MODEL_IDS);

  const changed = structuredClone(dataset);
  for (const set of changed.sets.filter((row) => row.eventId === "startgg:event:2")) {
    set.entrantIds.reverse();
    set.playerIds.reverse();
    set.scores.reverse();
    set.winnerEntrantId = "startgg:entrant:204";
    set.winnerPlayerId = "player-4";
    set.bracket.displayScore = "mutated outcome";
    for (const slot of set.bracket.slots) {
      slot.entrantId = "mutated-realized-entrant";
      slot.placement = 99;
      slot.standingId = "mutated-standing";
      slot.seed = { id: 123456789, seedNum: 999 };
    }
  }
  changed.events.find((row) => row.id === "startgg:event:2").eligible = false;
  changed.standings[0].placement = 2;
  changed.standings[1].placement = 1;
  assert.deepEqual(buildHistoricalTournamentForecasts(changed, contract, options), forecast);

  const forecastSha256 = forecastDigest(forecast);
  const firstOutcomes = extractHistoricalTournamentOutcomes(dataset, forecast,
    { outcomeReconciliation: OUTCOME_RECONCILIATION, forecastSha256 });
  const changedOutcomes = extractHistoricalTournamentOutcomes(changed, forecast,
    { outcomeReconciliation: OUTCOME_RECONCILIATION, forecastSha256 });
  assert.notDeepEqual(changedOutcomes, firstOutcomes);
  assert.notDeepEqual(
    scoreHistoricalTournamentForecasts(forecast, changedOutcomes, { forecastSha256 }),
    scoreHistoricalTournamentForecasts(forecast, firstOutcomes, { forecastSha256 }),
  );
});

test("default historical feature policy fails closed without a coherent pre-cutoff snapshot", () => {
  const { dataset, contract } = historicalFixture();
  const forecast = buildHistoricalTournamentForecasts(dataset, contract, {
    simulations: 16,
    randomSeed: 1,
  });
  assert.equal(forecast.events.length, 0);
  assert.equal(forecast.status, "no-eligible-events");
  assert.equal(forecast.featureAvailabilityPolicy.allowUnverifiedHistoricalFeatures, false);
  assert.deepEqual(forecast.exclusions.find((row) => row.eventId === "startgg:event:2").reasons,
    ["historical_features_not_observed_before_cutoff"]);
});

test("default policy accepts only complete pre-cutoff provenance and rejects mixed rows", () => {
  const { dataset, contract } = historicalFixture();
  dataset.provenance.find((row) => row.id === "prov-target").fetchedAt = "1970-01-01T00:02:30.000Z";
  const verified = buildHistoricalTournamentForecasts(dataset, contract, { simulations: 16, randomSeed: 2 });
  assert.equal(verified.status, "pipeline-validation");
  assert.equal(verified.events.length, 1);
  assert.equal(verified.events[0].featureAvailability.status, "observed-before-cutoff");

  const mixed = structuredClone(dataset);
  mixed.provenance.push({ id: "prov-post", fetchedAt: "1970-01-01T00:08:20.000Z" });
  mixed.seeds.find((row) => row.eventId === "startgg:event:2").source.provenanceIds.push("prov-post");
  const excluded = buildHistoricalTournamentForecasts(mixed, contract, { simulations: 16, randomSeed: 2 });
  assert.equal(excluded.events.length, 0);
  const target = excluded.exclusions.find((row) => row.eventId === "startgg:event:2");
  assert.equal(target.featureAvailability.unverifiedRows[0].allObservedBeforeCutoff, false);
  assert.equal(target.featureAvailability.unverifiedRows[0].disqualifyingProvenance[0].provenanceId,
    "prov-post");

  const lateTraining = structuredClone(dataset);
  lateTraining.provenance.find((row) => row.id === "prov-training").fetchedAt
    = "1970-01-01T00:08:20.000Z";
  const noTraining = buildHistoricalTournamentForecasts(lateTraining, contract,
    { simulations: 16, randomSeed: 2 });
  const trainingExclusion = noTraining.exclusions.find((row) => row.eventId === "startgg:event:2");
  assert.deepEqual(trainingExclusion.reasons, ["insufficient_training_events"]);
  assert.equal(trainingExclusion.trainingSourceAvailability.events[0].coherent, false);
});

test("scores tournament outcomes separately and never selects a model", () => {
  const { dataset, contract } = historicalFixture();
  const forecast = buildHistoricalTournamentForecasts(dataset, contract, {
    simulations: 512, randomSeed: 99, allowUnverifiedHistoricalFeatures: true,
  });
  const forecastSha256 = forecastDigest(forecast);
  const outcomes = extractHistoricalTournamentOutcomes(dataset, forecast,
    { outcomeReconciliation: OUTCOME_RECONCILIATION, forecastSha256 });
  const report = scoreHistoricalTournamentForecasts(forecast, outcomes,
    { dataset, forecastSha256 });
  assert.equal(outcomes.source, "canonical-final-standings");
  assert.equal(report.forecastEvents, 1);
  assert.deepEqual(report.models.map((model) => model.id), MODEL_IDS);
  assert.equal(report.selectedModel, null);
  assert.equal(report.productize, false);
  assert.equal(report.uploads, false);
  assert.equal(report.events[0].actualChampionLabel, "entrant-201");
  assert.ok(report.events[0].models.every((model) => model.topTitleLabel?.startsWith("entrant-")));
  for (const model of report.models) {
    assert.equal(model.events, 1);
    assert.ok(Number.isFinite(model.metrics.titleLogLoss));
    assert.ok(Number.isFinite(model.metrics.titleBrier));
    assert.ok(model.metrics.top8Brier > 0 && model.metrics.top8Brier < 0.00001);
    assert.equal(model.metrics.predictedTop8Overlap, 4);
  }
  assert.match(historicalBacktestMarkdown(report), /pipeline validation/i);
  assert.match(historicalBacktestMarkdown(report), /does not select a model/i);
  assert.match(historicalBacktestMarkdown(report), /entrant-201 \(startgg:entrant:201\)/);

  const zeroFrequency = structuredClone(forecast);
  const champion = outcomes.events[0].champion.entrantId;
  const row = zeroFrequency.events[0].models[0].entrants.find((entry) => entry.entrantId === champion);
  const recipient = zeroFrequency.events[0].models[0].entrants.find((entry) => entry.entrantId !== champion);
  recipient.titleWins += row.titleWins;
  recipient.titleProbability = recipient.titleWins / zeroFrequency.simulations.count;
  row.titleWins = 0;
  row.titleProbability = 0;
  const zeroFrequencySha256 = forecastDigest(zeroFrequency);
  const zeroFrequencyOutcomes = structuredClone(outcomes);
  zeroFrequencyOutcomes.forecastSha256 = zeroFrequencySha256;
  const smoothed = scoreHistoricalTournamentForecasts(zeroFrequency, zeroFrequencyOutcomes,
    { forecastSha256: zeroFrequencySha256 });
  assert.ok(smoothed.models[0].metrics.titleLogLoss < 10,
    "zero Monte Carlo title counts use finite count-aware smoothing rather than epsilon clipping");
});

test("route-contract structural hashes fail closed", () => {
  const { dataset, contract } = historicalFixture();
  contract.events[0].structuralSha256 = "f".repeat(64);
  assert.throws(() => buildHistoricalTournamentForecasts(dataset, contract, {
    simulations: 2, allowUnverifiedHistoricalFeatures: true,
  }),
    /Reviewed route structure changed/);
  const withOutcomeMetadata = historicalFixture();
  withOutcomeMetadata.contract.events[0].winner = "must-not-enter-forecast-contract";
  assert.throws(() => buildHistoricalTournamentForecasts(withOutcomeMetadata.dataset,
    withOutcomeMetadata.contract, { simulations: 2, allowUnverifiedHistoricalFeatures: true }),
  /Unknown historical route fields/);
});

test("scoring rejects unaudited, unpaired, or model-incomplete artifacts", () => {
  const { dataset, contract } = historicalFixture();
  const forecast = buildHistoricalTournamentForecasts(dataset, contract, {
    simulations: 16, randomSeed: 3, allowUnverifiedHistoricalFeatures: true,
    sourceDatasetSha256: "b".repeat(64),
  });
  const forecastSha256 = forecastDigest(forecast);
  const unaudited = extractHistoricalTournamentOutcomes(dataset, forecast, { forecastSha256 });
  assert.throws(() => scoreHistoricalTournamentForecasts(forecast, unaudited,
    { forecastSha256 }), /all-reconciled/);

  const outcomes = extractHistoricalTournamentOutcomes(dataset, forecast, {
    outcomeReconciliation: OUTCOME_RECONCILIATION,
    forecastSha256,
  });
  assert.throws(() => scoreHistoricalTournamentForecasts(forecast, outcomes),
    /requires the expected 64-character forecast SHA-256/);
  assert.throws(() => scoreHistoricalTournamentForecasts(forecast, outcomes,
    { forecastSha256: "d".repeat(64) }), /not paired/);

  const differentForecast = buildHistoricalTournamentForecasts(dataset, contract, {
    simulations: 16, randomSeed: 4, allowUnverifiedHistoricalFeatures: true,
    sourceDatasetSha256: "b".repeat(64),
  });
  assert.notEqual(forecastDigest(differentForecast), forecastSha256);
  assert.throws(() => scoreHistoricalTournamentForecasts(differentForecast, outcomes,
    { forecastSha256 }), /does not match the scored forecast artifact/);

  const wrongSource = structuredClone(outcomes);
  wrongSource.sourceDatasetSha256 = "e".repeat(64);
  assert.throws(() => scoreHistoricalTournamentForecasts(forecast, wrongSource,
    { forecastSha256 }), /source\/route provenance/);
  const incomplete = structuredClone(forecast);
  incomplete.events[0].models.pop();
  const incompleteSha256 = forecastDigest(incomplete);
  const incompleteOutcomes = structuredClone(outcomes);
  incompleteOutcomes.forecastSha256 = incompleteSha256;
  assert.throws(() => scoreHistoricalTournamentForecasts(incomplete, incompleteOutcomes,
    { forecastSha256: incompleteSha256 }), /model membership/);
});

test("CLI writes deterministic content-addressed forecast, outcome and report artifacts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ssbm-historical-backtest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dataset, contract } = historicalFixture();
  const datasetBody = JSON.stringify(dataset) + "\n";
  const datasetSha256 = digest(datasetBody);
  const datasetFile = `datasets/${datasetSha256}/dataset.json`;
  const routeFile = path.join(root, "route-contract.json");
  const audit = {
    schemaVersion: 1,
    kind: "forecast-historical-outcome-reconciliation-v1",
    datasetSha256,
    advisoryOnly: true,
    allReconciled: true,
  };
  const auditBody = JSON.stringify(audit) + "\n";
  const auditSha256 = digest(auditBody);
  const auditFile = `datasets/${datasetSha256}/outcome-reconciliation-${auditSha256}.json`;
  await writeJson(path.join(root, datasetFile), dataset);
  await writeJson(path.join(root, auditFile), audit);
  await writeJson(path.join(root, "latest.json"), {
    dataset: datasetFile,
    sha256: datasetSha256,
    outcomeReconciliation: { report: auditFile, sha256: auditSha256, allReconciled: true },
  });
  await writeJson(routeFile, contract);
  const run = (...extra) => spawnSync(process.execPath, [
    path.join(ROOT, "scripts/forecast.mjs"), "backtest", "--root", root,
    "--routing-contract", routeFile, ...extra,
  ], { encoding: "utf8", env: { ...process.env, STARTGG_TOKEN: "" } });

  const strict = run();
  assert.equal(strict.status, 0, strict.stderr);
  const strictManifest = await readJson(path.join(root, "latest-backtest.json"));
  const strictForecast = await readJson(path.join(root, strictManifest.forecasts));
  assert.equal(strictManifest.status, "no-eligible-events");
  assert.equal(strictManifest.allowUnverifiedHistoricalFeatures, false);
  assert.equal(strictManifest.featureAvailabilityPolicy.allowUnverifiedHistoricalFeatures, false);
  assert.equal(strictForecast.events.length, 0);
  assert.equal(strictForecast.exclusions.find((row) => row.eventId === "startgg:event:2")
    .reasons[0], "historical_features_not_observed_before_cutoff");

  const first = run("--allow-unverified-historical-features");
  assert.equal(first.status, 0, first.stderr);
  const manifest = await readJson(path.join(root, "latest-backtest.json"));
  assert.equal(manifest.status, "exploratory-pipeline-validation");
  assert.equal(manifest.allowUnverifiedHistoricalFeatures, true);
  assert.equal(manifest.featureAvailabilityPolicy.allowUnverifiedHistoricalFeatures, true);
  assert.equal(manifest.outcomeReconciliation.sha256, auditSha256);
  assert.equal(manifest.simulations, 20_000);
  assert.equal(manifest.productize, false);
  assert.equal(manifest.uploads, false);
  assert.match(manifest.forecasts, /^backtests\/[a-f0-9]{64}\/forecasts\.json$/);
  assert.match(manifest.outcomes, /^backtests\/[a-f0-9]{64}\/outcomes-[a-f0-9]{64}\.json$/);
  assert.match(manifest.report, /^backtests\/[a-f0-9]{64}\/backtest-[a-f0-9]{64}\.json$/);
  const forecastBody = await readFile(path.join(root, manifest.forecasts), "utf8");
  const outcomeBody = await readFile(path.join(root, manifest.outcomes), "utf8");
  const reportBody = await readFile(path.join(root, manifest.report), "utf8");
  assert.equal(digest(forecastBody), manifest.forecastSha256);
  assert.equal(digest(outcomeBody), manifest.outcomesSha256);
  assert.equal(digest(reportBody), manifest.reportSha256);
  assert.equal(JSON.parse(forecastBody).events.length, 1);
  assert.doesNotMatch(forecastBody, /winnerEntrantId|winnerPlayerId|displayScore|"scores"|"standings"/);
  assert.doesNotMatch(forecastBody, /entrant-201/);
  assert.match(outcomeBody, /canonical-final-standings/);
  assert.doesNotMatch(outcomeBody, /entrant-201/);
  assert.match(await readFile(path.join(root, manifest.markdown), "utf8"), /Per-event picks and outcomes/);

  const second = run("--allow-unverified-historical-features");
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await readJson(path.join(root, "latest-backtest.json")), manifest);
  const explicitStrict = run("--strict-seeds");
  assert.equal(explicitStrict.status, 0, explicitStrict.stderr);
  assert.deepEqual(await readJson(path.join(root, "latest-backtest.json")), strictManifest);
});
