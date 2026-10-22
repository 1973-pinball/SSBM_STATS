#!/usr/bin/env node
/**
 * Local-only expected UI values from a completed public archive export.
 * Uses production query, aggregation, rate, sample-note, and formatting code.
 * No Supabase credentials, network queries, raw replays, or publication.
 *
 * node scripts/report-archive-down-b-spot-check.mjs
 * --dir EXPORT --report JSON --profile sample supports completed QA fixtures.
 * --verification JSON optionally requires the independent export QA to match.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Character } from "@slippi/slippi-js";
import { createServer } from "vite";
import { ARCHIVE_CONTENT_TABLES, computeArchiveContentSha256 } from "./lib/archive-content-hash.mjs";

const cache = path.join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache", "SSBM_DASHBOARD_nikki_archive");
const args = {
  dir: path.join(cache, "public-export-v9"),
  report: path.join(cache, "down-b-v9-spot-check.json"),
  profile: "full", verification: null,
};
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index]?.replace(/^--/, "");
  if (!(option in args) || process.argv[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${process.argv[index]}`);
  args[option] = process.argv[index + 1];
}
assert.ok(["full", "sample"].includes(args.profile), "--profile must be full or sample");
const exportDir = path.resolve(args.dir);
const reportPath = path.resolve(args.report);
const relativeReport = path.relative(exportDir, reportPath);
assert.ok(relativeReport.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReport), "report must remain outside the immutable export");
assert.ok(!/\.(?:staging|previous|tmp)[-.]/i.test(path.basename(exportDir)), "refusing an in-progress or backup export");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
// The builder installs the complete directory atomically. Read its completion
// manifest first; no tables are examined when that manifest is missing.
const manifestText = await readFile(path.join(exportDir, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestText);
const qa = await json(path.join(exportDir, "qa.json"));
assert.deepEqual(manifest.loadOrder, ["archive_datasets", ...ARCHIVE_CONTENT_TABLES]);
assert.equal(qa.datasetId, manifest.datasetId);
assert.equal(qa.contentSha256, manifest.contentSha256);
assert.deepEqual(qa.tableCounts, manifest.tableCounts);
assert.deepEqual(qa.sourcePopulation, manifest.sourcePopulation);
assert.equal(qa.moveCoverage.statsVersion, 4);
if (args.profile === "full") {
  assert.equal(manifest.datasetId, "nikki-2026-09-08-v9");
  assert.equal(manifest.sourcePopulation.baseDatasetId, "nikki-2026-09-08-v8");
  assert.equal(new Set(manifest.sourcePopulation.includedBundles).size, 67);
  assert.equal(manifest.sourcePopulation.includedBundles.length, 67);
  assert.ok(!manifest.sourcePopulation.includedBundles.includes("ootb5"));
  assert.deepEqual(manifest.sourcePopulation.excludedBundles, ["ootb5"]);
  assert.equal(manifest.sourcePopulation.expectedReplayFiles, 159965);
  assert.equal(manifest.sourcePopulation.expectedCompressedBytes, 65335000563);
}
const tables = {};
const keep = new Set(["archive_datasets", "archive_rollups", "archive_players", "archive_player_rankings", "archive_bundles"]);
for (const table of manifest.loadOrder) {
  let count = 0;
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(path.join(exportDir, `${table}.ndjson`)), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    count++;
    if (row.dataset_id !== undefined) assert.equal(row.dataset_id, manifest.datasetId);
    if (keep.has(table)) rows.push(row);
  }
  assert.equal(count, manifest.tableCounts[table], `${table}: complete row count`);
  if (keep.has(table)) tables[table] = rows;
}
assert.equal(tables.archive_datasets.length, 1);
const dataset = tables.archive_datasets[0];
assert.equal(dataset.id, manifest.datasetId);
assert.equal(dataset.content_sha256, manifest.contentSha256);
assert.equal(await computeArchiveContentSha256({ dir: exportDir, datasetRow: dataset }), manifest.contentSha256, "complete export fingerprint");
if (args.profile === "full") {
  assert.equal(dataset.archive_count, 67);
  assert.equal(dataset.replay_file_count, 159965);
  assert.equal(dataset.compressed_bytes, 65335000563);
  assert.equal(tables.archive_bundles.length, 67);
}
let verifiedReconciliation = null;
if (args.verification) {
  const verification = await json(args.verification);
  assert.equal(verification.datasetId, dataset.id);
  assert.equal(verification.contentSha256, manifest.contentSha256);
  assert.equal(verification.profile, args.profile);
  verifiedReconciliation = { verifiedAt: verification.verifiedAt, comparedGlobalAggregates: verification.comparedGlobalAggregates };
}

// This adapter implements only read operations used by production selectors.
// Published=true is a local preview of the reviewed export after publication.
class LocalQuery {
  constructor(rows) { this.rows = rows; this.filters = []; this.orders = []; this.from = 0; this.to = Infinity; }
  select() { return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  is(column, value) { assert.equal(value, null); return this.eq(column, value); }
  not(column, operator, value) { assert.equal(operator, "is"); assert.equal(value, null); this.filters.push((row) => row[column] !== null); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  order(column, options = {}) { this.orders.push([column, options.ascending !== false]); return this; }
  range(from, to) { this.from = from; this.to = to; return this; }
  limit(count) { this.to = this.from + count - 1; return this; }
  response() {
    const data = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    data.sort((a, b) => {
      for (const [key, ascending] of this.orders) {
        const order = typeof a[key] === "string" ? a[key].localeCompare(b[key]) : a[key] - b[key];
        if (order) return ascending ? order : -order;
      }
      return 0;
    });
    return { data: data.slice(this.from, this.to + 1), error: null };
  }
  then(resolve_, reject_) { return Promise.resolve(this.response()).then(resolve_, reject_); }
  maybeSingle() { const response = this.response(); return Promise.resolve({ ...response, data: response.data[0] ?? null }); }
}
const adapterKey = "__archiveDownBSpotCheck";
globalThis[adapterKey] = {
  from(table) {
    assert.ok(tables[table], `unexpected query table: ${table}`);
    return new LocalQuery(tables[table].map((row) => ({ ...row, published: true })));
  },
};
const server = await createServer({
  configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "local-archive-spot-check", enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return `export const supabase = globalThis.${adapterKey};`;
    },
    transform(source, id) {
      if (id.endsWith("/src/components/CommunityArchiveAtlas.tsx")) return `${source}\nexport { formatMoveMetric as spotFormatMoveMetric, archiveMoveMetric as spotArchiveMoveMetric };`;
      if (id.endsWith("/src/components/Views.tsx")) return `${source}\nexport { MOVE_METRIC_CHOICES as spotMoveMetricChoices };`;
    },
  }],
});

try {
  const archive = await server.ssrLoadModule("/src/lib/publicArchive.ts");
  const helpers = await server.ssrLoadModule("/src/lib/executionMoveBenchmarks.ts");
  const atlas = await server.ssrLoadModule("/src/components/CommunityArchiveAtlas.tsx");
  const { spotMoveMetricChoices } = await server.ssrLoadModule("/src/components/Views.tsx");
  const { getDownBCapability } = await server.ssrLoadModule("/src/lib/downBSpecial.ts");
  const { num, pct } = await server.ssrLoadModule("/src/lib/format.ts");
  const { charName } = await server.ssrLoadModule("/src/lib/melee.ts");
  const options = await archive.fetchArchiveCommunityProOptions(dataset.id);
  const rows = [];
  const overall = (values) => values.find((row) => row.opponent_character_id === null && row.stage_id === null) ?? null;
  const add = (characterId, cohort, row, playerId = null) => {
    const move = helpers.groupedArchiveMove(row, "down-b");
    const counts = Object.fromEntries(["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"]
      .map((key) => [key, move?.[key] ?? null]));
    const capability = getDownBCapability(characterId);
    const completed = counts.hitAttempts !== null && counts.noHitAttempts !== null ? counts.hitAttempts + counts.noHitAttempts : null;
    const metrics = {};
    for (const [key, atlasKey] of [["attemptsPerGame", "attempts"], ["noHitPerGame", "noHitPerGame"], ["noHitRate", "noHitRate"]]) {
      const value = helpers.archiveMoveBenchmark(row, "down-b", key);
      const definition = spotMoveMetricChoices.find((item) => item.key === key);
      assert.ok(definition, `production metric definition ${key}`);
      const atlasValue = atlas.spotArchiveMoveMetric(move ? { ...move, key: "down-b" } : undefined, atlasKey, row);
      assert.equal(atlasValue, value === null ? null : key === "noHitRate" ? value / 100 : value);
      if (!capability.outcomes && key !== "attemptsPerGame") assert.equal(value, null, "utility moves cannot acquire no-hit rates");
      metrics[key] = {
        value, unit: key === "noHitRate" ? "percent" : "uses/game",
        executionDisplay: value === null ? "—" : `${num(value, definition.digits)}${definition.unit}`,
        atlasDisplay: atlas.spotFormatMoveMetric(atlasValue, atlasKey),
        sampleNote: helpers.archiveMoveSample(row, "down-b", key) ?? "No published sample",
        comparisonGames: helpers.archiveMoveComparisonGames(row, "down-b", key),
      };
    }
    const coverage = {
      attempts: row?.game_count ? (counts.attemptGames ?? 0) / row.game_count : null,
      outcomes: row?.game_count ? (counts.outcomeGames ?? 0) / row.game_count : null,
      completedUses: completed !== null && completed + (counts.incompleteAttempts ?? 0) > 0
        ? completed / (completed + counts.incompleteAttempts) : null,
    };
    rows.push({
      character: charName(characterId), characterId, cohort, playerId, publishedSample: Boolean(row),
      gameSides: row?.game_count ?? null, identifiedPlayers: row?.identified_player_count ?? null,
      sourceRollupKey: row?.rollup_key ?? null, counts, completedUses: completed,
      coverage, coverageDisplay: Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, pct(value)])),
      outcomeTrackingSupported: capability.outcomes, outcomeLimit: capability.reason, metrics,
    });
  };
  for (const characterId of [Character.FOX, Character.FALCO, Character.PEACH, Character.MARTH, Character.BOWSER]) {
    const [field, proRows, atlasRows] = await Promise.all([
      archive.fetchArchiveCommunityBenchmarks(dataset.id, characterId, "singles", null),
      archive.fetchArchiveProAggregateAtlasRows(dataset.id, characterId, "singles", null),
      archive.fetchArchiveCommunityAtlasRows(dataset.id, characterId, "singles"),
    ]);
    for (const population of ["broad", "conservative"]) {
      assert.deepEqual(field[population], overall(atlasRows.filter((row) => row.population === population)), "Execution and Atlas select the same overall cohort");
    }
    add(characterId, "Venue", field.broad);
    add(characterId, "Tournament", field.conservative);
    add(characterId, "Aggregate Pro", overall(proRows));
  }
  for (const [playerId, characterId, label] of [["moky", Character.FOX, "Moky"], ["magi", Character.FALCO, "Magi"], ["llod", Character.PEACH, "lloD"]]) {
    const option = options.find((player) => player.id === playerId);
    if (args.profile === "full") assert.ok(option?.observed_character_ids.includes(characterId), `${label} is selectable with the expected character`);
    const named = overall(await archive.fetchArchivePlayerAtlasRows(dataset.id, playerId, characterId, "singles"));
    if (args.profile === "full") assert.ok(named, `${label}'s overall named-player sample exists`);
    add(characterId, option?.display_name ?? label, named, playerId);
  }
  assert.equal(await readFile(path.join(exportDir, "manifest.json"), "utf8"), manifestText, "export must not change during the report");
  const report = {
    generatedAt: new Date().toISOString(), profile: args.profile, datasetId: dataset.id, contentSha256: manifest.contentSha256,
    sourcePopulation: manifest.sourcePopulation, verifiedReconciliation,
    scope: "Singles; selected character; all opponents, stages, events, and dates; Down B only.",
    rows,
    notes: [
      "This local preview reads the completed export and performs no database writes or live-site requests.",
      "Game counts and coverage denominators count player sides. Aggregate Pro weights measured player-games, not players equally.",
      "Attempts/game uses attemptGames. No-hit uses/game uses outcomeGames. No-hit rate is the percentage of completed uses with no opponent damage, including shields; incomplete uses are excluded.",
      "Peach and Marth have attempts only. Their no-hit displays must remain dashes with Outcome tracking unavailable, or No published sample when the cohort is absent.",
      "Execution shows one decimal for these metrics; Atlas uses two decimals for per-game values and one decimal for percentages.",
      "Refresh the site after publishing, select each character and all opponents, and set the Atlas local minimum attempts/game to 0 if the Down B row is hidden.",
      "This is an aggregate/UI spot check. Use verify-archive-down-b-export.mjs for independent reconciliation against per-game derived records.",
    ],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.table(rows.map((row) => ({
    Character: row.character, Cohort: row.cohort, Sides: row.gameSides, Tracked: row.counts.attemptGames,
    Outcomes: row.counts.outcomeGames, Attempts: row.counts.attempts, Hit: row.counts.hitAttempts,
    NoHit: row.counts.noHitAttempts, Incomplete: row.counts.incompleteAttempts,
    "Atlas attempts/g": row.metrics.attemptsPerGame.atlasDisplay,
    "Atlas no-hit/g": row.metrics.noHitPerGame.atlasDisplay, "No-hit %": row.metrics.noHitRate.atlasDisplay,
  })));
  console.log(JSON.stringify({ datasetId: dataset.id, contentSha256: manifest.contentSha256, rows: rows.length, report: reportPath }, null, 2));
} finally {
  await server.close();
  delete globalThis[adapterKey];
}
