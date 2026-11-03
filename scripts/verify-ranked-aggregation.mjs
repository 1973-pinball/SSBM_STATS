import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { inspectTar } from "./ranked-source-pilot.mjs";
import { inspectTarStream, sha256 } from "./lib/ranked-source-stream.mjs";
import { createRankedAggregator, rankedShards, ACTIONS } from "./lib/ranked-aggregation.mjs";
import { createRankedWrapperDeduplicator } from "./lib/ranked-deduplication.mjs";

const emptyMove = () => ({ landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lcSuccess: 0, lcFail: 0 });
const counter = () => ({ attempts: 2, punished: 1, hit: 1, traded: 0, noHit: 0, incomplete: 0 });
const side = (characterId, totalDamage, extra = {}) => ({ characterId, isCpu: false, totalDamage, neutralWins: 3,
  openingsPerKill: 4, damagePerOpening: null, inputsPerMinute: 250, lCancelSuccess: 3, lCancelFail: 1,
  techs: { inPlace: 1, toward: 2, away: 3, missed: 4, wallSuccess: 1, wallMissed: 0 },
  actions: Object.fromEntries(ACTIONS.map(key => [key, 2])), moveStats: { 13: { ...emptyMove(), attempts: 3, landed: 2, damage: 21, lcSuccess: 1, lcFail: 1 } },
  defense: { ledge: { getup: counter() }, oos: {}, shieldExits: {} }, ...extra });
const record = (players, extra = {}) => ({ statsVersion: 10, durationFrames: 3600, stageId: 31, isTeams: false, winnerIndex: 0, players, ...extra });
const a = record([side(20, 100, { moveStats: { 18: { ...emptyMove(), attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 } } }), side(2, 200)]);
const b = record([side(20, 300), side(20, 400, { defense: undefined })], { stageId: 32, winnerIndex: null });
const c = record([side(9, 500), side(20, 600)], { stageId: 2, winnerIndex: 1 });
const entries = [{ sha256: sha256("a"), record: a, tiers: ["diamond", "master"] },
  { sha256: sha256("b"), record: b, tiers: ["diamond", "diamond"] }, { sha256: sha256("c"), record: c, tiers: ["platinum", "master"] }];
