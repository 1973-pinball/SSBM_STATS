/** Regression: known CPU filtering plus cloud stat-version migration. */
import assert from "node:assert/strict";
import { File } from "node:buffer";
import { encode } from "@shelacek/ubjson";
import { createServer } from "vite";

// Minimal SLP with a real GAME_START player-type byte and no frame data.
function replay(playerTypes) {
  const start = Buffer.alloc(0x321);
  start[0] = 0x36;
  start[1] = 3;
  start[0x0d] = Number(playerTypes.length === 4);
  start.writeUInt16BE(31, 0x13);
  for (let i = 0; i < 4; i++) {
    start[0x65 + i * 0x24] = 2;
    start[0x66 + i * 0x24] = playerTypes[i] ?? 3;
    start[0x67 + i * 0x24] = 4;
    start[0x6e + i * 0x24] = Math.floor(i / 2);
  }
  const sizes = Buffer.from([0x35, 7, 0x36, 3, 0x20, 0x39, 0, 6]);
  const end = Buffer.from([0x39, 2, 0xff, 0, 1, 0xff, 0xff]);
  const raw = Buffer.concat([sizes, start, end]);
  const prefix = Buffer.from([0x7b, 0x55, 3, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c, 0, 0, 0, 0]);
  prefix.writeUInt32BE(raw.length, 11);
  const metadata = Buffer.from(encode({ startAt: "2026-01-01T12:00:00Z", lastFrame: 3600 }));
  const bytes = Buffer.concat([prefix, raw, Buffer.from("U\x08metadata"), metadata, Buffer.from("}")]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const persisted = [];
let packs = [];
globalThis.__cpuRollbackDb = { putRecords: async (rows) => persisted.push(...rows), pruneDuplicates: async (rows) => rows };
globalThis.__cpuRollbackCloud = {
  from(table) {
    assert.equal(table, "game_record_packs");
    let buckets = null;
    let range = null;
    const query = {
      select() { return query; },
      order() { return query; },
      range(from, to) { range = [from, to]; return query; },
      in(column, values) { assert.equal(column, "bucket"); buckets = values; return query; },
      then(resolve) {
        let data = packs.filter((pack) => !buckets || buckets.includes(pack.bucket));
        if (range) data = data.slice(range[0], range[1] + 1);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return query;
  },
  rpc() { throw new Error("Existing compatible cloud games must not be uploaded again"); },
};

const server = await createServer({
  configFile: false, server: { middlewareMode: true }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "mock-private-storage",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer?.endsWith("/src/lib/cloudSync.ts")) return;
      if (source === "./supabase") return "\0rollback-cloud";
      if (source === "./db") return "\0rollback-db";
    },
    load(id) {
      if (id === "\0rollback-cloud") return "export const supabase = globalThis.__cpuRollbackCloud;";
      if (id === "\0rollback-db") return "export const { putRecords, pruneDuplicates } = globalThis.__cpuRollbackDb;";
    },
  }],
});

