import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertHistoricalCorpusAudit,
  auditHistoricalCorpus,
  buildHistoricalCorpusContract,
} from "../lib/forecast/corpus-contract.mjs";
import {
  inspectHistoricalCorpusSources,
  isVettedStartggReceiptQuery,
} from "../lib/forecast/corpus-source-readiness.mjs";
import { buildRegistry } from "../lib/forecast/registry.mjs";
import { readDataset, ROOT } from "../lib/liquipedia-data.mjs";
import { digest, readJson, writeJson } from "../lib/forecast/local.mjs";

const event = (name, year, options = {}) => ({
  id: `major:${year}:${name}`,
  name,
  year,
  tier: options.tier ?? "major",
  format: "singles",
  eligible: options.eligible ?? true,
  online: options.eligible === false,
  liquipediaEndDate: `${year}-06-01`,
  mappingStatus: options.mappingStatus ?? "unmapped",
  startgg: options.startgg ?? null,
});

const registry = (events) => ({ schemaVersion: 1, events });
const specification = (decisions = []) => ({
  schemaVersion: 1,
  id: "synthetic-2018-2025-v1",
  scope: {
    startYear: 2018,
    endYear: 2025,
    offlineOnly: true,
    format: "singles",
    historicalCutoffExclusive: "2026-01-01T00:00:00Z",
  },
  defaultDisposition: "unresolved",
  decisions,
});

test("contract derives a closed historical set and separates post-cutoff events deterministically", () => {
  const events = [
    event("Included", 2018),
    event("Unavailable", 2019),
    event("Excluded", 2020),
    event("Ambiguous", 2021),
    event("Still open", 2025),
    event("Online", 2022, { eligible: false }),
    event("Future target", 2026),
  ];
  const decisions = [
    { majorName: "Included", year: 2018, disposition: "included", reason: "Complete reviewed source." },
    { majorName: "Unavailable", year: 2019, disposition: "source-unavailable", reason: "No complete bracket source located." },
    { majorName: "Excluded", year: 2020, disposition: "intentionally-excluded", reason: "Documented scope exception." },
    { majorName: "Ambiguous", year: 2021, disposition: "source-ambiguous", reason: "Two possible source events require review." },
  ];
  const built = buildHistoricalCorpusContract(registry(events), specification(decisions));
  assert.deepEqual(built.counts, {
    expected: 5,
    included: 1,
    intentionallyExcluded: 1,
    sourceUnavailable: 1,
    sourceAmbiguous: 1,
    unresolved: 1,
  });
  assert.equal(built.events.find((row) => row.name === "Still open").disposition, "unresolved");
  assert.equal(built.events.some((row) => row.name === "Online"), false);
  assert.deepEqual(built.separation.postCutoffEvents.map((row) => row.name), ["Future target"]);
  assert.equal(built.separation.postCutoffEvents[0].role, "target-or-evaluation-only");
  assert.deepEqual(
    built,
    buildHistoricalCorpusContract(registry([...events].reverse()), specification([...decisions].reverse())),
  );
});

test("contract rejects scope drift, duplicate decisions and undocumented dispositions", () => {
  const events = [event("Included", 2025), event("Online", 2025, { eligible: false })];
  const good = { majorName: "Included", year: 2025, disposition: "included", reason: "Reviewed." };
  assert.throws(() => buildHistoricalCorpusContract(registry(events), specification([good, good])), /Duplicate corpus decision/);
  assert.throws(() => buildHistoricalCorpusContract(registry(events), specification([
    { ...good, majorName: "Online" },
  ])), /not an in-scope offline major/);
  assert.throws(() => buildHistoricalCorpusContract(registry(events), specification([
    { ...good, disposition: "maybe" },
  ])), /Unsupported corpus disposition/);
  assert.throws(() => buildHistoricalCorpusContract(registry(events), specification([
    { ...good, reason: "" },
  ])), /needs a reason/);
  assert.throws(() => buildHistoricalCorpusContract(registry(events), {
    ...specification([good]),
    scope: { ...specification().scope, historicalCutoffExclusive: "2025-06-01T00:00:00Z" },
  }), /boundary immediately after the complete end year/);
});

test("dataset audit accepts an incremental subset but complete mode fails closed on unresolved coverage", () => {
  const includedMapping = {
    eventSlug: "tournament/included/event/melee-singles",
    eventId: "101",
    tournamentId: "201",
  };
  const contract = buildHistoricalCorpusContract(registry([
    event("Included", 2025, { mappingStatus: "verified", startgg: includedMapping }),
    event("Unresolved", 2025), event("Future", 2026),
  ]), specification([
    { majorName: "Included", year: 2025, disposition: "included", reason: "Reviewed." },
  ]));
  const normalizedEvent = {
    id: "startgg:event:101",
    slug: includedMapping.eventSlug,
    source: { system: "start.gg", id: "101" },
    tournament: { id: 201 },
    chronology: { startAt: Date.parse("2025-06-01T00:00:00Z") / 1000 },
    eligible: true,
    major: { id: "major:2025:Included", name: "Included", year: 2025 },
  };
  const audit = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [normalizedEvent] }, { datasetSha256: "abc" });
  assert.equal(audit.incrementalReady, true);
  assert.equal(audit.completeCorpusReady, false);
  assert.equal(assertHistoricalCorpusAudit(audit), audit);
  assert.throws(() => assertHistoricalCorpusAudit(audit, { complete: true }), /1 in-scope event/);

  const contaminated = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [
    normalizedEvent,
    { id: "event:2", eligible: true, major: { id: "major:2026:Future", name: "Future", year: 2026 } },
  ] });
  assert.equal(contaminated.incrementalReady, false);
  assert.equal(contaminated.postCutoffDatasetEvents.length, 1);
  assert.throws(() => assertHistoricalCorpusAudit(contaminated), /post-cutoff/);

  const mislabeledTarget = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [{
    ...normalizedEvent,
    chronology: { startAt: Date.parse("2026-01-01T00:00:00Z") / 1000 },
  }] });
  assert.equal(mislabeledTarget.postCutoffDatasetEvents.length, 1);
  assert.equal(mislabeledTarget.incrementalReady, false);
});

