/** Explicit replay retries against the real pipeline and storage helpers.
 * Synthetic files, a deterministic worker, and an in-memory Dexie test double:
 * no browser, credentials, or private replay files required.
 */
import assert from "node:assert/strict";
import { File } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const temp = await mkdtemp(join(tmpdir(), "ssbm-replay-retry-"));
const server = await createServer({
  configFile: false, envDir: temp, cacheDir: join(temp, "vite"),
  server: { middlewareMode: true, hmr: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { db, allRecords, putRecords, pruneDuplicates } = await server.ssrLoadModule("/src/lib/db.ts");
  const { runParsePipeline, RecordSaveError } = await server.ssrLoadModule("/src/lib/pool.ts");
  const { failedReplayIds } = await server.ssrLoadModule("/src/lib/types.ts");
  const { dedupeRecords } = await server.ssrLoadModule("/src/lib/dedupe.ts");

  // Clone reads like IndexedDB does, and roll back the fake store on rejection.
  // This exercises the real putRecords/pruneDuplicates transaction bodies.
  const seen = new Set();
  let packs = new Map();
  let nextPack = 0;
  let rejectNextAdd = false;
  db.seen.toCollection = () => ({ primaryKeys: async () => [...seen] });
  db.seen.bulkPut = async (rows) => { for (const row of rows) seen.add(row.id); };
  db.packs.toArray = async () => structuredClone([...packs.values()]);
  db.packs.orderBy = () => ({ last: async () => structuredClone([...packs.values()].at(-1)) });
  db.packs.put = async (pack) => { packs.set(pack.id, structuredClone(pack)); };
  db.packs.delete = async (id) => { packs.delete(id); };
  db.packs.clear = async () => { packs.clear(); };
  db.packs.add = async (pack) => {
    if (rejectNextAdd) { rejectNextAdd = false; throw new Error("synthetic storage failure"); }
    const id = ++nextPack;
    packs.set(id, structuredClone({ ...pack, id }));
    return id;
  };
  db.packs.bulkAdd = async (rows) => { for (const row of rows) await db.packs.add(row); };
  db.transaction = async (...args) => {
    const beforePacks = structuredClone(packs);
    const beforeSeen = [...seen];
    try { return await args.at(-1)(); }
    catch (error) {
      packs = beforePacks;
      seen.clear();
      for (const id of beforeSeen) seen.add(id);
      throw error;
    }
  };

  const attempts = [];
  let verdict = () => ({ ok: false, error: "original parser failure" });
  globalThis.Worker = class {
    postMessage(job) {
      attempts.push(job.id);
      const result = { id: job.id, path: job.path, ...verdict(job) };
      queueMicrotask(() => this.onmessage({ data: result }));
    }
    terminate() {}
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { hardwareConcurrency: 1 } });

  const replay = (name) => {
    const file = new File(["synthetic replay"], name, { lastModified: 1000 });
    return { file, path: name, format: "slp", id: `${name}|${file.size}|${file.lastModified}` };
  };
  const success = (job, playedAt = null) => ({
    ok: true,
    record: { id: job.id, path: job.path, playedAt, durationFrames: 3600,
      stageId: 31, gameType: "direct", isTeams: false, players: [],
      winnerIndex: null, winnerTeamId: null, statsVersion: 3 },
  });
  const run = async (files, retryFailed = false, signal) => {
    let progress;
    await runParsePipeline(files, (p) => { progress = p; }, signal, { retryFailed });
    return progress;
  };
  const first = replay("Game_20261007.slp");
  const second = replay("Game_20261008.slp");

  assert.equal((await run([first])).failed, 1);
  assert.equal(failedReplayIds(await allRecords()).size, 1);
  assert.ok(seen.has(first.id));
  const background = await run([first]);
  assert.equal(background.total, 0);
  assert.equal(background.skippedCached, 1);
  assert.equal(attempts.length, 1, "background scans never retry cached corruption");

  verdict = () => ({ ok: false, error: "retry still fails" });
  assert.equal((await run([first], true)).failed, 1);
  let rows = await allRecords();
  assert.equal(rows.length, 1, "repeated failure replaces the old tombstone");
  assert.equal(rows[0].parseError, "retry still fails", "the diagnostic describes the latest parse");

  verdict = (job) => success(job);
  await run([second], true);
  assert.equal(attempts.filter((id) => id === first.id).length, 2, "manual picks retry only selected files");
  assert.equal(failedReplayIds(await allRecords()).size, 1);

  verdict = () => ({ ok: false, incomplete: true });
  assert.equal((await run([first], true)).deferred, 1);
  verdict = () => ({ ok: false, readFailed: true });
  assert.equal((await run([first], true)).unreadable, 1);
  assert.equal((await allRecords()).find((r) => r.id === first.id).parseError, "retry still fails");
  const beforeBackground = attempts.length;
  await run([first]);
  assert.equal(attempts.length, beforeBackground, "deferred/unreadable retries retain the background skip");

  const controller = new AbortController();
  controller.abort();
  await run([first], true, controller.signal);
  assert.equal(attempts.length, beforeBackground, "cancelling never erases the cached failure");
  assert.equal(failedReplayIds(await allRecords()).size, 1);

  verdict = (job) => success(job);
  assert.equal((await run([first], true)).failed, 0);
  rows = await pruneDuplicates(await allRecords());
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.id === first.id).length, 1);
  assert.equal(rows.find((r) => r.id === first.id).playedAt, null);
  assert.equal(failedReplayIds(rows).size, 0, "a dateless success still replaces its failed same-ID copy");
  assert.equal(dedupeRecords(rows).length, 2);
  const afterRecovery = attempts.length;
  await run([first, second], true);
  assert.equal(attempts.length, afterRecovery, "healthy cached games are never forced through retries");

  // A pre-existing mixed cache must not turn a healthy same-ID record into a
  // new failure, regardless of which row appeared first in the packed cache.
  const staleFailure = { ...rows[0], parseError: "stale failure", players: [] };
  assert.equal(failedReplayIds([staleFailure, rows[0]]).size, 0);
  assert.equal(failedReplayIds([rows[0], staleFailure]).size, 0);
  await putRecords([staleFailure]);
  await run([first, second], true);
  assert.equal(attempts.length, afterRecovery);

  // Successful timestamped retries and repeated failures also stay one row
  // after save/reload; this cannot depend on gameKey matching a tombstone.
  const third = replay("Game_20261009.slp");
  verdict = () => ({ ok: false, error: "old version" });
  await run([third]);
  verdict = (job) => success(job, "2026-10-09T12:00:00Z");
  await run([third], true);
  rows = await pruneDuplicates(await allRecords());
  assert.equal(rows.filter((r) => r.id === third.id).length, 1);
  assert.equal(rows.find((r) => r.id === third.id).parseError, undefined);
  assert.equal(failedReplayIds(rows).size, 0);

  const recovered = rows.find((r) => r.id === third.id);
  await putRecords([{ ...recovered, parseError: "late retry failure", playedAt: null }], new Set([third.id]));
  rows = await pruneDuplicates(await allRecords());
  assert.deepEqual(rows.find((r) => r.id === third.id), recovered,
    "a successful copy arriving before a failed retry commit survives storage and dedup");
  assert.equal(failedReplayIds(rows).size, 0);

  // Force a new pack so a failed retry save rolls back removal of its old row.
  packs.clear(); seen.clear();
  verdict = () => ({ ok: false, error: "preserve on write failure" });
  await run([first]);
  rejectNextAdd = true;
  verdict = (job) => success(job);
  await assert.rejects(run([first], true), RecordSaveError);
  assert.equal((await allRecords())[0].parseError, "preserve on write failure");
  assert.ok(seen.has(first.id));

  // While one batch is saving, later batches may queue behind it. Aborting
  // must prevent those queued transactions from starting after a reset.
  packs.clear(); seen.clear();
  const transaction = db.transaction;
  let releaseStorage, storageStarted, storageCompleted, parsedAll;
  const blockedStorage = new Promise((resolve) => { releaseStorage = resolve; });
  const started = new Promise((resolve) => { storageStarted = resolve; });
  const completed = new Promise((resolve) => { storageCompleted = resolve; });
  const parsed = new Promise((resolve) => { parsedAll = resolve; });
  let transactions = 0;
  let fullAttempts = 0;
  db.transaction = async (...args) => {
    const ordinal = ++transactions;
    if (ordinal === 1) { storageStarted(); await blockedStorage; }
    try { return await transaction(...args); }
    finally { if (ordinal === 1) storageCompleted(); }
  };
  verdict = (job) => {
    if (job.mode === "full" && ++fullAttempts === 500) parsedAll();
    return success(job);
  };
  const abortQueued = new AbortController();
  const pending = run(Array.from({ length: 500 }, (_, i) => replay(`queued-${i}.slp`)), false, abortQueued.signal);
  await started;
  await parsed;
  await new Promise(setImmediate); // let the last result enqueue the second batch
  abortQueued.abort();
  releaseStorage();
  await pending;
  await completed;
  await new Promise(setImmediate);
  assert.equal(transactions, 1, "aborted queued batches never begin storage transactions");
  assert.equal((await allRecords()).length, 250, "only the already-started transaction can finish");

  console.log("Replay retry checks passed: explicit/background selection, repeated failure, deferred/unreadable/cancelled attempts, dateless and timestamped recovery, healthy-copy protection, deduplication, failed-save rollback, and queued-write cancellation.");
} finally {
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
