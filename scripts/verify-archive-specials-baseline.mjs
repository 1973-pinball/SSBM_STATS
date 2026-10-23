#!/usr/bin/env node
/** Check that adding N/S/Up usage leaves every previously published metric intact. */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i]?.replace(/^--/, "");
  assert.ok(["before", "after", "report"].includes(option) && process.argv[i + 1], "Expected --before DIR --after DIR [--report FILE]");
  args[option] = process.argv[i + 1];
}
assert.ok(args.before && args.after, "Expected --before DIR --after DIR");
const manifests = await Promise.all([args.before, args.after].map(async (dir) => JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"))));
assert.deepEqual(manifests[0].sourcePopulation, manifests[1].sourcePopulation, "source cohort must be identical");
const newFields = new Set(["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"]);
const dimensions = ["scope", "population", "series_id", "tournament_id", "set_id", "player_id", "format", "character_id", "opponent_character_id", "stage_id"];
function oldMetrics(metrics) {
  if (!metrics) return metrics;
  const result = structuredClone(metrics);
  const moves = result.moves ?? result;
  for (const id of [18, 19, 20]) {
    const move = moves[id];
    if (!move) continue;
    for (const field of newFields) delete move[field];
    // A newly measured zero-use special can add a zero-only row, but cannot
    // change any prior landed/damage/opening/kill measurement.
    if (Object.values(move).every((value) => value === 0)) delete moves[id];
  }
  return result;
}
async function rows(dir, datasetId, table) {
  const result = new Map();
  const normalize = (value) => typeof value === "string" ? value.replaceAll(datasetId, "DATASET") : value;
  const publicGames = new Map();
  if (table === "archive_game_players") {
    for await (const line of createInterface({ input: createReadStream(path.join(dir, "archive_games.ndjson")), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const game = JSON.parse(line);
      const key = game.game_key;
      delete game.game_key; delete game.dataset_id; delete game.stats_version; delete game.published;
      for (const field of Object.keys(game)) game[field] = normalize(game[field]);
      publicGames.set(key, game);
    }
  }
  for await (const line of createInterface({ input: createReadStream(path.join(dir, `${table}.ndjson`)), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (table === "archive_rollups") {
      const key = JSON.stringify(dimensions.map((field) => normalize(row[field])));
      assert.ok(!result.has(key), `${table}: unique dimensions`);
      const value = { ...row, metrics: oldMetrics(row.metrics) };
      delete value.rollup_key; delete value.dataset_id; delete value.stats_version; delete value.published;
      for (const field of dimensions) value[field] = normalize(value[field]);
      result.set(key, value);
    } else {
      const game = publicGames.get(row.game_key);
      assert.ok(game, "public side must resolve to a public game");
      const value = { ...row, move_stats: oldMetrics(row.move_stats) };
      delete value.game_key; delete value.dataset_id; delete value.published;
      // Public game hashes include the dataset ID. Compare the complete old
      // metadata+side payload as a multiset instead; identical public rows
      // retain their multiplicity, including games without timestamps.
      const key = JSON.stringify([game, value]);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
  }
  return result;
}
const checked = {};
for (const table of ["archive_game_players", "archive_rollups"]) {
  const [before, after] = await Promise.all([rows(args.before, manifests[0].datasetId, table), rows(args.after, manifests[1].datasetId, table)]);
  assert.equal(before.size, after.size, `${table}: row counts`);
  for (const [key, value] of before) assert.deepEqual(after.get(key), value, `${table}: existing metrics changed for ${key}`);
  checked[table] = table === "archive_game_players" ? [...before.values()].reduce((sum, count) => sum + count, 0) : before.size;
}
const report = { ok: true, before: manifests[0].datasetId, after: manifests[1].datasetId, checked, unchanged: "All prior public metrics, including Down B attempts and outcomes", checkedAt: new Date().toISOString() };
if (args.report) await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
