/** Exercise the v19 upgrade against mixed-version packs and seen markers. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const temporary = await mkdtemp(join(tmpdir(), "ssbm-special-migration-"));
const server = await createServer({
  configFile: false, envDir: temporary, cacheDir: join(temporary, "vite"),
  server: { middlewareMode: true, hmr: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { db } = await server.ssrLoadModule("/src/lib/db.ts");
  const { CURRENT_STATS_VERSION, hasCurrentStats, needsStatsRepair } = await server.ssrLoadModule("/src/lib/types.ts");
  assert.equal(CURRENT_STATS_VERSION, 6);
  const record = (id, statsVersion) => ({
    id, statsVersion, players: [{ techs: {}, actions: { crouchCancels: 0 } }],
  });
  const current = record("current", 6);
  const stale = record("previous", 5);
  const downBOnly = record("down-b-only", 4);
  const legacy = record("legacy", undefined);
  const failure = { id: "failure", players: [], parseError: "unreadable replay" };
  assert.ok(hasCurrentStats(current));
  assert.ok(needsStatsRepair(stale));
  assert.ok(needsStatsRepair(downBOnly));
  assert.ok(needsStatsRepair(legacy));
  assert.equal(needsStatsRepair(failure), false);
  assert.equal(needsStatsRepair({ ...stale, statsLevel: "header" }), false);

  const packs = new Map([
    [1, { id: 1, records: [stale, current, failure] }],
    [2, { id: 2, records: [legacy, downBOnly] }],
  ]);
  const seen = new Set(["current", "previous", "down-b-only", "legacy", "failure", "duplicate-file-marker"]);
  const stores = {
    packs: {
      toArray: async () => structuredClone([...packs.values()]),
      put: async (pack) => { packs.set(pack.id, structuredClone(pack)); },
      delete: async (id) => { packs.delete(id); },
    },
    seen: { bulkDelete: async (ids) => { for (const id of ids) seen.delete(id); } },
  };
  const upgrade = db._versions.find((version) => version._cfg.version === 19)?._cfg.contentUpgrade;
  assert.equal(typeof upgrade, "function", "v19 must register an upgrade");
  await upgrade({ table: (name) => {
    assert.ok(name in stores, `migration must not alter ${name}`);
    return stores[name];
  } });
  assert.deepEqual([...packs.values()], [{ id: 1, records: [current, failure] }]);
  assert.deepEqual([...seen].sort(), ["current", "duplicate-file-marker", "failure"]);
  console.log("Special stats v6 migration passed: v4/v5 payloads and markers released; current data, corruption diagnostics and duplicate markers preserved.");
} finally {
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}
