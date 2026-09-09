const LOG_LOSS_EPSILON = 1e-15;
const WILSON_Z = 1.959963984540054;

/**
 * Unweighted binary scores; p is P(actual = 1), and actual must be numeric 0/1.
 * Accuracy uses the > 0.5 decision and gives exactly 0.5 half credit, the
 * expected accuracy of a fair tie-break (independent of left/right orientation).
 * Only log loss clips p to [epsilon, 1-epsilon], keeping JSON reports finite.
 * AUC uses half credit for tied positive/negative scores, in O(n log n).
 * Calibration bins are [lower, upper), except the final bin includes 1.
 * Wilson intervals describe binomial observed rates, not forecast uncertainty
 * or event-cluster-adjusted confidence intervals. Empty scores/intervals are null.
 */
export function scorePredictions(rows, { bins = 10 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('Predictions must be an array');
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > 1000) {
    throw new RangeError('bins must be an integer from 1 to 1000');
  }
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row.p !== 'number' || !Number.isFinite(row.p) || row.p < 0 || row.p > 1) {
      throw new TypeError(`Prediction ${index} needs a finite numeric p in [0, 1]`);
    }
    if (row.actual !== 0 && row.actual !== 1) {
      throw new TypeError(`Prediction ${index} needs numeric actual 0 or 1`);
    }
  }
  // Reuse the AUC sort for deterministic floating-point accumulation too.
  const ordered = [...rows].sort((a, b) => a.p - b.p || a.actual - b.actual);
  const buckets = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, wins: 0 }));
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  let positives = 0;
  for (const { p, actual } of ordered) {
    correct += p === 0.5 ? 0.5 : Number(Number(p > 0.5) === actual);
    brier += (p - actual) ** 2;
    const clipped = Math.max(LOG_LOSS_EPSILON, Math.min(1 - LOG_LOSS_EPSILON, p));
    logLoss -= actual === 1 ? Math.log(clipped) : Math.log1p(-clipped);
    positives += actual;
    const bucket = buckets[Math.min(bins - 1, Math.floor(p * bins))];
    bucket.n++;
    bucket.sumP += p;
    bucket.wins += actual;
  }
  let concordance = 0;
  let negativesBefore = 0;
  for (let index = 0; index < ordered.length;) {
    let end = index;
    let groupPositives = 0;
    while (end < ordered.length && ordered[end].p === ordered[index].p) {
      groupPositives += ordered[end].actual;
      end++;
    }
    const groupNegatives = end - index - groupPositives;
    concordance += groupPositives * (negativesBefore + groupNegatives / 2);
    negativesBefore += groupNegatives;
    index = end;
  }
  const n = rows.length;
  const negatives = n - positives;
  return {
    n,
    accuracy: n ? correct / n : null,
    brier: n ? brier / n : null,
    logLoss: n ? logLoss / n : null,
    logLossEpsilon: LOG_LOSS_EPSILON,
    auc: positives && negatives ? concordance / (positives * negatives) : null,
    calibration: buckets.map((bucket, index) => ({
      lower: index / bins,
      upper: (index + 1) / bins,
      n: bucket.n,
      meanP: bucket.n ? bucket.sumP / bucket.n : null,
      winRate: bucket.n ? bucket.wins / bucket.n : null,
      wilson95: bucket.n ? wilsonInterval(bucket.wins, bucket.n) : null,
    })),
  };
}

/**
 * Unix-second bounds from reported source evidence ONLY. Deliberately do not
 * fall back to nominal chronology.startAt/endAt, set times or Liquipedia dates.
 * Invalid/missing source values remain unknown; the original event is untouched.
 */
export function eventTimeBounds(event) {
  const chronology = event?.chronology;
  const starts = validTimes(chronology, ['reportedEventStartAt', 'reportedTournamentStartAt']);
  const ends = validTimes(chronology, ['reportedEventEndAt', 'reportedTournamentEndAt']);
  const cutoff = starts.length ? Math.min(...starts.map(([, value]) => value)) : null;
  const trainingEnd = ends.length ? Math.max(...ends.map(([, value]) => value)) : null;
  return {
    cutoff,
    trainingEnd,
    cutoffSources: starts.filter(([, value]) => value === cutoff).map(([key]) => key),
    trainingEndSources: ends.filter(([, value]) => value === trainingEnd).map(([key]) => key),
  };
}