test("dataset audit validates normalized identity, source mapping, major metadata, and start chronology", () => {
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const contractEvent = contract.events.find((row) => row.name === "Included Source");
  const mapping = contractEvent.sourceMapping;
  const valid = {
    id: `startgg:event:${mapping.eventId}`,
    slug: mapping.eventSlug,
    source: { system: mapping.provider, id: mapping.eventId },
    tournament: { id: Number(mapping.tournamentId) },
    chronology: { startAt: Date.parse("2025-06-07T12:00:00Z") / 1000 },
    eligible: true,
    major: { id: contractEvent.id, name: contractEvent.name, year: contractEvent.year },
  };
  assert.equal(auditHistoricalCorpus(contract, { schemaVersion: 1, events: [valid] }).incrementalReady, true);

  const mismatched = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [{
    ...valid,
    slug: "tournament/wrong/event/wrong",
    source: { system: "other", id: "999" },
    tournament: { id: 999 },
    chronology: { startAt: Date.parse("2024-12-31T23:59:59Z") / 1000 },
    major: { ...valid.major, name: "Wrong name", year: 2024 },
  }] });
  assert.equal(mismatched.incrementalReady, false);
  assert.deepEqual(mismatched.sourceMappingMismatches[0].issues, [
    "event_slug_mismatch",
    "source_event_id_mismatch",
    "source_provider_mismatch",
    "source_tournament_id_mismatch",
  ]);
  assert.deepEqual(mismatched.majorMetadataMismatches[0].issues, ["major_name_mismatch", "major_year_mismatch"]);
  assert.deepEqual(mismatched.invalidEventStartTimes[0].issues, ["start_year_mismatch"]);
  assert.throws(() => assertHistoricalCorpusAudit(mismatched), /source mapping mismatch.*major metadata mismatch.*invalid event start time/);

  const missingStart = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [{
    ...valid, chronology: { startAt: null },
  }] });
  assert.deepEqual(missingStart.invalidEventStartTimes[0].issues, ["invalid_or_missing_start_at"]);
  assert.equal(missingStart.incrementalReady, false);

  const atCutoff = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [{
    ...valid, chronology: { startAt: Date.parse("2026-01-01T00:00:00Z") / 1000 },
  }] });
  assert.deepEqual(atCutoff.invalidEventStartTimes[0].issues, [
    "start_year_mismatch", "start_at_or_after_historical_cutoff",
  ]);
  assert.equal(atCutoff.postCutoffDatasetEvents.length, 1);
});

test("dataset audit requires unique, non-empty normalized event IDs deterministically", () => {
  const sourceRegistryValue = sourceRegistry();
  const contract = buildHistoricalCorpusContract(sourceRegistryValue, {
    ...specification([
      { majorName: "Included Source", year: 2025, disposition: "included", reason: "Reviewed." },
      { majorName: "Promotion Source", year: 2025, disposition: "included", reason: "Reviewed." },
    ]),
    id: "synthetic-source-identity-v1",
    scope: { ...specification().scope, startYear: 2025 },
  });
  const normalized = contract.events.map((contractEvent) => ({
    id: `startgg:event:${contractEvent.sourceMapping.eventId}`,
    slug: contractEvent.sourceMapping.eventSlug,
    source: { system: "start.gg", id: contractEvent.sourceMapping.eventId },
    tournament: { id: contractEvent.sourceMapping.tournamentId },
    chronology: { startAt: Date.parse("2025-06-07T12:00:00Z") / 1000 },
    eligible: true,
    major: { id: contractEvent.id, name: contractEvent.name, year: contractEvent.year },
  }));
  normalized[1] = { ...normalized[1], id: normalized[0].id };
  const duplicate = auditHistoricalCorpus(contract, { schemaVersion: 1, events: normalized });
  assert.deepEqual(duplicate.duplicateNormalizedEventIds, [{
    eventId: normalized[0].id,
    majorIds: normalized.map((row) => row.major.id).sort(),
    rows: 2,
  }]);
  assert.deepEqual(duplicate.sourceMappingMismatches.map((row) => row.issues), [
    ["normalized_event_id_mismatch"],
  ]);
  assert.equal(duplicate.incrementalReady, false);
  assert.deepEqual(
    duplicate,
    auditHistoricalCorpus(contract, { schemaVersion: 1, events: [...normalized].reverse() }),
  );

  const invalid = auditHistoricalCorpus(contract, { schemaVersion: 1, events: [{ ...normalized[0], id: null }] });
  assert.deepEqual(invalid.invalidNormalizedEventIds, [{ eventId: null, majorId: normalized[0].major.id }]);
  assert.equal(invalid.incrementalReady, false);
  assert.throws(() => assertHistoricalCorpusAudit(invalid), /invalid normalized event id/);
});

