/** Independent recovery QA reference: no builder, curator, or production identity resolver imports. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { displayName, playerKey } from "./liquipedia-parse.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
export const recoveryGameKey = (datasetId, key) => digest(`nikki-public-game-v1:${datasetId}:${key}`);
export const recoveryTournamentId = (datasetId, eventId) => `${datasetId}:${eventId}`;
const exhibition = "the-match-zain-vs-cody";
const sourceUrl = "https://replays.nikki.sh/";
const normal = value => typeof value === "string" && value.trim() ? value.trim().toLocaleLowerCase("en-US") : null;
const strict = value => typeof value === "string" && value.trim() ? value.trim().normalize("NFKC").toLocaleLowerCase("en-US") : null;
const buckets = () => ({ verifiedBracket: 0, probableBracket: 0, unclassifiedVenue: 0, excludedOrIncomplete: 0 });
const bucketFor = tier => ({ verified: "verifiedBracket", probable: "probableBracket", unclassified: "unclassifiedVenue", excluded: "excludedOrIncomplete" })[tier];
const eventFor = name => name.replace(/\.(?:7z|zip)$/i, "").replace(/-(?:main-stream|streams?|top-8|r2-offstream)$/i, "");
const rawKeyFor = (bundle, record) => record.identityKey ?? `${bundle}/${record.file}`;

export function recoveryPrivateIdentity(player, eventId) {
  if (player.connectCode) return `code:${player.connectCode.toUpperCase()}`;
  if (player.userIdHash) return `uid:${player.userIdHash}`;
  if (normal(player.displayName)) return `display:${normal(player.displayName)}`;
  if (normal(player.nametag)) return `event:${eventId}:tag:${normal(player.nametag)}`;
  return null;
}

function rosterAndTechnical(record, eventId) {
  const identities = record.players.map(player => recoveryPrivateIdentity(player, eventId));
  const teams = new Map();
  for (const [slot, side] of record.players.entries()) {
    const team = side.teamId == null ? "unknown" : String(side.teamId);
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(identities[slot]);
  }
  const roster = identities.some(value => value === null) ? null : record.isTeams
    ? [...teams.values()].map(team => [...team].sort().join("+")).sort().join(" vs ")
    : [...identities].sort().join(" vs ");
  let technicalExclusion = null;
  if (!record.legalStage) technicalExclusion = "illegal-stage";
  else if (!record.playableRoster) technicalExclusion = "invalid-roster";
  else if (!record.isTeams && record.players.length !== 2) technicalExclusion = "invalid-singles-format";
  else if (record.isTeams && (record.players.length !== 4 || teams.has("unknown") || teams.size !== 2 || [...teams.values()].some(team => team.length !== 2))) technicalExclusion = "invalid-doubles-format";
  else if (record.durationFrames < 1800) technicalExclusion = "under-30-seconds";
  return { roster, technicalExclusion };
}

function rankingTables(data, identityDocument) {
  assert.ok(Array.isArray(data?.editions), "Ranking evidence must contain editions");
  const latestYear = Math.max(...data.editions.map(edition => edition.year));
  const players = new Map(), aliases = new Map(), rankings = [];
  for (const edition of data.editions) for (const entry of edition.entries) {
    if (entry.rank < 1 || entry.rank > 100) continue;
    const id = playerKey(entry.player), canonical = displayName(entry.player);
    const metadata = data.players?.[canonical] ?? data.players?.[entry.player] ?? {};
    const old = players.get(id);
    players.set(id, { id, display_name: old?.display_name ?? canonical, normalized_name: id, liquipedia_url: null,
      country_code: old?.country_code ?? metadata.country ?? null, active: Boolean(old?.active || edition.year === latestYear),
      notes: "Current or historical Top 100 player from the bundled Liquipedia ranking snapshot.", published: false });
    rankings.push({ player_id: id, ranking_series: edition.title.startsWith("MPGR") ? "MPGR" : "SSBMRank",
      edition_label: edition.title, edition_year: edition.year, rank: entry.rank, source_url: edition.url, published: false });
    const aliasKey = `${id}|${playerKey(entry.player)}`;
    if (!aliases.has(aliasKey)) aliases.set(aliasKey, { player_id: id, alias: entry.player, normalized_alias: playerKey(entry.player),
      alias_kind: "liquipedia_name", source_url: edition.url, confidence: "verified", published: false });
  }
  for (const player of identityDocument.players ?? []) {
    assert.ok(player.id && player.displayName && playerKey(player.displayName) === player.id && player.sourceUrl, "Invalid publicly sourced regional player");
    assert.ok(!players.has(player.id), "Regional player already has global ranking evidence");
    assert.ok(Array.isArray(player.rankings) && player.rankings.length, "Regional player lacks public ranking evidence");
    players.set(player.id, { id: player.id, display_name: player.displayName, normalized_name: player.id,
      liquipedia_url: player.sourceUrl, country_code: player.countryCode ?? null, active: player.active ?? true,
      notes: player.notes ?? "Publicly ranked player with an evidence-backed archive identity mapping.", published: false });
    aliases.set(`${player.id}|${playerKey(player.displayName)}`, { player_id: player.id, alias: player.displayName,
      normalized_alias: playerKey(player.displayName), alias_kind: "liquipedia_name", source_url: player.sourceUrl, confidence: "verified", published: false });
    for (const ranking of player.rankings) {
      assert.ok(ranking.series && ranking.editionLabel && Number.isInteger(ranking.year) && Number.isInteger(ranking.rank)
        && ranking.rank >= 1 && ranking.sourceUrl, "Invalid regional ranking evidence");
      rankings.push({ player_id: player.id, ranking_series: ranking.series, edition_label: ranking.editionLabel,
        edition_year: ranking.year, rank: ranking.rank, source_url: ranking.sourceUrl, published: false });
    }
  }
  return { rankedPlayers: players, rankings, aliases };
}

function compileIdentityEvidence(identityDocument, supplementalDocument, model) {
  const exact = new Map(), alias = new Map(), character = new Map(), supplemental = new Map();
  const add = (map, key, row) => { assert.ok(!map.has(key), "Duplicate reviewed identity evidence"); map.set(key, row); };
  const expanded = [];
  for (const group of identityDocument.overrides ?? []) {
    if (group.kind === "event_aliases") {
      assert.ok(Array.isArray(group.aliases) && group.aliases.length, "Reviewed event alias group is empty");
      for (const row of group.aliases) expanded.push({ kind: "event_alias", eventId: group.eventId,
        observedAlias: row.observedAlias, playerId: row.playerId, sourceUrl: group.sourceUrl, resolution: group.resolution });
    } else if (group.kind === "event_game_players") {
      assert.ok(Array.isArray(group.games) && group.games.length, "Reviewed exact-game group is empty");
      for (const row of group.games) expanded.push({ kind: "event_game_player", eventId: group.eventId,
        identitySha256: row.identitySha256, slot: row.slot, characterId: row.characterId,
        playerId: group.playerId, sourceUrl: group.sourceUrl, resolution: group.resolution });
    } else expanded.push(group);
  }
  for (const row of expanded) {
    assert.ok(model.eventById.has(row.eventId) && model.rankedPlayers.has(row.playerId), "Reviewed identity references unknown public evidence");
    assert.ok(row.sourceUrl && ["verified", "probable"].includes(row.resolution), "Invalid reviewed identity evidence");
    if (row.kind === "event_alias") {
      assert.ok(strict(row.observedAlias), "Reviewed identity alias is empty");
      add(alias, `${row.eventId}|${strict(row.observedAlias)}`, row);
    } else if (row.kind === "event_character") {
      assert.equal(row.eventId, exhibition, "Character-only identity requires the verified exhibition");
      add(character, `${row.eventId}|${row.characterId}`, row);
    } else if (row.kind === "event_game_player") {
      assert.match(row.identitySha256, /^[a-f0-9]{64}$/, "Exact identity requires a game SHA-256");
      assert.ok(Number.isInteger(row.slot) && row.slot >= 0 && row.slot <= 3 && Number.isInteger(row.characterId), "Exact identity requires a valid slot and character");
      add(exact, `${row.eventId}|${row.identitySha256}|${row.slot}`, row);
    } else assert.fail("Unsupported reviewed identity rule");
  }
  if (supplementalDocument) {
    assert.equal(supplementalDocument.schemaVersion, 1, "Invalid supplemental registry schema");
    assert.match(supplementalDocument.reviewedAt, /^\d{4}-\d{2}-\d{2}$/, "Supplemental registry requires a review date");
    assert.ok(Array.isArray(supplementalDocument.overrides) && supplementalDocument.overrides.length, "Supplemental registry is empty");
    const globallyRanked = new Set(model.rankings.filter(row => ["MPGR", "SSBMRank"].includes(row.ranking_series)
      && Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= 100 && /^https:\/\//.test(row.source_url ?? "")).map(row => row.player_id));
    for (const group of supplementalDocument.overrides) {
      assert.equal(group.kind, "event_aliases", "Supplemental evidence only permits reviewed event aliases");
      assert.ok(model.eventById.has(group.eventId), "Unknown supplemental event");
      assert.equal(group.resolution, "probable", "Supplemental attendance evidence is only probable");
      assert.match(group.sourceUrl ?? "", /^https:\/\//, "Supplemental event evidence requires a public source");
      assert.ok(Array.isArray(group.aliases) && group.aliases.length, "Supplemental alias group is empty");
      for (const row of group.aliases) {
        assert.ok(globallyRanked.has(row.playerId), "Supplemental identity lacks global Top 100 evidence");
        assert.ok(strict(row.observedAlias), "Supplemental alias is empty");
        add(supplemental, `${group.eventId}|${strict(row.observedAlias)}`, { eventId: group.eventId, playerId: row.playerId,
          sourceUrl: group.sourceUrl, resolution: group.resolution });
      }
    }
  }
  return { exact, alias, character, supplemental };
}

function reviewedLabels(map, player, eventId) {
  const matches = [player.displayName, player.nametag].map(strict).filter(Boolean).map(label => map.get(`${eventId}|${label}`)).filter(Boolean);
  assert.ok(new Set(matches.map(row => row.playerId)).size <= 1, "Conflicting reviewed display-name and controller-tag identities");
  return matches[0] ?? null;
}

function sequenceGroups(games, tournamentField) {
  const stations = new Map(), groups = [];
  for (const game of games.values()) {
    if (game.technicalExclusion || !game[tournamentField] || game.explicitFriendly || !game.rosterKey) continue;
    const id = `${game.eventId}|${game.stationKey}`;
    if (!stations.has(id)) stations.set(id, []);
    stations.get(id).push(game);
  }
  for (const rows of stations.values()) {
    rows.sort((a, b) => Number.isFinite(a.timeMs) && Number.isFinite(b.timeMs) && a.timeMs !== b.timeMs
      ? a.timeMs - b.timeMs : a.file.localeCompare(b.file));
    let run = [];
    const flush = () => { if (run.length >= 2 && run.length <= 10) groups.push(run); run = []; };
    for (const row of rows) {
      const last = run.at(-1);
      const timesComparable = last && Number.isFinite(last.timeMs) && Number.isFinite(row.timeMs);
      if (last && (last.rosterKey !== row.rosterKey || (timesComparable && (row.timeMs < last.timeMs || row.timeMs - last.timeMs > 1800000)))) flush();
      run.push(row);
    }
    flush();
  }
  return groups;
}

/** payloads must be a repeatable async-generator factory yielding sorted {name,payload}. No raw records are retained. */
export async function buildRecoveryPopulation({ payloads, datasetId, eventDocument, seriesDocument, identityDocument, supplementalDocument = null, rankingDataset }) {
  assert.equal(typeof payloads, "function", "Recovery inputs require a repeatable payload factory");
  const eventById = new Map(eventDocument.events.map(row => [row.id, row]));
  assert.equal(eventById.size, eventDocument.events.length, "Duplicate event registry rows");
  const seriesIdByEvent = new Map();
  for (const series of seriesDocument.series) for (const eventId of series.eventIds) {
    assert.ok(!seriesIdByEvent.has(eventId), "An event belongs to multiple series");
    seriesIdByEvent.set(eventId, series.id);
  }
  for (const eventId of eventById.keys()) assert.ok(seriesIdByEvent.has(eventId), "Event registry lacks series evidence");
  const model = { datasetId, games: new Map(), eventById, seriesIdByEvent, includedEventIds: new Set(), bundleCounts: new Map(),
    counts: { replayFiles: 0, parsedFiles: 0, failedFiles: 0, duplicateFiles: 0, uniqueGames: 0 },
    baseBuckets: buckets(), buckets: buckets(), curationBuckets: buckets(), sets: new Map(), identityPromotedGames: 0,
    ...rankingTables(rankingDataset, identityDocument), selectionCompleted: false };
  model.identityEvidence = compileIdentityEvidence(identityDocument, supplementalDocument, model);
  model.supplementalAliases = model.identityEvidence.supplemental;
  let previousName = null;
  for await (const { name, payload } of payloads()) {
    assert.ok(typeof name === "string" && (previousName === null || name > previousName), "Payload filenames must be strictly sorted and unique");
    previousName = name;
    assert.equal(name.replace(/\.json$/i, ""), payload.bundle.replace(/\.(?:7z|zip)$/i, ""), "Payload filename and bundle identity differ");
    const eventId = eventFor(payload.bundle), event = eventById.get(eventId);
    assert.ok(event, "Source has no event registry evidence");
    assert.ok(!model.bundleCounts.has(payload.bundle), "Duplicate source bundle");
    model.includedEventIds.add(eventId);
    const bundle = { bundle: payload.bundle, eventId, replayFiles: payload.records.length, parsed: 0, failed: 0, duplicateCopies: 0, uniqueGames: 0, buckets: buckets() };
    model.bundleCounts.set(payload.bundle, bundle);
    const paths = new Set();
    for (const record of payload.records) {
      assert.ok(!paths.has(record.file), "Duplicate replay path within one source payload"); paths.add(record.file);
      if (!record.ok) { bundle.failed++; bundle.buckets.excludedOrIncomplete++; continue; }
      assert.ok(Array.isArray(record.players), "Successful replay lacks player sides");
      bundle.parsed++;
      const key = rawKeyFor(payload.bundle, record), keyHash = digest(key);
      const broadcast = /-(?:main-stream|streams?|top-8|r2-offstream)\.(?:7z|zip)$/i.test(payload.bundle)
        || /(?:^|[/\\ _-])(?:bracket|pools?|top[-_ ]?\d+|stream|broadcast)(?:$|[/\\ _-])/i.test(record.file);
      const friendly = /(?:^|[/\\ _-])(?:friendlies?|warm[-_ ]?ups?|hand[-_ ]?warmers?|casuals?)(?:$|[/\\ _-])/i.test(record.file);
      const exact = record.players.some((_side, slot) => model.identityEvidence.exact.has(`${eventId}|${keyHash}|${slot}`));
      const existing = model.games.get(key);
      if (existing) {
        bundle.duplicateCopies++; bundle.buckets.excludedOrIncomplete++;
        existing.broadcastEvidence ||= broadcast;
        existing.exactIdentityEvidence ||= exact;
        existing.explicitFriendly &&= friendly;
        existing.curationHasTournamentSource ||= eventId !== "personal-pre-slippi-online";
        existing.copies.push({ bundle: payload.bundle, file: record.file });
        existing.sourceBundles.add(payload.bundle);
        continue;
      }
      const { roster, technicalExclusion } = rosterAndTechnical(record, eventId);
      bundle.uniqueGames++;
      model.games.set(key, { key, keyHash, eventId, bundle: payload.bundle, file: record.file,
        copies: [{ bundle: payload.bundle, file: record.file }], sourceBundles: new Set([payload.bundle]),
        selectedRecord: `${payload.bundle}\0${record.file}`, stationKey: `${path.posix.dirname(record.file.replaceAll("\\", "/")).toLocaleLowerCase("en-US")}|${normal(record.consoleNick) ?? "unknown-console"}`,
        timeMs: record.playedAt ? Date.parse(record.playedAt) : NaN, isTeams: record.isTeams, rosterKey: roster, technicalExclusion,
        broadcastEvidence: broadcast, exactIdentityEvidence: exact, explicitFriendly: friendly, hasTournamentSource: event.isTournament,
        curationHasTournamentSource: eventId !== "personal-pre-slippi-online", baseTier: null, tier: null, setId: null });
    }
    assert.equal(payload.replayFiles, bundle.replayFiles, "Source replay-file total differs from records");
    assert.equal(payload.parsed, bundle.parsed, "Source parsed count differs from records");
    assert.equal(payload.failed, bundle.failed, "Source failed count differs from records");
    model.counts.replayFiles += bundle.replayFiles; model.counts.parsedFiles += bundle.parsed;
    model.counts.failedFiles += bundle.failed; model.counts.duplicateFiles += bundle.duplicateCopies;
  }
  model.counts.uniqueGames = model.games.size;
  // Omitted source events supply no reviewed identity rules to that revision.
  // Keep the complete registries available for recovery, but count precisely
  // the rules that the selected source cohort can use (69 in preserved v11).
  model.approvedOverrides = [model.identityEvidence.exact, model.identityEvidence.alias, model.identityEvidence.character]
    .reduce((sum, rules) => sum + [...rules.values()].filter(rule => model.includedEventIds.has(rule.eventId)).length, 0);
  assert.equal(model.counts.parsedFiles - model.counts.duplicateFiles, model.counts.uniqueGames, "Deduplication accounting differs");
  const makeSet = (id, eventId, members, manual = false) => ({ id, tournament_id: recoveryTournamentId(datasetId, eventId),
    format: manual ? "singles" : members[0].isTeams ? "doubles" : "singles", round_label: manual ? "First to 10" : null,
    best_of: null, set_order: manual ? 0 : null, resolution: manual ? "verified" : "probable",
    resolution_source_url: eventById.get(eventId)?.sourceUrl ?? sourceUrl, completed: true, published: false, members });
  for (const group of sequenceGroups(model.games, "hasTournamentSource")) {
    const first = group[0];
    const seed = `${first.stationKey}|${first.rosterKey}|${first.key}`;
    const id = `${datasetId}:${first.eventId}:${digest(`nikki-public-set-v1:${first.eventId}:${seed}`).slice(0, 24)}`;
    model.sets.set(id, makeSet(id, first.eventId, group));
    for (const game of group) game.setId = id;
  }
  const manual = [...model.games.values()].filter(game => game.eventId === exhibition && !game.technicalExclusion).sort((a, b) => a.timeMs - b.timeMs);
  if (manual.length) {
    const id = `${datasetId}:${exhibition}:main`;
    model.sets.set(id, makeSet(id, exhibition, manual, true));
    for (const game of manual) game.setId = id;
  }
  const curationSequences = new Set(sequenceGroups(model.games, "curationHasTournamentSource").flatMap(group => group.map(game => game.key)));
  for (const game of model.games.values()) {
    const tier = (tournament, sequence) => game.technicalExclusion || !tournament || game.explicitFriendly ? "excluded"
      : game.eventId === exhibition ? "verified" : game.broadcastEvidence || sequence ? "probable" : "unclassified";
    game.baseTier = tier(game.hasTournamentSource, game.setId);
    game.tier = game.baseTier === "unclassified" && game.exactIdentityEvidence ? "probable" : game.baseTier;
    model.baseBuckets[bucketFor(game.baseTier)]++; model.buckets[bucketFor(game.tier)]++;
    if (game.tier !== game.baseTier) model.identityPromotedGames++;
    const curationBucket = bucketFor(tier(game.curationHasTournamentSource, curationSequences.has(game.key)));
    model.curationBuckets[curationBucket]++;
    model.bundleCounts.get(game.bundle).buckets[curationBucket]++;
  }
  model.curationFileBuckets = { ...model.curationBuckets,
    excludedOrIncomplete: model.curationBuckets.excludedOrIncomplete + model.counts.failedFiles + model.counts.duplicateFiles };
  return model;
}