/**
 * Whole-event rolling-origin evaluation. Only explicitly eligible events/sets
 * are usable. An event needs reported start evidence and at least one eligible
 * set to count toward minTrainingEvents. A missing end prevents training, but
 * does not prevent holding that event out as a target.
 * If any eligible set has a valid completedAt at/after the target cutoff, the
 * entire training event is excluded, even if its reported end was earlier.
 * Missing set times still use the explicit reported event-end boundary. This
 * catches visible late reporting, but cannot prove historical corrections or
 * the current source snapshot were available at the cutoff.
 *
 * Event order is conservative start then ID. Within each event, set ID order is
 * deterministic serialization ONLY: consumers must use a batch update or a
 * separately validated dependency order, never interpret it as play chronology.
 * All source rows/chronology are returned intact and are not mutated.
 */
export function chronologicalFolds(dataset, { minTrainingEvents = 1 } = {}) {
  if (!dataset || !Array.isArray(dataset.events) || !Array.isArray(dataset.sets)) {
    throw new TypeError('Expected a canonical dataset with events and sets arrays');
  }
  if (!Number.isSafeInteger(minTrainingEvents) || minTrainingEvents < 0) {
    throw new RangeError('minTrainingEvents must be a nonnegative integer');
  }
  assertUniqueIds(dataset.events, 'event');
  assertUniqueIds(dataset.sets, 'set');
  const eventsById = new Map(dataset.events.map((event) => [event.id, event]));
  const setsByEvent = new Map(dataset.events.map((event) => [event.id, []]));
  const setRowsByEvent = new Map(dataset.events.map((event) => [event.id, 0]));
  const excludedSetsByEvent = new Map(dataset.events.map((event) => [event.id, []]));
  const latestEligibleCompletion = new Map();
  const exclusions = { events: [], sets: [], targets: [] };
  for (const set of [...dataset.sets].sort(byId)) {
    const event = eventsById.get(set.eventId);
    const reasons = [];
    if (set.eligible !== true) reasons.push('ineligible_set');
    if (!event) reasons.push('missing_event');
    else {
      setRowsByEvent.set(event.id, setRowsByEvent.get(event.id) + 1);
      if (event.eligible !== true) reasons.push('ineligible_event');
    }
    if (reasons.length) {
      const excluded = { setId: set.id, eventId: set.eventId ?? null, reasons, sourceReasons: sourceReasons(set) };
      exclusions.sets.push(excluded);
      if (event) excludedSetsByEvent.get(event.id).push(excluded);
    } else {
      setsByEvent.get(event.id).push(set);
      const completedAt = set.timestamps?.completedAt;
      if (typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0
        && completedAt > (latestEligibleCompletion.get(event.id)?.completedAt ?? -Infinity)) {
        latestEligibleCompletion.set(event.id, { completedAt, setId: set.id });
      }
    }
  }
  const prepared = dataset.events.map((event) => ({ event, ...eventTimeBounds(event), reasons: [] }));
  prepared.sort((a, b) => compare(a.cutoff ?? Infinity, b.cutoff ?? Infinity) || byId(a.event, b.event));
  for (const item of prepared) {
    if (item.event.eligible !== true) item.reasons.push('ineligible_event');
    if (item.cutoff == null) item.reasons.push('missing_reported_start');
    if (item.cutoff != null && item.trainingEnd != null && item.trainingEnd < item.cutoff) item.reasons.push('invalid_reported_interval');
    if (!setsByEvent.get(item.event.id).length) item.reasons.push('no_eligible_sets');
    if (item.reasons.length) {
      const excluded = { eventId: item.event.id, reasons: item.reasons, sourceReasons: sourceReasons(item.event) };
      exclusions.events.push(excluded);
      exclusions.targets.push(excluded);
    }
  }

  const folds = [];
  for (const target of prepared) {
    if (target.reasons.length) continue;
    const trainingEvents = [];
    const trainingExclusions = [];
    for (const candidate of prepared) {
      const reasons = [...candidate.reasons];
      if (candidate.event.id === target.event.id) reasons.push('target_event');
      if (candidate.trainingEnd == null) reasons.push('missing_reported_end');
      else if (candidate.trainingEnd >= target.cutoff) reasons.push('end_at_or_after_cutoff');
      const latestCompletion = latestEligibleCompletion.get(candidate.event.id);
      const lateCompletion = !reasons.length && latestCompletion?.completedAt >= target.cutoff;
      if (lateCompletion) reasons.push('eligible_set_completed_at_or_after_cutoff');
      if (reasons.length) {
        trainingExclusions.push({
          eventId: candidate.event.id, trainingEnd: candidate.trainingEnd, reasons,
          ...(lateCompletion ? {
            latestEligibleCompletedAt: latestCompletion.completedAt,
            latestEligibleCompletedSetId: latestCompletion.setId,
          } : {}),
        });
      } else trainingEvents.push(candidate.event);
    }
    const targetSets = setsByEvent.get(target.event.id);
    if (trainingEvents.length < minTrainingEvents) {
      exclusions.targets.push({
        eventId: target.event.id, reasons: ['insufficient_training_events'],
        trainingEvents: trainingEvents.length, targetSets: targetSets.length,
      });
      continue;
    }
    const trainingSets = trainingEvents.flatMap((event) => setsByEvent.get(event.id));
    folds.push({
      targetEvent: target.event,
      cutoff: target.cutoff,
      cutoffSources: target.cutoffSources,
      trainingEvents,
      trainingSets,
      targetSets,
      coverage: {
        trainingEvents: trainingEvents.length,
        trainingSets: trainingSets.length,
        targetSetRows: setRowsByEvent.get(target.event.id),
        targetSets: targetSets.length,
        excludedTargetSets: excludedSetsByEvent.get(target.event.id).length,
        excludedTrainingEvents: trainingExclusions.length,
      },
      exclusions: { trainingEvents: trainingExclusions, targetSets: excludedSetsByEvent.get(target.event.id) },
    });
  }
  // Target exclusions interleave static-quality and warm-up exclusions; give
  // them the same deterministic chronology as the folds themselves.
  const eventOrder = new Map(prepared.map((item, index) => [item.event.id, index]));
  exclusions.targets.sort((a, b) => eventOrder.get(a.eventId) - eventOrder.get(b.eventId));
  const evaluatedSets = folds.reduce((sum, fold) => sum + fold.targetSets.length, 0);
  return {
    folds,
    coverage: {
      sourceEvents: dataset.events.length,
      sourceSets: dataset.sets.length,
      eligibleEvents: dataset.events.filter((event) => event.eligible === true).length,
      eligibleSets: dataset.sets.length - exclusions.sets.length,
      usableEvents: prepared.filter((item) => !item.reasons.length).length,
      evaluatedEvents: folds.length,
      evaluatedSets,
      excludedTargetEvents: exclusions.targets.length,
      excludedTargetSets: dataset.sets.length - evaluatedSets,
    },
    exclusions,
    policy: {
      minTrainingEvents,
      cutoff: 'minimum valid reported event/tournament start',
      trainingBoundary: 'maximum valid reported event/tournament end < target cutoff',
      lateCompletionGuard: 'exclude whole training event if any eligible set has valid completedAt >= target cutoff',
      missingSetTimes: 'use explicit reported event-end boundary; do not infer missing set times',
      sourceAvailability: 'reported timestamps do not prove historical corrections or the current source snapshot were available at cutoff',
      targetHoldout: 'whole event by ID regardless of set timestamps',
      eventOrder: 'conservative start, then event ID',
      setOrder: 'event order, then set ID; not within-event chronology',
    },
  };
}

function wilsonInterval(wins, n) {
  const rate = wins / n;
  const z2 = WILSON_Z ** 2;
  const denominator = 1 + z2 / n;
  const center = (rate + z2 / (2 * n)) / denominator;
  const halfWidth = WILSON_Z * Math.sqrt(rate * (1 - rate) / n + z2 / (4 * n ** 2)) / denominator;
  return [wins === 0 ? 0 : Math.max(0, center - halfWidth), wins === n ? 1 : Math.min(1, center + halfWidth)];
}
function validTimes(chronology, keys) {
  return keys.map((key) => [key, chronology?.[key]])
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0);
}
function sourceReasons(row) { return Array.isArray(row.exclusionReasons) ? [...row.exclusionReasons].sort(compare) : []; }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function byId(a, b) { return compare(a.id, b.id); }
function assertUniqueIds(rows, kind) {
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) throw new TypeError(`Every ${kind} needs a canonical string id`);
    if (ids.has(row.id)) throw new TypeError(`Duplicate ${kind} id: ${row.id}`);
    ids.add(row.id);
  }
}
