#!/usr/bin/env node
/** Independently reconcile an additive identity revision against the frozen archive and public side rows. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { computeArchiveContentSha256 } from "./lib/archive-content-hash.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(["--cache", "--before", "--after", "--report"].includes(process.argv[i]) && process.argv[i + 1]);
  args.set(process.argv[i], process.argv[i + 1]);
}
assert.ok(args.has("--cache"), "Use --cache DIR [--before DIR] [--after DIR] [--report FILE]");
const cache = path.resolve(args.get("--cache"));
const beforeDir = path.resolve(args.get("--before") ?? path.join(cache, "public-export-v10"));
const afterDir = path.resolve(args.get("--after") ?? path.join(cache, "public-export-v11"));
if (args.has("--report")) {
  const rel = path.relative(afterDir, path.resolve(args.get("--report")));
  assert.ok(rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel), "Report must remain outside immutable export");
}
const json = async file => JSON.parse(await readFile(file, "utf8"));
const hash = value => createHash("sha256").update(value).digest("hex");
async function* ndjson(file) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
}
const rows = async file => { const result = []; for await (const row of ndjson(file)) result.push(row); return result; };
const [beforeManifest, afterManifest, beforeQA, afterQA, evidence] = await Promise.all([
  json(path.join(beforeDir, "manifest.json")), json(path.join(afterDir, "manifest.json")),
  json(path.join(beforeDir, "qa.json")), json(path.join(afterDir, "qa.json")), json(path.join(cache, "interaction-pro-evidence.local.json")),
]);
assert.notEqual(beforeManifest.datasetId, afterManifest.datasetId);
assert.equal(evidence.sourceDataset, beforeManifest.datasetId);
assert.deepEqual(afterQA.input, beforeQA.input, "all source, parse, deduplication and curation totals remain unchanged");
assert.deepEqual(afterQA.sourcePopulation, beforeQA.sourcePopulation, "retained source population remains unchanged");
assert.equal(afterQA.identity.supplementalRegistrySha256, evidence.registrySha256);
const [beforeGames, beforePlayers, afterGames, afterPlayers, beforeDatasets, afterDatasets] = await Promise.all([
  rows(path.join(beforeDir, "archive_games.ndjson")), rows(path.join(beforeDir, "archive_game_players.ndjson")),
  rows(path.join(afterDir, "archive_games.ndjson")), rows(path.join(afterDir, "archive_game_players.ndjson")),
  rows(path.join(beforeDir, "archive_datasets.ndjson")), rows(path.join(afterDir, "archive_datasets.ndjson")),
]);
for (const field of ["data_as_of", "parser_version", "curation_version", "compressed_bytes", "archive_count",
  "replay_file_count", "parsed_replay_count", "unique_game_count", "broad_game_count", "conservative_game_count"]) {
  assert.equal(afterDatasets[0][field], beforeDatasets[0][field], `public dataset ${field} remains unchanged`);
}
assert.match(afterDatasets[0].notes, /Tournament pools all eligible event-venue recordings/);
assert.doesNotMatch(afterDatasets[0].notes, /feed Venue aggregates|feed Tournament aggregates/);
assert.ok(afterGames.every(game => game.stats_version === 6), "identity expansion retains the existing parser statistics version");
const expectedIdentities = new Map(beforePlayers.filter(row => row.player_id).map(row => [`${row.game_key}|${row.slot}`, {
  player_id: row.player_id, character_id: row.character_id, identity_resolution: row.identity_resolution,
  identity_source_url: row.identity_source_url,
}]));
for (const row of evidence.rows) {
  const key = `${row.game_key}|${row.slot}`;
  assert.ok(!expectedIdentities.has(key), "reviewed additive fixture has no duplicate existing player sides");
  const { game_key: _gameKey, slot: _slot, ...identity } = row;
  expectedIdentities.set(key, identity);
}
const newToOld = new Map(), sourceSides = new Map();
const evidenceSources = new Map(evidence.resultsSources.map(row => [row.bundle, row.sha256]));
for (const filename of (await readdir(path.join(cache, "results-v6"))).filter(file => file.endsWith(".json")).sort()) {
  const bytes = await readFile(path.join(cache, "results-v6", filename));
  const payload = JSON.parse(bytes);
  if (evidenceSources.has(payload.bundle)) assert.equal(hash(bytes), evidenceSources.get(payload.bundle), "reviewed source records have not changed");
  for (const record of payload.records) {
    if (!record.ok) continue;
    const raw = record.identityKey ?? `${payload.bundle}/${record.file}`;
    const oldKey = hash(`nikki-public-game-v1:${beforeManifest.datasetId}:${raw}`);
    const newKey = hash(`nikki-public-game-v1:${afterManifest.datasetId}:${raw}`);
    newToOld.set(newKey, oldKey);
    for (const [slot, player] of record.players.entries()) {
      if (expectedIdentities.has(`${oldKey}|${slot}`) && !sourceSides.has(`${newKey}|${slot}`)) {
        assert.equal(record.statsVersion, 6);
        sourceSides.set(`${newKey}|${slot}`, player);
      }
    }
  }
}
const normalize = row => {
  const copy = { ...row };
  delete copy.rollup_key; delete copy.dataset_id;
  for (const key of ["id", "tournament_id", "set_id"]) if (typeof copy[key] === "string") {
    copy[key] = copy[key].replace(afterManifest.datasetId, "DATASET").replace(beforeManifest.datasetId, "DATASET");
  }
  if (copy.game_key) copy.game_key = newToOld.get(copy.game_key) ?? copy.game_key;
  return copy;
};
const afterGameByKey = new Map(afterGames.map(row => [row.game_key, row]));
const afterGameByOldKey = new Map(afterGames.map(row => [newToOld.get(row.game_key), row]));
const afterSideByOldKey = new Map(afterPlayers.map(row => [`${newToOld.get(row.game_key)}|${row.slot}`, row]));
assert.equal(afterSideByOldKey.size, afterPlayers.length, "public sides are unique");
for (const before of beforeGames) assert.deepEqual(normalize(afterGameByOldKey.get(before.game_key)), normalize(before), "existing game metadata remains identical");
for (const before of beforePlayers) {
  const after = afterSideByOldKey.get(`${before.game_key}|${before.slot}`);
  assert.ok(after, "existing public side remains present");
  const oldMetrics = normalize(before), newMetrics = normalize(after);
  for (const key of ["player_id", "identity_resolution", "identity_source_url"]) { delete oldMetrics[key]; delete newMetrics[key]; }
  assert.deepEqual(newMetrics, oldMetrics, "all original measurements and completeness withdrawals remain identical");
}
const named = afterPlayers.filter(row => row.player_id);
assert.equal(named.length, expectedIdentities.size);
for (const row of named) {
  const key = `${newToOld.get(row.game_key)}|${row.slot}`;
  const expected = expectedIdentities.get(key);
  assert.deepEqual({ player_id: row.player_id, character_id: row.character_id,
    identity_resolution: row.identity_resolution, identity_source_url: row.identity_source_url }, expected,
  "published identities equal the exact union of legacy and reviewed supplemental evidence");
  const source = sourceSides.get(`${row.game_key}|${row.slot}`);
  assert.ok(source);
  assert.deepEqual(row.move_stats, source.moveStats ?? {}, "newly named move measurements equal the existing v6 source");
  assert.deepEqual(row.action_counts, source.actions ?? {});
  assert.equal(row.damage_total, source.totalDamage ?? null);
}
const summary = selected => ({ players: new Set(selected.map(row => row.player_id)).size, playerGames: selected.length,
  games: new Set(selected.map(row => row.game_key)).size });
const singles = named.filter(row => afterGameByKey.get(row.game_key).format === "singles");
const doubles = named.filter(row => afterGameByKey.get(row.game_key).format === "doubles");
assert.deepEqual(summary(singles), { players: 98, playerGames: 1883, games: 1338 });
assert.equal(doubles.length, 115);
assert.deepEqual(summary(named), { players: 98, playerGames: 1998, games: 1420 });
assert.equal(afterGames.length, 1420);
assert.equal(named.filter(row => row.player_id === "ampp").length, 5);

// Hash every non-player archive rollup before comparing, keeping the full field
// corpus bounded in memory while proving the identity expansion did not alter it.
const dimensions = row => JSON.stringify([row.scope, row.population, row.series_id, row.tournament_id?.replace(beforeManifest.datasetId, "DATASET").replace(afterManifest.datasetId, "DATASET"),
  row.set_id, row.player_id, row.format, row.character_id, row.opponent_character_id, row.stage_id]);
const core = new Map();
for await (const row of ndjson(path.join(beforeDir, "archive_rollups.ndjson"))) if (row.scope !== "player") core.set(dimensions(row), hash(JSON.stringify(normalize(row))));
let checkedCore = 0; const pooled = [];
for await (const row of ndjson(path.join(afterDir, "archive_rollups.ndjson"))) {
  if (row.scope === "pro") pooled.push(row);
  else if (row.scope !== "player") {
    assert.equal(hash(JSON.stringify(normalize(row))), core.get(dimensions(row)), "field archive rollup remains identical"); checkedCore++;
  }
}
assert.equal(checkedCore, core.size);
assert.ok(pooled.length > 0);
const sideByKey = new Map(afterPlayers.map(row => [`${row.game_key}|${row.slot}`, row]));
const scalarFields = { damageTotal: "damage_total", neutralWins: "neutral_wins", lCancelSuccess: "l_cancel_success", lCancelFail: "l_cancel_fail",
  techInPlace: "tech_in_place", techToward: "tech_toward", techAway: "tech_away", techMissed: "tech_missed", wallTechSuccess: "wall_tech_success", wallTechMissed: "wall_tech_missed" };
let pooledFromSuppressedPlayers = 0;
for (const row of pooled) {
  assert.equal(row.population, "conservative");
  assert.equal(row.stats_version, 6);
  for (const key of ["series_id", "tournament_id", "set_id", "player_id"]) assert.equal(row[key], null);
  const selected = named.filter(side => {
    const game = afterGameByKey.get(side.game_key);
    const opponent = game.format === "singles" ? sideByKey.get(`${side.game_key}|${1 - side.slot}`) : null;
    return game.format === row.format && (row.character_id === null || side.character_id === row.character_id)
      && (row.opponent_character_id === null || opponent?.character_id === row.opponent_character_id)
      && (row.stage_id === null || game.stage_id === row.stage_id);
  });
  assert.equal(row.game_count, selected.length);
  assert.equal(row.identified_player_count, new Set(selected.map(side => side.player_id)).size);
  assert.equal(row.win_rate_game_count, selected.filter(side => side.won !== null).length);
  assert.equal(row.wins, selected.filter(side => side.won === true).length);
  assert.equal(row.metrics.durationFrames, selected.reduce((sum, side) => sum + afterGameByKey.get(side.game_key).duration_frames, 0));
  for (const [field, source] of Object.entries(scalarFields)) {
    const sum = selected.reduce((total, side) => total + (side[source] ?? 0), 0);
    assert.equal(row.metrics[field], field === "damageTotal" ? Number(sum.toFixed(3)) : sum);
  }
  for (const [prefix, source] of [["openingsPerKill", "openings_per_kill"], ["damagePerOpening", "damage_per_opening"], ["inputsPerMinute", "inputs_per_minute"]]) {
    const values = selected.map(side => side[source]).filter(Number.isFinite);
    assert.equal(row.metrics[`${prefix}Samples`], values.length);
    assert.equal(row.metrics[`${prefix}Sum`], Number(values.reduce((sum, value) => sum + value, 0).toFixed(6)));
  }
  for (const action of Object.keys(row.metrics.actions)) assert.equal(row.metrics.actions[action], selected.reduce((sum, side) => sum + (side.action_counts[action] ?? 0), 0));
  if (row.metrics.moves) for (const [id, move] of Object.entries(row.metrics.moves)) {
    const observations = selected.map(side => side.move_stats[id]).filter(Boolean);
    for (const field of ["attempts", "landed", "damage", "kills", "killPctSum", "openings", "openingDmg", "lCancelSuccess", "lCancelFail"]) {
      const source = field === "lCancelSuccess" ? "lcSuccess" : field === "lCancelFail" ? "lcFail" : field;
      const sum = observations.reduce((total, item) => total + (item[source] ?? 0), 0);
      assert.equal(move[field], ["damage", "killPctSum", "openingDmg"].includes(field) ? Number(sum.toFixed(3)) : sum);
    }
    if ([18, 19, 20, 21].includes(Number(id))) {
      const measured = observations.filter(item => Number.isSafeInteger(item.attempts));
      const outcomes = measured.filter(item => ["hitAttempts", "noHitAttempts", "incompleteAttempts"].every(field => Number.isSafeInteger(item[field])));
      assert.equal(move.attemptGames ?? 0, measured.length);
      assert.equal(move.outcomeGames ?? 0, outcomes.length);
      for (const field of ["hitAttempts", "noHitAttempts", "incompleteAttempts"]) assert.equal(move[field] ?? 0, outcomes.reduce((sum, item) => sum + item[field], 0));
    }
  }
  if (row.opponent_character_id !== null || row.stage_id !== null) {
    const counts = new Map(); for (const side of selected) counts.set(side.player_id, (counts.get(side.player_id) ?? 0) + 1);
    const minimum = row.opponent_character_id !== null && row.stage_id !== null ? 5 : 3;
    if ([...counts.values()].some(value => value < minimum)) pooledFromSuppressedPlayers++;
    assert.ok(selected.length >= minimum);
  }
}
assert.ok(pooledFromSuppressedPlayers > 0, "pooled rows retain valid observations that per-player sparse suppression would lose");
for (const format of ["singles", "doubles"]) assert.ok(pooled.some(row => row.format === format && row.character_id === null && row.opponent_character_id === null && row.stage_id === null && row.metrics.moves));
assert.ok(pooled.some(row => row.character_id === null && row.opponent_character_id !== null && row.metrics.moves), "all-character matchup rows preserve distinct players and moves");
assert.equal(await computeArchiveContentSha256({ dir: afterDir, datasetRow: afterDatasets[0] }), afterManifest.contentSha256);
const report = { ok: true, before: beforeManifest.datasetId, after: afterManifest.datasetId, singles: summary(singles),
  dataAsOf: afterDatasets[0].data_as_of, parserVersion: afterDatasets[0].parser_version, statsVersion: 6,
  doubles: summary(doubles), allFormats: summary(named), unchangedFieldRollups: checkedCore,
  pooledProRollups: pooled.length, pooledRowsRetainingSparsePlayerContributions: pooledFromSuppressedPlayers,
  published: false, checkedAt: new Date().toISOString() };
if (args.has("--report")) await writeFile(args.get("--report"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
