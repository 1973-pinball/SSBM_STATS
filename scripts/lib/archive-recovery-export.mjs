/** Independent full-table reconstruction for a source-addition revision. No writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { ARCHIVE_CONTENT_TABLES, computeArchiveContentSha256 } from "./archive-content-hash.mjs";
import { buildRecoveryPopulation, selectedRecoveryGames } from "./archive-recovery-population.mjs";
import { createRecoveryRollups, assertRecoveryRows, assertRecoveryCoverage, assertRecoveryRecordMeasurements, dimensionKey } from "./archive-recovery-rollups.mjs";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const signature = value => JSON.stringify(canonical(value));
export const TABLES = ["archive_datasets", ...ARCHIVE_CONTENT_TABLES];
const json = async file => JSON.parse(await readFile(file, "utf8"));
const sourceStem = name => name.replace(/\.(?:7z|zip|json)$/i, "");
const sourceUrl = "https://replays.nikki.sh/";
const won = (record, player, slot) => record.isTeams
  ? record.winnerTeamId === null ? null : player.teamId === record.winnerTeamId
  : record.winnerIndex === null ? null : slot === record.winnerIndex;

export function assertPublicRows(actual, expected, table) {
  // Multisets detect both duplicates and omissions; extra fields cannot hide in
  // allowed public schemas or turn a private label into a public identity.
  assert.equal(actual.length, expected.length, `${table}: independently reconstructed row count`);
  assert.deepEqual(actual.map(signature).sort(), expected.map(signature).sort(), `${table}: independent public rows differ`);
}

export async function readRecoveryTables(dir) {
  const manifest = await json(path.join(dir, "manifest.json"));
  const qa = await json(path.join(dir, "qa.json"));
  assert.deepEqual(manifest.loadOrder, TABLES, "Complete ordered archive table manifest");
  assert.deepEqual(Object.keys(manifest.tableCounts).sort(), [...TABLES].sort(), "No unmanifested table count");
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".ndjson")).sort(), TABLES.map(name => `${name}.ndjson`).sort(), "No extra public table files");
  assert.equal(qa.datasetId, manifest.datasetId);
  assert.equal(qa.contentSha256, manifest.contentSha256);
  assert.deepEqual(qa.tableCounts, manifest.tableCounts);
  assert.deepEqual(qa.sourcePopulation, manifest.sourcePopulation);
  const tables = {};
  for (const table of TABLES) {
    const rows = tables[table] = [];
    for await (const line of createInterface({ input: createReadStream(path.join(dir, `${table}.ndjson`)), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      assert.ok(!/"(?:file|path|sourceFilename|connectCode|connect_code|userIdHash|user_id_hash|nametag|displayName)"\s*:/.test(line), "Private source field in public output");
      const row = JSON.parse(line);
      assert.equal(row.published, false, "Local candidate tables must be unstaged");
      if (Object.hasOwn(row, "dataset_id")) assert.equal(row.dataset_id, manifest.datasetId, "Dataset isolation");
      rows.push(row);
    }
    assert.equal(rows.length, manifest.tableCounts[table], `${table}: manifest count`);
  }
  assert.equal(tables.archive_datasets.length, 1);
  const dataset = tables.archive_datasets[0];
  assert.equal(dataset.id, manifest.datasetId);
  assert.equal(dataset.content_sha256, manifest.contentSha256);
  assert.deepEqual(dataset.import_counts, manifest.tableCounts);
  assert.equal(await computeArchiveContentSha256({ dir, datasetRow: dataset }), manifest.contentSha256, "Archive content hash");
  return { tables, manifest, qa, dataset };
}

/** API test seams never become CLI switches or bypass source/coverage gates. */
export async function verifyDerivedRecoveryExport({ dir, payloadFiles, audit, auditSha256,
  eventDocument, seriesDocument, identityDocument, supplementalDocument, rankingDataset,
  supplementalSha256, capability, requiredCharacters, curation = null }) {
  const actual = await readRecoveryTables(dir);
  const { tables, manifest, qa, dataset } = actual;
  const payloads = async function* () {
    for (const file of payloadFiles) {
      const payload = await json(file);
      for (const record of payload.records) if (record.ok) assertRecoveryRecordMeasurements(record, capability);
      yield { name: path.basename(file), payload };
    }
  };
  const model = await buildRecoveryPopulation({ payloads, datasetId: manifest.datasetId,
    eventDocument, seriesDocument, identityDocument, supplementalDocument, rankingDataset });
  const rollups = createRecoveryRollups(manifest.datasetId);
  const expected = Object.fromEntries(TABLES.map(table => [table, []]));
  const usedSets = new Set(), setPlayers = new Map(), publicByRaw = new Map();
  const mappedPlayers = new Set();
  let mappedPlayerSides = 0, omittedTimestamps = 0;
  for await (const selected of selectedRecoveryGames(payloads, model)) {
    rollups.add(selected);
    const { record, key, eventId, identities, conservative, publicGameKey, setId, game } = selected;
    if (!conservative || !identities.some(Boolean)) continue;
    const playedAt = typeof record.playedAt === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(record.playedAt) ? record.playedAt : null;
    if (record.playedAt && !playedAt) omittedTimestamps++;
    const publicGame = {
      game_key: publicGameKey, dataset_id: manifest.datasetId, tournament_id: `${manifest.datasetId}:${eventId}`,
      set_id: setId, sequence_in_set: setId ? model.sets.get(setId).members.indexOf(game) + 1 : null,
      played_at: playedAt, stage_id: record.stageId, duration_frames: record.durationFrames,
      format: record.isTeams ? "doubles" : "singles", winner_slot: record.isTeams ? null : record.winnerIndex,
      winner_team_id: record.isTeams ? record.winnerTeamId : null, curation_tier: selected.tier,
      stats_version: record.statsVersion, published: false,
    };
    expected.archive_games.push(publicGame);
    const sides = [];
    publicByRaw.set(key, { game: publicGame, sides });
    if (setId) usedSets.add(setId);
    for (const [slot, player] of record.players.entries()) {
      const identity = identities[slot];
      if (identity) { mappedPlayers.add(identity.playerId); mappedPlayerSides++; }
      const side = {
        game_key: publicGameKey, slot, team_id: player.teamId ?? null, player_id: identity?.playerId ?? null,
        identity_resolution: identity?.resolution ?? null, identity_source_url: identity?.sourceUrl ?? null,
        character_id: player.characterId, won: won(record, player, slot), stocks_taken: player.kills ?? null,
        damage_total: player.totalDamage ?? null, neutral_wins: player.neutralWins ?? null,
        openings_per_kill: player.openingsPerKill ?? null, damage_per_opening: player.damagePerOpening ?? null,
        inputs_per_minute: player.inputsPerMinute ?? null, l_cancel_success: player.lCancelSuccess ?? 0,
        l_cancel_fail: player.lCancelFail ?? 0, tech_in_place: player.techs?.inPlace ?? 0,
        tech_toward: player.techs?.toward ?? 0, tech_away: player.techs?.away ?? 0,
        tech_missed: player.techs?.missed ?? 0, wall_tech_success: player.techs?.wallSuccess ?? 0,
        wall_tech_missed: player.techs?.wallMissed ?? 0, action_counts: player.actions ?? {},
        move_stats: player.moveStats ?? {}, published: false,
      };
      sides.push(side); expected.archive_game_players.push(side);
      if (!setId || !identity) continue;
      const setKey = `${setId}|${identity.playerId}`;
      let accumulator = setPlayers.get(setKey);
      if (!accumulator) {
        accumulator = { set_id: setId, player_id: identity.playerId,
          display_name: model.rankedPlayers.get(identity.playerId)?.display_name ?? identity.playerId,
          slot, team_id: player.teamId ?? null, gameWins: 0, published: false };
        setPlayers.set(setKey, accumulator);
      }
      if (side.won) accumulator.gameWins++;
    }
  }
  for (const id of usedSets) {
    const { members: _members, ...row } = model.sets.get(id);
    expected.archive_sets.push(row);
    const players = [...setPlayers.values()].filter(row => row.set_id === id).sort((a, b) => a.player_id.localeCompare(b.player_id));
    const maximum = Math.max(...players.map(row => row.gameWins));
    const unique = players.filter(row => row.gameWins === maximum).length === 1;
    for (const [slot, row] of players.entries()) {
      const { gameWins, ...rest } = row;
      expected.archive_set_players.push({ ...rest, slot, winner: players.length >= 2 && unique ? gameWins === maximum : null });
    }
  }
  expected.archive_players = [...model.rankedPlayers.values()];
  expected.archive_player_aliases = [...model.aliases.values()];
  expected.archive_player_rankings = model.rankings;
  const includedSources = audit.sources.filter(row => model.bundleCounts.has(row.sourceFilename));
  assert.equal(includedSources.length, payloadFiles.length, "Every result has a unique audited original");
  const population = {
    baseDatasetId: audit.dataset.id, originalBundleCount: audit.sources.length,
    includedBundles: includedSources.map(row => sourceStem(row.sourceFilename)).sort(),
    excludedBundles: audit.sources.filter(row => !includedSources.includes(row)).map(row => row.id.slice(audit.dataset.id.length + 1)).sort(),
    expectedReplayFiles: includedSources.reduce((sum, row) => sum + row.replay_file_count, 0),
    expectedCompressedBytes: includedSources.reduce((sum, row) => sum + row.compressed_bytes, 0),
    sourceAuditSha256: auditSha256,
  };
  assert.deepEqual(manifest.sourcePopulation, population, "Independently selected source population");
  for (const source of includedSources) {
    const row = model.bundleCounts.get(source.sourceFilename), stem = sourceStem(source.sourceFilename);
    assert.equal(row.replayFiles, source.replay_file_count, "Source replay count");
    expected.archive_bundles.push({ id: `${manifest.datasetId}:${stem}`, dataset_id: manifest.datasetId,
      tournament_id: `${manifest.datasetId}:${stem.replace(/-(?:main-stream|streams?|top-8|r2-offstream)$/i, "")}`,
      public_source_url: sourceUrl, compressed_bytes: source.compressed_bytes,
      replay_file_count: row.replayFiles, parsed_replay_count: row.parsed, failed_replay_count: row.failed,
      duplicate_replay_count: row.duplicateCopies, published: false });
  }
  expected.archive_tournaments = eventDocument.events.filter(event => model.includedEventIds.has(event.id)).map(event => ({
    id: `${manifest.datasetId}:${event.id}`, dataset_id: manifest.datasetId, event_key: event.id,
    series_id: model.seriesIdByEvent.get(event.id), canonical_name: event.name, year: event.year,
    start_date: null, end_date: null, location: null, online: null, is_tournament: event.isTournament,
    event_source_url: event.sourceUrl, event_source_label: event.sourceLabel, source_confidence: event.sourceConfidence,
    notes: event.sourceConfidence === "unverified" ? "Year comes from the archive label and replay metadata; external source pending." : null,
    published: false,
  }));
  expected.archive_tournament_series = seriesDocument.series.map(series => ({ ...series,
    eventIds: series.eventIds.filter(id => model.includedEventIds.has(id)) })).filter(series => series.eventIds.length).map(series => ({
    id: series.id, canonical_name: series.name, source_url: series.sourceUrl ?? null,
    notes: series.eventIds.length > 1 ? `${series.eventIds.length} archive editions.` : "One archive event.", published: false,
  }));
  const aggregated = rollups.finish();
  expected.archive_rollups = [...aggregated.rows.values()];
  for (const table of ARCHIVE_CONTENT_TABLES) {
    if (table === "archive_rollups") assertRecoveryRows(tables[table], aggregated.rows);
    else assertPublicRows(tables[table], expected[table], table);
  }
  const { counts, buckets, baseBuckets } = model;
  const expectedInput = { compressedBytes: population.expectedCompressedBytes, bundles: includedSources.length,
    ...counts, curationBuckets: baseBuckets, publishedBuckets: buckets, identityPromotedGames: model.identityPromotedGames };
  assert.deepEqual(qa.input, expectedInput, "QA population independently reconstructed");
  const excludedEvents = [...new Set(population.excludedBundles.map(name => name.replace(/-(?:main-stream|streams?|top-8|r2-offstream)$/i, "")))]
    .filter(id => !model.includedEventIds.has(id));
  const notes = [
    `Source cohort: ${includedSources.length} of ${audit.sources.length} original bundles from ${audit.dataset.id}.`
      + (population.excludedBundles.length ? ` Excluded because the original source is unavailable: ${excludedEvents.map(id => model.eventById.get(id)?.name ?? id).join(", ") || population.excludedBundles.join(", ")}.` : "")
      + " No new source events were added.",
    "Raw replays, paths, filenames, unresolved tags, connect codes, and private user identifiers are excluded. Tournament pools all eligible event-venue recordings, including the conservative set sample, without double-counting. Pro Tournament includes evidence-backed ranked-player sides in conservative tournament games.",
    supplementalDocument ? `Pro identity expansion: ${mappedPlayers.size} mapped ranked players; supplemental reviewed event labels apply only to already-conservative singles. The existing regional-ranking exception for Ampp is retained. Pooled Pro rollups are computed before per-player sparse-cell suppression.` : null,
  ].filter(Boolean).join(" ");
  expected.archive_datasets = [{ id: manifest.datasetId, label: "Nikki's Slippi Dumps — derived tournament statistics",
    source_url: sourceUrl, source_label: "Nikki's Slippi Dumps", license_url: null,
    compressed_bytes: population.expectedCompressedBytes, archive_count: includedSources.length,
    replay_file_count: counts.replayFiles, parsed_replay_count: counts.parsedFiles, unique_game_count: counts.uniqueGames,
    broad_game_count: buckets.verifiedBracket + buckets.probableBracket + buckets.unclassifiedVenue,
    conservative_game_count: buckets.verifiedBracket + buckets.probableBracket,
    parser_version: "@slippi/slippi-js 9.1.2", curation_version: "nikki-curation-v1", data_as_of: "2026-09-08",
    import_counts: Object.fromEntries(TABLES.map(table => [table, table === "archive_datasets" ? 1 : expected[table].length])),
    content_sha256: manifest.contentSha256, notes, published: false, published_at: null }];
  assertPublicRows(tables.archive_datasets, expected.archive_datasets, "archive_datasets");
  assert.equal(dataset.compressed_bytes, population.expectedCompressedBytes);
  assert.equal(dataset.archive_count, includedSources.length);
  assert.equal(dataset.replay_file_count, counts.replayFiles);
  assert.equal(dataset.parsed_replay_count, counts.parsedFiles);
  assert.equal(dataset.unique_game_count, counts.uniqueGames);
  assert.equal(dataset.broad_game_count, buckets.verifiedBracket + buckets.probableBracket + buckets.unclassifiedVenue);
  assert.equal(dataset.conservative_game_count, buckets.verifiedBracket + buckets.probableBracket);
  assert.equal(dataset.data_as_of, "2026-09-08");
  assert.equal(dataset.parser_version, "@slippi/slippi-js 9.1.2");
  assert.equal(dataset.curation_version, "nikki-curation-v1");
  assert.equal(dataset.source_url, sourceUrl);
  assert.equal(dataset.published_at, null);
  assert.match(dataset.notes, new RegExp(`Source cohort: ${includedSources.length} of ${audit.sources.length} original bundles`));
  if (!population.excludedBundles.length) assert.doesNotMatch(dataset.notes, /Excluded because the original source is unavailable/);
  assert.equal(qa.identity.eligibleRankedPlayers, model.rankedPlayers.size);
  assert.equal(qa.identity.mappedPlayersWithGames, mappedPlayers.size);
  assert.equal(qa.identity.mappedGames, expected.archive_games.length);
  assert.equal(qa.identity.mappedPlayerSlots, mappedPlayerSides);
  assert.equal(qa.identity.approvedOverrides, model.approvedOverrides);
  assert.equal(qa.identity.supplementalReviewedAliases, model.supplementalAliases.size);
  assert.equal(qa.identity.supplementalRegistrySha256, supplementalSha256);
  assert.equal(qa.identity.supplementalReviewedAt, supplementalDocument?.reviewedAt ?? null);
  assert.equal(qa.timestamps.omittedWithoutExplicitTimezone, omittedTimestamps);
  assert.deepEqual(qa.privacy, { rawReplayBytesExported: false, pathsOrFilenamesExported: false,
    connectCodesExported: false, privateUserIdsExported: false, unresolvedTagsExported: false, anonymousGamesAreAggregateOnly: true });
  for (const key of ["computed", "exported", "omittedSparse"]) assert.equal(qa.rollups[key], aggregated.summary[key], `QA ${key} rollups`);
  assert.deepEqual(qa.rollups.minimums, { communitySpecificCell: 25, seriesOrTournamentSingleDimension: 5,
    seriesOrTournamentMatchupStage: 10, playerSingleDimension: 3, playerMatchupStage: 5,
    pooledProSingleDimension: 3, pooledProMatchupStage: 5 });
  assert.deepEqual(qa.playerBalanced, { privateIdentityGroupsConsidered: aggregated.summary.privateIdentityGroupsConsidered,
    publishedCohorts: aggregated.summary.balancedCohorts, minimumGamesPerIdentityCharacter: 10,
    minimumLCancelAttempts: 50, minimumTechAttempts: 20, privateIdentifiersExported: false });
  const specialCoverage = Object.fromEntries([18, 19, 20, 21].map(id => [id, ["broad", "conservative"].map(population => {
    const rows = expected.archive_rollups.filter(row => row.scope === "community" && row.population === population
      && row.character_id !== null && row.opponent_character_id === null && row.stage_id === null);
    return { population, characterRows: rows.length, ...Object.fromEntries(["attemptGames", "outcomeGames", "attempts", "hitAttempts", "noHitAttempts", "incompleteAttempts"]
      .map(field => [field, rows.reduce((sum, row) => sum + (row.metrics.moves?.[id]?.[field] ?? 0), 0)])) };
  })]));
  assert.deepEqual(qa.moveCoverage, { statsVersion: 6, specials: specialCoverage, downB: specialCoverage[21] });
  const proCohorts = expected.archive_rollups.filter(row => row.scope === "pro" && row.character_id === null && row.opponent_character_id === null && row.stage_id === null)
    .map(row => ({ format: row.format, playerGames: row.game_count, players: row.identified_player_count }));
  assertPublicRows(qa.identity.proCohorts, proCohorts, "QA pooled Pro cohorts");
  if (curation) {
    for (const [key, value] of Object.entries(counts)) assert.equal(curation[key], value, `Curation ${key}`);
    assert.deepEqual(curation.uniqueGameBuckets, model.curationBuckets, "Independent curation buckets");
    assert.equal(curation.bundles.length, model.bundleCounts.size);
    const byBundle = new Map(curation.bundles.map(row => [row.bundle, row]));
    assert.equal(byBundle.size, curation.bundles.length, "No duplicate curation bundle");
    for (const [name, count] of model.bundleCounts) for (const field of ["replayFiles", "parsed", "failed", "duplicateCopies", "uniqueGames", "buckets"]) {
      assert.deepEqual(byBundle.get(name)?.[field], count[field], `Curation bundle ${field}`);
    }
  }
  const coverage = assertRecoveryCoverage(aggregated.rows, capability, requiredCharacters ? { requiredCharacters } : {});
  return { ...actual, model, expected, rollups: aggregated, publicByRaw, coverage,
    summary: { ...counts, tableCounts: manifest.tableCounts, rollups: aggregated.summary, coverage,
      mappedPlayerIds: [...mappedPlayers].sort(), mappedPlayerSides } };
}

