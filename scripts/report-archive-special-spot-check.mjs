#!/usr/bin/env node
/**
 * Local-only expected UI values from a completed public archive export.
 * Uses production query, aggregation, rate, sample-note, and formatting code.
 * No Supabase credentials, network queries, raw replays, or publication.
 *
 * node scripts/report-archive-special-spot-check.mjs
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
  dir: path.join(cache, "public-export-v10"),
  report: path.join(cache, "specials-v10-spot-check.json"),
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
assert.equal(qa.moveCoverage.statsVersion, 6);
if (args.profile === "full") {
  assert.equal(manifest.datasetId, "nikki-2026-09-08-v10");
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
const adapterKey = "__archiveSpecialSpotCheck";
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
  const { getSpecialMoveCapability } = await server.ssrLoadModule("/src/lib/specialMoves.ts");
  const { num, pct } = await server.ssrLoadModule("/src/lib/format.ts");
  const { charName } = await server.ssrLoadModule("/src/lib/melee.ts");
  const options = await archive.fetchArchiveCommunityProOptions(dataset.id);
  const rows = [];
  const overall = (values) => values.find((row) => row.opponent_character_id === null && row.stage_id === null) ?? null;
  const groups = [[18, "neutral-b", "Neutral B"], [19, "side-b", "Side B"], [20, "up-b", "Up B"], [21, "down-b", "Down B"]];
  const countFields = ["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"];
  const globalSingles = tables.archive_rollups.filter((row) => row.format === "singles" && row.character_id !== null
    && row.series_id === null && row.tournament_id === null && row.set_id === null
    && row.opponent_character_id === null && row.stage_id === null);
  const rawProRows = globalSingles.filter((row) => row.scope === "player" && row.population === "conservative" && row.player_id !== null);
  const selectorChecks = { community: 0, proAggregate: 0, namedPlayer: 0, positiveProCohorts: 0, sparseCoverageLimits: [] };
  // Independently reconstruct the inputs to each production selector. Deriving
  // expected rates from its own returned counts would miss dropped players or
  // coverage fields, even when every displayed rate was internally consistent.
  const checkSelection = (actual, sources, label, aggregate = false) => {
    assert.equal(Boolean(actual), sources.length > 0, `${label}: source population presence`);
    if (!actual) return;
    if (!aggregate) {
      assert.equal(sources.length, 1, `${label}: one exact global source row`);
      assert.equal(actual.rollup_key, sources[0].rollup_key, `${label}: selected source identity`);
    }
    for (const field of ["game_count", "win_rate_game_count", "wins"]) {
      assert.equal(actual[field], sources.reduce((sum, row) => sum + row[field], 0), `${label}: independent ${field}`);
    }
    if (aggregate) assert.equal(actual.identified_player_count, new Set(sources.map((row) => row.player_id)).size,
      `${label}: every distinct named player contributes`);
    for (const [moveId, moveKey] of groups) {
      const sourceMoves = sources.map((row) => row.metrics.moves?.[moveId]).filter(Boolean);
      const selected = helpers.groupedArchiveMove(actual, moveKey);
      assert.equal(Boolean(selected), sourceMoves.length > 0, `${label} ${moveKey}: measurement presence`);
      for (const field of countFields) {
        const values = sourceMoves.map((move) => move[field]).filter((value) => value !== undefined);
        assert.equal(selected?.[field], values.length ? values.reduce((sum, value) => sum + value, 0) : undefined,
          `${label} ${moveKey}: independent ${field}`);
      }
    }
  };
  const checkProCoverage = (row, label) => {
    if (args.profile !== "full" || !row) return;
    if (row.game_count >= 25) selectorChecks.positiveProCohorts++;
    for (const [moveId, moveKey] of groups) {
      const move = row.metrics.moves?.[moveId], capability = getSpecialMoveCapability(row.character_id, moveId);
      const missing = [
        ...(capability.attempts && !(move?.attemptGames > 0) ? ["attempts"] : []),
        ...(capability.outcomes && !(move?.outcomeGames > 0) ? ["outcomes"] : []),
      ];
      if (row.game_count >= 25) assert.deepEqual(missing, [], `${label} ${moveKey}: ample Pro samples require positive coverage`);
      else if (missing.length) selectorChecks.sparseCoverageLimits.push({ cohort: label, characterId: row.character_id,
        moveId, gameSides: row.game_count, missing,
        reason: "Sparse samples may contain only transformed, copied, or incomplete source observations; unavailable rates must remain explicit." });
    }
  };
  if (args.profile === "full") {
    assert.equal(rawProRows.length, 36, "the reviewed cohort contains 36 named singles character rows");
    assert.equal(new Set(rawProRows.map((row) => row.player_id)).size, 27, "all 27 named singles players remain selectable");
    assert.equal(new Set(rawProRows.map((row) => row.character_id)).size, 15, "only the 15 observed Pro characters require samples");
  }
  const add = (characterId, cohort, row, playerId = null) => {
    for (const [moveId, moveKey, moveName] of groups) {
      const move = helpers.groupedArchiveMove(row, moveKey);
      const counts = Object.fromEntries(["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"]
        .map((key) => [key, move?.[key] ?? null]));
      const capability = getSpecialMoveCapability(characterId, moveId);
      const completed = counts.hitAttempts !== null && counts.noHitAttempts !== null ? counts.hitAttempts + counts.noHitAttempts : null;
      const metrics = {};
      for (const [key, atlasKey] of [["attemptsPerGame", "attempts"], ["noHitPerGame", "noHitPerGame"], ["noHitRate", "noHitRate"]]) {
        const value = helpers.archiveMoveBenchmark(row, moveKey, key);
        const definition = spotMoveMetricChoices.find((item) => item.key === key);
        assert.ok(definition, `production metric definition ${key}`);
        const atlasValue = atlas.spotArchiveMoveMetric(move ? { ...move, key: moveKey } : undefined, atlasKey, row);
        if (value === null) assert.equal(atlasValue, null);
        else {
          const scaled = key === "noHitRate" ? value / 100 : value;
          assert.ok(typeof atlasValue === "number" && Math.abs(atlasValue - scaled) <= Number.EPSILON * 8 * Math.max(1, Math.abs(scaled)),
            "Atlas and Execution agree within floating-point rounding when converting percentages");
        }
        const expected = key === "attemptsPerGame"
          ? counts.attemptGames > 0 ? counts.attempts / counts.attemptGames : null
          : counts.outcomeGames > 0 && completed !== null && counts.incompleteAttempts !== null
            ? key === "noHitPerGame" ? counts.noHitAttempts / counts.outcomeGames
              : completed > 0 ? counts.noHitAttempts / completed * 100 : null
            : null;
        assert.equal(value, expected, `${cohort} ${characterId} ${moveKey}: independently calculated ${key}`);
        assert.equal(helpers.archiveMoveComparisonGames(row, moveKey, key),
          (key === "attemptsPerGame" ? counts.attemptGames : counts.outcomeGames) ?? 0,
          "comparison highlighting uses this move's measured coverage");
        if (!capability.attempts) assert.equal(value, null, "unsupported moves have no measured rates");
        if (!capability.outcomes && key !== "attemptsPerGame") assert.equal(value, null, "utility moves cannot acquire no-hit rates");
        metrics[key] = {
          value, unit: key === "noHitRate" ? "percent" : "uses/game",
          executionDisplay: value === null ? "—" : `${num(value, definition.digits)}${definition.unit}`,
          atlasDisplay: atlas.spotFormatMoveMetric(atlasValue, atlasKey),
          sampleNote: helpers.archiveMoveSample(row, moveKey, key) ?? "No published sample",
          comparisonGames: helpers.archiveMoveComparisonGames(row, moveKey, key),
        };
      }
      const coverage = {
        attempts: row?.game_count ? (counts.attemptGames ?? 0) / row.game_count : null,
        outcomes: row?.game_count ? (counts.outcomeGames ?? 0) / row.game_count : null,
        completedUses: completed !== null && completed + (counts.incompleteAttempts ?? 0) > 0
          ? completed / (completed + counts.incompleteAttempts) : null,
      };
      rows.push({
        character: charName(characterId), characterId, moveId, moveKey, moveName, cohort, playerId, publishedSample: Boolean(row),
        gameSides: row?.game_count ?? null, identifiedPlayers: row?.identified_player_count ?? null,
        sourceRollupKey: row?.rollup_key ?? null, counts, completedUses: completed,
        coverage, coverageDisplay: Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, pct(value)])),
        outcomeTrackingSupported: capability.outcomes, outcomeLimit: capability.reason, metrics,
      });
    }
  };
  // Slippi external character IDs 0 through 25 are the 26 playable selections.
  for (const characterId of Array.from({ length: 26 }, (_value, index) => index)) {
    const [field, proRows, atlasRows] = await Promise.all([
      archive.fetchArchiveCommunityBenchmarks(dataset.id, characterId, "singles", null),
      archive.fetchArchiveProAggregateAtlasRows(dataset.id, characterId, "singles", null),
      archive.fetchArchiveCommunityAtlasRows(dataset.id, characterId, "singles"),
    ]);
    for (const population of ["broad", "conservative"]) {
      assert.deepEqual(field[population], overall(atlasRows.filter((row) => row.population === population)), "Execution and Atlas select the same overall cohort");
      checkSelection(field[population], globalSingles.filter((row) => row.scope === "community" && row.population === population
        && row.player_id === null && row.character_id === characterId), `${population} ${characterId}`);
      selectorChecks.community++;
    }
    const pro = overall(proRows);
    checkSelection(pro, rawProRows.filter((row) => row.character_id === characterId), `Aggregate Pro ${characterId}`, true);
    checkProCoverage(pro, `Aggregate Pro ${characterId}`);
    selectorChecks.proAggregate++;
    add(characterId, "Venue", field.broad);
    add(characterId, "Tournament", field.conservative);
    add(characterId, "Aggregate Pro", pro);
  }
  // Exercise every observed player/character selector, including the small
  // secondary-character samples not represented by the three display examples.
  for (const source of rawProRows) {
    const selected = overall(await archive.fetchArchivePlayerAtlasRows(dataset.id, source.player_id, source.character_id, "singles"));
    checkSelection(selected, [source], `${source.player_id} ${source.character_id}`);
    checkProCoverage(selected, `${source.player_id} ${source.character_id}`);
    selectorChecks.namedPlayer++;
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
    sourcePopulation: manifest.sourcePopulation, verifiedReconciliation, selectorChecks,
    scope: "Singles; all 26 characters and all four special directions; all opponents, stages, events, and dates.",
    rows,
    notes: [
      "This local preview reads the completed export and performs no database writes or live-site requests.",
      "Game counts and coverage denominators count player sides. Aggregate Pro weights measured player-games, not players equally.",
      "Every observed named-player selector and each aggregate Pro selector is checked against independently summed raw global player rollups, including exact special counters, coverage, game totals, and distinct-player counts.",
      "Populated Pro cohorts with at least 25 game sides require positive attempt coverage in every direction and positive supported outcome coverage; smaller unavailable samples are reported explicitly.",
      "Attempts/game uses attemptGames. No-hit uses/game uses outcomeGames. No-hit rate is the percentage of completed uses with no opponent damage, including shields; incomplete uses are excluded.",
      "Each character/direction uses its audited outcome capability. Unsupported outcomes must remain dashes, while the reason distinguishes unavailable attribution from an absent published sample.",
      "Execution shows one decimal for these metrics; Atlas uses two decimals for per-game values and one decimal for percentages.",
      "Refresh the site after publishing, select each character and all opponents, and set the Atlas local minimum attempts/game to 0 if a special-move row is hidden.",
      "This is an aggregate/UI spot check. Use verify-archive-special-export.mjs for independent reconciliation against per-game derived records.",
    ],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.table(rows.filter((row) => row.playerId !== null).map((row) => ({
    Character: row.character, Move: row.moveName, Cohort: row.cohort, Sides: row.gameSides, Tracked: row.counts.attemptGames,
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