test("tracked 2018-2025 contract derives all 85 offline registry majors year by year", async () => {
  const mappings = JSON.parse(await readFile(path.join(ROOT, "scripts/data/forecast-event-mappings.json"), "utf8"));
  const contractSpec = JSON.parse(await readFile(path.join(ROOT, "scripts/data/forecast-corpus-contract.json"), "utf8"));
  const source = readDataset();
  const built = buildHistoricalCorpusContract(buildRegistry(source, mappings), contractSpec);
  assert.equal(built.id, "offline-melee-majors-2018-2025-v1");
  assert.deepEqual(built.counts, {
    expected: 85,
    included: 84,
    intentionallyExcluded: 0,
    sourceUnavailable: 0,
    sourceAmbiguous: 1,
    unresolved: 0,
  });
  assert.equal(built.coverageComplete, true);
  assert.deepEqual(
    built.events
      .filter((row) => row.disposition === "source-ambiguous")
      .map(({ name, year }) => [name, year]),
    [["Get On My Level 2022", 2022]],
  );
  assert.deepEqual(built.years.map(({ year, expected }) => [year, expected]), [
    [2018, 14], [2019, 12], [2020, 2], [2021, 6],
    [2022, 16], [2023, 12], [2024, 13], [2025, 10],
  ]);
  assert.ok(built.events.every((row) => row.year >= 2018 && row.year <= 2025));
  assert.ok(built.separation.postCutoffEvents.every((row) => row.year >= 2026));
});

function sourceRegistry() {
  const majors = ["Included Source", "Promotion Source"].map((name) => ({
    name,
    year: 2025,
    date: "2025-06-08",
    tier: "major",
    winner: "Fixture winner",
  }));
  const mappings = majors.map((major, index) => ({
    majorName: major.name,
    year: major.year,
    eventSlug: `tournament/source-${index + 1}/event/melee-singles`,
    confidence: "verified",
    eventId: String(101 + index),
    tournamentId: String(201 + index),
    evidenceUrl: `https://www.start.gg/tournament/source-${index + 1}/event/melee-singles`,
    notes: "Synthetic source-readiness fixture.",
  }));
  return buildRegistry({ asOf: "2025-06-10", majors }, { schemaVersion: 1, mappings });
}

function sourceContract(registry) {
  return buildHistoricalCorpusContract(registry, {
    schemaVersion: 1,
    id: "synthetic-source-readiness-v1",
    scope: {
      startYear: 2025,
      endYear: 2025,
      offlineOnly: true,
      format: "singles",
      historicalCutoffExclusive: "2026-01-01T00:00:00Z",
    },
    defaultDisposition: "unresolved",
    decisions: [{
      majorName: "Included Source",
      year: 2025,
      disposition: "included",
      reason: "Previously reviewed and normalized.",
    }],
  });
}

function sourceBundle(index) {
  const eventId = 101 + index;
  const tournamentId = 201 + index;
  const slug = `tournament/source-${index + 1}/event/melee-singles`;
  const startAt = Date.parse("2025-06-07T12:00:00Z") / 1000;
  const fetchedAt = "2026-09-01T12:00:00.000Z";
  const entrantIds = [11, 12].map((id) => id + index * 10);
  return {
    schemaVersion: 1,
    event: {
      id: eventId,
      slug,
      state: "COMPLETED",
      startAt,
      numEntrants: 2,
      isOnline: false,
      entrantSizeMin: 1,
      phases: [{ id: 301 + index, name: "Bracket" }],
      videogame: { id: 1 },
      tournament: { id: tournamentId, isOnline: false },
    },
    entrants: entrantIds.map((id) => ({ id, participants: [{ id: id + 20, player: { id: id + 30 } }] })),
    sets: [{ id: 401 + index, state: 3 }],
    seeds: [{ id: 501 + index, phase: { id: 301 + index, name: "Bracket" } }],
    standings: [
      { id: 601 + index, entrant: { id: entrantIds[0] } },
      { id: 701 + index, entrant: { id: entrantIds[1] } },
    ],
    phaseGroups: [{ id: 801 + index, phase: { id: 301 + index, name: "Bracket" } }],
    provenance: {
      source: "start.gg",
      fetchedAt,
      requests: [],
    },
  };
}

function stableFixtureJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableFixtureJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFixtureJson(value[key])}`).join(",")}}`;
}

function fixtureReceiptQuery(operation) {
  const queries = {
    ForecastEvent: `query ForecastEvent($slug: String!) {
      event(slug: $slug) {
        id slug name startAt entrantSizeMin numEntrants isOnline type state teamRosterSize
        tournament { id slug name startAt endAt isOnline }
        videogame { id name }
        phases { id name phaseOrder bracketType state numSeeds }
      }
    }`,
    ForecastEntrants: `query ForecastEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
      event(id: $eventId) { id entrants(query: { page: $page perPage: $perPage }) {
        pageInfo { total totalPages }
        nodes { id name participants { id gamerTag player { id } } }
      } }
    }`,
    ForecastSets: `query ForecastSets($eventId: ID!, $page: Int!, $perPage: Int!) {
      event(id: $eventId) { id sets(page: $page perPage: $perPage sortType: STANDARD filters: { showByes: true hideEmpty: false }) {
        pageInfo { total totalPages }
        nodes {
          id state round fullRoundText winnerId phaseGroup { id displayIdentifier }
          slots(includeByes: true) {
            id entrant { id name }
            standing { id placement stats { score { label value } } }
          }
        }
      } }
    }`,
    ForecastSetsByPhaseGroups: `query ForecastSetsByPhaseGroups($eventId: ID!, $phaseGroupIds: [ID]!, $page: Int!, $perPage: Int!) {
      event(id: $eventId) { id sets(page: $page perPage: $perPage sortType: STANDARD filters: { showByes: true hideEmpty: false phaseGroupIds: $phaseGroupIds }) {
        pageInfo { total totalPages }
        nodes {
          id state round fullRoundText winnerId phaseGroup { id displayIdentifier }
          slots(includeByes: true) {
            id entrant { id name }
            standing { id placement stats { score { label value } } }
          }
        }
      } }
    }`,
    ForecastStandings: `query ForecastStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
      event(id: $eventId) { id standings(query: { page: $page perPage: $perPage }) {
        pageInfo { total totalPages }
        nodes { id placement entrant { id name } }
      } }
    }`,
    ForecastPhaseSeeds: `query ForecastPhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
      phase(id: $phaseId) { id seeds(query: { page: $page perPage: $perPage }) {
        pageInfo { total totalPages }
        nodes { id seedNum entrant { id } }
      } }
    }`,
    ForecastPhaseGroups: `query ForecastPhaseGroups($phaseId: ID!, $page: Int!, $perPage: Int!) {
      phase(id: $phaseId) { id phaseGroups(query: { page: $page perPage: $perPage }) {
        pageInfo { total totalPages }
        nodes { id displayIdentifier }
      } }
    }`,
  };
  const query = queries[operation];
  assert.ok(query, `Missing fixture receipt query for ${operation}`);
  return query;
}