try {
  const { generateDemoRecords, DEMO_ACCOUNTS } = await server.ssrLoadModule("/src/lib/demo.ts");
  const stats = await server.ssrLoadModule("/src/lib/stats.ts");
  const types = await server.ssrLoadModule("/src/lib/types.ts");
  const { gameKey, dedupeRecords } = await server.ssrLoadModule("/src/lib/dedupe.ts");
  const cloud = await server.ssrLoadModule("/src/lib/cloudSync.ts");
  const parser = await server.ssrLoadModule("/src/lib/parse.ts");

  for (const playerTypes of [[0, 0], [0, 1], [1, 0], [0, 2], [0, 0, 1, 0]]) {
    const buffer = replay(playerTypes);
    const records = [
      parser.parseHeader("fixture", "fixture.slp", buffer),
      await parser.parseHeaderFile("fixture", "fixture.slp", new File([buffer], "fixture.slp")),
      parser.parseReplay("fixture", "fixture.slp", buffer),
    ];
    const expected = playerTypes.map((type) => type === 1 ? true : type === 0 ? false : undefined);
    for (const record of records) {
      assert.deepEqual(record.players.map((player) => player.isCpu), expected);
      assert.equal(types.hasKnownCpu(record), playerTypes.includes(1));
    }
  }
  const records = generateDemoRecords(600);
  const codes = new Set(DEMO_ACCOUNTS.map((account) => account.code));
  const singles = stats.resolveGames(records, codes);
  const teams = stats.resolveTeamGames(records, codes);
  assert.equal(singles.length, 600);
  assert.ok(teams.length > 0);
  stats.overview(singles, singles, types.DEFAULT_FILTERS);
  stats.executionSummary(singles);
  stats.teamOverview(teams);

  for (const [game, resolve] of [[singles[0], stats.resolveGames], [teams[0], stats.resolveTeamGames]]) {
    for (const value of [undefined, false, null, true]) {
      const record = structuredClone(game.rec);
      for (const player of record.players) {
        if (value === undefined) delete player.isCpu;
        else player.isCpu = value;
      }
      assert.equal(resolve([record], codes).length, value === true ? 0 : 1,
        "only explicit CPU evidence may filter a game");
      assert.equal(resolve([record], codes, true).length, 1, "the UI can include a confirmed CPU game again");
      assert.ok(types.hasCurrentStats(record));
      assert.ok(!types.needsStatsRepair(record));
    }
  }

  // CPU evidence from a newly parsed copy survives a stale cloud copy no
  // matter which arrives first. Contrary evidence resolves to unknown and is
  // included; it must stay conflicted through later merges.
  const human = structuredClone(singles[0].rec);
  human.id = "human-copy";
  human.players.forEach((player) => { player.isCpu = false; });
  const cpu = structuredClone(human);
  cpu.id = "cpu-copy";
  cpu.players[1].isCpu = true;
  const legacy = structuredClone(human);
  legacy.id = "legacy-copy";
  legacy.players.forEach((player) => { delete player.isCpu; });
  for (const copies of [[legacy, cpu], [cpu, legacy]]) {
    const merged = dedupeRecords(copies);
    assert.equal(merged.length, 1);
    assert.ok(types.hasKnownCpu(merged[0]));
    assert.equal(stats.resolveGames(merged, codes).length, 0);
  }
  for (const copies of [[human, cpu], [cpu, human], [human, cpu, cpu]]) {
    const merged = dedupeRecords(copies);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].players[1].isCpu, null);
    assert.ok(!types.hasKnownCpu(merged[0]));
    assert.equal(stats.resolveGames(merged, codes).length, 1);
  }

  // Older CPU-release payloads remain visible when restored, but the new
  // crouch-cancel schema must not persist them as current or treat them as
  // syncable. Users with replay folders will reparse them locally.
  const staleHistory = singles.map(({ rec }, i) => {
    const record = structuredClone(rec);
    record.statsVersion = i % 2 ? 2 : 1;
    if (record.statsVersion === 2) record.players.forEach((player) => { player.isCpu = false; });
    return record;
  });
  packs = [{
    bucket: 0,
    records: Object.fromEntries(staleHistory.map((record) => [gameKey(record), record])),
    versions: Object.fromEntries(staleHistory.map((record) => [gameKey(record), record.statsVersion])),
    updated_at: "2026-09-04T12:00:00Z",
  }];
  const restoredStale = await cloud.restoreCloudRecords();
  assert.equal(restoredStale.length, 600);
  assert.equal(persisted.length, 0, "stale cloud versions must not be cached as current");
  persisted.length = 0;

  const staleResult = await cloud.syncRecords(staleHistory.slice(0, 482), codes);
  assert.equal(staleResult.pushed, 0);
  assert.equal(staleResult.pulled.length, 0);

  // A 482-game cache must still recover current cloud games. Exercise the real
  // restore and sync code with in-memory storage.
  const currentHistory = singles.map(({ rec }) => structuredClone(rec));
  packs = [{
    bucket: 0,
    records: Object.fromEntries(currentHistory.map((record) => [gameKey(record), record])),
    versions: Object.fromEntries(currentHistory.map((record) => [gameKey(record), record.statsVersion])),
    updated_at: "2026-09-04T12:00:00Z",
  }];
  const restoredCurrent = await cloud.restoreCloudRecords();
  assert.equal(restoredCurrent.length, 600);
  assert.equal(persisted.length, 600, "current cloud versions must survive a reload");
  persisted.length = 0;
  const local = currentHistory.slice(0, 482);
  const result = await cloud.syncRecords(local, codes);
  assert.equal(result.pushed, 0);
  assert.equal(result.pulled.length, 118);
  assert.equal(persisted.length, 118);
  assert.equal(stats.resolveGames([...local, ...result.pulled], codes).length, 600);
  console.log("Known CPU filtering passed: singles, teams, unknown/conflicting status, dedup, stale cloud migration, and partial-cache recovery.");
} finally {
  await server.close();
  delete globalThis.__cpuRollbackDb;
  delete globalThis.__cpuRollbackCloud;
}
