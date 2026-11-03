import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileInteractionProRegistry, resolveInteractionProIdentity, assembleInteractionProEvidence } from "./lib/interaction-pro-evidence.mjs";

const rankings = [{ player_id: "player1", ranking_series: "SSBMRank", rank: 50, source_url: "https://example.com/rankings" },
  { player_id: "player2", ranking_series: "MPGR", rank: 100, source_url: "https://example.com/rankings" },
  { player_id: "regional", ranking_series: "Regional", rank: 1, source_url: "https://example.com/regional" }];
const registry = { schemaVersion: 1, reviewedAt: "2026-11-02", overrides: [{ kind: "event_aliases", eventId: "fixture",
  sourceUrl: "https://example.com/fixture/results", resolution: "probable",
  aliases: [{ observedAlias: "Player 1", playerId: "player1" }, { observedAlias: "Player 2", playerId: "player2" }] }] };
const compile = value => compileInteractionProRegistry(value, rankings, new Set(["fixture"]));
const aliases = compile(registry);
assert.equal(resolveInteractionProIdentity(aliases, "fixture", { displayName: " PLAYER 1 " }).playerId, "player1");
assert.equal(resolveInteractionProIdentity(aliases, "fixture", { nametag: "Player 2" }).playerId, "player2");
assert.equal(resolveInteractionProIdentity(aliases, "other-event", { displayName: "Player 1" }), null);
assert.equal(resolveInteractionProIdentity(aliases, "fixture", { displayName: "Player1" }), null, "Whitespace inside names is not removed");
assert.equal(resolveInteractionProIdentity(aliases, "fixture", { displayName: "Player I" }), null, "Lookalike letters are not folded");
assert.equal(resolveInteractionProIdentity(aliases, "fixture", { connectCode: "Player 1" }), null, "Private codes are not identity evidence");
assert.throws(() => resolveInteractionProIdentity(aliases, "fixture", { displayName: "Player 1", nametag: "Player 2" }), /Conflicting/);
for (const mutate of [
  x => { x.overrides[0].aliases[0].playerId = "regional"; },
  x => { x.overrides[0].eventId = "unknown"; },
  x => { x.overrides[0].sourceUrl = ""; },
  x => { x.overrides[0].resolution = "verified"; },
  x => { x.overrides[0].aliases.push({ observedAlias: "PLAYER 1", playerId: "player2" }); },
]) { const changed = structuredClone(registry); mutate(changed); assert.throws(() => compile(changed)); }

const sourceDataset = "fixture-v1", bundle = "fixture.7z";
const fingerprint = rawKey => createHash("sha256").update(`nikki-public-game-v1:${sourceDataset}:${rawKey}`).digest("hex");
const records = ["eligible", "unclassified"].map(identityKey => ({ ok: true, file: `${identityKey}.slp`, identityKey, isTeams: false,
  players: [{ characterId: 9, displayName: "Player 1", connectCode: "PRIVATE#123" }, { characterId: 2, displayName: "Unreviewed opponent" }] }));
const population = { schemaVersion: 1, sourceDataset, games: records.map((record, index) => ({
  gameKey: fingerprint(record.identityKey), file: record.file, eventId: "fixture", bundle, tier: index === 0 ? "probable" : "unclassified",
})) };
const onePlayer = structuredClone(registry); onePlayer.overrides[0].aliases.pop();
const inputs = { populationBytes: Buffer.from(JSON.stringify(population)), registryBytes: Buffer.from(JSON.stringify(onePlayer)),
  rankingBytes: Buffer.from(rankings.map(row => JSON.stringify(row)).join("\n")),
  sourceAuditBytes: Buffer.from(JSON.stringify({ sources: [{ sourceFilename: bundle, replay_file_count: 2 }] })),
  readResults: async requested => { assert.equal(requested, bundle); return Buffer.from(JSON.stringify({ bundle, replayFiles: 2, records })); },
};
const evidence = await assembleInteractionProEvidence(inputs);
assert.deepEqual(evidence.summary, { players: 1, games: 1, playerGames: 1, events: 1 });
assert.deepEqual(evidence.rows, [{ game_key: fingerprint("eligible"), slot: 0, character_id: 9, player_id: "player1",
  identity_resolution: "probable", identity_source_url: "https://example.com/fixture/results" }]);
assert.ok(!JSON.stringify(evidence).includes("PRIVATE#123"));
assert.ok(!JSON.stringify(evidence).includes("eligible.slp"));
assert.deepEqual(await assembleInteractionProEvidence(inputs), evidence, "Evidence rebuilding is deterministic");
const changedPopulation = structuredClone(population); changedPopulation.games[0].gameKey = "wrong";
await assert.rejects(assembleInteractionProEvidence({ ...inputs, populationBytes: Buffer.from(JSON.stringify(changedPopulation)) }), /Replay identity/);
const conflicting = structuredClone(records); conflicting[0].players[1].displayName = "Player 1";
await assert.rejects(assembleInteractionProEvidence({ ...inputs, readResults: async () => Buffer.from(JSON.stringify({ bundle, replayFiles: 2, records: conflicting })) }), /both sides/);
console.log("Supplemental Pro evidence requires reviewed event labels and global ranking evidence; conflicts fail closed.");
