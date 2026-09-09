import test from "node:test";
import assert from "node:assert/strict";
import { compareBasicModels, comparisonMarkdown, swapReportingSides } from "../lib/forecast/comparison.mjs";
import { fitBasicModels, initialSeedIndex, actualResult } from "../lib/forecast/baselines.mjs";
import { chronologicalFolds, scorePredictions } from "../lib/forecast/evaluation.mjs";

function fixture() {
  const events = [1, 2, 3].map((i) => ({
    id: "e" + i, name: "Fixture " + i, eligible: true,
    chronology: { reportedEventStartAt: i * 100 + 20, reportedTournamentStartAt: i * 100,
      reportedEventEndAt: i * 100 + 80, reportedTournamentEndAt: i * 100 + 90 },
  }));
  return {
    schemaVersion: 1, events,
    entrants: events.flatMap((e) => ["a", "b"].map((p) => ({ id: e.id + p, eventId: e.id }))),
    seeds: events.flatMap((e) => ["a", "b"].map((p, i) => ({
      id: e.id + "s" + p, eventId: e.id, source: { id: e.id + "s" + p },
      phase: { id: e.id + "phase" }, entrantId: e.id + p, seedNum: i + 1,
      usableAsPreEventFeature: null, exclusionReasons: [],
    }))),
    sets: events.map((e, i) => ({ id: "set" + i, eventId: e.id, eligible: true,
      playerIds: ["a", "b"], entrantIds: [e.id + "a", e.id + "b"], winnerPlayerId: i === 2 ? "b" : "a",
      timestamps: { completedAt: 50 } })),
  };
}

test("comparison holds out each event, emits all metrics and remains experimental", () => {
  const d = fixture();
  const { report, predictions } = compareBasicModels(d);
  assert.equal(report.productize, false);
  assert.equal(report.selectedModel, null);
  assert.equal(report.completeModelSuite, true);
  assert.deepEqual(report.outOfSample.models.map((model) => model.id), [
    "neutral", "higher-seed", "recency-elo", "glicko2",
    "dynamic-bradley-terry", "regularized-bt-recent-form",
  ]);
  assert.equal(report.outOfSample.folds.length, 2);
  assert.equal(predictions.length, 2);
  assert.equal(report.inSample.sets, 3);
  for (const fold of report.outOfSample.folds) assert.ok(!fold.trainingEventIds.includes(fold.eventId));
  assert.equal(report.outOfSample.models[0].scores.brier, 0.25);
  assert.equal(report.outOfSample.models[0].scores.accuracy, 0.5);
  assert.equal(report.outOfSample.models[0].scores.calibration.length, 10);
  assert.match(comparisonMarkdown(report), /not validated for product use/i);
  assert.match(comparisonMarkdown(report), /Retrospective in-sample/);
});

test("future outcomes cannot change earlier predictions; reordering cannot change the report", () => {
  const d = fixture();
  const first = compareBasicModels(d);
  const shuffled = { ...d, events: [...d.events].reverse(), sets: [...d.sets].reverse(), seeds: [...d.seeds].reverse() };
  assert.deepEqual(compareBasicModels(shuffled), first);
  d.sets[2].winnerPlayerId = "a";
  const changed = compareBasicModels(d);
  assert.deepEqual(changed.predictions.map((p) => p.models), first.predictions.map((p) => p.models));
});

test("strict seed mode has no historical coverage and one-event input refuses fake validation", () => {
  const d = fixture();
  const { report } = compareBasicModels(d, { allowHistoricalSeeds: false });
  assert.equal(report.outOfSample.models.find((m) => m.id === "higher-seed").scores.coverage, 0);
  assert.throws(() => compareBasicModels({ ...d, events: [d.events[0]], sets: [d.sets[0]] }), /No chronological test folds/);
});

test("retrospective cutoff includes late result timestamps but chronological folds exclude them", () => {
  const d = fixture();
  d.sets[0].timestamps.completedAt = 350;
  d.sets[2].timestamps.completedAt = 450;
  const { report } = compareBasicModels(d);
  assert.equal(report.outOfSample.folds.length, 1);
  assert.deepEqual(report.outOfSample.folds[0].trainingEventIds, ["e2"]);
  assert.equal(report.inSample.cutoff, 451);
});

test("report orientation is deterministic, auditable and preserves side-symmetric scores without mutating data", () => {
  const d = fixture();
  const unchanged = JSON.stringify(d);
  const { report, predictions } = compareBasicModels(d);
  assert.equal(JSON.stringify(d), unchanged);
  const rows = [[], [], []];
  for (const fold of chronologicalFolds(d).folds) {
    const models = fitBasicModels({ events: fold.trainingEvents, sets: fold.trainingSets,
      cutoff: fold.cutoff, seedIndex: initialSeedIndex(d) });
    for (const set of fold.targetSets) models.forEach((model, i) => rows[i].push({ ...model.predict(set), actual: actualResult(set) }));
  }
  rows.forEach((values, i) => {
    const source = scorePredictions(values);
    const oriented = report.outOfSample.models[i].scores;
    for (const key of ["accuracy", "brier", "logLoss"]) assert.ok(Math.abs(source[key] - oriented[key]) < 1e-12);
    assert.equal(oriented.n, values.length);
  });
  for (const row of predictions) {
    assert.equal(row.sourceSidesSwapped, swapReportingSides(row.setId));
    assert.deepEqual(row.playerIds, row.sourceSidesSwapped ? [...row.sourcePlayerIds].reverse() : row.sourcePlayerIds);
    assert.deepEqual(row.entrantIds, row.sourceSidesSwapped ? [...row.sourceEntrantIds].reverse() : row.sourceEntrantIds);
  }
  assert.match(report.reportingOrientation.methodologicalRevision, /salt not tuned/);
  assert.equal(swapReportingSides("repeat"), swapReportingSides("repeat"));
});
