#!/usr/bin/env node

// Local-only: not imported by src/, the build, the archive publisher or Supabase.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDataset, ROOT } from "./lib/liquipedia-data.mjs";
import { attachMajor, buildRegistry, normalizeEventSlug } from "./lib/forecast/registry.mjs";
import { DEFAULT_ROOT, digest, loadToken, readJson, researchRoot, writeJson, writeText } from "./lib/forecast/local.mjs";

const HELP = [
  "Local tournament forecast research (no uploads)",
  "",
  "  npm run forecast -- registry",
  '  npm run forecast -- map --major "Riptide 2025" --year 2025 --event tournament/riptide-2025-4/event/melee-singles',
  "  npm run forecast -- download --event tournament/riptide-2025-4/event/melee-singles",
  "  npm run forecast -- download --all-mapped",
  "  npm run forecast -- normalize",
  "  npm run forecast -- evaluate [--strict-seeds]",
  "  npm run forecast -- bracket-report --event tournament/riptide-2026-4/event/melee-singles [--refresh]",
  "  npm run forecast -- storage",
  "  npm run forecast -- status",
  "",
  "Options: --offline (cache only), --refresh (explicitly refetch), --root DIR",
  "Registry overrides: --mappings FILE. Optional map explanation: --notes TEXT.",
  "Token: STARTGG_TOKEN in ignored .env.forecast.local or the environment.",
  "Default output: .forecast/ (ignored, outside the web app). Node 22 recommended.",
  "Map verifies exact source IDs, title, dates, Melee and offline singles metadata.",
  "Standings are outcomes; fetched seeds do not prove pre-event availability.",
].join("\n");

function parseArgs(argv) {
  const command = argv[0] ?? "help";
  if (!["help", "--help", "registry", "map", "download", "normalize", "evaluate", "bracket-report", "storage", "status"].includes(command)) throw new Error("Unknown command; use npm run forecast -- help");
  const options = { command };
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (["--offline", "--refresh", "--all-mapped", "--strict-seeds"].includes(key)) options[key.slice(2)] = true;
    else if (["--root", "--mappings", "--major", "--year", "--event", "--notes"].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(key + " needs a value");
      options[key.slice(2)] = value;
    } else throw new Error("Unknown option; use npm run forecast -- help");
  }
  if (options.offline && options.refresh) throw new Error("--offline and --refresh are mutually exclusive");
  return options;
}

async function registryFor(options, root) {
  const mappings = await readJson(options.mappings ?? path.join(ROOT, "scripts/data/forecast-event-mappings.json"));
  const local = await readJson(path.join(root, "mappings.json"), { schemaVersion: 1, mappings: [] });
  if (mappings.schemaVersion !== 1 || !Array.isArray(mappings.mappings) || local.schemaVersion !== 1 || !Array.isArray(local.mappings)) throw new Error("Unsupported mappings schema");
  // Duplicates WITHIN either file fail. Local verified decisions replace candidates.
  const snapshot = readDataset();
  buildRegistry(snapshot, mappings); buildRegistry(snapshot, local);
  const keys = new Set(local.mappings.map((m) => JSON.stringify([m.majorName, m.year])));
  return buildRegistry(snapshot, {
    schemaVersion: 1,
    mappings: [...mappings.mappings.filter((m) => !keys.has(JSON.stringify([m.majorName, m.year]))), ...local.mappings],
  });
}

async function clientFor(options, root) {
  const { createStartggClient } = await import("./lib/forecast/startgg.mjs");
  return createStartggClient({ token: await loadToken(), cacheDir: path.join(root, "cache"), offline: options.offline ?? false, refresh: options.refresh ?? false });
}

async function downloadOne(options, root, registry, slug, sharedClient = null) {
  const client = sharedClient ?? await clientFor(options, root);
  const { downloadEvent } = await import("./lib/forecast/startgg.mjs");
  console.log("Downloading public event: " + slug);
  const bundle = await downloadEvent(client, slug, {
    onProgress: ({ collection, page, totalPages, rows, total, shardGroupCount }) => {
      if (page === 1 || page === totalPages || page % 10 === 0) {
        console.log("  " + collection + (shardGroupCount ? " [" + shardGroupCount + "-group shard]" : "")
          + ": " + rows + "/" + total + " rows (page " + page + "/" + totalPages + ")");
      }
    },
  });
  // Exploration downloads are allowed, but unverified ones cannot normalize.
  if (registry.events.some((e) => e.startgg?.eventSlug === slug && e.mappingStatus === "verified")) attachMajor(bundle, registry);
  const sha256 = digest(JSON.stringify(bundle) + "\n");
  const file = "raw/" + sha256 + ".json";
  await writeJson(path.join(root, file), bundle);
  const indexPath = path.join(root, "downloads.json");
  const index = await readJson(indexPath, { schemaVersion: 1, events: [] });
  if (index.schemaVersion !== 1 || !Array.isArray(index.events)) throw new Error("Unsupported download index");
  index.events = [...index.events.filter((e) => e.slug !== slug), {
    slug, eventId: String(bundle.event.id), file, sha256,
  }].sort((a, b) => a.slug.localeCompare(b.slug, "en"));
  await writeJson(indexPath, index);
  console.log(JSON.stringify({ event: slug, entrants: bundle.entrants.length, sets: bundle.sets.length, localFile: file }));
  return { bundle, sha256, file };
}