async function saveReceipt(root, operation, variables, data, fetchedAt) {
  const query = fixtureReceiptQuery(operation);
  const request = { query, variables };
  const requestHash = digest(stableFixtureJson(request));
  const response = { data };
  const responseHash = digest(stableFixtureJson(response));
  await writeJson(path.join(root, "cache", `${requestHash}.json`), {
    schemaVersion: 1,
    source: "start.gg",
    endpoint: "https://api.start.gg/gql/alpha",
    requestHash,
    request,
    fetchedAt,
    responseHash,
    response,
  });
  return { source: "start.gg", requestHash, operation, fetchedAt, responseHash };
}

async function savePages(root, operation, parent, parentId, field, rows, fetchedAt, extraVariables = {}) {
  const requests = [];
  const perPage = 25;
  const totalPages = Math.ceil(rows.length / perPage);
  for (let page = 1; page <= Math.max(1, totalPages); page++) {
    const nodes = rows.slice((page - 1) * perPage, page * perPage);
    requests.push(await saveReceipt(root, operation, {
      [`${parent}Id`]: parentId,
      ...extraVariables,
      page,
      perPage,
    }, {
      [parent]: {
        id: parentId,
        [field]: { pageInfo: { total: rows.length, totalPages }, nodes },
      },
    }, fetchedAt));
  }
  return requests;
}

async function saveSource(root, bundle) {
  const fetchedAt = bundle.provenance.fetchedAt;
  const requests = [await saveReceipt(root, "ForecastEvent", { slug: bundle.event.slug }, {
    event: bundle.event,
  }, fetchedAt)];
  requests.push(...await savePages(root, "ForecastEntrants", "event", bundle.event.id,
    "entrants", bundle.entrants, fetchedAt));
  requests.push(...await savePages(root, "ForecastSets", "event", bundle.event.id,
    "sets", bundle.sets, fetchedAt));
  requests.push(...await savePages(root, "ForecastStandings", "event", bundle.event.id,
    "standings", bundle.standings, fetchedAt));
  for (const phase of bundle.event.phases) {
    requests.push(...await savePages(root, "ForecastPhaseSeeds", "phase", phase.id,
      "seeds", bundle.seeds.filter((row) => row.phase.id === phase.id).map(({ phase: _phase, ...row }) => row), fetchedAt));
    requests.push(...await savePages(root, "ForecastPhaseGroups", "phase", phase.id,
      "phaseGroups", bundle.phaseGroups.filter((row) => row.phase.id === phase.id).map(({ phase: _phase, ...row }) => row), fetchedAt));
  }
  bundle.provenance.requests = requests;
  const sha256 = digest(JSON.stringify(bundle) + "\n");
  const file = `raw/${sha256}.json`;
  await writeJson(path.join(root, file), bundle);
  return { slug: bundle.event.slug, eventId: String(bundle.event.id), file, sha256 };
}

async function saveRawOnly(root, bundle) {
  const sha256 = digest(JSON.stringify(bundle) + "\n");
  const file = `raw/${sha256}.json`;
  await writeJson(path.join(root, file), bundle);
  return { slug: bundle.event.slug, eventId: String(bundle.event.id), file, sha256 };
}

