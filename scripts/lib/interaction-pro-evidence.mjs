import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const strictProAlias = value => typeof value === "string" && value.trim()
  ? value.trim().normalize("NFKC").toLocaleLowerCase("en-US") : null;

/** A reviewed public event label and historical global rank are both required. */
export function compileInteractionProRegistry(registry, rankings, eventIds) {
  assert.equal(registry.schemaVersion, 1);
  assert.match(registry.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(registry.overrides) && registry.overrides.length > 0);
  const ranked = new Set(rankings.filter(row => ["SSBMRank", "MPGR"].includes(row.ranking_series)
    && Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= 100
    && /^https:\/\//.test(row.source_url ?? "")).map(row => row.player_id));
  const aliases = new Map();
  for (const group of registry.overrides) {
    assert.equal(group.kind, "event_aliases", "Only explicitly reviewed event labels are supported");
    assert.ok(eventIds.has(group.eventId), `Unknown reviewed event ${group.eventId}`);
    assert.equal(group.resolution, "probable", "Attendance and label evidence cannot claim verified replay identity");
    assert.ok(/^https:\/\//.test(group.sourceUrl ?? ""), "Public event evidence is required");
    assert.ok(Array.isArray(group.aliases) && group.aliases.length > 0);
    for (const row of group.aliases) {
      assert.ok(ranked.has(row.playerId), `Global Top 100 ranking evidence is required for ${row.playerId}`);
      const alias = strictProAlias(row.observedAlias);
      assert.ok(alias, "Reviewed aliases cannot be empty");
      const key = `${group.eventId}|${alias}`;
      assert.ok(!aliases.has(key), `Duplicate reviewed event alias ${key}`);
      aliases.set(key, { playerId: row.playerId, resolution: group.resolution, sourceUrl: group.sourceUrl });
    }
  }
  return aliases;
}

export function resolveInteractionProIdentity(aliases, eventId, player) {
  const matches = [player.displayName, player.nametag].map(strictProAlias).filter(Boolean)
    .map(alias => aliases.get(`${eventId}|${alias}`)).filter(Boolean);
  assert.ok(new Set(matches.map(match => match.playerId)).size <= 1,
    "Conflicting reviewed display-name and controller-tag identities");
  return matches[0] ?? null;
}

/** Rebuild every row from reviewed rules and the frozen source records, not a previous evidence file. */
export async function assembleInteractionProEvidence({ populationBytes, registryBytes, rankingBytes, sourceAuditBytes,
  readResults, onBundle = () => {} }) {
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const normalized = value => value.replaceAll("\\", "/").replace(/^\.\//, "");
  const population = JSON.parse(populationBytes), registry = JSON.parse(registryBytes), audit = JSON.parse(sourceAuditBytes);
  assert.equal(population.schemaVersion, 1);
  const rankings = rankingBytes.toString().trim().split(/\r?\n/).map(JSON.parse);
  const aliases = compileInteractionProRegistry(registry, rankings, new Set(population.games.map(game => game.eventId)));
  const reviewedEvents = new Set(registry.overrides.map(group => group.eventId));
  const grouped = new Map();
  for (const game of population.games) {
    if (!reviewedEvents.has(game.eventId) || !["verified", "probable"].includes(game.tier)) continue;
    assert.match(game.bundle, /^[^/\\]+\.(?:zip|7z)$/);
    const group = grouped.get(game.bundle) ?? []; group.push(game); grouped.set(game.bundle, group);
  }
  const rows = [], resultsSources = [], matched = new Set();
  for (const [bundle, games] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = await readResults(bundle);
    const payload = JSON.parse(bytes);
    assert.equal(payload.bundle, bundle, "Audited result bundle must agree");
    const source = audit.sources.find(row => row.sourceFilename === bundle);
    assert.ok(source, "Result bundle must belong to the frozen source audit");
    assert.equal(payload.replayFiles, source.replay_file_count);
    const records = new Map(payload.records.map(record => [normalized(record.file), record]));
    resultsSources.push({ bundle, sha256: hash(bytes) });
    for (const game of games) {
      const record = records.get(normalized(game.file));
      assert.ok(record?.ok && !record.isTeams && record.players.length === 2, "Population must resolve to valid audited singles");
      assert.equal(hash(`nikki-public-game-v1:${population.sourceDataset}:${record.identityKey ?? `${bundle}/${record.file}`}`), game.gameKey,
        "Replay identity must agree with the frozen population");
      const identities = record.players.map(player => resolveInteractionProIdentity(aliases, game.eventId, player));
      assert.ok(!identities[0] || !identities[1] || identities[0].playerId !== identities[1].playerId,
        "One reviewed player cannot occupy both sides of a singles game");
      for (const [slot, identity] of identities.entries()) {
        if (!identity) continue;
        const characterId = record.players[slot].characterId;
        assert.ok(Number.isInteger(characterId) && characterId >= 0 && characterId <= 25);
        rows.push({ game_key: game.gameKey, slot, character_id: characterId, player_id: identity.playerId,
          identity_resolution: identity.resolution, identity_source_url: identity.sourceUrl });
        matched.add(`${game.eventId}|${identity.playerId}`);
      }
    }
    onBundle(bundle, games.length);
  }
  const unmatched = registry.overrides.flatMap(group => group.aliases
    .filter(row => !matched.has(`${group.eventId}|${row.playerId}`)).map(row => `${group.eventId}:${row.playerId}`));
  assert.deepEqual(unmatched, [], "Every reviewed mapping must match an eligible replay side");
  rows.sort((a, b) => a.game_key.localeCompare(b.game_key) || a.slot - b.slot);
  const summary = { players: new Set(rows.map(row => row.player_id)).size,
    games: new Set(rows.map(row => row.game_key)).size, playerGames: rows.length, events: reviewedEvents.size };
  return { schemaVersion: 1, sourceDataset: population.sourceDataset, reviewedAt: registry.reviewedAt,
    populationSha256: hash(populationBytes), registrySha256: hash(registryBytes), rankingEvidenceSha256: hash(rankingBytes),
    sourceAuditSha256: hash(sourceAuditBytes), resultsSources, summary, rows };
}
