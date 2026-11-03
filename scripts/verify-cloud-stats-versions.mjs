/** Exercise real cloud reconciliation against an in-memory Supabase boundary. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const temporary = await mkdtemp(join(tmpdir(), "ssbm-cloud-versions-"));
const packs = new Map();
const saved = [];
const uploads = [];
const queries = [];
let tick = 1;
const timestamp = () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;
const store = (key, rec, version = rec.statsVersion, bucket = 1) => {
  const pack = packs.get(bucket) ?? { bucket, records: {}, versions: {}, updated_at: timestamp() };
  pack.records[key] = structuredClone(rec); pack.versions[key] = version; pack.updated_at = timestamp();
  packs.set(bucket, pack);
};
const fake = {
  from(table) {
    assert.equal(table, "game_record_packs");
    const options = { select: "", range: null, buckets: null, since: null };
    const query = {
      select(value) { options.select = value; return query; },
      order() { return query; },
      range(from, to) { options.range = [from, to]; return query; },
      in(column, value) { assert.equal(column, "bucket"); options.buckets = value; return query; },
      gt(column, value) { assert.equal(column, "updated_at"); options.since = value; return query; },
      abortSignal() { return query; },
      then(resolve, reject) {
        queries.push(structuredClone(options));
        let rows = [...packs.values()].sort((a, b) => a.bucket - b.bucket);
        if (options.buckets) rows = rows.filter(p => options.buckets.includes(p.bucket));
        if (options.since) rows = rows.filter(p => p.updated_at > options.since);
        if (options.range) rows = rows.slice(options.range[0], options.range[1] + 1);
        if (!options.select.includes("records")) rows = rows.map(({ records: _records, ...rest }) => rest);
        return Promise.resolve({ data: structuredClone(rows), error: null }).then(resolve, reject);
      },
    };
    return query;
  },
  async rpc(name, { entries }) {
    assert.equal(name, "merge_game_record_entries");
    uploads.push(...structuredClone(entries));
    // Mirror the production RPC's monotonic version guard, including races.
    for (const entry of entries) {
      const bucket = bucketFor(entry.game_key);
      const previous = packs.get(bucket)?.versions[entry.game_key] ?? -1;
      if (entry.stats_version > previous) store(entry.game_key, entry.data, entry.stats_version, bucket);
    }
    return { data: entries.length, error: null };
  },
};
globalThis.__ssbmCloudVersionTest = {
  supabase: fake,
  putRecords: async records => { saved.push(...structuredClone(records)); },
  pruneDuplicates: async () => {},
};
const server = await createServer({
  configFile: false, envDir: temporary, cacheDir: join(temporary, "vite"),
  server: { middlewareMode: true, hmr: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "cloud-version-test-boundaries",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer?.replaceAll("\\", "/").endsWith("/src/lib/cloudSync.ts")) return null;
      if (source === "./supabase") return "\0cloud-version-supabase";
      if (source === "./db") return "\0cloud-version-db";
      return null;
    },
    load(id) {
      if (id === "\0cloud-version-supabase") return "export const supabase = globalThis.__ssbmCloudVersionTest.supabase;";
      if (id === "\0cloud-version-db") return "export const { putRecords, pruneDuplicates } = globalThis.__ssbmCloudVersionTest;";
      return null;
    },
  }],
});
let bucketFor;
try {
  const { syncRecords, restoreCloudRecords, gameRecordBucket, isSyncable } = await server.ssrLoadModule("/src/lib/cloudSync.ts");
  const { gameKey } = await server.ssrLoadModule("/src/lib/dedupe.ts");
  const { CURRENT_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  bucketFor = gameRecordBucket;
  const codes = new Set(["ME#1"]);
  const record = (statsVersion, id = "game", extras = {}) => ({
    id, path: `${id}.slp`, playedAt: null, statsVersion, isTeams: false, stageId: 31,
    players: [{ connectCode: "ME#1", port: 1, characterId: 2, techs: {}, actions: { crouchCancels: 0 } },
      { connectCode: "OPP#1", port: 2, characterId: 9, techs: {}, actions: { crouchCancels: 0 } }],
    ...extras,
  });
  const reset = () => { packs.clear(); saved.length = 0; uploads.length = 0; queries.length = 0; tick = 1; };
  const remote = (rec, version = rec.statsVersion) => store(gameKey(rec), rec, version, bucketFor(gameKey(rec)));
  const baseline = record(6), previousAnalysis = record(7), previousRevision = record(8), analyzed = record(9, "game", { players: record(9).players.map(p => ({ ...p, defense: { ledge: {}, oos: {}, shieldExits: {} } })) });

  reset();
  let result = await syncRecords([baseline], codes);
  assert.equal(result.pushed, 1);
  assert.equal(uploads[0].stats_version, 6);
  assert.equal(uploads[0].data.statsVersion, 6, "baseline upload must never be stamped as analyzed");
  assert.equal(result.knowledge.versions.get("game"), 6);
  assert.ok(isSyncable(baseline, codes));
  assert.ok(isSyncable(previousAnalysis, codes), "v7 baseline may still sync without claiming corrected coverage");
  assert.ok(isSyncable(previousRevision, codes), "v8 baseline may still sync without claiming current interaction coverage");
  assert.ok(isSyncable(analyzed, codes));
  assert.equal(isSyncable(record(5), codes), false);

  reset(); remote(baseline);
  result = await syncRecords([analyzed], codes);
  assert.equal(result.pushed, 1, "analyzed payload upgrades same remote game key");
  assert.equal(uploads[0].stats_version, 9);
  assert.equal(result.knowledge.versions.get("game"), 9);
  assert.deepEqual(result.pulled, []);

  reset(); remote(analyzed);
  result = await syncRecords([baseline], codes);
  assert.equal(result.pushed, 0, "baseline cannot overwrite analyzed cloud copy");
  assert.equal(result.pulled.length, 1, "same-key remote upgrade must be pulled");
  assert.deepEqual(result.pulled[0], analyzed);
  assert.deepEqual(saved, [analyzed]);

  reset(); remote(baseline);
  result = await syncRecords([baseline], codes);
  assert.equal(result.pushed, 0); assert.deepEqual(result.pulled, []);
  const baselineKnowledge = result.knowledge;
  remote(analyzed);
  result = await syncRecords([baseline], codes, baselineKnowledge);
  assert.equal(result.pushed, 0); assert.deepEqual(result.pulled, [analyzed]);
  assert.equal(result.knowledge.versions.get("game"), 9, "delta sync updates persisted version knowledge");
  assert.ok(queries.some(q => q.since === baselineKnowledge.cursor));

  reset(); remote(baseline);
  result = await syncRecords([baseline], codes);
  const knownBaseline = result.knowledge;
  result = await syncRecords([analyzed], codes, knownBaseline);
  assert.equal(result.pushed, 1, "same-key local upgrade pushes even with unchanged remote cursor");
  assert.equal(result.knowledge.versions.get("game"), 9);
  result = await syncRecords([analyzed], codes, result.knowledge);
  assert.equal(result.pushed, 0, "acknowledged upgrade does not repeat");

  const parserCorrected = record(10);
  reset(); remote(analyzed);
  result = await syncRecords([parserCorrected], codes);
  assert.equal(result.pushed, 1, "v10 parser correction upgrades compatible v9 cloud records");
  assert.equal(uploads[0].stats_version, 10);
  assert.equal(uploads[0].data.statsVersion, 10);
  result = await syncRecords([analyzed], codes, result.knowledge);
  assert.equal(result.pushed, 0, "a late v9 response cannot downgrade corrected parser output");
  reset(); remote(parserCorrected);
  result = await syncRecords([analyzed], codes);
  assert.deepEqual(result.pulled, [parserCorrected], "v10 corrections restore across devices without relabelling v9");

  reset(); remote(record(CURRENT_STATS_VERSION + 1));
  result = await syncRecords([analyzed], codes);
  assert.equal(result.pushed, 0, "future remote payload also cannot be downgraded");
  assert.deepEqual(result.pulled, [], "unsupported future payload is not persisted by reconciliation");
  assert.equal(result.knowledge.versions.get("game"), CURRENT_STATS_VERSION + 1);

  reset(); remote(baseline);
  result = await restoreCloudRecords();
  assert.deepEqual(result, [baseline]); assert.deepEqual(saved, [baseline]);
  assert.equal(saved[0].statsVersion, 6, "restore preserves actual version");
  reset(); remote(analyzed);
  result = await restoreCloudRecords();
  assert.deepEqual(saved, [analyzed]);

  for (const previous of [previousAnalysis, previousRevision]) {
    reset(); remote(previous);
    result = await restoreCloudRecords();
    assert.deepEqual(saved, [previous], `v${previous.statsVersion} restore preserves its actual version rather than stamping v9`);
    reset();
    result = await syncRecords([previous], codes);
    assert.equal(uploads[0].stats_version, previous.statsVersion);
    assert.equal(uploads[0].data.statsVersion, previous.statsVersion);
    result = await syncRecords([analyzed], codes, result.knowledge);
    assert.equal(result.pushed, 1, `v9 upgrade replaces a previously acknowledged v${previous.statsVersion}`);
    assert.equal(result.knowledge.versions.get("game"), 9);
    reset(); remote(analyzed);
    result = await syncRecords([previous], codes);
    assert.equal(result.pushed, 0);
    assert.deepEqual(result.pulled, [analyzed], `v${previous.statsVersion} device restores current same-key v9`);
  }

  reset(); remote(baseline, 9);
  await syncRecords([], codes);
  assert.deepEqual(saved, [], "mismatched index/payload version is not persisted");
  await restoreCloudRecords();
  assert.deepEqual(saved, [], "restore also refuses mismatched index/payload versions");

  reset();
  const copiedBase = record(6, "copy-a", { playedAt: "2026-01-01T00:00:00Z" });
  const copiedPrevious = record(8, "copy-b", { playedAt: copiedBase.playedAt });
  const copiedAnalysis = record(9, "copy-z", { playedAt: copiedBase.playedAt });
  result = await syncRecords([copiedBase, copiedPrevious, copiedAnalysis], codes);
  assert.equal(result.pushed, 1); assert.equal(uploads[0].stats_version, 9, "duplicate paths upload the best payload once");
  console.log("Cloud stats-version checks passed: compatible baselines preserved; v9 detector and v10 parser upgrades push/pull; old copies never downgrade newer data.");
} finally {
  await server.close();
  delete globalThis.__ssbmCloudVersionTest;
  await rm(temporary, { recursive: true, force: true });
}
