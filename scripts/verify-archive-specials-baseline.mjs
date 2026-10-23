#!/usr/bin/env node
/** Preserve published metrics except exact replay-proven Down B coverage withdrawals. */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i]?.replace(/^--/, "");
  assert.ok(["before", "after", "report", "corrections"].includes(option) && process.argv[i + 1], "Expected --before DIR --after DIR [--report FILE] [--corrections VERIFIED_DELTAS.json]");
  args[option] = process.argv[i + 1];
}
assert.ok(args.before && args.after, "Expected --before DIR --after DIR");
const manifests = await Promise.all([args.before, args.after].map(async (dir) => JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"))));
assert.deepEqual(manifests[0].sourcePopulation, manifests[1].sourcePopulation, "source cohort must be identical");
const newFields = new Set(["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"]);
const dimensions = ["scope", "population", "series_id", "tournament_id", "set_id", "player_id", "format", "character_id", "opponent_character_id", "stage_id"];
const corrections = args.corrections ? JSON.parse(await readFile(args.corrections, "utf8")) : null;
const correctionByRollup = new Map(), consumedCorrections = new Set();
if (corrections) {
  assert.equal(corrections.schemaVersion, 1);
  assert.equal(corrections.beforeDatasetId, manifests[0].datasetId);
  assert.equal(corrections.beforeContentSha256, manifests[0].contentSha256);
  assert.equal(corrections.afterDatasetId, manifests[1].datasetId);
  assert.equal(corrections.afterContentSha256, manifests[1].contentSha256);
  assert.equal(corrections.auditSha256, manifests[1].sourcePopulation.sourceAuditSha256);
  assert.match(corrections.correctionManifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(corrections.publicSideCorrections, [], "public side pairing and all existing public per-game values remain exact");
  for (const entry of corrections.rollups) {
    const key = JSON.stringify(entry.dimensions);
    assert.equal(entry.dimensions.length, dimensions.length);
    assert.ok(!correctionByRollup.has(key), "one exact correction per rollup");
    assert.deepEqual(Object.keys(entry.delta).sort(), [...newFields].sort());
    assert.ok(Object.values(entry.delta).every((value) => Number.isSafeInteger(value) && value <= 0), "only withdrawals of unreliable measured coverage are allowed");
    assert.ok(entry.sourceSides.length > 0 && entry.delta.attemptGames < 0, "each correction identifies replay-proven removed game sides");
    correctionByRollup.set(key, entry);
  }
}
function withdrawUnreliableDownB(value, correction) {
  const move = value.metrics?.moves?.[21];
  assert.ok(move, "a proven Down B withdrawal must resolve to an existing prior move");
  for (const field of newFields) {
    const updated = (move[field] ?? 0) + correction.delta[field];
    assert.ok(Number.isSafeInteger(updated) && updated >= 0, `correction cannot exceed prior ${field}`);
    move[field] = updated;
  }
  if (move.attemptGames === 0) delete move.attemptGames;
  if (move.outcomeGames === 0) {
    for (const field of ["hitAttempts", "noHitAttempts", "incompleteAttempts"]) {
      assert.equal(move[field], 0, "no outcome coverage may retain an outcome numerator");
      delete move[field];
    }
    delete move.outcomeGames;
  }
}
function removeEmptyCorrectedDownB(value) {
  const moves = value.metrics?.moves, move = moves?.[21];
  if (move && move.attemptGames === undefined && move.outcomeGames === undefined
    && Object.values(move).every((number) => number === 0)) delete moves[21];
}
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
      const correction = correctionByRollup.get(key);
      if (correction) {
        if (datasetId === manifests[0].datasetId) {
          withdrawUnreliableDownB(value, correction);
          consumedCorrections.add(key);
        }
        removeEmptyCorrectedDownB(value);
      }
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
assert.equal(consumedCorrections.size, correctionByRollup.size, "every replay-proven correction resolves to an existing published rollup");
const report = { ok: true, before: manifests[0].datasetId, after: manifests[1].datasetId, checked,
  unchanged: "All populations, public per-game values, landed/damage/kills, and other prior metrics; Down B usage differs only by exact replay-proven completeness withdrawals",
  completenessCorrections: corrections ? { sourceSides: corrections.sourceSides, retainedSides: corrections.retainedSides,
    affectedRollups: correctionByRollup.size, correctionManifestSha256: corrections.correctionManifestSha256,
    parserSha256: corrections.parserSha256 } : null, checkedAt: new Date().toISOString() };
if (args.report) await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