const titleKey = (text) => String(text).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
const cleanFileStem = (text) => String(text).normalize("NFKD").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "upcoming-event";

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (["help", "--help"].includes(options.command)) { console.log(HELP); return; }
  const root = await researchRoot(options.root ?? DEFAULT_ROOT);
  // Reproduce immutable datasets without depending on today's mapping edits.
  const registry = ["evaluate", "storage"].includes(options.command) ? null : await registryFor(options, root);

  if (options.command === "registry") {
    await writeJson(path.join(root, "registry.json"), registry);
    console.log(JSON.stringify({ registry: path.join(root, "registry.json"), ...registry.counts }, null, 2));
    return;
  }

  if (options.command === "map") {
    if (!options.major || !/^\d{4}$/.test(options.year ?? "") || !options.event) throw new Error("map requires --major NAME --year YYYY --event SLUG");
    const entry = registry.events.find((e) => e.name === options.major && e.year === Number(options.year));
    if (!entry?.eligible) throw new Error("Select an exact offline major name and year from the registry");
    const slug = normalizeEventSlug(options.event);
    const { fetchEventMetadata } = await import("./lib/forecast/startgg.mjs");
    const metadata = await fetchEventMetadata(await clientFor(options, root), slug);
    const event = metadata.event ?? metadata;
    if (titleKey(event.tournament?.name) !== titleKey(entry.name)) throw new Error("Tournament title differs from the major. Review source evidence and supply an explicit reviewed --mappings file; automatic mapping refused.");
    const mapping = {
      majorName: entry.name, year: entry.year, eventSlug: slug,
      eventId: String(event.id), tournamentId: String(event.tournament?.id),
      confidence: "verified", evidenceUrl: "https://www.start.gg/" + slug,
      notes: options.notes ?? "Exact tournament title, source IDs, event dates, Melee and offline singles metadata checked by the local mapping command.",
    };
    const singleRegistry = buildRegistry(readDataset(), { schemaVersion: 1, mappings: [mapping] });
    attachMajor({ event }, singleRegistry);
    const localPath = path.join(root, "mappings.json");
    const local = await readJson(localPath, { schemaVersion: 1, mappings: [] });
    const updated = { schemaVersion: 1, mappings: [...local.mappings.filter((m) => m.majorName !== entry.name || m.year !== entry.year), mapping] };
    const otherMappings = registry.events.filter((e) => e.startgg && e.id !== entry.id).map((e) => ({ majorName: e.name, year: e.year, ...e.startgg }));
    const merged = buildRegistry(readDataset(), { schemaVersion: 1, mappings: [...otherMappings, mapping] });
    await writeJson(localPath, updated);
    await writeJson(path.join(root, "registry.json"), merged);
    console.log(JSON.stringify({ mapped: entry.name, source: mapping.evidenceUrl, eventId: mapping.eventId, tournamentId: mapping.tournamentId }, null, 2));
    return;
  }

  if (options.command === "download") {
    if (Boolean(options.event) === Boolean(options["all-mapped"])) throw new Error("download requires exactly one of --event SLUG or --all-mapped");
    const slugs = options.event ? [normalizeEventSlug(options.event)] : registry.events.filter((e) => e.eligible && e.mappingStatus === "verified").map((e) => e.startgg.eventSlug);
    if (!slugs.length) throw new Error("No verified mappings yet. Run registry, then map a major.");
    const client = await clientFor(options, root);
    for (const slug of slugs) {
      await downloadOne(options, root, registry, slug, client);
    }
    return;
  }

  if (options.command === "bracket-report") {
    if (!options.event || options["all-mapped"]) throw new Error("bracket-report requires exactly one --event SLUG");
    const slug = normalizeEventSlug(options.event);
    const { bundle, sha256: sourceSha256 } = await downloadOne(options, root, registry, slug);
    const source = await readJson(path.join(root, "latest.json"), null);
    if (!source || !/^datasets\/[a-f0-9]{64}\/dataset\.json$/.test(source.dataset)) {
      throw new Error("No valid normalized historical dataset; run normalize and evaluate first");
    }
    const datasetBody = await readFile(path.join(root, source.dataset), "utf8");
    if (digest(datasetBody) !== source.sha256) throw new Error("Normalized dataset hash mismatch; refusing changed input");
    const dataset = JSON.parse(datasetBody);
    const cutoff = Date.parse(bundle.provenance?.fetchedAt) / 1000;
    if (!Number.isFinite(cutoff)) throw new Error("Upcoming source snapshot has no valid forecast cutoff");
    const { eventTimeBounds } = await import("./lib/forecast/evaluation.mjs");
    const events = dataset.events.filter((event) => event.eligible === true
      && eventTimeBounds(event).trainingEnd != null && eventTimeBounds(event).trainingEnd < cutoff);
    const eventIds = new Set(events.map((event) => event.id));
    const sets = dataset.sets.filter((set) => set.eligible === true && eventIds.has(set.eventId));
    if (!events.length || !sets.length) throw new Error("No eligible historical training corpus exists before this source snapshot");

    const { initialSeedIndex } = await import("./lib/forecast/baselines.mjs");
    const { fitRegularizedBradleyTerryModel } = await import("./lib/forecast/regularized-bradley-terry.mjs");
    const { buildUpcomingMatchupReport, selectRootFullFieldSeedPhase,
      upcomingMatchupDetailedMarkdown, upcomingMatchupMarkdown }
      = await import("./lib/forecast/upcoming-report.mjs");
    const rootSeedPhase = selectRootFullFieldSeedPhase(bundle);
    const historicalSeeds = initialSeedIndex(dataset, { allowHistorical: true });
    const combinedSeedIndex = {
      seeds: new Map(historicalSeeds.seeds),
      reports: [...historicalSeeds.reports, {
        eventId: `startgg:event:${bundle.event.id}`,
        phaseId: rootSeedPhase.phaseId,
        available: rootSeedPhase.seeds.length,
        historical: 0,
        reason: null,
      }],
      allowHistorical: true,
    };
    for (const seed of rootSeedPhase.seeds) {
      combinedSeedIndex.seeds.set(`startgg:entrant:${seed.entrantId}`, seed.seedNum);
    }
    const fitted = fitRegularizedBradleyTerryModel({ events, sets, cutoff, seedIndex: combinedSeedIndex });
    const historySetCounts = new Map();
    for (const set of sets) {
      for (const playerId of set.playerIds) {
        historySetCounts.set(playerId, (historySetCounts.get(playerId) ?? 0) + 1);
      }
    }
    const evaluation = await readJson(path.join(root, "latest-evaluation.json"), null);
    const evaluationRunHash = evaluation?.sourceDatasetSha256 === source.sha256 ? evaluation.runHash : null;
    const report = buildUpcomingMatchupReport({
      bundle,
      sourceSha256,
      historicalDatasetSha256: source.sha256,
      refreshCommand: "npm run forecast:riptide",
      model: {
        id: fitted.id,
        name: fitted.name,
        trainingEvents: events.length,
        trainingSets: sets.length,
        evaluationRunHash,
        methodology: fitted.methodology,
      },
      predict(input) {
        return {
          ...fitted.predict(input),
          historySetCounts: input.playerIds.map((playerId) => historySetCounts.get(playerId) ?? 0),
        };
      },
    });
    report.implementationSha256 = digest((await Promise.all([
      "baselines", "evaluation", "regularized-bradley-terry", "upcoming-report",
    ].map((name) => readFile(path.join(ROOT, "scripts/lib/forecast", name + ".mjs"), "utf8")))).join("\n"));
    const reportBody = JSON.stringify(report) + "\n";
    const runHash = digest(reportBody);
    const directory = "upcoming/" + runHash;
    const tournamentSlug = cleanFileStem(bundle.event.tournament?.slug?.split("/").at(-1)
      ?? bundle.event.tournament?.name ?? bundle.event.slug);
    const stableMarkdown = tournamentSlug + "-matchups.md";
    const stableDetailedMarkdown = tournamentSlug + "-all-matchups.md";
    const markdown = upcomingMatchupMarkdown(report, { detailFile: "./" + stableDetailedMarkdown });
    const detailedMarkdown = upcomingMatchupDetailedMarkdown(report);
    await writeText(path.join(root, directory, "matchups.json"), reportBody);
    await writeText(path.join(root, directory, "matchups.md"), markdown);
    await writeText(path.join(root, directory, "matchups-full.md"), detailedMarkdown);
    await writeText(path.join(root, stableMarkdown), markdown);
    await writeText(path.join(root, stableDetailedMarkdown), detailedMarkdown);
    const manifest = {
      schemaVersion: 1,
      runHash,
      sourceSha256,
      sourceFetchedAt: report.event.fetchedAt,
      sourceDatasetSha256: source.sha256,
      event: slug,
      report: directory + "/matchups.json",
      markdown: directory + "/matchups.md",
      detailedMarkdown: directory + "/matchups-full.md",
      stableMarkdown,
      stableDetailedMarkdown,
      model: fitted.id,
      productize: false,
      uploads: false,
    };
    await writeJson(path.join(root, "latest-bracket-report.json"), manifest);
    console.log(JSON.stringify({ ...manifest, counts: report.counts }, null, 2));
    return;
  }

  if (options.command === "normalize") {
    const index = await readJson(path.join(root, "downloads.json"), { schemaVersion: 1, events: [] });
    if (index.schemaVersion !== 1 || !Array.isArray(index.events) || !index.events.length) throw new Error("No downloaded events; download a verified major first");
    const bundles = [];
    const excluded = [];
    for (const source of index.events) {
      if (!/^raw\/[a-f0-9]{64}\.json$/.test(source.file)) throw new Error("Invalid bundle path in download index");
      const body = await readFile(path.join(root, source.file), "utf8");
      if (digest(body) !== source.sha256) throw new Error("Downloaded bundle hash mismatch; refusing changed source data");
      const bundle = JSON.parse(body);
      if (normalizeEventSlug(bundle.event?.slug) !== source.slug || String(bundle.event?.id) !== source.eventId) throw new Error("Downloaded bundle identity mismatch");
      const entry = registry.events.find((e) => e.startgg?.eventSlug === source.slug);
      if (!entry?.eligible || entry.mappingStatus !== "verified") { excluded.push({ slug: source.slug, reason: "no_verified_offline_major_mapping" }); continue; }
      bundles.push(attachMajor(bundle, registry));
    }
    if (!bundles.length) throw new Error("No downloaded events have verified offline major mappings");
    const { normalizeEvents } = await import("./lib/forecast/dataset.mjs");
    const dataset = normalizeEvents(bundles);
    const datasetBody = JSON.stringify(dataset) + "\n";
    const sha256 = digest(datasetBody);
    const directory = "datasets/" + sha256;
    const counts = Object.fromEntries(["events", "players", "aliases", "entrants", "seeds", "sets", "standings"].map((key) => [key, dataset[key].length]));
    await writeJson(path.join(root, directory, "dataset.json"), dataset);
    await writeJson(path.join(root, directory, "quality.json"), { ...dataset.quality, excludedDownloads: excluded });
    await writeJson(path.join(root, directory, "registry.json"), registry);
    const manifest = {
      schemaVersion: 1, status: "experimental-data-only", dataset: directory + "/dataset.json", quality: directory + "/quality.json",
      sha256, datasetBytes: Buffer.byteLength(datasetBody), counts,
      sources: index.events.filter((e) => !excluded.some((x) => x.slug === e.slug)), excludedDownloads: excluded, uploads: false,
    };
    // Manifest last: interrupted runs cannot advertise a partial generation.
    await writeJson(path.join(root, "latest.json"), manifest);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (options.command === "evaluate") {
    const source = await readJson(path.join(root, "latest.json"), null);
    if (!source || !/^datasets\/[a-f0-9]{64}\/dataset\.json$/.test(source.dataset)) throw new Error("No valid normalized dataset manifest; run normalize first");
    const body = await readFile(path.join(root, source.dataset), "utf8");
    if (digest(body) !== source.sha256) throw new Error("Normalized dataset hash mismatch; refusing changed input");
    const { compareBasicModels, comparisonMarkdown } = await import("./lib/forecast/comparison.mjs");
    const { calibrationSvg } = await import("./lib/forecast/plots.mjs");
    const result = compareBasicModels(JSON.parse(body), { allowHistoricalSeeds: !options["strict-seeds"] });
    result.report.sourceDatasetSha256 = source.sha256;
    result.report.implementationSha256 = digest((await Promise.all([
      "baselines", "glicko2", "dynamic-bradley-terry", "regularized-bradley-terry",
      "evaluation", "comparison", "plots",
    ].map((name) => readFile(path.join(ROOT, "scripts/lib/forecast", name + ".mjs"), "utf8")))).join("\n"));
    const runHash = digest(JSON.stringify(result));
    const directory = "reports/" + runHash;
    await writeJson(path.join(root, directory, "comparison.json"), result.report);
    await writeJson(path.join(root, directory, "predictions.json"), result.predictions);
    await writeText(path.join(root, directory, "comparison.md"), comparisonMarkdown(result.report));
    await writeText(path.join(root, directory, "calibration.svg"), calibrationSvg(result.report));
    await writeText(path.join(root, directory, "calibration-in-sample.svg"), calibrationSvg(result.report, { inSample: true }));
    const manifest = { schemaVersion: 1, runHash, sourceDatasetSha256: source.sha256,
      report: directory + "/comparison.json", markdown: directory + "/comparison.md", predictions: directory + "/predictions.json",
      calibration: directory + "/calibration.svg", calibrationInSample: directory + "/calibration-in-sample.svg",
      productize: false, uploads: false };
    await writeJson(path.join(root, "latest-evaluation.json"), manifest);
    console.log(JSON.stringify({ ...manifest, folds: result.report.coverage.evaluatedEvents,
      testSets: result.predictions.length,
      models: result.report.outOfSample.models.map(({ name, scores: s }) => ({ name, accuracy: s.accuracy, brier: s.brier, logLoss: s.logLoss, auc: s.auc, coverage: s.coverage })) }, null, 2));
    return;
  }

  if (options.command === "storage") {
    const source = await readJson(path.join(root, "latest.json"), null);
    if (!source || !/^datasets\/[a-f0-9]{64}\/dataset\.json$/.test(source.dataset)) throw new Error("No valid normalized dataset manifest; run normalize first");
    const body = await readFile(path.join(root, source.dataset), "utf8");
    if (digest(body) !== source.sha256) throw new Error("Normalized dataset hash mismatch; refusing changed input");
    const evaluation = await readJson(path.join(root, "latest-evaluation.json"), null);
    let predictions = [];
    if (evaluation) {
      if (evaluation.sourceDatasetSha256 !== source.sha256) throw new Error("Latest evaluation belongs to a different dataset; run evaluate first");
      if (!/^reports\/[a-f0-9]{64}\/predictions\.json$/.test(evaluation.predictions)
          || !/^reports\/[a-f0-9]{64}\/comparison\.json$/.test(evaluation.report)) throw new Error("Invalid evaluation artifact path");
      predictions = await readJson(path.join(root, evaluation.predictions));
      const evaluationReport = await readJson(path.join(root, evaluation.report));
      if (evaluationReport.sourceDatasetSha256 !== source.sha256) throw new Error("Evaluation report belongs to a different dataset");
      if (digest(JSON.stringify({ report: evaluationReport, predictions })) !== evaluation.runHash) throw new Error("Evaluation artifact hash mismatch");
    }
    const { inventoryStorage, projectStorage, storageMarkdown } = await import("./lib/forecast/storage.mjs");
    const report = { schemaVersion: 1, kind: "forecast-storage-v1", uploads: false,
      sourceDatasetSha256: source.sha256, evaluationRunHash: evaluation?.runHash ?? null,
      datasetBytes: Buffer.byteLength(body), predictionRows: predictions.length,
      inventory: await inventoryStorage(root), projection: projectStorage(JSON.parse(body), { predictions }) };
    const reportHash = digest(JSON.stringify(report));
    const directory = "storage-reports/" + reportHash;
    await writeJson(path.join(root, directory, "storage.json"), report);
    await writeText(path.join(root, directory, "storage.md"), storageMarkdown(report));
    const manifest = { schemaVersion: 1, reportHash, sourceDatasetSha256: source.sha256,
      report: directory + "/storage.json", markdown: directory + "/storage.md", uploads: false };
    await writeJson(path.join(root, "latest-storage.json"), manifest);
    console.log(JSON.stringify({ ...manifest, datasetBytes: report.datasetBytes,
      localBytes: report.inventory.bytes, predictionRows: report.predictionRows,
      projectedBytesWithHeadroom: report.projection.scenarios.map((r) => ({ payloadFactor: r.payloadFactor, bytes: r.withHeadroomBytes })) }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    root, registry: registry.counts,
    downloadedEvents: (await readJson(path.join(root, "downloads.json"), { events: [] })).events.length,
    dataset: await readJson(path.join(root, "latest.json"), null),
    evaluation: await readJson(path.join(root, "latest-evaluation.json"), null),
    storage: await readJson(path.join(root, "latest-storage.json"), null),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error("Forecast research: " + error.message); process.exitCode = 1; });
}
