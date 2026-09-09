const DISPOSITIONS = new Set([
  "included",
  "intentionally-excluded",
  "source-unavailable",
  "source-ambiguous",
  "unresolved",
]);

const compare = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const byEvent = (a, b) => a.year - b.year
  || compare(a.liquipediaEndDate ?? "", b.liquipediaEndDate ?? "")
  || compare(a.name, b.name)
  || compare(a.id, b.id);
const decisionKey = (name, year) => JSON.stringify([name, year]);
const countKey = (disposition) => disposition.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function validYear(value, label) {
  if (!Number.isInteger(value) || value < 2000 || value > 3000) throw new Error(`${label} must be a four-digit year`);
  return value;
}

function validateUrl(value, label) {
  if (value == null) return null;
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${label} must be an HTTPS URL`);
  return url.href;
}

function validateScope(scope) {
  if (!scope || scope.offlineOnly !== true || scope.format !== "singles") {
    throw new Error("Corpus scope must explicitly select offline singles");
  }
  const startYear = validYear(scope.startYear, "scope.startYear");
  const endYear = validYear(scope.endYear, "scope.endYear");
  if (endYear < startYear) throw new Error("scope.endYear must not precede scope.startYear");
  if (typeof scope.historicalCutoffExclusive !== "string") throw new Error("Corpus scope needs historicalCutoffExclusive");
  const cutoffMilliseconds = Date.parse(scope.historicalCutoffExclusive);
  if (!Number.isFinite(cutoffMilliseconds) || !scope.historicalCutoffExclusive.endsWith("Z")) {
    throw new Error("historicalCutoffExclusive must be an ISO UTC instant");
  }
  // A year-based scope promises the whole final year. A cutoff within that year
  // would silently relabel some expected majors as training data.
  if (cutoffMilliseconds !== Date.UTC(endYear + 1, 0, 1)) {
    throw new Error("historicalCutoffExclusive must be the UTC boundary immediately after the complete end year");
  }
  return {
    startYear,
    endYear,
    offlineOnly: true,
    format: "singles",
    historicalCutoffExclusive: new Date(cutoffMilliseconds).toISOString(),
    postCutoffRole: "target-or-evaluation-only",
  };
}

function emptyCounts(expected = 0) {
  return {
    expected,
    included: 0,
    intentionallyExcluded: 0,
    sourceUnavailable: 0,
    sourceAmbiguous: 0,
    unresolved: 0,
  };
}

function dispositionCounts(events) {
  const counts = emptyCounts(events.length);
  for (const event of events) counts[countKey(event.disposition)]++;
  return counts;
}

function registryRow(event, decision, defaultDisposition) {
  const disposition = decision?.disposition ?? defaultDisposition;
  return {
    id: event.id,
    name: event.name,
    year: event.year,
    tier: event.tier,
    liquipediaEndDate: event.liquipediaEndDate ?? null,
    disposition,
    reason: decision?.reason?.trim()
      ?? "No reviewed source disposition has been recorded for this in-scope major.",
    evidenceUrl: decision?.evidenceUrl ?? null,
    sourceMapping: event.startgg ? {
      provider: "start.gg",
      confidence: event.mappingStatus,
      eventSlug: event.startgg.eventSlug,
      eventId: event.startgg.eventId,
      tournamentId: event.startgg.tournamentId,
    } : null,
  };
}

/**
 * Expand a compact, reviewed policy into a closed-world historical corpus.
 * The expected event set always comes from the bundled major registry; omitted
 * decisions become explicit unresolved rows instead of disappearing.
 */
export function buildHistoricalCorpusContract(registry, specification) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.events)) throw new Error("Expected forecast registry schemaVersion 1");
  if (specification?.schemaVersion !== 1 || typeof specification.id !== "string" || !specification.id.trim()) {
    throw new Error("Expected corpus contract schemaVersion 1 and a stable id");
  }
  const scope = validateScope(specification.scope);
  const defaultDisposition = specification.defaultDisposition ?? "unresolved";
  if (defaultDisposition !== "unresolved") throw new Error("Unreviewed corpus events must default to unresolved");
  if (!Array.isArray(specification.decisions)) throw new Error("Corpus contract decisions must be an array");

  const expected = registry.events
    .filter((event) => event.eligible === true && event.format === "singles"
      && event.year >= scope.startYear && event.year <= scope.endYear)
    .sort(byEvent);
  if (!expected.length) throw new Error("Corpus scope contains no offline majors from the registry");
  const expectedByKey = new Map(expected.map((event) => [decisionKey(event.name, event.year), event]));
  if (expectedByKey.size !== expected.length || new Set(expected.map((event) => event.id)).size !== expected.length) {
    throw new Error("Corpus scope contains duplicate registry identities");
  }
  const decisions = new Map();
  for (const raw of specification.decisions) {
    if (!raw || typeof raw.majorName !== "string" || !raw.majorName.trim() || !Number.isInteger(raw.year)) {
      throw new Error("Each corpus decision needs an exact majorName and year");
    }
    const key = decisionKey(raw.majorName, raw.year);
    const event = expectedByKey.get(key);
    if (!event) throw new Error(`Corpus decision is not an in-scope offline major: ${raw.majorName} ${raw.year}`);
    if (decisions.has(key)) throw new Error(`Duplicate corpus decision: ${raw.majorName} ${raw.year}`);
    if (!DISPOSITIONS.has(raw.disposition)) throw new Error(`Unsupported corpus disposition: ${raw.disposition}`);
    if (typeof raw.reason !== "string" || !raw.reason.trim()) throw new Error(`Corpus decision needs a reason: ${raw.majorName} ${raw.year}`);
    decisions.set(key, {
      disposition: raw.disposition,
      reason: raw.reason.trim(),
      evidenceUrl: validateUrl(raw.evidenceUrl, `Evidence for ${raw.majorName} ${raw.year}`),
    });
  }

  const events = expected.map((event) => registryRow(
    event,
    decisions.get(decisionKey(event.name, event.year)),
    defaultDisposition,
  ));
  const years = [];
  for (let year = scope.startYear; year <= scope.endYear; year++) {
    const rows = events.filter((event) => event.year === year);
    const counts = dispositionCounts(rows);
    years.push({ year, ...counts, coverageComplete: counts.unresolved === 0 });
  }
  const counts = dispositionCounts(events);
  const postCutoffEvents = registry.events
    .filter((event) => event.eligible === true && event.format === "singles" && event.year > scope.endYear)
    .sort(byEvent)
    .map((event) => ({
      id: event.id,
      name: event.name,
      year: event.year,
      tier: event.tier,
      liquipediaEndDate: event.liquipediaEndDate ?? null,
      role: scope.postCutoffRole,
    }));

  return {
    schemaVersion: 1,
    kind: "forecast-historical-corpus-contract-v1",
    id: specification.id.trim(),
    scope,
    counts,
    coverageComplete: counts.unresolved === 0,
    years,
    events,
    separation: {
      historicalEventCount: events.length,
      postCutoffEventCount: postCutoffEvents.length,
      postCutoffEvents,
      rule: `Only dispositions marked included inside ${scope.startYear}-${scope.endYear} may enter this historical corpus; events at or after ${scope.historicalCutoffExclusive} are target or evaluation inputs only.`,
    },
  };
}

/** Compare a normalized dataset with a built contract without mutating either. */
export function auditHistoricalCorpus(contract, dataset = null, { datasetSha256 = null } = {}) {
  if (contract?.kind !== "forecast-historical-corpus-contract-v1" || !Array.isArray(contract.events)) {
    throw new Error("Expected a built historical corpus contract");
  }
  if (dataset != null && (dataset.schemaVersion !== 1 || !Array.isArray(dataset.events))) {
    throw new Error("Expected normalized dataset schemaVersion 1");
  }
  const included = contract.events.filter((event) => event.disposition === "included");
  const contractById = new Map(contract.events.map((event) => [event.id, event]));
  const datasetRows = dataset?.events ?? [];
  const rowsByMajor = new Map();
  const rowsByNormalizedEventId = new Map();
  const invalidNormalizedEventIds = [];
  const unidentifiedDatasetEvents = [];
  const postCutoffDatasetEvents = [];
  const sourceMappingMismatches = [];
  const majorMetadataMismatches = [];
  const invalidEventStartTimes = [];
  const cutoffSeconds = Date.parse(contract.scope.historicalCutoffExclusive) / 1000;
  for (const event of datasetRows) {
    const normalizedEventId = event?.id;
    const majorId = event?.major?.id;
    const majorYear = event?.major?.year;
    if (typeof normalizedEventId !== "string" || !normalizedEventId.trim()) {
      invalidNormalizedEventIds.push({ eventId: normalizedEventId ?? null, majorId: majorId ?? null });
    } else {
      if (!rowsByNormalizedEventId.has(normalizedEventId)) rowsByNormalizedEventId.set(normalizedEventId, []);
      rowsByNormalizedEventId.get(normalizedEventId).push(event);
    }
    if (!majorId) {
      unidentifiedDatasetEvents.push(normalizedEventId ?? null);
      continue;
    }
    const contractEvent = contractById.get(majorId);
    if (!contractEvent) {
      const row = { eventId: normalizedEventId ?? null, majorId, name: event?.major?.name ?? null, year: majorYear ?? null };
      if (Number.isInteger(majorYear) && majorYear > contract.scope.endYear) postCutoffDatasetEvents.push(row);
      else unidentifiedDatasetEvents.push(row);
      continue;
    }

    const metadataIssues = [];
    if (event?.major?.name !== contractEvent.name) metadataIssues.push("major_name_mismatch");
    if (majorYear !== contractEvent.year) metadataIssues.push("major_year_mismatch");
    if (metadataIssues.length) {
      majorMetadataMismatches.push({
        eventId: normalizedEventId ?? null,
        majorId,
        issues: metadataIssues,
        expected: { name: contractEvent.name, year: contractEvent.year },
        observed: { name: event?.major?.name ?? null, year: majorYear ?? null },
      });
    }

    const mapping = contractEvent.sourceMapping;
    const mappingIssues = [];
    const expectedNormalizedEventId = mapping?.provider === "start.gg" && mapping.eventId != null
      ? `startgg:event:${mapping.eventId}`
      : null;
    if (!mapping) {
      mappingIssues.push("missing_contract_source_mapping");
    } else {
      if (event?.source?.system !== mapping.provider) mappingIssues.push("source_provider_mismatch");
      if (mapping.eventSlug != null && event?.slug !== mapping.eventSlug) mappingIssues.push("event_slug_mismatch");
      if (mapping.eventId != null && String(event?.source?.id ?? "") !== String(mapping.eventId)) {
        mappingIssues.push("source_event_id_mismatch");
      }
      if (expectedNormalizedEventId != null && normalizedEventId !== expectedNormalizedEventId) {
        mappingIssues.push("normalized_event_id_mismatch");
      }
      if (mapping.tournamentId != null && String(event?.tournament?.id ?? "") !== String(mapping.tournamentId)) {
        mappingIssues.push("source_tournament_id_mismatch");
      }
    }
    if (mappingIssues.length) {
      sourceMappingMismatches.push({
        eventId: normalizedEventId ?? null,
        majorId,
        issues: mappingIssues.sort(compare),
        expected: mapping ? {
          provider: mapping.provider ?? null,
          eventSlug: mapping.eventSlug ?? null,
          eventId: mapping.eventId ?? null,
          normalizedEventId: expectedNormalizedEventId,
          tournamentId: mapping.tournamentId ?? null,
        } : null,
        observed: {
          provider: event?.source?.system ?? null,
          eventSlug: event?.slug ?? null,
          eventId: event?.source?.id ?? null,
          normalizedEventId: normalizedEventId ?? null,
          tournamentId: event?.tournament?.id ?? null,
        },
      });
    }

    const startAt = event?.chronology?.startAt;
    const startAtValid = typeof startAt === "number" && Number.isFinite(startAt) && startAt > 0;
    const derivedStartYear = startAtValid ? new Date(startAt * 1000).getUTCFullYear() : null;
    const observedStartYear = Number.isInteger(derivedStartYear) ? derivedStartYear : null;
    const startIssues = [];
    if (!startAtValid || !Number.isInteger(observedStartYear)) startIssues.push("invalid_or_missing_start_at");
    else {
      if (observedStartYear !== contractEvent.year) startIssues.push("start_year_mismatch");
      if (startAt >= cutoffSeconds) startIssues.push("start_at_or_after_historical_cutoff");
    }
    if (startIssues.length) {
      invalidEventStartTimes.push({
        eventId: normalizedEventId ?? null,
        majorId,
        issues: startIssues,
        expectedYear: contractEvent.year,
        historicalCutoffExclusive: contract.scope.historicalCutoffExclusive,
        observedStartAt: startAtValid ? startAt : null,
        observedStartYear,
      });
    }

    const reportedTimes = [event?.chronology?.startAt, event?.chronology?.endAt]
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    if (reportedTimes.some((value) => value >= cutoffSeconds)) {
      postCutoffDatasetEvents.push({
        eventId: normalizedEventId ?? null,
        majorId,
        name: event?.major?.name ?? null,
        year: majorYear ?? null,
      });
    }
    if (!rowsByMajor.has(majorId)) rowsByMajor.set(majorId, []);
    rowsByMajor.get(majorId).push(event);
  }

  const missingIncluded = included.filter((event) => !rowsByMajor.has(event.id)).map((event) => event.id);
  const unexpectedDispositions = contract.events
    .filter((event) => event.disposition !== "included" && rowsByMajor.has(event.id))
    .map((event) => ({ majorId: event.id, disposition: event.disposition }));
  const duplicateMajorRows = [...rowsByMajor.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([majorId, rows]) => ({ majorId, eventIds: rows.map((event) => event?.id ?? null).sort(compare) }))
    .sort((a, b) => compare(a.majorId, b.majorId));
  const duplicateNormalizedEventIds = [...rowsByNormalizedEventId.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([eventId, rows]) => ({
      eventId,
      majorIds: rows.map((event) => event?.major?.id ?? null).sort(compare),
      rows: rows.length,
    }))
    .sort((a, b) => compare(a.eventId, b.eventId));
  const ineligibleIncluded = included
    .filter((event) => (rowsByMajor.get(event.id) ?? []).some((row) => row?.eligible !== true))
    .map((event) => event.id);
  const sorted = (values) => values.sort((a, b) => compare(typeof a === "string" ? a : JSON.stringify(a), typeof b === "string" ? b : JSON.stringify(b)));
  sorted(missingIncluded);
  sorted(unexpectedDispositions);
  sorted(unidentifiedDatasetEvents);
  sorted(postCutoffDatasetEvents);
  sorted(invalidNormalizedEventIds);
  sorted(sourceMappingMismatches);
  sorted(majorMetadataMismatches);
  sorted(invalidEventStartTimes);

  const datasetComplete = dataset != null
    && !missingIncluded.length
    && !unexpectedDispositions.length
    && !duplicateMajorRows.length
    && !invalidNormalizedEventIds.length
    && !duplicateNormalizedEventIds.length
    && !ineligibleIncluded.length
    && !unidentifiedDatasetEvents.length
    && !postCutoffDatasetEvents.length
    && !sourceMappingMismatches.length
    && !majorMetadataMismatches.length
    && !invalidEventStartTimes.length;
  return {
    schemaVersion: 1,
    kind: "forecast-historical-corpus-audit-v1",
    contractId: contract.id,
    datasetSha256,
    historicalCutoffExclusive: contract.scope.historicalCutoffExclusive,
    counts: {
      expected: contract.counts.expected,
      included: contract.counts.included,
      presentIncluded: included.length - missingIncluded.length,
      unresolved: contract.counts.unresolved,
      datasetEvents: datasetRows.length,
    },
    missingIncluded,
    unexpectedDispositions,
    duplicateMajorRows,
    invalidNormalizedEventIds,
    duplicateNormalizedEventIds,
    ineligibleIncluded,
    unidentifiedDatasetEvents,
    postCutoffDatasetEvents,
    sourceMappingMismatches,
    majorMetadataMismatches,
    invalidEventStartTimes,
    incrementalReady: datasetComplete,
    completeCorpusReady: datasetComplete && contract.coverageComplete,
    years: contract.years,
  };
}

export function assertHistoricalCorpusAudit(audit, { complete = false } = {}) {
  if (!audit?.incrementalReady) {
    const problems = [
      audit?.missingIncluded?.length ? `${audit.missingIncluded.length} included event(s) missing` : null,
      audit?.unexpectedDispositions?.length ? `${audit.unexpectedDispositions.length} non-included event(s) present` : null,
      audit?.duplicateMajorRows?.length ? `${audit.duplicateMajorRows.length} duplicate major row(s)` : null,
      audit?.invalidNormalizedEventIds?.length ? `${audit.invalidNormalizedEventIds.length} invalid normalized event id(s)` : null,
      audit?.duplicateNormalizedEventIds?.length ? `${audit.duplicateNormalizedEventIds.length} duplicate normalized event id(s)` : null,
      audit?.ineligibleIncluded?.length ? `${audit.ineligibleIncluded.length} included event(s) ineligible` : null,
      audit?.unidentifiedDatasetEvents?.length ? `${audit.unidentifiedDatasetEvents.length} unidentified/out-of-scope event(s)` : null,
      audit?.postCutoffDatasetEvents?.length ? `${audit.postCutoffDatasetEvents.length} post-cutoff event(s)` : null,
      audit?.sourceMappingMismatches?.length ? `${audit.sourceMappingMismatches.length} source mapping mismatch(es)` : null,
      audit?.majorMetadataMismatches?.length ? `${audit.majorMetadataMismatches.length} major metadata mismatch(es)` : null,
      audit?.invalidEventStartTimes?.length ? `${audit.invalidEventStartTimes.length} invalid event start time(s)` : null,
    ].filter(Boolean);
    throw new Error(`Historical corpus audit failed: ${problems.join(", ") || "no normalized dataset"}`);
  }
  if (complete && !audit.completeCorpusReady) {
    throw new Error(`Historical corpus is not complete: ${audit.counts.unresolved} in-scope event(s) remain unresolved`);
  }
  return audit;
}