async function saveShardedSource(root, strategy) {
  const bundle = sourceBundle(0);
  const groups = [801, 802].map((id) => ({ id, phase: { ...bundle.event.phases[0] } }));
  bundle.phaseGroups = groups;
  bundle.sets = Array.from({ length: 30 }, (_, index) => ({
    id: 5000 + index,
    state: 3,
    phaseGroup: { id: groups[index % groups.length].id },
  }));
  await saveSource(root, bundle);
  const retained = [];
  for (const request of bundle.provenance.requests) {
    if (request.operation !== "ForecastSets") {
      retained.push(request);
      continue;
    }
    const cacheFile = path.join(root, "cache", `${request.requestHash}.json`);
    const envelope = JSON.parse(await readFile(cacheFile, "utf8"));
    if (strategy === "phase-group-shards-v1" && envelope.request.variables.page !== 1) continue;
    if (strategy === "phase-group-shards-global-order-v1" && envelope.request.variables.page === 2) {
      envelope.response.data.event.sets.nodes[0].id = bundle.sets[0].id;
      envelope.responseHash = digest(stableFixtureJson(envelope.response));
      request.responseHash = envelope.responseHash;
      await writeJson(cacheFile, envelope);
    }
    retained.push(request);
  }
  const shards = [];
  for (const group of groups) {
    const phaseGroupIds = [String(group.id)];
    const rows = bundle.sets.filter((set) => String(set.phaseGroup.id) === phaseGroupIds[0]);
    retained.push(...await savePages(root, "ForecastSetsByPhaseGroups", "event", bundle.event.id,
      "sets", rows, bundle.provenance.fetchedAt, { phaseGroupIds }));
    shards.push({ phaseGroupIds, total: rows.length });
  }
  bundle.provenance.requests = retained;
  bundle.provenance.setPagination = {
    strategy,
    eventTotal: bundle.sets.length,
    connectionRowLimit: strategy === "phase-group-shards-v1" ? 25 : 10000,
    initialShardGroupLimit: 32,
    ...(strategy === "phase-group-shards-global-order-v1"
      ? { reason: "unstable event-wide STANDARD ordering repeated a source set ID across pages" }
      : {}),
    shards,
  };
  return { bundle, source: await saveRawOnly(root, bundle) };
}

test("source readiness reports verified promotion candidates and mapped download gaps deterministically", async (t) => {
  const root = await workspace(t);
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const first = await saveSource(root, sourceBundle(0));
  const second = await saveSource(root, sourceBundle(1));
  const downloadIndex = { schemaVersion: 1, events: [first, second] };
  const report = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex,
  });
  assert.deepEqual(report.counts, {
    expected: 2,
    verifiedMappings: 2,
    verifiedDownloads: 2,
    includedVerified: 1,
    promotionCandidates: 1,
    mappedAwaitingDownload: 0,
    invalidInScopeDownloads: 0,
    includedSourceFailures: 0,
    eventsWithMissingStandings: 0,
    entrantsWithoutStandings: 0,
    outsideScopeDownloads: 0,
  });
  assert.deepEqual(report.promotionCandidates.map((row) => row.name), ["Promotion Source"]);
  assert.equal(report.allIncludedSourcesReady, true);
  assert.deepEqual(report, await inspectHistoricalCorpusSources({
    root,
    registry: { ...sourceRegistryValue, events: [...sourceRegistryValue.events].reverse() },
    contract,
    downloadIndex: { schemaVersion: 1, events: [second, first] },
  }));

  const missing = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [first] },
  });
  assert.equal(missing.counts.promotionCandidates, 0);
  assert.equal(missing.counts.mappedAwaitingDownload, 1);
  assert.deepEqual(missing.mappedAwaitingDownload.map((row) => row.name), ["Promotion Source"]);
});

test("source readiness refuses corrupt or duplicated download selections", async (t) => {
  const root = await workspace(t);
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const first = await saveSource(root, sourceBundle(0));
  await writeJson(path.join(root, first.file), { ...sourceBundle(0), sets: [] });
  const corrupt = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [first] },
  });
  assert.equal(corrupt.counts.invalidInScopeDownloads, 1);
  assert.equal(corrupt.allIncludedSourcesReady, false);
  assert.ok(corrupt.includedSourceFailures[0].issues.includes("bundle_hash_mismatch"));

  const duplicate = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [first, first] },
  });
  assert.equal(duplicate.counts.invalidInScopeDownloads, 1);
  assert.ok(duplicate.invalidInScopeDownloads[0].issues.includes("multiple_downloads_for_major"));
});

test("source readiness rejects a symlinked raw parent that escapes the resolved research root", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const source = await saveSource(root, sourceBundle(0));
  const escaped = path.join(outside, "escaped-raw");
  await rename(path.join(root, "raw"), escaped);
  await symlink(escaped, path.join(root, "raw"), "dir");
  const report = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [source] },
  });
  assert.equal(report.counts.invalidInScopeDownloads, 1);
  assert.ok(report.includedSourceFailures[0].issues.includes("bundle_parent_symlink"));
  assert.ok(report.includedSourceFailures[0].issues.includes("bundle_parent_outside_root"));
});

test("source readiness authenticates request and response provenance against cache envelopes", async (t) => {
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  for (const mode of [
    "operation", "response-hash", "missing-cache", "filtered-query",
    "envelope-request-hash", "envelope-response",
  ]) {
    const root = await workspace(t);
    const bundle = sourceBundle(0);
    let source = await saveSource(root, bundle);
    const request = bundle.provenance.requests.find((row) => row.operation === "ForecastEntrants");
    if (mode === "operation") {
      request.operation = "ForecastStandings";
      source = await saveRawOnly(root, bundle);
    } else if (mode === "response-hash") {
      request.responseHash = "f".repeat(64);
      source = await saveRawOnly(root, bundle);
    } else {
      const cacheFile = path.join(root, "cache", `${request.requestHash}.json`);
      if (mode === "missing-cache") await rm(cacheFile);
      else {
        const envelope = JSON.parse(await readFile(cacheFile, "utf8"));
        if (mode === "filtered-query") {
          envelope.request.query = envelope.request.query.replace(
            "entrants(query: { page: $page perPage: $perPage })",
            "entrants(query: { page: $page perPage: $perPage filter: { isDisqualified: false } })",
          );
          const filteredHash = digest(stableFixtureJson(envelope.request));
          envelope.requestHash = filteredHash;
          request.requestHash = filteredHash;
          await writeJson(path.join(root, "cache", `${filteredHash}.json`), envelope);
          source = await saveRawOnly(root, bundle);
        } else if (mode === "envelope-request-hash") envelope.requestHash = "e".repeat(64);
        else envelope.response.data.event.entrants.nodes = [];
        if (mode !== "filtered-query") await writeJson(cacheFile, envelope);
      }
    }
    const report = await inspectHistoricalCorpusSources({
      root,
      registry: sourceRegistryValue,
      contract,
      downloadIndex: { schemaVersion: 1, events: [source] },
    });
    assert.equal(report.counts.invalidInScopeDownloads, 1, mode);
    const issues = report.includedSourceFailures[0].issues;
    if (mode === "operation" || mode === "response-hash") {
      assert.ok(issues.includes("request_provenance_receipt_mismatch"), mode);
    } else if (mode === "missing-cache") assert.ok(issues.includes("request_cache_file_missing"), mode);
    else if (mode === "filtered-query") assert.ok(issues.includes("invalid_request_query_contract"), mode);
    else assert.ok(issues.includes("invalid_request_cache_envelope"), mode);
  }
});