/** Consume fully: exact and supplemental evidence completeness is checked at generator exhaustion. */
export async function* selectedRecoveryGames(payloads, model) {
  const matchedExact = new Set(), matchedSupplemental = new Set(), selected = new Set();
  model.selectionCompleted = false;
  for await (const { payload } of payloads()) for (const record of payload.records) {
    if (!record.ok) continue;
    const key = rawKeyFor(payload.bundle, record), game = model.games.get(key);
    if (!game || game.selectedRecord !== `${payload.bundle}\0${record.file}` || game.tier === "excluded") continue;
    assert.ok(!selected.has(key), "A selected game was traversed twice"); selected.add(key);
    const format = record.isTeams ? "doubles" : "singles", conservative = ["verified", "probable"].includes(game.tier);
    const identities = record.players.map((player, slot) => {
      const exactKey = `${game.eventId}|${game.keyHash}|${slot}`;
      const exact = model.identityEvidence.exact.get(exactKey);
      if (exact) { assert.equal(player.characterId, exact.characterId, "Character drift for exact identity evidence"); matchedExact.add(exactKey); }
      const alias = reviewedLabels(model.identityEvidence.alias, player, game.eventId);
      const character = model.identityEvidence.character.get(`${game.eventId}|${player.characterId}`);
      const legacy = exact ?? alias ?? character;
      // Unlike precedence alone, this independent check exposes contradictory
      // public evidence even when production would choose the stronger rule.
      assert.ok(new Set([exact, alias, character].filter(Boolean).map(row => row.playerId)).size <= 1, "Conflicting legacy identity evidence");
      const supplemental = format === "singles" && conservative ? reviewedLabels(model.identityEvidence.supplemental, player, game.eventId) : null;
      if (supplemental) matchedSupplemental.add(`${game.eventId}|${supplemental.playerId}`);
      assert.ok(!legacy || !supplemental || legacy.playerId === supplemental.playerId, "Conflicting legacy and supplemental identities");
      const match = legacy ?? supplemental;
      return match ? { playerId: match.playerId, resolution: match.resolution, sourceUrl: match.sourceUrl } : null;
    });
    if (format === "singles") {
      const named = identities.filter(Boolean).map(row => row.playerId);
      assert.equal(new Set(named).size, named.length, "One reviewed player occupies both singles sides");
    }
    yield { record, key, eventId: game.eventId, seriesId: model.seriesIdByEvent.get(game.eventId), tier: game.tier,
      format, identities, setId: game.setId, game, conservative, publicGameKey: recoveryGameKey(model.datasetId, key) };
  }
  assert.equal(selected.size, model.games.size - model.buckets.excludedOrIncomplete, "Source traversal omitted selected games");
  for (const [key, rule] of model.identityEvidence.exact) if (model.includedEventIds.has(rule.eventId)) {
    assert.ok(matchedExact.has(key), "Exact identity evidence did not match selected games");
  }
  for (const rule of model.identityEvidence.supplemental.values()) {
    assert.ok(matchedSupplemental.has(`${rule.eventId}|${rule.playerId}`), "Supplemental identity did not match conservative singles");
  }
  model.selectionCompleted = true;
  model.matchedExactOverrides = matchedExact.size;
  model.matchedSupplementalPlayers = matchedSupplemental.size;
}
