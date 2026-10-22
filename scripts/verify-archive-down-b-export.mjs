#!/usr/bin/env node
/**
 * Independent, local-only QA of the Down B archive refresh. No database writes.
 * Public game rows omit anonymous games; --results supplies the local derived
 * parse files needed to reconstruct the full Venue and tournament populations.
 *
 * node scripts/verify-archive-down-b-export.mjs --dir CACHE/public-export-v9 \
 *   --results CACHE/results-v4 --audit CACHE/source-audit-2026-10-22.json
 * --profile sample relaxes the fixed v9 totals/player roster for isolated tests.
 * --report FILE optionally saves the aggregate-only QA report outside the export.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Character } from "@slippi/slippi-js";
import { computeArchiveContentSha256 } from "./lib/archive-content-hash.mjs";

const cache = path.join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache", "SSBM_DASHBOARD_nikki_archive");
const args = {
  dir: path.join(cache, "public-export-v9"), results: path.join(cache, "results-v4"),
  audit: path.join(cache, "source-audit-2026-10-22.json"), profile: "full", report: null,
  events: "scripts/data/nikki-event-registry.json", identities: "scripts/data/nikki-player-overrides.json",
};
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index]?.replace(/^--/, "");
  if (!(option in args) || process.argv[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${process.argv[index]}`);
  args[option] = process.argv[index + 1];
}
assert.ok(["full", "sample"].includes(args.profile), "--profile must be full or sample");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const stem = (name) => name.replace(/\.(?:7z|zip|json)$/i, "");
const eventFor = (name) => stem(name).replace(/-(?:main-stream|streams?|top-8|r2-offstream)$/i, "");
const sorted = (values) => [...values].sort();
const fields = ["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"];
const outcomes = ["hitAttempts", "noHitAttempts", "incompleteAttempts"];
const directCharacters = new Set([Character.CAPTAIN_FALCON, Character.DONKEY_KONG, Character.FOX,
  Character.KIRBY, Character.BOWSER, Character.LUIGI, Character.MARIO, Character.JIGGLYPUFF,
  Character.FALCO, Character.DR_MARIO, Character.GANONDORF]);
const expectedPlayers = ["aklo", "ampp", "amsa", "axe", "codyschwab", "fiction", "ginger", "hungrybox", "jmook",
  "joshman", "kodorin", "krudo", "llod", "magi", "moky", "none", "ossify", "rapmonster", "s2j", "salt", "sdj",
  "sfat", "shroomed", "soonsay", "spark", "wizzrobe", "zain"];
const [manifest, qa, audit, eventDocument, identityDocument] = await Promise.all([
  json(path.join(args.dir, "manifest.json")), json(path.join(args.dir, "qa.json")), json(args.audit), json(args.events), json(args.identities),
]);
const datasetId = manifest.datasetId;
assert.deepEqual(manifest.loadOrder, ["archive_datasets", "archive_tournament_series", "archive_tournaments", "archive_bundles",
  "archive_players", "archive_player_aliases", "archive_player_rankings", "archive_sets", "archive_set_players",
  "archive_games", "archive_game_players", "archive_rollups"], "complete archive table manifest");
assert.equal(qa.datasetId, datasetId);
assert.equal(qa.contentSha256, manifest.contentSha256);
const sourceByStem = new Map(audit.sources.map((source) => [source.id.slice(`${audit.dataset.id}:`.length), source]));
assert.equal(sourceByStem.size, audit.dataset.archive_count, "source audit is complete and unique");
assert.ok(audit.sources.every((source) => source.id.startsWith(`${audit.dataset.id}:`)), "source audit dataset IDs agree");
assert.ok(sourceByStem.has("ootb5"), "source audit includes the explicitly excluded original bundle");
const included = sorted([...sourceByStem.keys()].filter((name) => name !== "ootb5"));
const population = manifest.sourcePopulation;
assert.ok(population, "export must record its reviewed source population");
assert.deepEqual(population, qa.sourcePopulation, "manifest and QA provenance agree");
assert.equal(population.baseDatasetId, audit.dataset.id);
assert.equal(population.originalBundleCount, sourceByStem.size);
assert.deepEqual(population.includedBundles, included);
assert.deepEqual(population.excludedBundles, ["ootb5"]);
assert.equal(population.sourceAuditSha256, hash(await readFile(args.audit, "utf8")));
const sourceReplayFiles = included.reduce((sum, name) => sum + sourceByStem.get(name).replay_file_count, 0);
const sourceBytes = included.reduce((sum, name) => sum + sourceByStem.get(name).compressed_bytes, 0);
assert.equal(population.expectedReplayFiles, sourceReplayFiles);
assert.equal(population.expectedCompressedBytes, sourceBytes);
if (args.profile === "full") {
  assert.equal(datasetId, "nikki-2026-09-08-v9");
  assert.equal(audit.dataset.id, "nikki-2026-09-08-v8");
  assert.equal(included.length, 67);
  assert.equal(sourceReplayFiles, 159965);
  assert.equal(sourceBytes, 65335000563);
}

const datasets = [], bundles = [], tournaments = [], series = [];
const publicGames = new Map(), publicSides = new Map(), playerDirectory = new Set(), actual = new Map();
const counts = {};
const keyFor = (scope, population_, player, format, character, opponent) => JSON.stringify([scope, population_, player, format, character, opponent]);
const isGlobal = (row) => row.series_id === null && row.tournament_id === null && row.set_id === null && row.stage_id === null;
const identifiers = new Set(["id", "dataset_id", "tournament_id", "set_id", "series_id", "rollup_key"]);
function validateMove(move, character, format, label, aggregate = false, games = null) {
  if (!move) return;
  if (format === "doubles") assert.equal(aggregate ? move.attemptGames : move.attempts, undefined, `${label}: doubles initiation coverage is unavailable`);
  if (move.attempts !== undefined) assert.ok(count(move.attempts), `${label}: valid attempts`);
  const hasOutcomes = outcomes.some((field) => move[field] !== undefined);
  if (hasOutcomes) {
    assert.ok(format === "singles" && directCharacters.has(character), `${label}: utility/delayed moves and doubles must not expose damage outcomes`);
    assert.ok(count(move.attempts) && outcomes.every((field) => count(move[field])), `${label}: complete outcome partition`);
    const outcomeUses = outcomes.reduce((sum, field) => sum + move[field], 0);
    if (aggregate) assert.ok(outcomeUses <= move.attempts, `${label}: outcomes cannot exceed uses`);
    else assert.equal(outcomeUses, move.attempts, `${label}: per-use outcome partition`);
  }
  if (!aggregate) return;
  if (move.attemptGames !== undefined) {
    assert.ok(count(move.attemptGames) && move.attemptGames > 0 && move.attemptGames <= games, `${label}: attempt coverage is measured game sides`);
    assert.ok(count(move.attempts), `${label}: attempt coverage needs a count`);
  } else assert.equal(move.attempts ?? 0, 0, `${label}: attempts need explicit measured-game coverage`);
  if (move.outcomeGames !== undefined) {
    assert.ok(hasOutcomes && count(move.outcomeGames) && move.outcomeGames > 0 && move.outcomeGames <= (move.attemptGames ?? 0), `${label}: outcome coverage is a subset of attempt coverage`);
    if (move.outcomeGames === move.attemptGames) assert.equal(outcomes.reduce((sum, field) => sum + move[field], 0), move.attempts, `${label}: completely measured outcomes partition attempts`);
  } else assert.equal(hasOutcomes, false, `${label}: outcome totals need outcome coverage`);
}
for (const table of manifest.loadOrder) {
  assert.match(table, /^archive_[a-z_]+$/, "safe table filename");
  let rows = 0;
  for await (const line of createInterface({ input: createReadStream(path.join(args.dir, `${table}.ndjson`)), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line); rows++;
    assert.ok(!/"(?:file|path|connectCode|userIdHash|nametag|displayName)"\s*:/.test(line), `${table}: private source fields absent`);
    for (const [field, value] of Object.entries(row)) {
      if (field === "dataset_id") assert.equal(value, datasetId, `${table}: dataset isolation`);
      if (identifiers.has(field) && typeof value === "string") assert.ok(!/(?:^|:)ootb5(?:$|:)/.test(value) && value !== "out-of-the-blue", `${table}: excluded source has no public row`);
    }
    if (table === "archive_datasets") datasets.push(row);
    else if (table === "archive_bundles") bundles.push(row);
    else if (table === "archive_tournaments") tournaments.push(row);
    else if (table === "archive_tournament_series") series.push(row);
    else if (table === "archive_players") playerDirectory.add(row.id);
    else if (table === "archive_games") {
      assert.equal(row.stats_version, 4); assert.ok(!publicGames.has(row.game_key), "unique public game key");
      assert.ok(["verified", "probable"].includes(row.curation_tier), "public games are conservative");
      publicGames.set(row.game_key, row);
    } else if (table === "archive_game_players") {
      const game = publicGames.get(row.game_key);
      assert.ok(game, "public player side has a game");
      assert.ok(row.player_id === null || playerDirectory.has(row.player_id), "named side is a public identity");
      validateMove(row.move_stats?.[21], row.character_id, game.format, "public per-game side");
      const sides = publicSides.get(row.game_key) ?? new Map();
      assert.ok(!sides.has(row.slot), "unique game-side slot");
      sides.set(row.slot, { player: row.player_id, character: row.character_id, move: row.move_stats?.[21] });
      publicSides.set(row.game_key, sides);
    } else if (table === "archive_rollups") {
      assert.equal(row.stats_version, 4);
      assert.ok(count(row.game_count), "valid rollup game count");
      validateMove(row.metrics.moves?.[21], row.character_id, row.format, "archive rollup", true, row.game_count);
      if (isGlobal(row) && ["community", "player"].includes(row.scope)) {
        const key = keyFor(row.scope, row.population, row.player_id, row.format, row.character_id, row.opponent_character_id);
        assert.ok(!actual.has(key), "unique global rollup dimensions");
        actual.set(key, row);
      }
    }
  }
  assert.equal(rows, manifest.tableCounts[table], `${table}: manifest row count`);
  assert.equal(rows, qa.tableCounts[table], `${table}: QA row count`);
  counts[table] = rows;
}
assert.equal(datasets.length, 1);
const dataset = datasets[0];
assert.equal(dataset.id, datasetId);
assert.deepEqual(dataset.import_counts, counts, "dataset publication counts equal verified table rows");
assert.equal(dataset.replay_file_count, sourceReplayFiles);
assert.equal(dataset.compressed_bytes, sourceBytes);
assert.equal(dataset.archive_count, included.length);
assert.equal(dataset.content_sha256, manifest.contentSha256);
assert.equal(await computeArchiveContentSha256({ dir: args.dir, datasetRow: dataset }), manifest.contentSha256, "export content fingerprint");
assert.match(dataset.notes, /Out of the Blue 5/, "visible cohort exclusion note");
if (args.profile === "full") assert.match(dataset.notes, /67 of 68/, "visible original-source coverage");
assert.deepEqual(sorted(bundles.map((row) => row.id.slice(`${datasetId}:`.length))), included, "exact source bundle set");
assert.deepEqual(sorted(tournaments.map((row) => row.event_key)), sorted(new Set(included.map(eventFor))), "exact retained event set");
assert.deepEqual(sorted(series.map((row) => row.id)), sorted(new Set(tournaments.map((row) => row.series_id))), "no empty series from excluded sources");
const tournamentById = new Map(tournaments.map((row) => [row.id, row]));
for (const bundle of bundles) {
  const name = bundle.id.slice(`${datasetId}:`.length), source = sourceByStem.get(name);
  assert.equal(bundle.compressed_bytes, source.compressed_bytes);
  assert.equal(bundle.replay_file_count, source.replay_file_count);
  assert.equal(bundle.parsed_replay_count + bundle.failed_replay_count, source.replay_file_count);
  assert.equal(tournamentById.get(bundle.tournament_id)?.event_key, eventFor(name));
}

// Reconstruct curation independently from minimal local per-game metadata.
// No source labels, paths, private identity keys, or raw replay bytes are emitted.
const eventById = new Map(eventDocument.events.map((event) => [event.id, event]));
const retainedEvents = new Set(included.map(eventFor));
const exactOverrides = new Map(), aliasOverrides = new Map(), characterOverrides = new Map();
const aliasKey = (value) => typeof value === "string" && value.trim() ? value.trim().normalize("NFKC").toLocaleLowerCase("en-US") : null;
for (const group of identityDocument.overrides) {
  if (!retainedEvents.has(group.eventId)) continue;
  const rules = group.kind === "event_aliases" ? group.aliases.map((alias) => ({ ...group, ...alias, kind: "event_alias" }))
    : group.kind === "event_game_players" ? group.games.map((game) => ({ ...group, ...game, kind: "event_game_player" })) : [group];
  for (const rule of rules) {
    const [map, key] = rule.kind === "event_game_player" ? [exactOverrides, `${rule.eventId}|${rule.identitySha256}|${rule.slot}`]
      : rule.kind === "event_alias" ? [aliasOverrides, `${rule.eventId}|${aliasKey(rule.observedAlias)}`]
        : rule.kind === "event_character" ? [characterOverrides, `${rule.eventId}|${rule.characterId}`] : [];
    assert.ok(map, "recognized retained identity rule");
    assert.ok(!map.has(key), "unique retained identity evidence");
    map.set(key, rule);
  }
}
function namedIdentity(player, eventId, digest, slot) {
  const exact = exactOverrides.get(`${eventId}|${digest}|${slot}`);
  if (exact) assert.equal(player.characterId, exact.characterId, "exact identity evidence retains its expected character");
  const alias = [player.displayName, player.nametag].map(aliasKey).filter(Boolean)
    .map((name) => aliasOverrides.get(`${eventId}|${name}`)).find(Boolean);
  return (exact ?? alias ?? characterOverrides.get(`${eventId}|${player.characterId}`))?.playerId ?? null;
}
const normalize = (value) => typeof value === "string" && value.trim() ? value.trim().toLocaleLowerCase("en-US") : null;
const identityFor = (player, event) => player.connectCode ? `code:${player.connectCode.toUpperCase()}`
  : player.userIdHash ? `uid:${player.userIdHash}` : normalize(player.displayName) ? `display:${normalize(player.displayName)}`
    : normalize(player.nametag) ? `event:${event}:tag:${normalize(player.nametag)}` : null;
const sourceGames = new Map();
let parsed = 0, failed = 0, duplicates = 0;
const resultFiles = (await readdir(args.results)).filter((name) => name.endsWith(".json")).sort();
assert.deepEqual(resultFiles.map(stem), included, "local results match the reviewed source cohort");
for (const [index, filename] of resultFiles.entries()) {
  const payload = await json(path.join(args.results, filename));
  const source = sourceByStem.get(stem(filename)), eventId = eventFor(payload.bundle), event = eventById.get(eventId);
  assert.ok(event, "every source event has a registry row");
  assert.equal(payload.schemaVersion, 2); assert.equal(payload.statProfile, "dashboard-full-derived-v1");
  assert.equal(payload.bundle, source.sourceFilename, "local parse names the audited original bundle");
  assert.equal(stem(payload.bundle), stem(filename));
  assert.equal(payload.replayFiles, source.replay_file_count);
  assert.equal(payload.records.length, source.replay_file_count);
  let bundleParsed = 0, bundleFailed = 0;
  for (const record of payload.records) {
    if (!record.ok) { failed++; bundleFailed++; continue; }
    parsed++; bundleParsed++;
    assert.equal(record.statsVersion, 4, "local source statistics must be reparsed");
    const rawKey = record.identityKey ?? `${payload.bundle}/${record.file}`;
    const gameKey = hash(`nikki-public-game-v1:${datasetId}:${rawKey}`);
    const broadcast = /-(?:main-stream|streams?|top-8|r2-offstream)\.(?:7z|zip)$/i.test(payload.bundle)
      || /(?:^|[/\\ _-])(?:bracket|pools?|top[-_ ]?\d+|stream|broadcast)(?:$|[/\\ _-])/i.test(record.file);
    const friendly = /(?:^|[/\\ _-])(?:friendlies?|warm[-_ ]?ups?|hand[-_ ]?warmers?|casuals?)(?:$|[/\\ _-])/i.test(record.file);
    const identityDigest = hash(rawKey);
    const exact = record.players.some((_side, slot) => exactOverrides.has(`${eventId}|${identityDigest}|${slot}`));
    const existing = sourceGames.get(gameKey);
    if (existing) { duplicates++; existing.broadcast ||= broadcast; existing.exact ||= exact; existing.friendly &&= friendly; continue; }
    const format = record.isTeams ? "doubles" : "singles";
    const sides = record.players.map((side, slot) => {
      validateMove(side.moveStats?.[21], side.characterId, format, "local derived side");
      return { character: side.characterId, move: side.moveStats?.[21], player: namedIdentity(side, eventId, identityDigest, slot) };
    });
    const identities = record.players.map((player) => identityFor(player, eventId));
    const teams = new Map();
    for (const [slot, player] of record.players.entries()) {
      const key = player.teamId ?? "unknown", members = teams.get(key) ?? [];
      members.push(identities[slot]); teams.set(key, members);
    }
    const roster = identities.some((id) => id === null) ? null : record.isTeams
      ? [...teams.values()].map((members) => members.sort().join("+")).sort().join(" vs ")
      : identities.sort().join(" vs ");
    const technical = !record.legalStage || !record.playableRoster || record.durationFrames < 1800
      || (record.isTeams ? sides.length !== 4 || teams.has("unknown") || teams.size !== 2 || [...teams.values()].some((members) => members.length !== 2) : sides.length !== 2);
    sourceGames.set(gameKey, { gameKey, eventId, format, sides, technical, tournament: event.isTournament, broadcast, friendly, exact,
      file: record.file, roster, time: record.playedAt ? Date.parse(record.playedAt) : NaN,
      station: `${path.posix.dirname(record.file.replaceAll("\\", "/")).toLocaleLowerCase("en-US")}|${normalize(record.consoleNick) ?? "unknown-console"}`,
      sequence: false });
  }
  assert.equal(payload.parsed, bundleParsed); assert.equal(payload.failed, bundleFailed);
  const bundle = bundles.find((row) => row.id === `${datasetId}:${stem(filename)}`);
  assert.equal(bundle.parsed_replay_count, bundleParsed); assert.equal(bundle.failed_replay_count, bundleFailed);
  if ((index + 1) % 10 === 0) process.stderr.write(`QA indexed ${index + 1}/${resultFiles.length} derived bundles\n`);
}
const stations = new Map();
for (const game of sourceGames.values()) {
  if (game.technical || !game.tournament || game.friendly || !game.roster) continue;
  const key = `${game.eventId}|${game.station}`, rows = stations.get(key) ?? [];
  rows.push(game); stations.set(key, rows);
}
for (const games of stations.values()) {
  games.sort((a, b) => Number.isFinite(a.time) && Number.isFinite(b.time) && a.time !== b.time ? a.time - b.time : a.file.localeCompare(b.file));
  let sequence = [];
  const flush = () => { if (sequence.length >= 2 && sequence.length <= 10) sequence.forEach((game) => { game.sequence = true; }); sequence = []; };
  for (const game of games) {
    const last = sequence.at(-1);
    const gapValid = !last || !Number.isFinite(last.time) || !Number.isFinite(game.time) || (game.time >= last.time && game.time - last.time <= 30 * 60 * 1000);
    if (last && (last.roster !== game.roster || !gapValid)) flush();
    sequence.push(game);
  }
  flush();
}
const expected = new Map();
function add(scope, population_, player, format, character, opponent, move) {
  const key = keyFor(scope, population_, player, format, character, opponent);
  const row = expected.get(key) ?? { scope, population: population_, player, format, character, opponent, games: 0, move: null };
  row.games++;
  if (move && character !== null) {
    row.move ??= { attempts: 0 };
    row.move.attempts += move.attempts ?? 0;
    if (move.attempts !== undefined) row.move.attemptGames = (row.move.attemptGames ?? 0) + 1;
    if (move.hitAttempts !== undefined) {
      row.move.outcomeGames = (row.move.outcomeGames ?? 0) + 1;
      outcomes.forEach((field) => { row.move[field] = (row.move[field] ?? 0) + move[field]; });
    }
  }
  expected.set(key, row);
}
function addSide(scope, population_, player, format, side, opponent) {
  add(scope, population_, player, format, null, null, null);
  add(scope, population_, player, format, side.character, null, side.move);
  if (format === "singles") add(scope, population_, player, format, side.character, opponent.character, side.move);
}
const buckets = { verifiedBracket: 0, probableBracket: 0, unclassifiedVenue: 0, excludedOrIncomplete: 0 };
const publicSeen = new Set(), mappedPlayers = new Set();
let mappedPlayerSides = 0;
const rawCounts = (move) => move ? Object.fromEntries(["attempts", ...outcomes].filter((field) => move[field] !== undefined).map((field) => [field, move[field]])) : null;
for (const game of sourceGames.values()) {
  const excluded = game.technical || !game.tournament || game.friendly;
  const verified = game.eventId === "the-match-zain-vs-cody";
  const conservative = !excluded && (verified || game.broadcast || game.sequence || game.exact);
  const bucket = excluded ? "excludedOrIncomplete" : verified ? "verifiedBracket" : conservative ? "probableBracket" : "unclassifiedVenue";
  buckets[bucket]++;
  if (!excluded) for (const [slot, side] of game.sides.entries()) {
    const opponent = game.sides[slot === 0 ? 1 : 0];
    addSide("community", "broad", null, game.format, side, opponent);
    if (conservative) addSide("community", "conservative", null, game.format, side, opponent);
  }
  const publicGame = publicGames.get(game.gameKey);
  assert.equal(Boolean(publicGame), conservative && game.sides.some((side) => side.player !== null), "public games exactly cover conservative games with approved named identity evidence");
  if (!publicGame) continue;
  assert.ok(conservative, "each public game belongs to the independently derived conservative population");
  assert.equal(publicGame.tournament_id, `${datasetId}:${game.eventId}`); assert.equal(publicGame.format, game.format);
  assert.equal(publicGame.curation_tier, verified ? "verified" : "probable");
  const sides = publicSides.get(game.gameKey);
  assert.equal(sides?.size, game.sides.length, "all public game sides present");
  assert.ok([...sides.values()].some((side) => side.player !== null), "anonymous games remain aggregate-only");
  for (const [slot, side] of game.sides.entries()) {
    const published = sides.get(slot);
    assert.equal(published?.character, side.character);
    assert.equal(published.player, side.player, "published identity matches retained public evidence");
    assert.deepEqual(rawCounts(published.move), rawCounts(side.move), "public per-game Down B counts equal selected local derived counts");
    if (published.player !== null) {
      mappedPlayerSides++;
      mappedPlayers.add(published.player);
      addSide("player", "conservative", published.player, game.format, published, game.sides[slot === 0 ? 1 : 0]);
    }
  }
  publicSeen.add(game.gameKey);
}
assert.equal(publicSeen.size, publicGames.size, "all public games match selected source games");
assert.equal(publicSeen.size, qa.identity.mappedGames);
assert.equal(mappedPlayerSides, qa.identity.mappedPlayerSlots);
assert.equal(parsed, dataset.parsed_replay_count); assert.equal(sourceGames.size, dataset.unique_game_count);
assert.equal(parsed + failed, sourceReplayFiles); assert.equal(parsed - duplicates, sourceGames.size);
assert.equal(buckets.verifiedBracket + buckets.probableBracket, dataset.conservative_game_count);
assert.equal(sourceGames.size - buckets.excludedOrIncomplete, dataset.broad_game_count);
assert.deepEqual(buckets, qa.input.publishedBuckets);
assert.equal(duplicates, qa.input.duplicateFiles); assert.equal(failed, qa.input.failedFiles);
const required = (row) => row.opponent === null || row.games >= (row.scope === "community" ? 25 : 3);
let compared = 0, comparedMatchups = 0;
for (const [key, row] of expected) {
  const published = actual.get(key);
  if (!required(row)) { assert.equal(published, undefined, "sparse global matchup cells are omitted"); continue; }
  assert.ok(published, `required aggregate exists: ${key}`);
  assert.equal(published.game_count, row.games, `aggregate game sides: ${key}`);
  const move = published.metrics.moves?.[21];
  assert.equal(Boolean(move), Boolean(row.move), `move measurement presence: ${key}`);
  for (const field of fields) assert.equal(move?.[field], row.move?.[field], `${field}: ${key}`);
  compared++; if (row.opponent !== null) comparedMatchups++;
}
for (const key of actual.keys()) assert.ok(expected.has(key) && required(expected.get(key)), `no extra global aggregate: ${key}`);
const representedPlayers = new Set([...actual.values()].filter((row) => row.scope === "player" && row.character_id === null && row.opponent_character_id === null && row.game_count > 0).map((row) => row.player_id));
assert.deepEqual(sorted(representedPlayers), sorted(mappedPlayers), "global player rollups cover precisely the named per-game population");
assert.equal(mappedPlayers.size, qa.identity.mappedPlayersWithGames);
if (args.profile === "full") assert.deepEqual(sorted(mappedPlayers), expectedPlayers, "all 27 approved identities actually survive in conservative games");
assert.equal(qa.moveCoverage.statsVersion, 4);
assert.deepEqual(sorted(qa.moveCoverage.downB.map((summary) => summary.population)), ["broad", "conservative"]);
for (const summary of qa.moveCoverage.downB) {
  const rows = [...expected.values()].filter((row) => row.scope === "community" && row.population === summary.population && row.character !== null && row.opponent === null);
  assert.equal(summary.characterRows, rows.length, "QA character coverage row count");
  for (const field of fields) assert.equal(summary[field], rows.reduce((sum, row) => sum + (row.move?.[field] ?? 0), 0), `QA summary ${summary.population} ${field}`);
}

const rates = (row) => {
  const move = row.move ?? {}, completed = (move.hitAttempts ?? 0) + (move.noHitAttempts ?? 0);
  return { games: row.games, ...move, attemptsPerGame: move.attemptGames ? move.attempts / move.attemptGames : null,
    noHitPerGame: move.outcomeGames ? move.noHitAttempts / move.outcomeGames : null,
    noHitRate: completed ? move.noHitAttempts / completed : null,
    completedUseCoverage: completed + (move.incompleteAttempts ?? 0) ? completed / (completed + (move.incompleteAttempts ?? 0)) : null,
    attemptCoverage: row.games ? (move.attemptGames ?? 0) / row.games : null,
    outcomeCoverage: row.games ? (move.outcomeGames ?? 0) / row.games : null };
};
const characterCoverage = [...expected.values()].filter((row) => row.scope === "community" && row.character !== null && row.opponent === null)
  .map((row) => ({ population: row.population, format: row.format, characterId: row.character,
    outcomesSupported: row.format === "singles" && directCharacters.has(row.character), ...rates(row) }))
  .sort((a, b) => a.population.localeCompare(b.population) || a.format.localeCompare(b.format) || a.characterId - b.characterId);
const representativeMatchups = [...expected.values()].filter((row) => row.opponent !== null && required(row) && row.move?.attemptGames)
  .sort((a, b) => b.games - a.games).slice(0, 20)
  .map((row) => ({ scope: row.scope, population: row.population, playerId: row.player, format: row.format, characterId: row.character, opponentCharacterId: row.opponent, ...rates(row) }));
const report = {
  verifiedAt: new Date().toISOString(), profile: args.profile, datasetId, contentSha256: manifest.contentSha256,
  sourceCohort: { bundles: bundles.length, replayFiles: sourceReplayFiles, compressedBytes: sourceBytes, excluded: ["ootb5"] },
  localDerivedCounts: { parsed, failed, duplicateCopies: duplicates, uniqueGames: sourceGames.size, populations: buckets },
  matchedPublicGames: publicSeen.size, mappedPlayerIds: sorted(mappedPlayers), comparedGlobalAggregates: compared, comparedMatchupAggregates: comparedMatchups,
  characterCoverage, representativeMatchups, tableCounts: counts,
  definitions: [
    "Game denominators count measured player sides, including zero-use games; they are not the full archive game count.",
    "Attempts/game = attempts / attemptGames. No-hit uses/game = noHitAttempts / outcomeGames.",
    "No-hit rate = noHitAttempts / (hitAttempts + noHitAttempts); unfinished uses are excluded.",
    "No-hit is a damage-based whiff proxy that includes shield contact and defensive uses. It is not a verified whiff rate.",
    "Utility, counter, item, delayed/projectile, and transformation Down Bs have attempts only. Current Down B tracking covers singles; doubles initiation and outcome coverage remain unavailable.",
  ],
  limits: [
    "This verifies aggregation and coverage from derived statistics; detector accuracy against replay frames is tested separately.",
    "Public per-game rows contain only conservative games with a named player. Complete community reconciliation uses local derived parse files and an independent curation pass.",
    "Every global character and eligible global matchup cell is reconciled for broad community, conservative community, and conservative players. Event/series rollups receive coverage and integrity checks, not a separate sum reconstruction.",
    "No raw replay bytes, source filenames, paths, private keys, unresolved labels, or connect codes are included in this report.",
  ],
};
if (args.report) await writeFile(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: "passed", profile: args.profile, datasetId, sourceCohort: report.sourceCohort,
  mappedPlayers: mappedPlayers.size, matchedPublicGames: publicSeen.size, comparedGlobalAggregates: compared,
  comparedMatchupAggregates: comparedMatchups, reportSaved: Boolean(args.report) }, null, 2));