test("receipt query contracts allow both phase-group source shapes but reject filtered collections", () => {
  const currentGroups = fixtureReceiptQuery("ForecastPhaseGroups");
  const legacyGroups = currentGroups.replace("id displayIdentifier", "id displayIdentifier startAt");
  const filteredSets = fixtureReceiptQuery("ForecastSets").replace(
    "showByes: true hideEmpty: false",
    "showByes: false hideEmpty: true",
  );
  assert.equal(isVettedStartggReceiptQuery(currentGroups, "ForecastPhaseGroups"), true);
  assert.equal(isVettedStartggReceiptQuery(legacyGroups, "ForecastPhaseGroups"), true);
  assert.equal(isVettedStartggReceiptQuery(filteredSets, "ForecastSets"), false);
});

test("source readiness rejects a collection whose receipt list omits a required page", async (t) => {
  const root = await workspace(t);
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const bundle = sourceBundle(0);
  bundle.entrants = Array.from({ length: 30 }, (_, index) => ({
    id: 1000 + index,
    participants: [{ id: 2000 + index, player: { id: 3000 + index } }],
  }));
  bundle.event.numEntrants = bundle.entrants.length;
  bundle.standings = bundle.entrants.map((entrant, index) => ({
    id: 4000 + index,
    entrant: { id: entrant.id },
  }));
  await saveSource(root, bundle);
  const retainedRequests = [];
  for (const request of bundle.provenance.requests) {
    if (request.operation !== "ForecastEntrants") retainedRequests.push(request);
    else {
      const envelope = JSON.parse(await readFile(path.join(root, "cache", `${request.requestHash}.json`), "utf8"));
      if (envelope.request.variables.page === 1) retainedRequests.push(request);
    }
  }
  bundle.provenance.requests = retainedRequests;
  const source = await saveRawOnly(root, bundle);
  const report = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [source] },
  });
  assert.equal(report.counts.invalidInScopeDownloads, 1);
  assert.ok(report.includedSourceFailures[0].issues.includes("invalid_entrants_pagination_receipts"));
});

test("source readiness rejects unreceipted phase rows and altered appended phase metadata", async (t) => {
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const cases = [
    ["seeds-unknown", "seeds", (bundle) => {
      bundle.seeds.push({ id: 999999, phase: { id: 888888, name: "Unreceipted" } });
    }],
    ["groups-unknown", "phaseGroups", (bundle) => {
      bundle.phaseGroups.push({ id: 999999, phase: { id: 888888, name: "Unreceipted" } });
    }],
    ["seed-phase-metadata", "seeds", (bundle) => { bundle.seeds[0].phase.name = "Altered"; }],
    ["group-phase-metadata", "phaseGroups", (bundle) => { bundle.phaseGroups[0].phase.name = "Altered"; }],
  ];
  for (const [label, field, mutate] of cases) {
    const root = await workspace(t);
    const bundle = sourceBundle(0);
    await saveSource(root, bundle);
    mutate(bundle);
    const source = await saveRawOnly(root, bundle);
    const report = await inspectHistoricalCorpusSources({
      root,
      registry: sourceRegistryValue,
      contract,
      downloadIndex: { schemaVersion: 1, events: [source] },
    });
    assert.equal(report.counts.invalidInScopeDownloads, 1, label);
    assert.ok(report.includedSourceFailures[0].issues.includes(`invalid_${field}_pagination_receipts`), label);
  }
});

test("source readiness rejects a provenance receipt beyond the advertised terminal page", async (t) => {
  const root = await workspace(t);
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const bundle = sourceBundle(0);
  await saveSource(root, bundle);
  bundle.provenance.requests.push(await saveReceipt(root, "ForecastEntrants", {
    eventId: bundle.event.id,
    page: 2,
    perPage: 25,
  }, {
    event: {
      id: bundle.event.id,
      entrants: { pageInfo: { total: 2, totalPages: 1 }, nodes: [] },
    },
  }, bundle.provenance.fetchedAt));
  const source = await saveRawOnly(root, bundle);
  const report = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [source] },
  });
  assert.equal(report.counts.invalidInScopeDownloads, 1);
  assert.ok(report.includedSourceFailures[0].issues.includes("invalid_pagination_receipt"));
});