const aggregator = createRankedAggregator({ statsVersion: 10, interactionStatsVersion: 9 });
for (const entry of entries) assert.equal(aggregator.add(entry), true);
assert.equal(aggregator.add(entries[0]), false, "cross-shard byte duplicate does not add either slot twice");
assert.throws(() => aggregator.add({ ...entries[0], tiers: ["master", "diamond"] }), /conflicting/, "same bytes cannot receive conflicting actual-slot tier labels");
const rows = aggregator.finish();
for (const row of rows) {
  const expected = entries.flatMap(entry => entry.record.players.map((player, slot) => ({ ...entry, player, slot, tier: entry.tiers[slot] })))
    .filter(entry => entry.tier === row.tier && (row.characterId === null || row.characterId === entry.player.characterId)
      && (row.opponentCharacterId === null || row.opponentCharacterId === entry.record.players[1 - entry.slot].characterId)
      && (row.stageId === null || row.stageId === entry.record.stageId));
  assert.equal(row.playerGames, expected.length, "every nullable filter is independently pooled");
  assert.equal(row.distinctGames, new Set(expected.map(entry => entry.sha256)).size, "same-tier dittos count two player-games but one distinct game");
  assert.equal(row.metrics.damageTotal, expected.reduce((sum, entry) => sum + entry.player.totalDamage, 0));
  assert.equal(row.decidedPlayerGames, expected.filter(entry => entry.record.winnerIndex !== null).length);
  assert.equal(row.wins, expected.filter(entry => entry.record.winnerIndex === entry.slot).length);
  assert.equal(row.coverage.statsPlayerGames, row.playerGames);
  assert.equal(row.coverage.actionDurationFrames, expected.reduce((sum, entry) => sum + entry.record.durationFrames, 0));
  assert.equal(row.metrics.damagePerOpeningSamples, 0, "unavailable ratios do not become zero measurements");
  assert.equal(row.coverage.metrics.damagePerOpening.playerGames, 0);
  assert.equal(row.interactions.defenseGames, expected.filter(entry => entry.player.defense).length);
  assert.equal(row.interactions.recoveryGames, 0, "missing analysis is unavailable, not measured zero");
  assert.equal(row.uniquePlayers, null); assert.equal(row.metrics.playerBalanced, null);
}
const diamond = rows.find(row => row.tier === "diamond" && row.characterId === null && row.opponentCharacterId === null && row.stageId === null);
assert.equal(diamond.playerGames, 3); assert.equal(diamond.distinctGames, 2);
assert.equal(diamond.metrics.moves[18].attempts, 0); assert.equal(diamond.metrics.moves[18].attemptGames, 1, "measured zero survives, unmeasured games do not inflate denominator");
assert.equal(diamond.metrics.moves[18].outcomeGames, 1); assert.equal(diamond.coverage.moves[18].outcomes.playerGames, 1);
assert.equal(diamond.metrics.moves[2].attempts, 0); assert.equal(diamond.metrics.moves[2].attemptGames, 3, "verified normal action computer supplies implicit zero");
assert.equal(diamond.coverage.moves[13].landed.playerGames, 3, "late-observed move landed coverage includes earlier measured-zero games");
assert.equal(diamond.metrics.moves[18].lCancelSuccess, 0);
assert.equal(diamond.coverage.moves[18].lCancel.playerGames, 0);
const malformed = structuredClone(entries[2]); malformed.sha256 = sha256("bad"); malformed.record.players[0].moveStats[18] = { ...emptyMove(), attempts: 2, hitAttempts: 1, noHitAttempts: 0, incompleteAttempts: 0 };
assert.throws(() => createRankedAggregator({ statsVersion: 10, interactionStatsVersion: 9 }).add(malformed), /partition/);
for (const broken of [{ ledge: { getup: { attempts: 1 } }, oos: {}, shieldExits: {} },
  { ledge: {}, oos: { jump: { ...counter(), cStickInputs: 1 } }, shieldExits: {} },
  { ledge: { getup: { ...counter(), attempts: 3 } }, oos: {}, shieldExits: {} }]) {
  const candidate = structuredClone(entries[0]); candidate.record.players[0].defense = broken;
  assert.throws(() => createRankedAggregator({ statsVersion: 10, interactionStatsVersion: 9 }).add(candidate), /interaction|partition/);
}
const wrappers = createRankedWrapperDeduplicator();
const wrapper = { sha256: sha256("wrapper1"), rawCommandSha256: sha256("same raw"), tiers: ["diamond", "master"], record: a };
assert.equal(wrappers.add(wrapper, []), true);
assert.equal(wrappers.add({ ...wrapper, sha256: sha256("wrapper2") }, []), false);
assert.equal(wrappers.duplicateCopies, 1);
assert.throws(() => wrappers.add({ ...wrapper, sha256: sha256("wrapper3"), tiers: ["master", "diamond"] }, []), /conflicting wrapper/);
assert.throws(() => wrappers.add({ ...wrapper, sha256: sha256("wrapper4") }, ["source-rank-pair-conflict"]), /conflicting wrapper/);
const privacy = structuredClone(entries[0]); privacy.sha256 = sha256("privacy"); privacy.record.players[0].displayName = "PRIVATE-NAME"; privacy.record.players[0].connectCode = "PRIV#111"; privacy.record.path = "C:/private/replay.slp";
const privateAggregate = createRankedAggregator({ statsVersion: 10, interactionStatsVersion: 9 }); privateAggregate.add(privacy);
const publicJson = JSON.stringify([...rankedShards(privateAggregate.finish(), { datasetId: "fixture", statsVersion: 10, interactionStatsVersion: 9 }).values()]);
for (const secret of ["PRIVATE-NAME", "PRIV#111", "C:/private", privacy.sha256]) assert.ok(!publicJson.includes(secret), "only pooled fields enter public shards");

function member(name, body, type = "0") {
  const header = Buffer.alloc(512); header.write(name); header.write(body.length.toString(8).padStart(11, "0") + "\0", 124); header.fill(32, 148, 156); header.write(type, 156);
  const sum = header.reduce((n, byte) => n + byte, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
const tar = Buffer.concat([member("nested/a.slp", Buffer.from("one")), member("b.slp", Buffer.alloc(1300, 13)), Buffer.alloc(1024)]);
async function unpack(bytes, size = 7) {
  const chunks = []; for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  const members = []; for await (const item of inspectTarStream(Readable.from(chunks))) members.push(item); return members;
}
assert.deepEqual(await unpack(tar), inspectTar(tar), "stream boundaries cannot alter tar contents");
await assert.rejects(unpack(Buffer.concat([member("../escape.slp", Buffer.from("x")), Buffer.alloc(1024)])), /tar member/);
await assert.rejects(unpack(Buffer.concat([member("link.slp", Buffer.alloc(0), "2"), Buffer.alloc(1024)])), /unsupported\/link/);
await assert.rejects(unpack(tar.subarray(0, 1500)), /truncated/);
await assert.rejects(unpack(Buffer.concat([tar, Buffer.from("nonzero")])), /nonzero/);
console.log("Ranked aggregation verified: all eight exact filter combinations, byte dedupe, dittos, tier-slot separation, measured denominators, unavailable metrics, privacy, and bounded streaming tar.");
