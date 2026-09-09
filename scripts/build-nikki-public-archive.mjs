#!/usr/bin/env node

/**
 * Turn the local Nikki archive parse into privacy-safe, Supabase-ready NDJSON.
 *
 * Raw replay bytes, paths, filenames, connect codes, hashed Slippi user ids,
 * and unresolved tags never enter the export. Anonymous games contribute only
 * to aggregate rollups. Per-game rows are emitted for conservative tournament
 * games only when at least one publicly ranked player is resolved.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import { computeArchiveContentSha256 } from "./lib/archive-content-hash.mjs";
import { readDataset } from "./lib/liquipedia-data.mjs";
import { displayName as canonicalDisplay, playerKey } from "./lib/liquipedia-parse.mjs";

const CACHE_ROOT = process.env.NIKKI_ARCHIVE_CACHE_ROOT ?? path.join(
  homedir(),
  process.platform === "darwin" ? "Library/Caches" : ".cache",
  "SSBM_DASHBOARD_nikki_archive",
);
const localDate = (date = new Date()) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, "0"),
  String(date.getDate()).padStart(2, "0"),
].join("-");
const DEFAULTS = {
  results: path.join(CACHE_ROOT, "results"),
  downloads: path.join(CACHE_ROOT, "downloads"),
  curation: path.join(CACHE_ROOT, "archive-curation.json"),
  events: new URL("./data/nikki-event-registry.json", import.meta.url).pathname,
  series: new URL("./data/nikki-series-registry.json", import.meta.url).pathname,
  identities: new URL("./data/nikki-player-overrides.json", import.meta.url).pathname,
  output: path.join(CACHE_ROOT, "public-export"),
  dataAsOf: localDate(),
  version: "v1",
};

const args = { ...DEFAULTS };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error("Usage: build-nikki-public-archive.mjs [--results DIR] [--downloads DIR] [--curation FILE] [--events FILE] [--series FILE] [--identities FILE] [--output DIR] [--data-as-of YYYY-MM-DD] [--version vN]");
  }
  const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  if (!(name in args)) throw new Error(`Unknown option ${key}`);
  args[name] = value;
}

if (!/^v[1-9]\d*$/.test(args.version)) throw new Error("--version must look like v1, v2, …");
const DATASET_ID = `nikki-${args.dataAsOf}-${args.version}`;
const SOURCE_URL = "https://replays.nikki.sh/";
const MIN_GAME_FRAMES = 30 * 60;
const MAX_SET_GAMES = 10;
const SET_GAP_MS = 30 * 60 * 1000;
const ARCHIVE_STATS_VERSION = 3;
const BROADCAST_BUNDLE = /-(?:main-stream|streams?|top-8|r2-offstream)\.(?:7z|zip)$/i;
const BRACKET_PATH = /(?:^|[/\\ _-])(?:bracket|pools?|top[-_ ]?\d+|stream|broadcast)(?:$|[/\\ _-])/i;
const FRIENDLY_PATH = /(?:^|[/\\ _-])(?:friendlies?|warm[-_ ]?ups?|hand[-_ ]?warmers?|casuals?)(?:$|[/\\ _-])/i;
const VERIFIED_EVENTS = new Set(["the-match-zain-vs-cody"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicGameKey = (key) => hash(`nikki-public-game-v1:${DATASET_ID}:${key}`);
const tournamentId = (eventId) => `${DATASET_ID}:${eventId}`;
const publicSetId = (eventId, seed) => `${DATASET_ID}:${eventId}:${hash(`nikki-public-set-v1:${eventId}:${seed}`).slice(0, 24)}`;
const assertCurrentStats = (record, bundle) => {
  const hasCrouchCancels = record.players.every((player) =>
    Number.isInteger(player.actions?.crouchCancels) && player.actions.crouchCancels >= 0);
  if (record.statsVersion !== ARCHIVE_STATS_VERSION || !hasCrouchCancels) {
    throw new Error(
      `${bundle}/${record.file} has archive stats v${record.statsVersion ?? "unknown"} without current `
      + `crouch-cancel counts; re-run analyze-nikki-bundle.mjs before building v${ARCHIVE_STATS_VERSION} rollups`,
    );
  }
};
const normalize = (value) => typeof value === "string" && value.trim()
  ? value.trim().toLocaleLowerCase("en-US")
  : null;
// Public identity overrides must match the replay label exactly apart from
// Unicode normalization, surrounding whitespace, and case. In particular,
// punctuation and lookalike digits are not folded here.
const strictAlias = (value) => typeof value === "string" && value.trim()
  ? value.trim().normalize("NFKC").toLocaleLowerCase("en-US")
  : null;
const eventIdFor = (bundle) => bundle
  .replace(/\.(?:7z|zip)$/i, "")
  .replace(/-(?:main-stream|streams?|top-8|r2-offstream)$/i, "");

const privatePlayerIdentity = (player, eventId) => {
  if (player.connectCode) return `code:${player.connectCode.toUpperCase()}`;
  if (player.userIdHash) return `uid:${player.userIdHash}`;
  const display = normalize(player.displayName);
  if (display) return `display:${display}`;
  const tag = normalize(player.nametag);
  if (tag) return `event:${eventId}:tag:${tag}`;
  return null;
};

const rosterKeyFor = (record, eventId) => {
  const sides = record.players.map((player) => ({
    id: privatePlayerIdentity(player, eventId),
    teamId: player.teamId,
  }));
  if (sides.some((side) => !side.id)) return null;
  if (!record.isTeams) return sides.map((side) => side.id).sort().join(" vs ");
  const teams = new Map();
  for (const side of sides) {
    const team = String(side.teamId ?? "unknown");
    const members = teams.get(team) ?? [];
    members.push(side.id);
    teams.set(team, members);
  }
  return [...teams.values()].map((members) => members.sort().join("+")).sort().join(" vs ");
};

const stationKeyFor = (record) => {
  const directory = path.posix.dirname(record.file.replaceAll("\\", "/")).toLocaleLowerCase("en-US");
  return `${directory}|${normalize(record.consoleNick) ?? "unknown-console"}`;
};

const technicalExclusion = (record) => {
  if (!record.legalStage) return "illegal-stage";
  if (!record.playableRoster) return "invalid-roster";
  if (!record.isTeams && record.players.length !== 2) return "invalid-singles-format";
  if (record.isTeams) {
    if (record.players.length !== 4) return "invalid-doubles-format";
    const sizes = new Map();
    for (const player of record.players) {
      if (player.teamId === null || player.teamId === undefined) return "invalid-doubles-format";
      sizes.set(player.teamId, (sizes.get(player.teamId) ?? 0) + 1);
    }
    if (sizes.size !== 2 || [...sizes.values()].some((size) => size !== 2)) return "invalid-doubles-format";
  }
  return record.durationFrames < MIN_GAME_FRAMES ? "under-30-seconds" : null;
};

const hasWinner = (record) => record.isTeams ? record.winnerTeamId !== null : record.winnerIndex !== null;
const wonBy = (record, player, slot) => {
  if (!hasWinner(record)) return null;
  return record.isTeams ? record.winnerTeamId === player.teamId : record.winnerIndex === slot;
};

class NdjsonWriter {
  constructor(file) {
    this.file = file;
    this.stream = createWriteStream(file, { encoding: "utf8" });
    this.rows = 0;
  }

  async write(row) {
    if (!this.stream.write(`${JSON.stringify(row)}\n`)) await once(this.stream, "drain");
    this.rows++;
  }

  async close() {
    this.stream.end();
    await once(this.stream, "finish");
  }
}

const writeRows = async (file, rows) => {
  const writer = new NdjsonWriter(file);
  for (const row of rows) await writer.write(row);
  await writer.close();
  return writer.rows;
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const eventDoc = await readJson(args.events);
const seriesDoc = await readJson(args.series);
const identityDoc = await readJson(args.identities);
const curation = await readJson(args.curation);
const eventById = new Map(eventDoc.events.map((event) => [event.id, event]));
const seriesIdByEvent = new Map();
for (const series of seriesDoc.series) {
  for (const eventId of series.eventIds) {
    if (seriesIdByEvent.has(eventId)) throw new Error(`Event ${eventId} belongs to multiple series`);
    seriesIdByEvent.set(eventId, series.id);
  }
}
for (const event of eventDoc.events) {
  if (!seriesIdByEvent.has(event.id)) throw new Error(`Event ${event.id} has no series`);
}

const liquipedia = readDataset();
const latestRankingYear = Math.max(...liquipedia.editions.map((edition) => edition.year));
const rankedPlayers = new Map();
const rankings = [];
const aliases = new Map();
for (const edition of liquipedia.editions) {
  for (const entry of edition.entries) {
    if (entry.rank < 1 || entry.rank > 100) continue;
    const id = playerKey(entry.player);
    const displayName = canonicalDisplay(entry.player);
    const playerMeta = liquipedia.players[displayName] ?? liquipedia.players[entry.player] ?? {};
    const existing = rankedPlayers.get(id);
    rankedPlayers.set(id, {
      id,
      display_name: existing?.display_name ?? displayName,
      normalized_name: id,
      liquipedia_url: null,
      country_code: existing?.country_code ?? playerMeta.country ?? null,
      active: Boolean(existing?.active || edition.year === latestRankingYear),
      notes: "Current or historical Top 100 player from the bundled Liquipedia ranking snapshot.",
      published: false,
    });
    rankings.push({
      player_id: id,
      ranking_series: edition.title.startsWith("MPGR") ? "MPGR" : "SSBMRank",
      edition_label: edition.title,
      edition_year: edition.year,
      rank: entry.rank,
      source_url: edition.url,
      published: false,
    });
    const normalizedAlias = playerKey(entry.player);
    const aliasKey = `${id}|${normalizedAlias}`;
    if (!aliases.has(aliasKey)) {
      aliases.set(aliasKey, {
        player_id: id,
        alias: entry.player,
        normalized_alias: normalizedAlias,
        alias_kind: "liquipedia_name",
        source_url: edition.url,
        confidence: "verified",
        published: false,
      });
    }
  }
}

// A small number of explicitly requested players may have public regional
// rankings without a current or historical global Top 100 placement. Keep
// their provenance in the same checked-in identity document as their replay
// mappings, and label the ranking series in the UI so it cannot be mistaken
// for a world rank.
for (const player of identityDoc.players ?? []) {
  if (!player.id || !player.displayName || playerKey(player.displayName) !== player.id) {
    throw new Error(`Curated player needs a stable normalized id: ${player.displayName ?? player.id}`);
  }
  if (!player.sourceUrl) throw new Error(`Curated player needs a public source URL: ${player.id}`);
  if (rankedPlayers.has(player.id)) throw new Error(`Curated player already exists in ranking history: ${player.id}`);
  if (!Array.isArray(player.rankings) || player.rankings.length === 0) {
    throw new Error(`Curated player needs at least one public ranking: ${player.id}`);
  }
  rankedPlayers.set(player.id, {
    id: player.id,
    display_name: player.displayName,
    normalized_name: player.id,
    liquipedia_url: player.sourceUrl,
    country_code: player.countryCode ?? null,
    active: player.active ?? true,
    notes: player.notes ?? "Publicly ranked player with an evidence-backed archive identity mapping.",
    published: false,
  });
  const normalizedAlias = playerKey(player.displayName);
  aliases.set(`${player.id}|${normalizedAlias}`, {
    player_id: player.id,
    alias: player.displayName,
    normalized_alias: normalizedAlias,
    alias_kind: "liquipedia_name",
    source_url: player.sourceUrl,
    confidence: "verified",
    published: false,
  });
  for (const ranking of player.rankings) {
    if (!ranking.series || !ranking.editionLabel || !Number.isInteger(ranking.year)
      || !Number.isInteger(ranking.rank) || ranking.rank < 1 || !ranking.sourceUrl) {
      throw new Error(`Curated player has an invalid ranking: ${player.id}`);
    }
    rankings.push({
      player_id: player.id,
      ranking_series: ranking.series,
      edition_label: ranking.editionLabel,
      edition_year: ranking.year,
      rank: ranking.rank,
      source_url: ranking.sourceUrl,
      published: false,
    });
  }
}

const characterIdentityOverrides = new Map();
const aliasIdentityOverrides = new Map();
const gamePlayerIdentityOverrides = new Map();
// Most reviewed additions arrive as an event roster with one shared bracket
// source. Keep that evidence grouped in the checked-in file, then expand it to
// the same strict event+alias rules used by the resolver. A group is only a
// compact authoring format; it does not weaken the per-alias publication gate.
const identityOverrides = identityDoc.overrides.flatMap((override) => {
  if (override.kind === "event_aliases") {
    if (!Array.isArray(override.aliases) || override.aliases.length === 0) {
      throw new Error(`event_aliases override needs aliases for ${override.eventId}`);
    }
    return override.aliases.map((alias) => ({
      kind: "event_alias",
      eventId: override.eventId,
      observedAlias: alias.observedAlias,
      playerId: alias.playerId,
      resolution: override.resolution,
      sourceUrl: override.sourceUrl,
      notes: override.notes,
    }));
  }
  if (override.kind === "event_game_players") {
    if (!Array.isArray(override.games) || override.games.length === 0) {
      throw new Error(`event_game_players override needs games for ${override.eventId}`);
    }
    return override.games.map((game) => ({
      kind: "event_game_player",
      eventId: override.eventId,
      identitySha256: game.identitySha256,
      slot: game.slot,
      characterId: game.characterId,
      playerId: override.playerId,
      resolution: override.resolution,
      sourceUrl: override.sourceUrl,
      notes: override.notes,
    }));
  }
  return [override];
});
for (const override of identityOverrides) {
  if (!eventById.has(override.eventId)) throw new Error(`Identity override has unknown event ${override.eventId}`);
  if (!rankedPlayers.has(override.playerId)) throw new Error(`Identity override has unknown player ${override.playerId}`);
  if (!override.sourceUrl) throw new Error(`Identity override needs a public source URL for ${override.playerId}`);
  if (!['verified', 'probable'].includes(override.resolution)) {
    throw new Error(`Identity override has invalid resolution ${override.resolution}`);
  }
  if (override.kind === "event_character") {
    if (!VERIFIED_EVENTS.has(override.eventId)) {
      throw new Error(`event_character identity overrides are limited to explicitly verified two-player exhibitions: ${override.eventId}`);
    }
    const key = `${override.eventId}|${override.characterId}`;
    if (characterIdentityOverrides.has(key)) throw new Error(`Duplicate identity override ${key}`);
    characterIdentityOverrides.set(key, override);
    continue;
  }
  if (override.kind === "event_alias") {
    const alias = strictAlias(override.observedAlias);
    if (!alias) throw new Error(`event_alias override needs observedAlias for ${override.playerId}`);
    const key = `${override.eventId}|${alias}`;
    if (aliasIdentityOverrides.has(key)) throw new Error(`Duplicate identity override ${key}`);
    aliasIdentityOverrides.set(key, override);
    continue;
  }
  if (override.kind === "event_game_player") {
    if (!/^[a-f0-9]{64}$/.test(override.identitySha256)) {
      throw new Error(`event_game_player override needs an identitySha256 for ${override.playerId}`);
    }
    if (!Number.isInteger(override.slot) || override.slot < 0 || override.slot > 3) {
      throw new Error(`event_game_player override has an invalid slot for ${override.playerId}`);
    }
    if (!Number.isInteger(override.characterId)) {
      throw new Error(`event_game_player override needs a characterId for ${override.playerId}`);
    }
    const key = `${override.eventId}|${override.identitySha256}|${override.slot}`;
    if (gamePlayerIdentityOverrides.has(key)) throw new Error(`Duplicate identity override ${key}`);
    gamePlayerIdentityOverrides.set(key, override);
    continue;
  }
  throw new Error(`Unsupported identity override kind ${override.kind}`);
}

const resultFiles = (await readdir(args.results)).filter((name) => name.endsWith(".json")).sort();
const gamesByKey = new Map();
const candidateMappings = new Map();
let replayFiles = 0;
let parsedFiles = 0;
let failedFiles = 0;
let duplicateFiles = 0;

const candidateRankedIdentity = (player) => {
  for (const label of [player.displayName, player.nametag]) {
    if (!label) continue;
    const key = playerKey(label);
    if (rankedPlayers.has(key)) return { playerId: key, label };
  }
  return null;
};

const matchedGamePlayerOverrideKeys = new Set();
const approvedRankedIdentity = (player, eventId, rawGameKey, slot) => {
  const gameIdentitySha256 = hash(rawGameKey);
  const gamePlayerKey = `${eventId}|${gameIdentitySha256}|${slot}`;
  const gamePlayerOverride = gamePlayerIdentityOverrides.get(gamePlayerKey);
  if (gamePlayerOverride && player.characterId !== gamePlayerOverride.characterId) {
    throw new Error(`Character drift for exact identity override ${gamePlayerKey}`);
  }
  if (gamePlayerOverride) matchedGamePlayerOverrideKeys.add(gamePlayerKey);
  const aliasOverride = [player.displayName, player.nametag]
    .map(strictAlias)
    .filter(Boolean)
    .map((alias) => aliasIdentityOverrides.get(`${eventId}|${alias}`))
    .find(Boolean);
  const override = gamePlayerOverride ?? aliasOverride ?? characterIdentityOverrides.get(`${eventId}|${player.characterId}`);
  return override ? {
    playerId: override.playerId,
    resolution: override.resolution,
    sourceUrl: override.sourceUrl,
  } : null;
};

console.log(`Pass 1/2: indexing ${resultFiles.length} parsed bundles…`);
for (const [fileIndex, name] of resultFiles.entries()) {
  const payload = await readJson(path.join(args.results, name));
  const eventId = eventIdFor(payload.bundle);
  const event = eventById.get(eventId);
  if (!event) throw new Error(`No event registry row for ${eventId}`);
  replayFiles += payload.replayFiles;
  parsedFiles += payload.parsed;
  failedFiles += payload.failed;
  for (const record of payload.records) {
    if (!record.ok) continue;
    assertCurrentStats(record, payload.bundle);
    const key = record.identityKey ?? `${payload.bundle}/${record.file}`;
    const identitySha256 = hash(key);
    const exactIdentityEvidence = record.players.some((_player, slot) =>
      gamePlayerIdentityOverrides.has(`${eventId}|${identitySha256}|${slot}`));
    const broadcastEvidence = BROADCAST_BUNDLE.test(payload.bundle) || BRACKET_PATH.test(record.file);
    const explicitFriendly = FRIENDLY_PATH.test(record.file);
    const existing = gamesByKey.get(key);
    if (existing) {
      duplicateFiles++;
      existing.broadcastEvidence ||= broadcastEvidence;
      existing.exactIdentityEvidence ||= exactIdentityEvidence;
      existing.explicitFriendly &&= explicitFriendly;
      continue;
    }
    const meta = {
      key,
      eventId,
      bundle: payload.bundle,
      file: record.file,
      selectedRecord: `${payload.bundle}\0${record.file}`,
      stationKey: stationKeyFor(record),
      timeMs: record.playedAt ? Date.parse(record.playedAt) : Number.NaN,
      isTeams: record.isTeams,
      rosterKey: rosterKeyFor(record, eventId),
      technicalExclusion: technicalExclusion(record),
      broadcastEvidence,
      exactIdentityEvidence,
      explicitFriendly,
      hasTournamentSource: event.isTournament,
      tier: null,
      setId: null,
    };
    gamesByKey.set(key, meta);
    for (const player of record.players) {
      const candidate = candidateRankedIdentity(player);
      if (!candidate) continue;
      const candidateKey = `${eventId}|${candidate.playerId}`;
      const row = candidateMappings.get(candidateKey) ?? {
        eventId,
        playerId: candidate.playerId,
        publicDisplayName: rankedPlayers.get(candidate.playerId)?.display_name ?? candidate.playerId,
        observedLabels: new Set(),
        gameKeys: new Set(),
      };
      row.observedLabels.add(candidate.label);
      row.gameKeys.add(publicGameKey(key));
      candidateMappings.set(candidateKey, row);
    }
  }
  if ((fileIndex + 1) % 8 === 0 || fileIndex + 1 === resultFiles.length) {
    console.log(`  indexed ${fileIndex + 1}/${resultFiles.length} bundles`);
  }
}

const sequenceGroups = [];
const byStation = new Map();
for (const game of gamesByKey.values()) {
  if (game.technicalExclusion || !game.hasTournamentSource || game.explicitFriendly || !game.rosterKey) continue;
  const station = `${game.eventId}|${game.stationKey}`;
  const rows = byStation.get(station) ?? [];
  rows.push(game);
  byStation.set(station, rows);
}

for (const rows of byStation.values()) {
  rows.sort((a, b) => {
    if (Number.isFinite(a.timeMs) && Number.isFinite(b.timeMs) && a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return a.file.localeCompare(b.file);
  });
  let group = [];
  const flush = () => {
    if (group.length >= 2 && group.length <= MAX_SET_GAMES) sequenceGroups.push(group);
    group = [];
  };
  for (const game of rows) {
    const previous = group.at(-1);
    const comparableTimes = previous && Number.isFinite(previous.timeMs) && Number.isFinite(game.timeMs);
    const withinGap = comparableTimes
      ? game.timeMs >= previous.timeMs && game.timeMs - previous.timeMs <= SET_GAP_MS
      : true;
    if (previous && (previous.rosterKey !== game.rosterKey || !withinGap)) flush();
    group.push(game);
  }
  flush();
}

const sets = new Map();
for (const group of sequenceGroups) {
  const first = group[0];
  const id = publicSetId(first.eventId, `${first.stationKey}|${first.rosterKey}|${first.key}`);
  const set = {
    id,
    tournament_id: tournamentId(first.eventId),
    format: first.isTeams ? "doubles" : "singles",
    round_label: null,
    best_of: null,
    set_order: null,
    resolution: "probable",
    resolution_source_url: eventById.get(first.eventId)?.sourceUrl ?? SOURCE_URL,
    completed: true,
    published: false,
    members: group,
  };
  sets.set(id, set);
  for (const game of group) game.setId = id;
}

const manualMatchGames = [...gamesByKey.values()]
  .filter((game) => game.eventId === "the-match-zain-vs-cody" && !game.technicalExclusion)
  .sort((a, b) => a.timeMs - b.timeMs);
if (manualMatchGames.length) {
  const id = `${DATASET_ID}:the-match-zain-vs-cody:main`;
  sets.set(id, {
    id,
    tournament_id: tournamentId("the-match-zain-vs-cody"),
    format: "singles",
    round_label: "First to 10",
    best_of: null,
    set_order: 0,
    resolution: "verified",
    resolution_source_url: eventById.get("the-match-zain-vs-cody")?.sourceUrl ?? SOURCE_URL,
    completed: true,
    published: false,
    members: manualMatchGames,
  });
  for (const game of manualMatchGames) game.setId = id;
}

const baseBuckets = { verifiedBracket: 0, probableBracket: 0, unclassifiedVenue: 0, excludedOrIncomplete: 0 };
const buckets = { verifiedBracket: 0, probableBracket: 0, unclassifiedVenue: 0, excludedOrIncomplete: 0 };
let identityPromotedGames = 0;
for (const game of gamesByKey.values()) {
  if (game.technicalExclusion || !game.hasTournamentSource || game.explicitFriendly) {
    game.baseTier = "excluded";
    baseBuckets.excludedOrIncomplete++;
  } else if (VERIFIED_EVENTS.has(game.eventId)) {
    game.baseTier = "verified";
    baseBuckets.verifiedBracket++;
  } else if (game.broadcastEvidence || game.setId) {
    game.baseTier = "probable";
    baseBuckets.probableBracket++;
  } else {
    game.baseTier = "unclassified";
    baseBuckets.unclassifiedVenue++;
  }
  game.tier = game.baseTier;
  if (game.baseTier === "unclassified" && game.exactIdentityEvidence) {
    game.tier = "probable";
    identityPromotedGames++;
  }
  if (game.tier === "excluded") buckets.excludedOrIncomplete++;
  else if (game.tier === "verified") buckets.verifiedBracket++;
  else if (game.tier === "probable") buckets.probableBracket++;
  else {
    buckets.unclassifiedVenue++;
  }
}

const expectedBuckets = curation.uniqueGameBuckets;
for (const [key, expected] of Object.entries(expectedBuckets)) {
  if (baseBuckets[key] !== expected) throw new Error(`Curation drift for ${key}: export=${baseBuckets[key]} report=${expected}`);
}
if (replayFiles !== curation.replayFiles || parsedFiles !== curation.parsedFiles || failedFiles !== curation.failedFiles) {
  throw new Error("Replay-file totals drifted from archive-curation.json");
}
if (duplicateFiles !== curation.duplicateFiles || gamesByKey.size !== curation.uniqueGames) {
  throw new Error("Deduplication totals drifted from archive-curation.json");
}

const resolveRankedIdentity = (player, eventId, rawGameKey, slot) => {
  return approvedRankedIdentity(player, eventId, rawGameKey, slot);
};

const emptyMetrics = () => ({
  durationFrames: 0,
  damageTotal: 0,
  neutralWins: 0,
  openingsPerKillSum: 0,
  openingsPerKillSamples: 0,
  damagePerOpeningSum: 0,
  damagePerOpeningSamples: 0,
  inputsPerMinuteSum: 0,
  inputsPerMinuteSamples: 0,
  lCancelSuccess: 0,
  lCancelFail: 0,
  techInPlace: 0,
  techToward: 0,
  techAway: 0,
  techMissed: 0,
  wallTechSuccess: 0,
  wallTechMissed: 0,
  actions: {
    rolls: 0,
    airDodges: 0,
    spotDodges: 0,
    wavedashes: 0,
    wavelands: 0,
    dashDances: 0,
    ledgeGrabs: 0,
    crouchCancels: 0,
    grabs: 0,
  },
  playerBalanced: null,
  moves: null,
});

const rollups = new Map();
const rollupDimensions = (scope, population, extras, characterId, opponentCharacterId, stageId) => ({
  scope,
  population,
  series_id: extras.seriesId ?? null,
  tournament_id: extras.tournamentId ?? null,
  set_id: extras.setId ?? null,
  player_id: extras.playerId ?? null,
  format: extras.format,
  character_id: characterId,
  opponent_character_id: opponentCharacterId,
  stage_id: stageId,
});

const addRollup = (dimensions, record, player, slot, includeMoves) => {
  const signature = JSON.stringify(dimensions);
  const rollupKey = `r:${hash(`${DATASET_ID}:${signature}`)}`;
  let row = rollups.get(rollupKey);
  if (!row) {
    row = {
      rollup_key: rollupKey,
      dataset_id: DATASET_ID,
      ...dimensions,
      game_count: 0,
      win_rate_game_count: 0,
      wins: 0,
      identified_player_count: dimensions.player_id ? 1 : null,
      player_balanced_sample_count: null,
      metrics: emptyMetrics(),
      stats_version: ARCHIVE_STATS_VERSION,
      published: false,
    };
    rollups.set(rollupKey, row);
  }
  row.game_count++;
  const won = wonBy(record, player, slot);
  if (won !== null) {
    row.win_rate_game_count++;
    if (won) row.wins++;
  }
  const metrics = row.metrics;
  metrics.durationFrames += record.durationFrames;
  metrics.damageTotal += player.totalDamage ?? 0;
  metrics.neutralWins += player.neutralWins ?? 0;
  if (Number.isFinite(player.openingsPerKill)) {
    metrics.openingsPerKillSum += player.openingsPerKill;
    metrics.openingsPerKillSamples++;
  }
  if (Number.isFinite(player.damagePerOpening)) {
    metrics.damagePerOpeningSum += player.damagePerOpening;
    metrics.damagePerOpeningSamples++;
  }
  if (Number.isFinite(player.inputsPerMinute)) {
    metrics.inputsPerMinuteSum += player.inputsPerMinute;
    metrics.inputsPerMinuteSamples++;
  }
  metrics.lCancelSuccess += player.lCancelSuccess ?? 0;
  metrics.lCancelFail += player.lCancelFail ?? 0;
  const techs = player.techs ?? {};
  metrics.techInPlace += techs.inPlace ?? 0;
  metrics.techToward += techs.toward ?? 0;
  metrics.techAway += techs.away ?? 0;
  metrics.techMissed += techs.missed ?? 0;
  metrics.wallTechSuccess += techs.wallSuccess ?? 0;
  metrics.wallTechMissed += techs.wallMissed ?? 0;
  for (const action of Object.keys(metrics.actions)) {
    metrics.actions[action] += player.actions?.[action] ?? 0;
  }
  if (!includeMoves) return;
  metrics.moves ??= {};
  for (const [moveId, move] of Object.entries(player.moveStats ?? {})) {
    const target = metrics.moves[moveId] ?? {
      attempts: 0, landed: 0, damage: 0, kills: 0, killPctSum: 0,
      openings: 0, openingDmg: 0, lCancelSuccess: 0, lCancelFail: 0,
    };
    target.attempts += move.attempts ?? 0;
    target.landed += move.landed ?? 0;
    target.damage += move.damage ?? 0;
    target.kills += move.kills ?? 0;
    target.killPctSum += move.killPctSum ?? 0;
    target.openings += move.openings ?? 0;
    target.openingDmg += move.openingDmg ?? 0;
    target.lCancelSuccess += move.lcSuccess ?? 0;
    target.lCancelFail += move.lcFail ?? 0;
    metrics.moves[moveId] = target;
  }
};

const addScopeRows = (scope, population, extras, record, player, opponent, slot) => {
  addRollup(rollupDimensions(scope, population, extras, null, null, null), record, player, slot, false);
  addRollup(rollupDimensions(scope, population, extras, player.characterId, null, null), record, player, slot, true);
  addRollup(rollupDimensions(scope, population, extras, player.characterId, null, record.stageId), record, player, slot, false);
  if (!record.isTeams && opponent) {
    // Execution comparisons need move usage for the exact character matchup.
    // Keep stage-specific rows compact; Execution's archive references span all stages.
    addRollup(rollupDimensions(scope, population, extras, player.characterId, opponent.characterId, null), record, player, slot, true);
    addRollup(rollupDimensions(scope, population, extras, player.characterId, opponent.characterId, record.stageId), record, player, slot, false);
  }
};

const outputTarget = path.resolve(args.output);
await mkdir(path.dirname(outputTarget), { recursive: true });
const buildOutput = await mkdtemp(path.join(path.dirname(outputTarget), `.${path.basename(outputTarget)}.build-`));
args.output = buildOutput;
const gameWriter = new NdjsonWriter(path.join(args.output, "archive_games.ndjson"));
const gamePlayerWriter = new NdjsonWriter(path.join(args.output, "archive_game_players.ndjson"));
const usedSets = new Set();
const setPlayerAcc = new Map();
const playerBalanceGroups = new Map();
const mappedPlayerIds = new Set();
let mappedGames = 0;
let mappedPlayerSlots = 0;
let selectedParsedGames = 0;
let omittedAmbiguousTimestamps = 0;

console.log(`Pass 2/2: deriving public rows and rollups…`);
for (const [fileIndex, name] of resultFiles.entries()) {
  const payload = await readJson(path.join(args.results, name));
  const eventId = eventIdFor(payload.bundle);
  const seriesId = seriesIdByEvent.get(eventId);
  for (const record of payload.records) {
    if (!record.ok) continue;
    const rawKey = record.identityKey ?? `${payload.bundle}/${record.file}`;
    const game = gamesByKey.get(rawKey);
    if (!game || game.selectedRecord !== `${payload.bundle}\0${record.file}` || game.tier === "excluded") continue;
    selectedParsedGames++;
    const format = record.isTeams ? "doubles" : "singles";
    const identities = record.players.map((player, slot) => resolveRankedIdentity(player, eventId, rawKey, slot));
    const conservative = game.tier === "verified" || game.tier === "probable";
    for (const [slot, player] of record.players.entries()) {
      const opponent = !record.isTeams && record.players.length === 2 ? record.players[slot === 0 ? 1 : 0] : null;
      for (const population of conservative ? ["broad", "conservative"] : ["broad"]) {
        addScopeRows("community", population, { format }, record, player, opponent, slot);
        addScopeRows("series", population, { format, seriesId }, record, player, opponent, slot);
        addScopeRows("tournament", population, { format, seriesId, tournamentId: tournamentId(eventId) }, record, player, opponent, slot);
      }
      const identity = identities[slot];
      if (conservative) {
        const privateIdentity = privatePlayerIdentity(player, eventId);
        if (privateIdentity) {
          const balanceKey = `${format}|${privateIdentity}|${player.characterId}`;
          const balance = playerBalanceGroups.get(balanceKey) ?? {
            format,
            characterId: player.characterId,
            games: 0,
            lCancelSuccess: 0,
            lCancelFail: 0,
            techSuccess: 0,
            techMissed: 0,
          };
          balance.games++;
          balance.lCancelSuccess += player.lCancelSuccess ?? 0;
          balance.lCancelFail += player.lCancelFail ?? 0;
          const techs = player.techs ?? {};
          balance.techSuccess += (techs.inPlace ?? 0) + (techs.toward ?? 0) + (techs.away ?? 0) + (techs.wallSuccess ?? 0);
          balance.techMissed += (techs.missed ?? 0) + (techs.wallMissed ?? 0);
          playerBalanceGroups.set(balanceKey, balance);
        }
      }
      if (identity && conservative) {
        mappedPlayerSlots++;
        mappedPlayerIds.add(identity.playerId);
        addScopeRows("player", "conservative", { format, playerId: identity.playerId }, record, player, opponent, slot);
        addScopeRows("player", "conservative", { format, playerId: identity.playerId, seriesId }, record, player, opponent, slot);
        addScopeRows("player", "conservative", { format, playerId: identity.playerId, seriesId, tournamentId: tournamentId(eventId) }, record, player, opponent, slot);
      }
    }

    if (!conservative || identities.every((identity) => !identity)) continue;
    mappedGames++;
    const gameKey = publicGameKey(rawKey);
    if (game.setId) usedSets.add(game.setId);
    const playedAt = typeof record.playedAt === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(record.playedAt)
      ? record.playedAt
      : null;
    if (record.playedAt && !playedAt) omittedAmbiguousTimestamps++;
    await gameWriter.write({
      game_key: gameKey,
      dataset_id: DATASET_ID,
      tournament_id: tournamentId(eventId),
      set_id: game.setId,
      sequence_in_set: game.setId ? (sets.get(game.setId)?.members.indexOf(game) ?? -1) + 1 : null,
      played_at: playedAt,
      stage_id: record.stageId,
      duration_frames: record.durationFrames,
      format,
      winner_slot: record.isTeams ? null : record.winnerIndex,
      winner_team_id: record.isTeams ? record.winnerTeamId : null,
      curation_tier: game.tier,
      stats_version: record.statsVersion,
      published: false,
    });
    for (const [slot, player] of record.players.entries()) {
      const identity = identities[slot];
      await gamePlayerWriter.write({
        game_key: gameKey,
        slot,
        team_id: player.teamId ?? null,
        player_id: identity?.playerId ?? null,
        identity_resolution: identity?.resolution ?? null,
        identity_source_url: identity?.sourceUrl ?? null,
        character_id: player.characterId,
        won: wonBy(record, player, slot),
        stocks_taken: player.kills ?? null,
        damage_total: player.totalDamage ?? null,
        neutral_wins: player.neutralWins ?? null,
        openings_per_kill: player.openingsPerKill ?? null,
        damage_per_opening: player.damagePerOpening ?? null,
        inputs_per_minute: player.inputsPerMinute ?? null,
        l_cancel_success: player.lCancelSuccess ?? 0,
        l_cancel_fail: player.lCancelFail ?? 0,
        tech_in_place: player.techs?.inPlace ?? 0,
        tech_toward: player.techs?.toward ?? 0,
        tech_away: player.techs?.away ?? 0,
        tech_missed: player.techs?.missed ?? 0,
        wall_tech_success: player.techs?.wallSuccess ?? 0,
        wall_tech_missed: player.techs?.wallMissed ?? 0,
        action_counts: player.actions ?? {},
        move_stats: player.moveStats ?? {},
        published: false,
      });
      if (!game.setId || !identity) continue;
      const key = `${game.setId}|${identity.playerId}`;
      const acc = setPlayerAcc.get(key) ?? {
        set_id: game.setId,
        player_id: identity.playerId,
        display_name: rankedPlayers.get(identity.playerId)?.display_name ?? identity.playerId,
        slot,
        team_id: player.teamId ?? null,
        gameWins: 0,
        published: false,
      };
      if (wonBy(record, player, slot)) acc.gameWins++;
      setPlayerAcc.set(key, acc);
    }
  }
  if ((fileIndex + 1) % 8 === 0 || fileIndex + 1 === resultFiles.length) {
    console.log(`  derived ${fileIndex + 1}/${resultFiles.length} bundles`);
  }
}
await gameWriter.close();
await gamePlayerWriter.close();
if (matchedGamePlayerOverrideKeys.size !== gamePlayerIdentityOverrides.size) {
  const missing = [...gamePlayerIdentityOverrides.keys()].filter((key) => !matchedGamePlayerOverrideKeys.has(key));
  throw new Error(`Exact identity overrides did not match selected games: ${missing.join(", ")}`);
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};
const summarizeRates = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    qualifiedPlayers: sorted.length,
    equalWeightMean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
  };
};
const balancedByCohort = new Map();
for (const group of playerBalanceGroups.values()) {
  if (group.games < 10) continue;
  const key = `${group.format}|${group.characterId}`;
  const cohort = balancedByCohort.get(key) ?? { lCancelRates: [], techRates: [] };
  const lCancelAttempts = group.lCancelSuccess + group.lCancelFail;
  const techAttempts = group.techSuccess + group.techMissed;
  if (lCancelAttempts >= 50) cohort.lCancelRates.push(group.lCancelSuccess / lCancelAttempts);
  if (techAttempts >= 20) cohort.techRates.push(group.techSuccess / techAttempts);
  balancedByCohort.set(key, cohort);
}
for (const row of rollups.values()) {
  if (
    row.scope !== "community" || row.population !== "conservative"
    || row.character_id === null || row.opponent_character_id !== null || row.stage_id !== null
  ) continue;
  const cohort = balancedByCohort.get(`${row.format}|${row.character_id}`);
  if (!cohort) continue;
  const lCancel = summarizeRates(cohort.lCancelRates);
  const techSuccess = summarizeRates(cohort.techRates);
  row.metrics.playerBalanced = { lCancel, techSuccess };
  row.player_balanced_sample_count = Math.max(lCancel.qualifiedPlayers, techSuccess.qualifiedPlayers);
}

for (const row of rollups.values()) {
  const metrics = row.metrics;
  metrics.damageTotal = Number(metrics.damageTotal.toFixed(3));
  metrics.openingsPerKillSum = Number(metrics.openingsPerKillSum.toFixed(6));
  metrics.damagePerOpeningSum = Number(metrics.damagePerOpeningSum.toFixed(6));
  metrics.inputsPerMinuteSum = Number(metrics.inputsPerMinuteSum.toFixed(6));
  if (metrics.moves) {
    for (const move of Object.values(metrics.moves)) {
      move.damage = Number(move.damage.toFixed(3));
      move.killPctSum = Number(move.killPctSum.toFixed(3));
      move.openingDmg = Number(move.openingDmg.toFixed(3));
    }
  }
}

const downloadFiles = await readdir(args.downloads);
const compressedByBundle = new Map();
for (const name of downloadFiles) compressedByBundle.set(name, (await stat(path.join(args.downloads, name))).size);
const totalCompressedBytes = [...compressedByBundle.values()].reduce((sum, bytes) => sum + bytes, 0);
const curationBundleByName = new Map(curation.bundles.map((bundle) => [bundle.bundle, bundle]));
const bundleRows = resultFiles.map((name) => {
  const bundle = curationBundleByName.get(name.replace(/\.json$/, ".7z"))
    ?? curationBundleByName.get(name.replace(/\.json$/, ".zip"))
    ?? [...curationBundleByName.values()].find((row) => `${row.bundle.replace(/\.(7z|zip)$/i, "")}.json` === name);
  if (!bundle) throw new Error(`No curation bundle row for ${name}`);
  const compressedBytes = compressedByBundle.get(bundle.bundle);
  if (compressedBytes === undefined) throw new Error(`No compressed file for ${bundle.bundle}`);
  return {
    id: `${DATASET_ID}:${bundle.bundle.replace(/\.(?:7z|zip)$/i, "")}`,
    dataset_id: DATASET_ID,
    tournament_id: tournamentId(bundle.eventId),
    public_source_url: SOURCE_URL,
    compressed_bytes: compressedBytes,
    replay_file_count: bundle.replayFiles,
    parsed_replay_count: bundle.parsed,
    failed_replay_count: bundle.failed,
    duplicate_replay_count: bundle.duplicateCopies,
    published: false,
  };
});

const tournamentRows = eventDoc.events.map((event) => ({
  id: tournamentId(event.id),
  dataset_id: DATASET_ID,
  event_key: event.id,
  series_id: seriesIdByEvent.get(event.id),
  canonical_name: event.name,
  year: event.year,
  start_date: null,
  end_date: null,
  location: null,
  online: null,
  is_tournament: event.isTournament,
  event_source_url: event.sourceUrl,
  event_source_label: event.sourceLabel,
  source_confidence: event.sourceConfidence,
  notes: event.sourceConfidence === "unverified" ? "Year comes from the archive label and replay metadata; external source pending." : null,
  published: false,
}));

const seriesRows = seriesDoc.series.map((series) => ({
  id: series.id,
  canonical_name: series.name,
  source_url: series.sourceUrl ?? null,
  notes: series.eventIds.length > 1 ? `${series.eventIds.length} archive editions.` : "One archive event.",
  published: false,
}));

const usedSetRows = [...usedSets].map((id) => {
  const { members: _members, ...row } = sets.get(id);
  return row;
});
const setPlayerRows = [];
const bySet = new Map();
for (const row of setPlayerAcc.values()) {
  if (!usedSets.has(row.set_id)) continue;
  const list = bySet.get(row.set_id) ?? [];
  list.push(row);
  bySet.set(row.set_id, list);
}
for (const rows of bySet.values()) {
  rows.sort((a, b) => a.player_id.localeCompare(b.player_id));
  const maxWins = Math.max(...rows.map((row) => row.gameWins));
  const uniqueWinner = rows.filter((row) => row.gameWins === maxWins).length === 1;
  for (const [slot, row] of rows.entries()) {
    const { gameWins, ...output } = row;
    setPlayerRows.push({ ...output, slot, winner: rows.length >= 2 && uniqueWinner ? gameWins === maxWins : null });
  }
}

const datasetRow = {
  id: DATASET_ID,
  label: "Nikki's Slippi Dumps — derived tournament statistics",
  source_url: SOURCE_URL,
  source_label: "Nikki's Slippi Dumps",
  license_url: null,
  compressed_bytes: totalCompressedBytes,
  archive_count: bundleRows.length,
  replay_file_count: replayFiles,
  parsed_replay_count: parsedFiles,
  unique_game_count: gamesByKey.size,
  broad_game_count: buckets.verifiedBracket + buckets.probableBracket + buckets.unclassifiedVenue,
  conservative_game_count: buckets.verifiedBracket + buckets.probableBracket,
  parser_version: "@slippi/slippi-js 9.1.2",
  curation_version: "nikki-curation-v1",
  data_as_of: args.dataAsOf,
  import_counts: {},
  content_sha256: null,
  notes: "Raw replays, paths, filenames, unresolved tags, connect codes, and private user identifiers are excluded. Broad games feed Community aggregates; conservative games feed Tournament aggregates.",
  published: false,
  published_at: null,
};

// A row that is too sparse to display honestly is also too sparse to store.
// Whole-scope and character rows are always retained for accounting. The more
// specific cells use the same minimums the UI uses for faded/hidden estimates.
const shouldExportRollup = (row) => {
  const hasOpponent = row.opponent_character_id !== null;
  const hasStage = row.stage_id !== null;
  if (!hasOpponent && !hasStage) return true;
  if (row.scope === "community") return row.game_count >= 25;
  if (row.scope === "player") return row.game_count >= (hasOpponent && hasStage ? 5 : 3);
  return row.game_count >= (hasOpponent && hasStage ? 10 : 5);
};
const exportedRollups = [...rollups.values()].filter(shouldExportRollup);

const tableCounts = {
  archive_datasets: 1,
  archive_tournament_series: seriesRows.length,
  archive_tournaments: tournamentRows.length,
  archive_bundles: bundleRows.length,
  archive_players: rankedPlayers.size,
  archive_player_aliases: aliases.size,
  archive_player_rankings: rankings.length,
  archive_sets: usedSetRows.length,
  archive_set_players: setPlayerRows.length,
  archive_games: gameWriter.rows,
  archive_game_players: gamePlayerWriter.rows,
  archive_rollups: exportedRollups.length,
};
datasetRow.import_counts = tableCounts;
const writeAndCheck = async (table, rows) => {
  const count = await writeRows(path.join(args.output, `${table}.ndjson`), rows);
  if (count !== tableCounts[table]) throw new Error(`${table}: wrote ${count}, expected ${tableCounts[table]}`);
};
await writeAndCheck("archive_tournament_series", seriesRows);
await writeAndCheck("archive_tournaments", tournamentRows);
await writeAndCheck("archive_bundles", bundleRows);
await writeAndCheck("archive_players", [...rankedPlayers.values()]);
await writeAndCheck("archive_player_aliases", [...aliases.values()]);
await writeAndCheck("archive_player_rankings", rankings);
await writeAndCheck("archive_sets", usedSetRows);
await writeAndCheck("archive_set_players", setPlayerRows);
await writeAndCheck("archive_rollups", exportedRollups);

// Bind forecasts and staged imports to this exact export, not merely its
// date-based dataset id or row counts. The digest covers stable dataset metadata
// plus every derived table payload except the dataset row that stores the digest.
const contentSha256 = await computeArchiveContentSha256({ dir: args.output, datasetRow });
datasetRow.content_sha256 = contentSha256;
await writeAndCheck("archive_datasets", [datasetRow]);

const outputFiles = (await readdir(args.output)).filter((name) => name.endsWith(".ndjson")).sort();
const outputBytes = {};
for (const name of outputFiles) outputBytes[name] = (await stat(path.join(args.output, name))).size;
const forbidden = /"(?:file|path|connectCode|userIdHash|nametag|displayName)"\s*:/;
for (const name of outputFiles) {
  const contents = await readFile(path.join(args.output, name), "utf8");
  if (forbidden.test(contents)) throw new Error(`Privacy QA failed: forbidden field in ${name}`);
}

const qa = {
  schemaVersion: 1,
  datasetId: DATASET_ID,
  contentSha256,
  generatedAt: new Date().toISOString(),
  source: SOURCE_URL,
  input: {
    compressedBytes: totalCompressedBytes,
    bundles: bundleRows.length,
    replayFiles,
    parsedFiles,
    failedFiles,
    duplicateFiles,
    uniqueGames: gamesByKey.size,
    curationBuckets: baseBuckets,
    publishedBuckets: buckets,
    identityPromotedGames,
  },
  privacy: {
    rawReplayBytesExported: false,
    pathsOrFilenamesExported: false,
    connectCodesExported: false,
    privateUserIdsExported: false,
    unresolvedTagsExported: false,
    anonymousGamesAreAggregateOnly: true,
  },
  identity: {
    eligibleRankedPlayers: rankedPlayers.size,
    mappedPlayersWithGames: mappedPlayerIds.size,
    mappedGames,
    mappedPlayerSlots,
    approvedOverrides: characterIdentityOverrides.size + aliasIdentityOverrides.size + gamePlayerIdentityOverrides.size,
    unresolvedCandidateEventPlayers: candidateMappings.size,
    method: "Only explicit, publicly sourced overrides are published. Exact replay-tag matches are written to a local candidate report for bracket verification and never enter public rows automatically. Bracket-verified anonymous stream games use a SHA-256 identity fingerprint plus player slot and expected character.",
  },
  timestamps: {
    omittedWithoutExplicitTimezone: omittedAmbiguousTimestamps,
  },
  playerBalanced: {
    privateIdentityGroupsConsidered: playerBalanceGroups.size,
    publishedCohorts: balancedByCohort.size,
    minimumGamesPerIdentityCharacter: 10,
    minimumLCancelAttempts: 50,
    minimumTechAttempts: 20,
    privateIdentifiersExported: false,
  },
  rollups: {
    computed: rollups.size,
    exported: exportedRollups.length,
    omittedSparse: rollups.size - exportedRollups.length,
    minimums: {
      communitySpecificCell: 25,
      seriesOrTournamentSingleDimension: 5,
      seriesOrTournamentMatchupStage: 10,
      playerSingleDimension: 3,
      playerMatchupStage: 5,
    },
  },
  tableCounts,
  outputBytes,
};
await writeFile(path.join(args.output, "qa.json"), `${JSON.stringify(qa, null, 2)}\n`);
await writeFile(path.join(args.output, "identity-candidates.local.json"), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: qa.generatedAt,
  warning: "Local review queue only. A candidate is not a verified player identity and must not be uploaded.",
  candidates: [...candidateMappings.values()].map((row) => ({
    eventId: row.eventId,
    playerId: row.playerId,
    publicDisplayName: row.publicDisplayName,
    observedLabels: [...row.observedLabels].sort(),
    candidateGameCount: row.gameKeys.size,
    candidateGameKeys: [...row.gameKeys].sort(),
  })).sort((a, b) => b.candidateGameCount - a.candidateGameCount || a.eventId.localeCompare(b.eventId) || a.playerId.localeCompare(b.playerId)),
}, null, 2)}\n`);
await writeFile(path.join(args.output, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  datasetId: DATASET_ID,
  contentSha256,
  generatedAt: qa.generatedAt,
  loadOrder: [
    "archive_datasets", "archive_tournament_series", "archive_tournaments", "archive_bundles",
    "archive_players", "archive_player_aliases", "archive_player_rankings", "archive_sets",
    "archive_set_players", "archive_games", "archive_game_players", "archive_rollups",
  ],
  tableCounts,
}, null, 2)}\n`);

// The complete export becomes visible only after every table, QA report, and
// manifest has been written. A failed build therefore leaves the prior export
// intact instead of exposing a mixed or truncated dataset to validators/loaders.
const previousOutput = `${outputTarget}.previous-${process.pid}-${Date.now()}`;
let movedPrevious = false;
try {
  try {
    await rename(outputTarget, previousOutput);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(buildOutput, outputTarget);
  if (movedPrevious) await rm(previousOutput, { recursive: true, force: true });
} catch (error) {
  if (movedPrevious) {
    try {
      await rename(previousOutput, outputTarget);
    } catch {
      // Preserve both directories for manual recovery if the swap itself fails.
    }
  }
  throw error;
}

console.log(JSON.stringify(qa, null, 2));