test("source readiness reconstructs complete set unions for limit and legacy-order shard fallbacks", async (t) => {
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  for (const strategy of ["phase-group-shards-v1", "phase-group-shards-global-order-v1"]) {
    const root = await workspace(t);
    const { source } = await saveShardedSource(root, strategy);
    const report = await inspectHistoricalCorpusSources({
      root,
      registry: sourceRegistryValue,
      contract,
      downloadIndex: { schemaVersion: 1, events: [source] },
    });
    assert.equal(report.counts.verifiedDownloads, 1, JSON.stringify(report.invalidInScopeDownloads));
    assert.equal(report.counts.invalidInScopeDownloads, 0, strategy);
  }
});

test("source readiness requires an oversized event-wide set fallback to stop after its first page", async (t) => {
  const root = await workspace(t);
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const { bundle } = await saveShardedSource(root, "phase-group-shards-v1");
  const extraPages = await savePages(root, "ForecastSets", "event", bundle.event.id,
    "sets", bundle.sets, bundle.provenance.fetchedAt);
  bundle.provenance.requests.push(extraPages[1]);
  const source = await saveRawOnly(root, bundle);
  const report = await inspectHistoricalCorpusSources({
    root,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [source] },
  });
  assert.equal(report.counts.invalidInScopeDownloads, 1);
  assert.ok(report.includedSourceFailures[0].issues.includes("invalid_sets_fallback_receipts"));
});

test("missing standings are observed without failing, while malformed standing references fail closed", async (t) => {
  const sourceRegistryValue = sourceRegistry();
  const contract = sourceContract(sourceRegistryValue);
  const partialRoot = await workspace(t);
  const partialBundle = sourceBundle(0);
  partialBundle.standings.pop();
  const partial = await saveSource(partialRoot, partialBundle);
  const accepted = await inspectHistoricalCorpusSources({
    root: partialRoot,
    registry: sourceRegistryValue,
    contract,
    downloadIndex: { schemaVersion: 1, events: [partial] },
  });
  assert.equal(accepted.counts.verifiedDownloads, 1);
  assert.equal(accepted.counts.eventsWithMissingStandings, 1);
  assert.equal(accepted.counts.entrantsWithoutStandings, 1);
  assert.deepEqual(accepted.missingStandingObservations, [{
    id: contract.events.find((event) => event.name === "Included Source").id,
    name: "Included Source",
    year: 2025,
    entrantsWithoutStanding: 1,
  }]);
  assert.deepEqual(accepted.events.find((event) => event.name === "Included Source").observations.standingCoverage, {
    entrants: 2,
    standings: 1,
    knownEntrantsReferenced: 1,
    entrantsWithoutStanding: 1,
    standingRowsWithoutEntrant: 0,
    duplicateEntrantReferences: [],
    foreignEntrantIds: [],
  });

  const cases = [
    ["duplicate_standing_entrant", (bundle) => { bundle.standings[1].entrant.id = bundle.standings[0].entrant.id; }],
    ["foreign_standing_entrant", (bundle) => { bundle.standings[1].entrant.id = 999999; }],
    ["standing_missing_entrant", (bundle) => { bundle.standings[1].entrant = null; }],
    ["standing_count_exceeds_entrants", (bundle) => { bundle.standings.push({ id: 999, entrant: { id: bundle.entrants[0].id } }); }],
  ];
  for (const [expectedIssue, mutate] of cases) {
    const root = await workspace(t);
    const bundle = sourceBundle(0);
    mutate(bundle);
    const source = await saveSource(root, bundle);
    const report = await inspectHistoricalCorpusSources({
      root,
      registry: sourceRegistryValue,
      contract,
      downloadIndex: { schemaVersion: 1, events: [source] },
    });
    assert.equal(report.counts.invalidInScopeDownloads, 1, expectedIssue);
    assert.ok(report.invalidInScopeDownloads[0].issues.includes(expectedIssue), expectedIssue);
  }
});

