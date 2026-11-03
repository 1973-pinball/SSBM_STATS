import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { strictProAlias, compileReviewedProRegistry, resolveReviewedProIdentity } from "./archive-pro-identity.mjs";

export { strictProAlias };

/** A reviewed public event label and historical global rank are both required. */
export function compileInteractionProRegistry(registry, rankings, eventIds) {
  return compileReviewedProRegistry(registry, rankings, eventIds);
}

export function resolveInteractionProIdentity(aliases, eventId, player) {
  return resolveReviewedProIdentity(aliases, eventId, player);
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
