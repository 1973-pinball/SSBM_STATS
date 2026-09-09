import test from 'node:test';
import assert from 'node:assert/strict';
import { chronologicalFolds, eventTimeBounds, scorePredictions } from '../lib/forecast/evaluation.mjs';

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function event(id, start, end, chronology = {}) {
  return {
    id, eligible: true, exclusionReasons: [],
    chronology: {
      startAt: start, endAt: end, precision: 'reported-source-timestamps',
      reportedEventStartAt: start, reportedEventEndAt: end,
      reportedTournamentStartAt: start, reportedTournamentEndAt: end,
      ...chronology,
    },
  };
}
function set(id, eventId, extra = {}) {
  return { id, eventId, eligible: true, exclusionReasons: [], timestamps: { completedAt: 1 }, ...extra };
}
function fixture(events, sets = events.map((row) => set(`set-${row.id}`, row.id))) {
  return { schemaVersion: 1, events, sets };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('neutral predictions score 0.5 tie accuracy and tie-correct AUC regardless of actual balance', () => {
  const score = scorePredictions([{ p: 0.5, actual: 1 }, { p: 0.5, actual: 1 }, { p: 0.5, actual: 0 }]);
  assert.equal(score.n, 3);
  assert.equal(score.accuracy, 0.5);
  assert.equal(score.brier, 0.25);
  close(score.logLoss, Math.log(2));
  assert.equal(score.auc, 0.5);
  assert.equal(score.calibration[5].n, 3);
  assert.equal(score.calibration[5].winRate, 2 / 3);
});

test('perfect and reversed predictions retain boundary Brier/accuracy while log loss is finite and explicit', () => {
  const perfect = scorePredictions([{ p: 0, actual: 0 }, { p: 1, actual: 1 }]);
  assert.equal(perfect.accuracy, 1);
  assert.equal(perfect.brier, 0);
  assert.equal(perfect.auc, 1);
  close(perfect.logLoss, 0);
  assert.equal(perfect.logLossEpsilon, 1e-15);
  const reversed = scorePredictions([{ p: 0, actual: 1 }, { p: 1, actual: 0 }]);
  assert.equal(reversed.accuracy, 0);
  assert.equal(reversed.brier, 1);
  assert.equal(reversed.auc, 0);
  close(reversed.logLoss, -(Math.log(1e-15) + Math.log1p(-(1 - 1e-15))) / 2);
  assert.ok(Number.isFinite(JSON.parse(JSON.stringify(reversed)).logLoss));
});

test('AUC counts partially tied positive-negative pairs, not arbitrary sorted tie order', () => {
  const rows = [{ p: 0.8, actual: 1 }, { p: 0.8, actual: 0 }, { p: 0.2, actual: 0 }, { p: 0.1, actual: 1 }];
  assert.equal(scorePredictions(rows).auc, 0.375);
  const frozen = freeze(rows);
  assert.deepEqual(scorePredictions(frozen), scorePredictions([...rows].reverse()));
});

test('empty and single-class predictions do not invent undefined scores', () => {
  const empty = scorePredictions([]);
  for (const field of ['accuracy', 'brier', 'logLoss', 'auc']) assert.equal(empty[field], null);
  assert.equal(empty.n, 0);
  assert.equal(empty.calibration.length, 10);
  assert.ok(empty.calibration.every((row) => row.n === 0 && row.meanP === null && row.winRate === null && row.wilson95 === null));
  assert.equal(scorePredictions([{ p: 0.9, actual: 1 }]).auc, null);
  assert.equal(scorePredictions([{ p: 0.1, actual: 0 }, { p: 0.2, actual: 0 }]).auc, null);
});

test('calibration bins include exact lower boundaries and p=1 with observed Wilson intervals', () => {
  const rows = [{ p: 0, actual: 0 }, { p: 0.2, actual: 1 }, { p: 0.5, actual: 0 }, { p: 1, actual: 1 }];
  const bins = scorePredictions(rows, { bins: 2 }).calibration;
  assert.deepEqual(bins.map(({ lower, upper, n, meanP, winRate }) => ({ lower, upper, n, meanP, winRate })), [
    { lower: 0, upper: 0.5, n: 2, meanP: 0.1, winRate: 0.5 },
    { lower: 0.5, upper: 1, n: 2, meanP: 0.75, winRate: 0.5 },
  ]);
  close(bins[0].wilson95[0], 0.0945312057342307);
  close(bins[0].wilson95[1], 0.9054687942657693);
  const extremes = scorePredictions([{ p: 0, actual: 0 }, { p: 1, actual: 1 }], { bins: 2 }).calibration;
  assert.equal(extremes[0].wilson95[0], 0);
  assert.equal(extremes[1].wilson95[1], 1);
  assert.equal(scorePredictions(rows, { bins: 1 }).calibration[0].n, 4);
});

test('invalid probabilities, outcomes, sparse rows and calibration options are rejected', () => {
  assert.throws(() => scorePredictions({}), /array/);
  for (const p of [-0.1, 1.01, NaN, Infinity, -Infinity, '0.5', null, undefined]) {
    assert.throws(() => scorePredictions([{ p, actual: 1 }]), /numeric p/);
  }
  for (const actual of [-1, 2, 0.5, true, false, '1', null, undefined, NaN]) {
    assert.throws(() => scorePredictions([{ p: 0.5, actual }]), /actual/);
  }
  assert.throws(() => scorePredictions(Array(1)), /numeric p/);
  for (const bins of [0, -1, 0.5, 1001, Infinity, '10']) {
    assert.throws(() => scorePredictions([], { bins }), /bins/);
  }
});

test('event bounds use min start and max end, preserving source evidence without date inference', () => {
  const row = freeze(event('a', 30, 40, { reportedTournamentStartAt: 10, reportedTournamentEndAt: 50 }));
  assert.deepEqual(eventTimeBounds(row), {
    cutoff: 10, trainingEnd: 50,
    cutoffSources: ['reportedTournamentStartAt'], trainingEndSources: ['reportedTournamentEndAt'],
  });
  assert.equal(row.chronology.startAt, 30);
  assert.deepEqual(eventTimeBounds({ chronology: { startAt: 5, endAt: 100 } }), {
    cutoff: null, trainingEnd: null, cutoffSources: [], trainingEndSources: [],
  });
  const invalid = event('invalid', 1, 2, {
    reportedEventStartAt: NaN, reportedTournamentStartAt: '10',
    reportedEventEndAt: -1, reportedTournamentEndAt: Infinity,
  });
  assert.equal(eventTimeBounds(invalid).cutoff, null);
  assert.equal(eventTimeBounds(invalid).trainingEnd, null);
});

test('target sets reported before nominal start remain held out by event ID', () => {
  const early = event('early', 10, 20);
  const target = event('target', 100, 200, { reportedTournamentStartAt: 80 });
  const data = freeze(fixture([target, early], [set('target-early-set', 'target', { timestamps: { completedAt: 5 } }), set('early-set', 'early')]));
  const result = chronologicalFolds(data);
  assert.equal(result.folds.length, 1);
  const fold = result.folds[0];
  assert.equal(fold.targetEvent, target);
  assert.equal(fold.cutoff, 80);
  assert.deepEqual(fold.trainingEvents.map((row) => row.id), ['early']);
  assert.deepEqual(fold.trainingSets.map((row) => row.id), ['early-set']);
  assert.deepEqual(fold.targetSets.map((row) => row.id), ['target-early-set']);
  assert.equal(fold.targetSets[0].timestamps.completedAt, 5);
  assert.ok(fold.exclusions.trainingEvents.find((row) => row.eventId === 'target').reasons.includes('target_event'));
});

test('strict end boundary excludes equality, overlaps, missing ends and later events', () => {
  const data = fixture([
    event('prior', 10, 20),
    event('same-boundary', 30, 100),
    event('overlap', 40, 90, { reportedTournamentEndAt: 110 }),
    event('unknown-end', 50, null),
    event('target', 120, 150, { reportedTournamentStartAt: 100 }),
    event('future', 200, 250),
  ]);
  const fold = chronologicalFolds(data).folds.find((row) => row.targetEvent.id === 'target');
  assert.deepEqual(fold.trainingEvents.map((row) => row.id), ['prior']);
  for (const id of ['same-boundary', 'overlap', 'future']) {
    assert.ok(fold.exclusions.trainingEvents.find((row) => row.eventId === id).reasons.includes('end_at_or_after_cutoff'));
  }
  assert.ok(fold.exclusions.trainingEvents.find((row) => row.eventId === 'unknown-end').reasons.includes('missing_reported_end'));
  // A missing end blocks training, not a target with known start and outcomes.
  assert.ok(chronologicalFolds(data).folds.some((row) => row.targetEvent.id === 'unknown-end'));
});

test('a late eligible completion excludes its entire event until strictly before the target cutoff', () => {
  const data = fixture([
    event('safe', 10, 20), event('late', 30, 40), event('equal', 50, 60),
    event('target', 100, 110), event('after-correction', 200, 210),
  ], [
    set('safe-set', 'safe', { timestamps: { completedAt: 99 } }),
    set('late-early-set', 'late', { timestamps: { completedAt: 35 } }),
    set('late-corrected-set', 'late', { timestamps: { completedAt: 150 } }),
    set('equal-set', 'equal', { timestamps: { completedAt: 100 } }),
    set('target-set', 'target'), set('after-correction-set', 'after-correction'),
  ]);
  const result = chronologicalFolds(freeze(data));
  const fold = result.folds.find((row) => row.targetEvent.id === 'target');
  assert.deepEqual(fold.trainingEvents.map((row) => row.id), ['safe']);
  assert.deepEqual(fold.trainingSets.map((row) => row.id), ['safe-set']);
  assert.deepEqual(fold.exclusions.trainingEvents.find((row) => row.eventId === 'late'), {
    eventId: 'late', trainingEnd: 40, reasons: ['eligible_set_completed_at_or_after_cutoff'],
    latestEligibleCompletedAt: 150, latestEligibleCompletedSetId: 'late-corrected-set',
  });
  assert.ok(fold.exclusions.trainingEvents.find((row) => row.eventId === 'equal').reasons.includes('eligible_set_completed_at_or_after_cutoff'));
  const later = result.folds.find((row) => row.targetEvent.id === 'after-correction');
  assert.ok(later.trainingSets.some((row) => row.id === 'late-early-set'));
  assert.ok(later.trainingSets.some((row) => row.id === 'late-corrected-set'));
  assert.equal(eventTimeBounds(data.events[1]).trainingEnd, 40);
  assert.match(result.policy.lateCompletionGuard, /whole training event/);
  assert.match(result.policy.sourceAvailability, /do not prove historical corrections/);
});

test('missing or invalid set completion times and ineligible late rows do not replace reported event ends', () => {
  const unknownTimes = [undefined, null, 0, -1, NaN, Infinity, '1000'];
  const data = fixture([
    event('prior', 10, 20), event('missing-end', 30, null), event('target', 100, 110),
  ], [
    ...unknownTimes.map((completedAt, index) => set(`unknown-${index}`, 'prior', { timestamps: { completedAt } })),
    set('no-timestamps', 'prior', { timestamps: undefined }),
    set('excluded-late', 'prior', { eligible: false, exclusionReasons: ['dq'], timestamps: { completedAt: 1000 } }),
    set('early-without-event-end', 'missing-end', { timestamps: { completedAt: 40 } }),
    set('target-set', 'target'),
  ]);
  const fold = chronologicalFolds(freeze(data)).folds.find((row) => row.targetEvent.id === 'target');
  assert.deepEqual(fold.trainingEvents.map((row) => row.id), ['prior']);
  assert.equal(fold.trainingSets.length, unknownTimes.length + 1);
  assert.ok(fold.exclusions.trainingEvents.find((row) => row.eventId === 'missing-end').reasons.includes('missing_reported_end'));
});

test('only eligible sets in eligible events are usable and coverage reconciles every source row', () => {
  const prior = event('prior', 10, 20);
  const ineligible = { ...event('online', 30, 40), eligible: false, exclusionReasons: ['event_online'] };
  const target = event('target', 50, 60);
  const data = fixture([prior, ineligible, target], [
    set('prior-good', 'prior'), set('prior-dq', 'prior', { eligible: false, exclusionReasons: ['dq'] }),
    set('online-set', 'online'), set('target-good', 'target'),
    set('target-bye', 'target', { eligible: false, exclusionReasons: ['bye'] }), set('orphan', 'missing'),
  ]);
  const result = chronologicalFolds(data);
  assert.deepEqual(result.folds[0].trainingSets.map((row) => row.id), ['prior-good']);
  assert.deepEqual(result.folds[0].targetSets.map((row) => row.id), ['target-good']);
  assert.deepEqual(result.coverage, {
    sourceEvents: 3, sourceSets: 6, eligibleEvents: 2, eligibleSets: 2,
    usableEvents: 2, evaluatedEvents: 1, evaluatedSets: 1,
    excludedTargetEvents: 2, excludedTargetSets: 5,
  });
  assert.deepEqual(result.folds[0].exclusions.targetSets[0].sourceReasons, ['bye']);
  assert.deepEqual(result.exclusions.events[0].sourceReasons, ['event_online']);
  assert.ok(result.exclusions.sets.find((row) => row.setId === 'orphan').reasons.includes('missing_event'));
  assert.equal(result.folds[0].coverage.targetSetRows, 2);
  assert.equal(result.folds[0].coverage.excludedTargetSets, 1);
});

test('missing starts, invalid intervals and empty events never satisfy the training minimum', () => {
  const data = fixture([
    event('empty', 1, 2), event('no-start', null, 3), event('invalid', 9, 4),
    event('first', 10, 20), event('second', 30, 40), event('third', 50, 60),
  ]);
  data.sets = data.sets.filter((row) => row.eventId !== 'empty');
  // Nominal fallback dates are deliberately ignored.
  data.events[1].chronology.startAt = 1;
  const result = chronologicalFolds(data, { minTrainingEvents: 2 });
  assert.deepEqual(result.folds.map((row) => row.targetEvent.id), ['third']);
  assert.deepEqual(result.folds[0].trainingEvents.map((row) => row.id), ['first', 'second']);
  assert.ok(result.exclusions.events.find((row) => row.eventId === 'empty').reasons.includes('no_eligible_sets'));
  assert.ok(result.exclusions.events.find((row) => row.eventId === 'no-start').reasons.includes('missing_reported_start'));
  assert.ok(result.exclusions.events.find((row) => row.eventId === 'invalid').reasons.includes('invalid_reported_interval'));
  assert.equal(result.exclusions.targets.find((row) => row.eventId === 'second').trainingEvents, 1);
});

test('input order does not change folds and set order is ID order, never source completion order', () => {
  const data = fixture([event('b', 10, 20), event('a', 10, 20), event('target', 40, 60)]);
  data.sets.push(set('a-lexical-first', 'a', { timestamps: { completedAt: 39 } }));
  data.sets.push(set('z-lexical-last', 'a', { timestamps: { completedAt: 1 } }));
  const reversed = structuredClone(data);
  reversed.events.reverse(); reversed.sets.reverse();
  const result = chronologicalFolds(freeze(data), { minTrainingEvents: 0 });
  assert.deepEqual(result, chronologicalFolds(freeze(reversed), { minTrainingEvents: 0 }));
  assert.deepEqual(result.folds.map((row) => row.targetEvent.id), ['a', 'b', 'target']);
  assert.deepEqual(result.folds[0].targetSets.map((row) => row.id), ['a-lexical-first', 'set-a', 'z-lexical-last']);
  assert.equal(result.folds[0].trainingEvents.length, 0);
  assert.equal(result.folds[1].trainingEvents.length, 0);
  assert.deepEqual(result.folds[2].trainingEvents.map((row) => row.id), ['a', 'b']);
});

test('empty folds remain auditable and malformed datasets, duplicate IDs and options fail loudly', () => {
  const empty = chronologicalFolds(fixture([]));
  assert.deepEqual(empty.folds, []);
  assert.equal(empty.coverage.sourceSets, 0);
  assert.deepEqual(empty.exclusions, { events: [], sets: [], targets: [] });
  for (const data of [undefined, null, {}, { events: [] }, { events: {}, sets: [] }]) {
    assert.throws(() => chronologicalFolds(data), /arrays/);
  }
  for (const minTrainingEvents of [-1, 0.5, Infinity, '1']) {
    assert.throws(() => chronologicalFolds(fixture([]), { minTrainingEvents }), /nonnegative integer/);
  }
  assert.throws(() => chronologicalFolds(fixture([event('a', 1, 2), event('a', 1, 2)], [])), /Duplicate event id/);
  assert.throws(() => chronologicalFolds(fixture([], [set('a', 'x'), set('a', 'x')])), /Duplicate set id/);
  assert.throws(() => chronologicalFolds(fixture([{ eligible: true }], [])), /string id/);
});
