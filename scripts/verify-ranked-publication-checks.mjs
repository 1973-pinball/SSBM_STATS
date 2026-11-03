/** Exercise the public release gate over HTTP without raw replays or credentials. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createRankedAggregator, rankedShards, ACTIONS } from "./lib/ranked-aggregation.mjs";
import { verifyRankedPublication, verifyRankedPartitions } from "./verify-ranked-publication.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const side = characterId => ({ characterId, totalDamage: 10, neutralWins: 1, openingsPerKill: null, damagePerOpening: 10, inputsPerMinute: 100,
  lCancelSuccess: 0, lCancelFail: 0, techs: { inPlace: 0, toward: 0, away: 0, missed: 0, wallSuccess: 0, wallMissed: 0 },
  actions: Object.fromEntries(ACTIONS.map(key => [key, 0])), moveStats: {} });
const aggregator = createRankedAggregator({ statsVersion: 10, interactionStatsVersion: 9 });
for (const [index, tierLabels, characterIds, stageId] of [[0, ["diamond", "diamond"], [2, 20], 31],
  [1, ["diamond", "master"], [20, 2], 32], [2, ["diamond", "diamond"], [20, 20], 31]]) {
  aggregator.add({ sha256: sha(String(index)), tiers: tierLabels, record: { statsVersion: 10, durationFrames: 3600, stageId, isTeams: false, winnerIndex: 0, players: characterIds.map(side) } });
}
const rows = aggregator.finish(), datasetId = "publication-fixture-v1", assets = new Map(), shardIndex = [];
for (const [name, shard] of rankedShards(rows, { datasetId, statsVersion: 10, interactionStatsVersion: 9 })) {
  const body = gzipSync(Buffer.from(JSON.stringify(shard))), file = `/ranked/${datasetId}/${name}.json.gz`; assets.set(file, body);
  shardIndex.push({ tier: shard.tier, characterId: shard.characterId, path: file, encoding: "gzip", sha256: sha(body), bytes: body.length, rows: shard.rows.length });
}
const source = { repository: "fixture/source", revision: "pinned-fixture", selectionMethod: "Generated numerical fixture; no replay data.", files: [{ path: "fixture.tar.gz", bytes: 1, sha256: "a".repeat(64) }] };
const totals = Object.fromEntries(rows.filter(row => row.characterId === null && row.opponentCharacterId === null && row.stageId === null)
  .map(row => [row.tier, { playerGames: row.playerGames, distinctGames: row.distinctGames, decidedPlayerGames: row.decidedPlayerGames, wins: row.wins }]));
const manifest = { schemaVersion: 1, exportQualityVersion: "ranked-export-quality-v1", datasetId, statsVersion: 10, interactionStatsVersion: 9, generatedAt: "2026-11-03T00:00:00.000Z",
  source: { repository: source.repository, revision: source.revision, url: "https://example.com/fixture", selectionMethod: source.selectionMethod, archives: source.files, sourceManifestSha256: sha(JSON.stringify(source)) },
  rankTiming: "unknown", rankSeason: null, rankDate: null, uniquePlayers: null, qualityGates: ["Generated numerical test fixture."],
  counts: { sourceArchives: 1, sourceBytes: 1, replayOccurrences: 3, uniqueReplays: 3, duplicateCopies: 0, wrapperDuplicateCopies: 0, acceptedGames: 3, rejectedGames: 0, rejections: {} }, tiers: totals, shards: shardIndex };
const manifestBytes = Buffer.from(JSON.stringify(manifest));
assets.set("/ranked/manifest.json", manifestBytes); assets.set(`/ranked/${datasetId}/manifest.json`, manifestBytes);
assert.ok(verifyRankedPartitions(rows, manifest).partitions > 0, "character sums may overlap distinct games but stages may not");
const broken = structuredClone(rows); broken.find(row => row.tier === "diamond" && row.characterId === null && row.opponentCharacterId === null && row.stageId === null).playerGames++;
assert.throws(() => verifyRankedPartitions(broken, manifest), /partition/);
const temporary = await mkdtemp(path.join(tmpdir(), "ssbm-ranked-publication-checks-"));
const root = path.join(temporary, "ranked"); await mkdir(path.join(root, datasetId), { recursive: true });
for (const [file, bytes] of assets) await writeFile(path.join(temporary, file.slice(1)), bytes);
const sourceFile = path.join(temporary, "source.json"); await writeFile(sourceFile, JSON.stringify(source, null, 2).replaceAll("\n", "\r\n"));
let corrupt = false, badStableCache = false;
const server = createServer((request, response) => {
  const file = new URL(request.url, "http://127.0.0.1").pathname, body = assets.get(file);
  if (!body) { response.writeHead(404); response.end(); return; }
  response.setHeader("Cache-Control", file === "/ranked/manifest.json" && !badStableCache ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable");
  const payload = Buffer.from(body); if (corrupt && file.endsWith(".json.gz")) payload[payload.length - 1] ^= 1;
  response.writeHead(200); response.end(payload);
});
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const options = { dir: root, baseUrl: `http://127.0.0.1:${server.address().port}`, sourceManifest: sourceFile };
  const report = await verifyRankedPublication(options); assert.equal(report.ok, true); assert.equal(report.stablePointerChecked, true); assert.equal(report.httpCacheChecks, shardIndex.length + 2);
  corrupt = true; await assert.rejects(verifyRankedPublication(options), /Expected values/);
  corrupt = false; badStableCache = true; await assert.rejects(verifyRankedPublication(options), /must revalidate/);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({ ...manifest, exportQualityVersion: "unknown" }));
  await assert.rejects(verifyRankedPublication({ dir: root, sourceManifest: sourceFile }), /export eligibility version/);
} finally {
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith("ssbm-ranked-publication-checks-"));
  await rm(resolved, { recursive: true });
}
console.log("Public ranked release checks passed: semantic source pinning, stable/versioned manifests, real consumer validation, gzip integrity, HTTP cache policy, and non-overcounted distinct-game partitions.");
