#!/usr/bin/env node
/** Rebuild local canonical model inputs from the reviewed cohort via public
 * Start.gg observations. Never relabel these receipts as GraphQL-validated. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ROOT, readDataset } from "./lib/liquipedia-data.mjs";
import { digest, readJson, researchRoot, writeJson, writeText } from "./lib/forecast/local.mjs";
import { attachMajor, buildRegistry } from "./lib/forecast/registry.mjs";
import { buildHistoricalCorpusContract, auditHistoricalCorpus, assertHistoricalCorpusAudit } from "./lib/forecast/corpus-contract.mjs";
import { auditHistoricalOutcomes } from "./lib/forecast/outcome-reconciliation.mjs";
import { normalizeEvents } from "./lib/forecast/dataset.mjs";
import { PUBLIC_ADAPTER_VERSION, createPublicStartggClient, downloadPublicEvent, inspectPublicEvent } from "./lib/forecast/startgg-public.mjs";

export async function restorePublicForecast(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--census") options.census = true;
    else if (["--root", "--event", "--upcoming"].includes(argv[index])) {
      const name = argv[index].slice(2);
      const value = argv[++index];
      if (!value) throw new Error(`--${name} needs a value`);
      options[name] = value;
    } else throw new Error("Usage: node scripts/restore-public-forecast.mjs [--census | --event ID | --upcoming ID] [--root DIR]");
  }
  if ([options.census, options.event, options.upcoming].filter(Boolean).length > 1) throw new Error("Choose one of --census, --event, or --upcoming");
  const root = await researchRoot(options.root);
  if (options.upcoming) {
    // Each upcoming fetch gets a fresh receipt namespace so the current field
    // is refreshed without overwriting evidence for an earlier forecast.
    const sourceCacheDirectory = `public-source-cache/upcoming-${Date.now()}`;
    const client = createPublicStartggClient({ cacheDir: path.join(root, sourceCacheDirectory) });
    const bundle = await downloadPublicEvent(client, options.upcoming, { requireCompleted: false });
    const body = JSON.stringify(bundle) + "\n";
    const sha256 = digest(body);
    const file = `public-raw/${sha256}.json`;
    await writeText(path.join(root, file), body);
    const manifest = { schemaVersion: 1, eventId: String(bundle.event.id), file, sha256,
      fetchedAt: bundle.provenance.fetchedAt, transport: bundle.provenance.transport, sourceCacheDirectory };
    await writeJson(path.join(root, "latest-upcoming.json"), manifest);
    console.log(JSON.stringify({ ...manifest, audit: bundle.provenance.publicSourceAudit }));
    return manifest;
  }
  const mappings = await readJson(path.join(ROOT, "scripts/data/forecast-event-mappings.json"));
  const registry = buildRegistry(readDataset(), mappings);
  const contract = buildHistoricalCorpusContract(registry, await readJson(path.join(ROOT, "scripts/data/forecast-corpus-contract.json")));
  const included = new Set(contract.events.filter((entry) => entry.disposition === "included").map((entry) => entry.id));
  let entries = registry.events.filter((entry) => included.has(entry.id));
  if (entries.some((entry) => entry.mappingStatus !== "verified")) throw new Error("All restored events need reviewed mappings");
  entries.sort((a, b) => a.year - b.year || String(a.liquipediaEndDate).localeCompare(String(b.liquipediaEndDate)));
  if (options.event) {
    entries = entries.filter((entry) => entry.startgg.eventId === options.event);
    if (entries.length !== 1) throw new Error("--event must identify one included reviewed event");
  }
  const client = createPublicStartggClient({ cacheDir: path.join(root, "public-source-cache") });
  const emit = (value) => console.log(JSON.stringify(value));
  emit({ operation: options.census ? "public-source-census" : "public-source-restore", events: entries.length, root });
  const census = [];
  if (options.census) {
    for (const entry of entries) {
      const { entities } = await inspectPublicEvent(client, entry.startgg.eventId);
      const row = { eventId: entry.startgg.eventId, name: entry.name, phases: entities.phase?.length, groups: entities.groups?.length,
        entrants: entities.entrants?.length, seeds: entities.seeds?.length };
      census.push(row);
      emit({ completed: census.length, ...row });
    }
    const summary = { schemaVersion: 1, transport: "startgg-public-legacy-v1", events: census,
      groupRequests: census.reduce((sum, row) => sum + row.groups, 0),
      minimumRequests: census.reduce((sum, row) => sum + row.groups + 2, 0) };
    await writeJson(path.join(root, "public-source-census.json"), summary);
    emit({ complete: true, events: census.length, groupRequests: summary.groupRequests, minimumRequests: summary.minimumRequests });
    return summary;
  }
  const index = await readJson(path.join(root, "public-downloads.json"), { schemaVersion: 1, events: [] });
  const bundles = [];
  for (const [eventIndex, entry] of entries.entries()) {
    const cached = index.events.find((source) => source.eventId === entry.startgg.eventId);
    let bundle;
    if (cached) {
      if (!/^public-raw\/[a-f0-9]{64}\.json$/.test(cached.file)) throw new Error("Invalid public bundle path");
      const body = await readFile(path.join(root, cached.file), "utf8");
      if (digest(body) !== cached.sha256) throw new Error("Public bundle content checksum mismatch");
      bundle = JSON.parse(body);
      if (String(bundle.event?.id) !== cached.eventId || bundle.event?.slug !== cached.slug
        || cached.slug !== entry.startgg.eventSlug || cached.transport !== "startgg-public-legacy-v1") throw new Error("Public cached bundle index identity mismatch");
      if (bundle.provenance?.transport !== "startgg-public-legacy-v1" || !bundle.provenance.publicSourceAudit?.collectionsReconciled) throw new Error("Public bundle lacks its source reconciliation audit");
      if (bundle.provenance.adapterVersion !== PUBLIC_ADAPTER_VERSION) bundle = null;
    }
    if (!bundle) {
      emit({ event: eventIndex + 1, events: entries.length, name: entry.name, eventId: entry.startgg.eventId, status: "downloading" });
      bundle = await downloadPublicEvent(client, entry.startgg.eventId, { onProgress(progress) {
        if (progress.group % 10 === 0 || progress.group === progress.groups) emit({ event: eventIndex + 1, name: entry.name, ...progress });
      } });
      bundle = attachMajor(bundle, registry);
      const body = JSON.stringify(bundle) + "\n";
      const sha256 = digest(body);
      const source = { eventId: entry.startgg.eventId, slug: entry.startgg.eventSlug, file: `public-raw/${sha256}.json`, sha256,
        transport: "startgg-public-legacy-v1", fetchedAt: bundle.provenance.fetchedAt };
      await writeText(path.join(root, source.file), body);
      index.events = index.events.filter((row) => row.eventId !== source.eventId);
      index.events.push(source);
      await writeJson(path.join(root, "public-downloads.json"), index);
    }
    bundles.push(attachMajor(bundle, registry));
    emit({ event: eventIndex + 1, events: entries.length, name: entry.name, status: "verified-and-cached", ...bundle.provenance.publicSourceAudit });
  }
  // An explicit single-event command warms/audits the cache only. It cannot
  // replace the full-cohort latest pointer with a smaller training set.
  if (options.event) return { complete: true, cachedEvents: bundles.length, fullCorpusPublished: false };
  const dataset = normalizeEvents(bundles);
  const eventsWithEligibleSets = new Set(dataset.sets.filter((set) => set.eligible).map((set) => set.eventId));
  if (dataset.events.some((event) => !eventsWithEligibleSets.has(event.id))) throw new Error("An included public event has no eligible historical sets");
  if (dataset.quality.eventConflicts.length || dataset.quality.entrantConflicts.length || dataset.quality.conflictingSets.length) {
    throw new Error("Public corpus has conflicting event, entrant, or set observations");
  }
  const body = JSON.stringify(dataset) + "\n";
  const sha256 = digest(body);
  const directory = `datasets/${sha256}`;
  const corpusAudit = auditHistoricalCorpus(contract, dataset, { datasetSha256: sha256 });
  assertHistoricalCorpusAudit(corpusAudit, { complete: true });
  const outcomes = auditHistoricalOutcomes(registry, dataset, { datasetSha256: sha256 });
  const outcomeBody = JSON.stringify(outcomes) + "\n";
  const outcomeSha256 = digest(outcomeBody);
  const outcomeFile = `${directory}/outcome-reconciliation-${outcomeSha256}.json`;
  const sourceAudit = { schemaVersion: 1, transport: "startgg-public-legacy-v1", graphqlPaginationValidated: false,
    events: bundles.map((bundle) => bundle.provenance.publicSourceAudit), collectionsReconciled: true };
  await writeText(path.join(root, directory, "dataset.json"), body);
  await writeJson(path.join(root, directory, "quality.json"), dataset.quality);
  await writeJson(path.join(root, directory, "registry.json"), registry);
  await writeJson(path.join(root, directory, "public-source-audit.json"), sourceAudit);
  await writeJson(path.join(root, directory, "corpus-audit.json"), { contract, audit: corpusAudit });
  await writeText(path.join(root, outcomeFile), outcomeBody);
  const counts = Object.fromEntries(["events", "players", "aliases", "entrants", "seeds", "sets", "standings"].map((key) => [key, dataset[key].length]));
  const manifest = { schemaVersion: 1, status: "public-source-reconstructed", dataset: `${directory}/dataset.json`, quality: `${directory}/quality.json`,
    sha256, datasetBytes: Buffer.byteLength(body), counts, sources: index.events.filter((source) => entries.some((entry) => entry.startgg.eventId === source.eventId)),
    publicSourceAudit: `${directory}/public-source-audit.json`, graphqlPaginationValidated: false,
    corpus: { contractId: contract.id, historicalCutoffExclusive: contract.scope.historicalCutoffExclusive,
      report: `${directory}/corpus-audit.json`, coverageComplete: contract.coverageComplete, membershipAuditPassed: true },
    outcomeReconciliation: { report: outcomeFile, sha256: outcomeSha256, advisoryOnly: true,
      allMatched: outcomes.allMatched, allReconciled: outcomes.allReconciled, counts: outcomes.counts, corroborationCounts: outcomes.corroborationCounts }, uploads: false };
  await writeJson(path.join(root, "latest.json"), manifest);
  emit({ complete: true, ...manifest, eligibleSets: dataset.quality.counts.eligibleSets });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restorePublicForecast().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