const run = (args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/forecast.mjs"), ...args], {
  encoding: "utf8",
  env: { ...process.env, STARTGG_TOKEN: "" },
});

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ssbm-corpus-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("CLI reports the closed tracked contract and strict mode requires included sources", async (t) => {
  const root = await workspace(t);
  const result = run(["corpus", "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readJson(path.join(root, "latest-corpus.json"));
  assert.equal(manifest.contractId, "offline-melee-majors-2018-2025-v1");
  assert.equal(manifest.coverageComplete, true);
  assert.equal(manifest.incrementalReady, false);
  assert.equal(manifest.incrementalPipelineReady, false);
  assert.equal(manifest.allIncludedSourcesReady, false);
  const readiness = await readJson(path.join(root, manifest.sourceReadiness));
  assert.equal(readiness.counts.verifiedMappings, 85);
  assert.equal(readiness.counts.verifiedDownloads, 0);
  assert.equal(readiness.counts.mappedAwaitingDownload, 0);
  assert.equal(readiness.counts.includedSourceFailures, 84);
  const contract = await readJson(path.join(root, manifest.contract));
  const ambiguous = contract.events.filter((row) => row.disposition === "source-ambiguous");
  assert.deepEqual(ambiguous.map(({ name, year }) => [name, year]), [["Get On My Level 2022", 2022]]);
  assert.match(result.stdout, /"expected": 85/);
  assert.match(result.stdout, /"included": 84/);
  assert.match(result.stdout, /"sourceAmbiguous": 1/);
  assert.match(result.stdout, /"unresolved": 0/);
  const strict = run(["corpus", "--strict-corpus", "--root", root]);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /84 included event\(s\) missing/);
});

test("CLI corpus normalization preserves incremental mode and strict mode requires complete ready sources", async (t) => {
  const root = await workspace(t);
  const slug = "tournament/riptide-2025-4/event/melee-singles";
  const startAt = Date.parse("2025-09-05T16:00:00Z") / 1000;
  const bundle = {
    schemaVersion: 1,
    event: {
      id: 101,
      name: "Melee Singles",
      slug,
      startAt,
      isOnline: false,
      entrantSizeMin: 1,
      videogame: { id: 1 },
      tournament: { id: 201, startAt, endAt: startAt + 172800, isOnline: false },
    },
    entrants: [11, 12].map((id) => ({
      id,
      name: `Synthetic ${id}`,
      participants: [{ id: id + 10, gamerTag: `Synthetic ${id}`, player: { id: id + 100 } }],
    })),
    sets: [{
      id: 301,
      state: 3,
      winnerId: 11,
      slots: [
        { id: 1011, entrant: { id: 11 }, standing: { stats: { score: { value: 2 } } } },
        { id: 1012, entrant: { id: 12 }, standing: { stats: { score: { value: 1 } } } },
      ],
    }],
    seeds: [],
    standings: [],
    phaseGroups: [],
    provenance: { source: "start.gg", fetchedAt: "2026-09-04T12:00:00Z", requests: [] },
  };
  await writeJson(path.join(root, "mappings.json"), { schemaVersion: 1, mappings: [{
    majorName: "Riptide 2025",
    year: 2025,
    eventSlug: slug,
    confidence: "verified",
    eventId: 101,
    tournamentId: 201,
    evidenceUrl: `https://www.start.gg/${slug}`,
    notes: "Synthetic corpus CLI fixture.",
  }] });
  const sha256 = digest(JSON.stringify(bundle) + "\n");
  const file = `raw/${sha256}.json`;
  await writeJson(path.join(root, file), bundle);
  await writeJson(path.join(root, "downloads.json"), {
    schemaVersion: 1,
    events: [{ slug, eventId: "101", file, sha256 }],
  });
  const contractFile = path.join(root, "contract.json");
  await writeJson(contractFile, {
    ...specification([{
      majorName: "Riptide 2025",
      year: 2025,
      disposition: "included",
      reason: "Synthetic reviewed source.",
    }]),
    id: "synthetic-2025-v1",
    scope: { ...specification().scope, startYear: 2025 },
  });

  const result = run(["normalize", "--corpus", "--corpus-contract", contractFile, "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readJson(path.join(root, "latest.json"));
  assert.equal(manifest.corpus.contractId, "synthetic-2025-v1");
  assert.equal(manifest.corpus.incrementalReady, true);
  assert.equal(manifest.corpus.incrementalPipelineReady, false);
  assert.equal(manifest.corpus.completeCorpusReady, false);
  assert.equal(manifest.corpus.allIncludedSourcesReady, false);
  assert.equal(manifest.corpus.sourceReadinessCounts.includedSourceFailures, 1);
  assert.match(manifest.corpus.sourceReadinessSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.corpus.historicalCutoffExclusive, "2026-01-01T00:00:00.000Z");
  const report = await readJson(path.join(root, manifest.corpus.report));
  assert.equal(report.audit.counts.presentIncluded, 1);
  assert.equal(report.contract.counts.unresolved, 9);
  assert.equal(report.sourceReadiness.report, manifest.corpus.sourceReadiness);
  assert.equal(report.sourceReadiness.sha256, manifest.corpus.sourceReadinessSha256);
  assert.equal(report.sourceReadiness.allIncludedSourcesReady, false);
  const readinessBody = await readFile(path.join(root, manifest.corpus.sourceReadiness), "utf8");
  assert.equal(digest(readinessBody), manifest.corpus.sourceReadinessSha256);
  assert.equal(JSON.parse(readinessBody).includedSourceFailures.length, 1);

  const strict = run(["normalize", "--strict-corpus", "--corpus-contract", contractFile, "--root", root]);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /9 in-scope event\(s\) remain unresolved/);

  const trackedMappings = JSON.parse(await readFile(path.join(ROOT, "scripts/data/forecast-event-mappings.json"), "utf8"));
  const completeDecisions = buildRegistry(readDataset(), trackedMappings).events
    .filter((entry) => entry.eligible === true && entry.format === "singles" && entry.year === 2025)
    .map((entry) => ({
      majorName: entry.name,
      year: entry.year,
      disposition: entry.name === "Riptide 2025" ? "included" : "intentionally-excluded",
      reason: entry.name === "Riptide 2025"
        ? "Synthetic malformed source under strict review."
        : "Synthetic terminal disposition closes this CLI fixture.",
    }));
  const completeContractFile = path.join(root, "complete-contract.json");
  await writeJson(completeContractFile, {
    ...specification(completeDecisions),
    id: "synthetic-complete-2025-v1",
    scope: { ...specification().scope, startYear: 2025 },
  });

  const nonStrictComplete = run(["normalize", "--corpus", "--corpus-contract", completeContractFile, "--root", root]);
  assert.equal(nonStrictComplete.status, 0, nonStrictComplete.stderr);
  const completeManifest = await readJson(path.join(root, "latest.json"));
  assert.equal(completeManifest.corpus.coverageComplete, true);
  assert.equal(completeManifest.corpus.incrementalReady, true);
  assert.equal(completeManifest.corpus.allIncludedSourcesReady, false);
  assert.equal(completeManifest.corpus.completeCorpusReady, false);

  const strictMalformed = run(["normalize", "--strict-corpus", "--corpus-contract", completeContractFile, "--root", root]);
  assert.equal(strictMalformed.status, 1);
  assert.match(strictMalformed.stderr, /Historical corpus source audit failed: 1 included source\(s\) are missing or invalid/);
});
