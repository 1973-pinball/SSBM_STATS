/** Consumer contract checks: exact slices, measured zeros, versions, and verified lazy fetches. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
const originalFetch = globalThis.fetch;
try {
  const { ACTION_LABELS, CURRENT_STATS_VERSION, INTERACTION_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const adapter = await server.ssrLoadModule("/src/lib/rankedBenchmarks.ts");
  const { archiveMoveBenchmark } = await server.ssrLoadModule("/src/lib/executionMoveBenchmarks.ts");
  const measured = { playerGames: 10, durationFrames: 36000 };
  const normal = { attempts: 0, landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lCancelSuccess: 0, lCancelFail: 0 };
  const row = {
    tier: "diamond", characterId: 20, opponentCharacterId: null, stageId: null,
    playerGames: 10, distinctGames: 7, decidedPlayerGames: 8, wins: 5, uniquePlayers: null,
    metrics: { durationFrames: 36000, damageTotal: 100, neutralWins: 10,
      openingsPerKillSum: 20, openingsPerKillSamples: 10, damagePerOpeningSum: 0, damagePerOpeningSamples: 0,
      inputsPerMinuteSum: 2000, inputsPerMinuteSamples: 10, lCancelSuccess: 3, lCancelFail: 1,
      techInPlace: 1, techToward: 2, techAway: 3, techMissed: 4, wallTechSuccess: 0, wallTechMissed: 0,
      actions: Object.fromEntries(ACTION_LABELS.map(({key}) => [key, 0])), playerBalanced: null,
      moves: { 2: { ...normal, attempts: 40, landed: 5 }, 3: { ...normal, attempts: undefined, landed: 30 }, 13: normal, 18: { ...normal, attempts: undefined }, 19: { ...normal, attemptGames: 10 } },
    },
    coverage: { statsPlayerGames: 10, statsDurationFrames: 36000, actionPlayerGames: 10, actionDurationFrames: 36000, movePlayerGames: 10, moveDurationFrames: 36000,
      metrics: { ...Object.fromEntries(["damageTotal", "neutralWins", "lCancel", "tech", "wallTech", "openingsPerKill", "inputsPerMinute"].map(key => [key, measured])), damagePerOpening: { playerGames: 0, durationFrames: 0 } }, actions: Object.fromEntries(ACTION_LABELS.map(({key}) => [key, measured])),
      moves: { 2: { attempts: measured }, 3: { attempts: { playerGames: 0, durationFrames: 0 } }, 13: { attempts: measured }, 18: { attempts: { playerGames: 0, durationFrames: 0 } }, 19: { attempts: measured } } },
    interactions: { games: 10, defenseGames: 0, recoveryGames: 0, punishGames: 0, ledge: {}, oos: {}, shieldExits: {}, recoveries: {}, edgeguards: {}, beforeOpening: {} },
  };
  // Match what JSON actually publishes: absent fields are not explicit undefined.
  const overall = JSON.parse(JSON.stringify(row));
  const exact = { ...structuredClone(overall), opponentCharacterId: 2, stageId: 31, playerGames: 10 };
  exact.metrics.moves[13].attempts = 30;
  const shard = { schemaVersion: 1, datasetId: "fixture-v1", statsVersion: CURRENT_STATS_VERSION, interactionStatsVersion: INTERACTION_STATS_VERSION, tier: "diamond", characterId: 20, rows: [overall, exact] };
  const bytes = gzipSync(JSON.stringify(shard));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const index = { tier: "diamond", characterId: 20, path: "/ranked/fixture-v1/diamond-20.json.gz", encoding: "gzip", bytes: bytes.length, sha256, rows: 2 };
  const manifest = { schemaVersion: 1, datasetId: "fixture-v1", statsVersion: CURRENT_STATS_VERSION, interactionStatsVersion: INTERACTION_STATS_VERSION, generatedAt: "2026-11-03T00:00:00.000Z", rankTiming: "unknown", rankSeason: null, rankDate: null, uniquePlayers: null, qualityGates: ["Verified fixture"],
    source: { repository: "fixture", revision: "pinned", url: "https://example.com/fixture", selectionMethod: "Deliberately distinct fixture cells", archives: [], sourceManifestSha256: "a".repeat(64) }, tiers: { diamond: { playerGames: 10, distinctGames: 7, decidedPlayerGames: 8, wins: 5 } }, shards: [index] };
  assert.ok(adapter.parseRankedManifest(manifest));
  assert.ok(adapter.parseRankedShard(shard, manifest, "diamond", 20));
  const scope = { characterId: 20, opponentCharacterId: 2, stageId: 31 };
  assert.equal(adapter.selectRankedBenchmarkRow(shard.rows, scope), exact);
  assert.equal(adapter.selectRankedBenchmarkRow(shard.rows, { ...scope, stageId: 32 }), null, "missing stage cannot fall back to all stages");
  assert.equal(adapter.selectRankedBenchmarkRow(shard.rows, { ...scope, opponentCharacterId: 9 }), null, "missing opponent cannot fall back to all opponents");
  assert.equal(adapter.selectRankedBenchmarkRow(shard.rows, { ...scope, characterId: null }), null, "all characters requires its own published row");
  const view = adapter.rankedMetricRow(overall, "move");
  assert.equal(archiveMoveBenchmark(view, "jab", "attemptsPerGame"), 4, "Jab 2 landed rows cannot hide the combined Jab 1 initiation counter");
  assert.equal(archiveMoveBenchmark(view, "nair", "attemptsPerGame"), 0, "measured normal zero remains zero");
  assert.equal(archiveMoveBenchmark(view, "neutral-b", "attemptsPerGame"), null, "missing attempts cannot become measured zero in the formatting view");
  assert.equal(archiveMoveBenchmark(view, "side-b", "attemptsPerGame"), 0, "explicit special zero retains its measured denominator");
  assert.equal(archiveMoveBenchmark(view, "side-b", "noHitRate"), null, "attempt-only coverage cannot invent outcomes");
  assert.equal(archiveMoveBenchmark(adapter.rankedMetricRow(exact, "move"), "nair", "attemptsPerGame"), 3);
  assert.equal(view.identified_player_count, null);
  assert.equal(view.metrics.playerBalanced, null);
  assert.equal(adapter.rankedMetricRow({ ...overall, coverage: { ...overall.coverage, actionPlayerGames: 0 } }, "action"), null);
  assert.equal(adapter.parseRankedManifest({ ...manifest, rankTiming: "current" }), null);
  assert.equal(adapter.parseRankedManifest({ ...manifest, statsVersion: CURRENT_STATS_VERSION - 1 }), null);
  for (const path of ["https://evil.example/diamond.json.gz", "/ranked/fixture-v1/../other.json.gz", "/ranked/different/diamond.json.gz"]) assert.equal(adapter.parseRankedManifest({ ...manifest, shards: [{ ...index, path }] }), null);
  assert.equal(adapter.parseRankedShard({ ...shard, rows: [overall, overall] }, manifest, "diamond", 20), null, "duplicate exact rows cannot be summed");
  assert.equal(adapter.parseRankedShard({ ...shard, rows: [{ ...overall, coverage: { ...overall.coverage, actionPlayerGames: 0 } }] }, manifest, "diamond", 20), null, "v1 rejects partial base-family coverage instead of treating placeholders as zero");
  assert.equal(adapter.parseRankedShard({ ...shard, tier: "master" }, manifest, "diamond", 20), null);
  assert.equal(adapter.parseRankedShard({ ...shard, rows: [{ ...overall, wins: 9 }] }, manifest, "diamond", 20), null, "wins cannot exceed decided sides");
  assert.equal(adapter.parseRankedShard({ ...shard, rows: [{ ...overall, uniquePlayers: 10 }] }, manifest, "diamond", 20), null);
  assert.equal(adapter.parseRankedShard({ ...shard, rows: [{ ...overall, metrics: { ...overall.metrics, damageTotal: NaN } }] }, manifest, "diamond", 20), null);
  const calls = [];
  let corrupt = true;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "/ranked/manifest.json") return new Response(JSON.stringify(manifest));
    assert.equal(url, index.path);
    const payload = Buffer.from(bytes); if (corrupt) payload[0] ^= 1;
    return new Response(payload);
  };
  await assert.rejects(adapter.fetchRankedBenchmarkRows("diamond", 20), /integrity/);
  corrupt = false;
  const loaded = await adapter.fetchRankedBenchmarkRows("diamond", 20);
  assert.deepEqual(loaded, shard.rows, "verified gzip expands to the exact shard");
  assert.equal(await adapter.fetchRankedBenchmarkRows("diamond", 20), loaded, "immutable successful shard is reused");
  assert.deepEqual(await adapter.fetchRankedBenchmarkRows("master", 20), [], "missing tier stays unavailable without downloading another shard");
  assert.equal(calls.filter(call => call.url === index.path).length, 2, "failed integrity is retryable; successful data is cached");
  assert.equal(calls[0].options.cache, "no-cache");
  assert.equal(calls[1].options.cache, "force-cache");
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--dataset-root"), "Usage: verify-ranked-benchmarks.mjs [--dataset-root DIRECTORY]");
  if (args.length) {
    const directory = path.resolve(args[1]);
    const published = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    assert.ok(adapter.parseRankedManifest(published), "actual manifest passes the consumer contract");
    let totalRows = 0;
    for (const entry of published.shards) {
      const body = await readFile(path.join(directory, path.basename(entry.path)));
      assert.equal(body.length, entry.bytes, entry.path);
      assert.equal(createHash("sha256").update(body).digest("hex"), entry.sha256, entry.path);
      const data = JSON.parse(gunzipSync(body));
      assert.ok(adapter.parseRankedShard(data, published, entry.tier, entry.characterId), entry.path);
      assert.equal(data.rows.length, entry.rows, entry.path); totalRows += data.rows.length;
    }
    console.log("Actual ranked publication accepted by consumer: " + published.shards.length + " shards / " + totalRows + " exact rows.");
  }
  console.log("Ranked benchmark adapter passed: exact dimensions, measured zeros, missing attempts/outcomes, anonymous samples, malformed/version rejection, gzip hashes, retries, and lazy cache.");
} finally { globalThis.fetch = originalFetch; await server.close(); }
