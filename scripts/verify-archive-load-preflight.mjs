import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectArchiveExportRows, requirePooledProArchiveSupport } from "./lib/archive-load-preflight.mjs";

const scratch = await mkdtemp(path.join(tmpdir(), "ssbm-archive-preflight-"));
try {
  const file = path.join(scratch, "rollups.ndjson");
  await writeFile(file, '\n{"scope":"community"}\r\n{"scope":"player"}\n');
  assert.deepEqual(await inspectArchiveExportRows(file, true), { count: 2, hasPooledPro: false });
  await requirePooledProArchiveSupport({ rpc() { throw new Error("Legacy exports must not call the capability RPC"); } }, false);
  await writeFile(file, '{"scope":"community"}\n{"scope":"pro"}\n{"scope":"player"}\n');
  assert.deepEqual(await inspectArchiveExportRows(file, true), { count: 3, hasPooledPro: true });
  assert.deepEqual(await inspectArchiveExportRows(file, false), { count: 3, hasPooledPro: false }, "other tables do not advertise rollup capabilities");
  const calls = [];
  await requirePooledProArchiveSupport({ async rpc(name) { calls.push(name); return { data: true, error: null }; } }, true);
  assert.deepEqual(calls, ["archive_supports_pooled_pro_rollups"]);
  for (const response of [
    { data: null, error: { code: "PGRST202", message: "Function not found" } },
    { data: null, error: { code: "42501", message: "Permission denied" } },
    { data: false, error: null }, { data: null, error: null }, { data: "true", error: null },
  ]) {
    await assert.rejects(requirePooledProArchiveSupport({ rpc: async () => response }, true), /Apply supabase\/archive-pro-rollups-upgrade.sql/);
  }
  console.log("Archive load preflight passed: pooled-row detection, legacy compatibility, and missing/denied/false capability rejection.");
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith("ssbm-archive-preflight-"));
  await rm(resolved, { recursive: true, force: true });
}