const normalizeDataset = (value, datasetId) => JSON.parse(JSON.stringify(value).replaceAll(datasetId, "DATASET"));
export function reconcileRecoveryAddition(before, after) {
  const oldCounts = before.model.counts, newCounts = after.model.counts;
  const recovered = [...after.model.bundleCounts].filter(([bundle]) => sourceStem(bundle) === "ootb5");
  assert.equal(recovered.length, 1);
  const recoveredCounts = recovered[0][1];
  assert.equal(newCounts.parsedFiles, oldCounts.parsedFiles + recoveredCounts.parsed);
  assert.equal(newCounts.failedFiles, oldCounts.failedFiles + recoveredCounts.failed);
  assert.equal(newCounts.uniqueGames - oldCounts.uniqueGames,
    recoveredCounts.parsed - (newCounts.duplicateFiles - oldCounts.duplicateFiles));
  const ledger = [], duplicateGroups = [];
  for (const [key, game] of after.model.games) {
    const previous = before.model.games.get(key);
    if (game.copies.length > 1 && game.copies.some(copy => sourceStem(copy.bundle) === "ootb5")) {
      duplicateGroups.push({ gameIdentitySha256: digest(key), copies: game.copies.length,
        sourceBundles: [...game.sourceBundles].map(sourceStem).sort(),
        recoveredCopies: game.copies.filter(copy => sourceStem(copy.bundle) === "ootb5").length,
        representativeChanged: Boolean(previous && previous.selectedRecord !== game.selectedRecord) });
    }
    const describe = (meta, datasetId) => meta ? normalizeDataset({
      representative: digest(meta.selectedRecord), eventId: meta.eventId,
      tier: meta.tier, baseTier: meta.baseTier, setId: meta.setId,
      broadcastEvidence: meta.broadcastEvidence, exactIdentityEvidence: meta.exactIdentityEvidence,
      explicitFriendly: meta.explicitFriendly,
    }, datasetId) : null;
    const oldState = describe(previous, before.manifest.datasetId), newState = describe(game, after.manifest.datasetId);
    const publicState = (result, key) => {
      const entry = result.publicByRaw.get(key);
      if (!entry) return null;
      const normalized = normalizeDataset(entry, result.manifest.datasetId);
      delete normalized.game.game_key;
      for (const side of normalized.sides) delete side.game_key;
      return normalized;
    };
    const oldPublic = publicState(before, key), newPublic = publicState(after, key);
    const publicChanged = signature(oldPublic) !== signature(newPublic);
    if (!previous || signature(oldState) !== signature(newState) || publicChanged) {
      // All effects must be reproduced by the independently verified full union;
      // there is no user-authored list of permitted metric deltas.
      ledger.push({ gameIdentitySha256: digest(key), kind: previous ? "changed-existing-selection-or-curation" : "new-unique-game",
        before: oldState, after: newState, publicChanged,
        publicBeforeSha256: oldPublic ? digest(signature(oldPublic)) : null,
        publicAfterSha256: newPublic ? digest(signature(newPublic)) : null });
    }
  }
  for (const key of before.model.games.keys()) assert.ok(after.model.games.has(key), "Source addition cannot lose an original raw identity");
  const rollupStates = result => new Map(result.expected.archive_rollups.map(row => {
    const normalized = normalizeDataset(row, result.manifest.datasetId); delete normalized.rollup_key;
    return [dimensionKey(normalized), normalized];
  }));
  const oldRows = rollupStates(before), newRows = rollupStates(after);
  const rollupChanges = { unchanged: 0, changed: 0, added: 0, removed: 0 };
  for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
    if (!oldRows.has(key)) rollupChanges.added++;
    else if (!newRows.has(key)) rollupChanges.removed++;
    else if (signature(oldRows.get(key)) === signature(newRows.get(key))) rollupChanges.unchanged++;
    else rollupChanges.changed++;
  }
  return { recovered: recoveredCounts, newUniqueGames: newCounts.uniqueGames - oldCounts.uniqueGames,
    addedDuplicateCopies: newCounts.duplicateFiles - oldCounts.duplicateFiles, rollupChanges, duplicateGroups, ledger };
}
