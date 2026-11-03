import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRankedJob, rankedJobStatus, requestRankedPause } from "./ranked-baseline-job.mjs";

const temporary = await mkdtemp(path.join(tmpdir(), "ranked-job-check-"));
const json = value => JSON.stringify(value, null, 2) + "\n";
const read = async file => JSON.parse(await readFile(file, "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");
const worker = String.raw`
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const cache = args.get("--cache"), startedAt = new Date().toISOString();
const read = async file => { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const write = (file, value) => writeFile(file, JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pause = async () => (await read(path.join(cache, "ranked-job-control.json")))?.pauseRequested;
const mode = await read(path.join(cache, "fake-mode.json")) ?? {};
if (role === "download") {
  const source = await read(args.get("--manifest")), archive = source.files[0];
  await mkdir(path.join(cache, "archives"), { recursive: true });
  await writeFile(path.join(cache, "archives", archive.sha256 + ".tar.gz.partial"), "p");
  while (!await pause() && !await read(path.join(cache, "fake-build-complete.json"))) await wait(15);
  const status = await pause() ? "paused" : "completed";
  if (status === "completed") for (const file of source.files) await writeFile(path.join(cache, "archives", file.sha256 + ".tar.gz"), file.fixtureContent);
  await write(path.join(cache, "download-receipt.json"), { status, startedAt });
} else {
  const datasetId = args.get("--dataset-id"), output = args.get("--output"), progressFile = path.join(cache, datasetId + ".progress.local.json");
  await wait(mode.startDelay ?? 50);
  if (mode.fail) process.exit(3);
  if (mode.silentExit) process.exit(0);
  let count = (await read(path.join(cache, "fake-count.json")))?.count ?? 0, completedThisRun = 0;
  const report = (status, current = count) => write(progressFile, { status, startedAt, updatedAt: new Date().toISOString(), datasetId, output,
    parserFingerprint: "a".repeat(64), pending: 0, archivesFinished: current, archivesTotal: 3, archivesCompletedThisRun: completedThisRun,
    uniqueReplays: current * 2, completedSourceBytes: current * 2, totalSourceBytes: 6 });
  if (mode.rehydrate) {
    await report("running", 0); await write(path.join(cache, "fake-revalidating.json"), { ready: true });
    while (!await pause() && !await read(path.join(cache, "fake-continue.json"))) await wait(15);
  }
  await report("running");
  while (count < 3) {
    if (await pause()) { await report("paused"); process.exit(0); }
    await wait(60);
    if (mode.waitForPause) continue;
    count++; completedThisRun++; await write(path.join(cache, "fake-count.json"), { count }); await report("running");
    if (count < 3 && Number(args.get("--pause-after-archives")) > 0 && completedThisRun >= Number(args.get("--pause-after-archives"))) { await report("paused"); process.exit(0); }
  }
  const config = await read(path.join(cache, "ranked-job-config.local.json")), bytes = Buffer.from("fixture");
  const sha = value => createHash("sha256").update(value).digest("hex");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "diamond-all.json.gz"), bytes);
  const manifest = { datasetId, source: { sourceManifestSha256: config.sourceManifestSha256 }, shards: [{ path: "/ranked/" + datasetId + "/diamond-all.json.gz", bytes: bytes.length, sha256: sha(bytes) }] };
  await write(path.join(output, "manifest.json"), manifest);
  const manifestSha256 = sha(await readFile(path.join(output, "manifest.json")));
  await write(path.join(cache, datasetId + ".build.local.json"), { ok: true, datasetId, output, manifestSha256, publicationPerformed: false });
  await report("complete"); await write(path.join(cache, "fake-build-complete.json"), { done: true });
}
`;
const downloadScript = path.join(temporary, "download.mjs"), buildScript = path.join(temporary, "build.mjs");
await writeFile(downloadScript, 'const role = "download";\n' + worker);
await writeFile(buildScript, 'const role = "build";\n' + worker);
const dependencies = { downloadScript, buildScript, pollIntervalMs: 10, onProgress() {} };
const activeRuns = [];
async function fixture(name) {
  const cache = path.join(temporary, name); await mkdir(cache);
  const sourceManifest = path.join(cache, "source.json");
  await writeFile(sourceManifest, json({ files: ["aa", "bb", "cc"].map(content => ({ path: "fake-" + content, bytes: 2, sha256: sha(content), fixtureContent: content })), compressedBytes: 6 }));
  return { cache, sourceManifest, output: path.join(cache, "staged"), datasetId: "ranked-fixture-v1", workers: 2, concurrency: 1 };
}
async function until(check, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(message);
}

try {
  const batch = await fixture("batches");
  const first = await runRankedJob("run", { ...batch, pauseAfterArchives: 1 }, dependencies);
  assert.equal(first.status, "paused"); assert.equal(first.controller.alive, false); assert.equal(first.activeChildren.length, 0);
  assert.equal(first.checkpoints.build.archivesFinished, 1); assert.equal(first.checkpoints.download.status, "paused");
  assert.equal(first.progress.processingSourceVolumePercent, 100 / 3); assert.equal(first.progress.downloadedVerifiedBytes, 0);
  assert.equal(first.publicationPerformed, false); assert.equal(first.resumeReady, true);
  assert.equal(await stat(batch.output).catch(() => null), null, "pause creates no partial public export");
  assert.ok((await readdir(path.join(batch.cache, "archives"))).some(file => file.endsWith(".partial")), "download checkpoint survives pause");
  const saved = await read(path.join(batch.cache, "ranked-job-config.local.json"));
  assert.equal(saved.workers, 2); assert.equal(saved.concurrency, 1); assert.equal(saved.output, batch.output);
  const checkpointFile = path.join(batch.cache, "ranked-job-checkpoint.local.json");
  const firstCheckpoint = await read(checkpointFile);
  assert.equal(firstCheckpoint.completedSourceBytes, 2); assert.equal(firstCheckpoint.uniqueReplays, 2);
  await rm(checkpointFile); // Simulate adopting a paused older controller without checkpoint history.
  await writeFile(path.join(batch.cache, "fake-mode.json"), json({ rehydrate: true }));
  const secondRun = runRankedJob("resume", { cache: batch.cache }, dependencies); void secondRun.catch(() => {});
  activeRuns.push({ cache: batch.cache, run: secondRun });
  await until(async () => Boolean(await stat(path.join(batch.cache, "fake-revalidating.json")).catch(() => null)), "fake revalidation did not start");
  const beforeStatus = await read(checkpointFile);
  const revalidating = await rankedJobStatus(batch.cache);
  assert.equal(revalidating.progress.phase, "revalidating-cache"); assert.equal(revalidating.progress.floorApplied, true);
  assert.equal(revalidating.progress.processingSourceVolumePercent, first.progress.processingSourceVolumePercent, "overall completed work does not regress while the same parser reloads receipts");
  assert.equal(revalidating.progress.observedUniqueReplays, 2); assert.equal(revalidating.progress.currentRun.observedUniqueReplays, 0);
  assert.equal(revalidating.progress.currentRun.completedSourceBytes, 0); assert.equal(revalidating.progress.previouslyCompleted.newlyVerifiedThisRun, false);
  assert.deepEqual(await read(checkpointFile), beforeStatus, "read-only status does not promote or modify the saved checkpoint");
  await writeFile(path.join(batch.cache, "fake-continue.json"), json({ continue: true }));
  const second = await secondRun;
  assert.equal(second.status, "paused"); assert.equal(second.checkpoints.build.archivesFinished, 2, "saved batch cadence resumes from prior checkpoint");
  assert.equal(second.progress.floorApplied, false); assert.equal(second.progress.currentRun.completedSourceBytes, 4, "current-run counters replace the floor after catching up");
  assert.equal((await read(path.join(batch.cache, "ranked-job-config.local.json"))).sourceManifestSha256, saved.sourceManifestSha256);
  // Read-only status fixtures exercise stale/mismatched identity and failure
  // boundaries without changing either running fake workers or the real job.
  const monitor = await fixture("status-identity"), monitorConfig = { ...saved, ...monitor };
  const monitorState = { schemaVersion: 1, token: "status-fixture", controllerPid: process.pid,
    startedAt: new Date(Date.now() - 100).toISOString(), heartbeatAt: new Date().toISOString(), status: "running", children: {} };
  const monitorCheckpoint = await read(checkpointFile);
  const monitorProgressFile = path.join(monitor.cache, monitor.datasetId + ".progress.local.json");
  const monitorCheckpointFile = path.join(monitor.cache, "ranked-job-checkpoint.local.json");
  const monitorProgress = { ...second.checkpoints.build, output: monitor.output, completedSourceBytes: 0, uniqueReplays: 0, archivesFinished: 0 };
  await writeFile(path.join(monitor.cache, "ranked-job-config.local.json"), json(monitorConfig));
  await writeFile(path.join(monitor.cache, "ranked-job-state.local.json"), json(monitorState));
  await writeFile(path.join(monitor.cache, "ranked-job-lock.local.json"), json({ controllerPid: process.pid, token: monitorState.token }));
  await writeFile(monitorCheckpointFile, json(monitorCheckpoint));
  await writeFile(monitorProgressFile, json({ ...monitorProgress, startedAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 500).toISOString() }));
  const staleProgress = await rankedJobStatus(monitor.cache);
  assert.equal(staleProgress.progress.phase, "checking-parser-identity"); assert.equal(staleProgress.progress.floorApplied, false);
  assert.equal(staleProgress.progress.completedSourceBytes, null); assert.equal(staleProgress.progress.currentRun, null);
  assert.equal(staleProgress.progress.previouslyCompleted.completedSourceBytes, 4, "stale progress is labelled historical, never current-run verification");
  const freshProgress = { ...monitorProgress, startedAt: new Date(Date.now() - 10).toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(monitorProgressFile, json(freshProgress));
  assert.equal((await rankedJobStatus(monitor.cache)).progress.floorApplied, true);
  await writeFile(path.join(monitor.cache, "ranked-job-state.local.json"), json({ ...monitorState, status: "paused" }));
  await writeFile(path.join(monitor.cache, "ranked-job-lock.local.json"), json({ controllerPid: 2147483647, token: "finished" }));
  await writeFile(monitorProgressFile, json({ ...freshProgress, status: "paused" }));
  const pausedAgain = await rankedJobStatus(monitor.cache);
  assert.equal(pausedAgain.status, "paused"); assert.equal(pausedAgain.progress.phase, "paused", "a second pause during revalidation must not appear to keep running");
  assert.equal(pausedAgain.progress.floorApplied, true); assert.equal(pausedAgain.progress.completedWorkBasis, "previous-checkpoint-and-current-run");
  assert.equal(pausedAgain.progress.completedSourceBytes, 4); assert.equal(pausedAgain.progress.currentRun.completedSourceBytes, 0);
  await writeFile(path.join(monitor.cache, "ranked-job-state.local.json"), json(monitorState));
  await writeFile(path.join(monitor.cache, "ranked-job-lock.local.json"), json({ controllerPid: process.pid, token: monitorState.token }));
  await writeFile(monitorProgressFile, json({ ...freshProgress, parserFingerprint: "b".repeat(64) }));
  const changedParser = await rankedJobStatus(monitor.cache);
  assert.equal(changedParser.progress.phase, "parser-changed"); assert.equal(changedParser.progress.floorApplied, false);
  assert.equal(changedParser.progress.completedSourceBytes, 0);
  await writeFile(monitorProgressFile, json(freshProgress));
  const originalSource = await readFile(monitor.sourceManifest);
  await writeFile(monitor.sourceManifest, Buffer.concat([originalSource, Buffer.from("\n")]));
  const changedSource = await rankedJobStatus(monitor.cache);
  assert.equal(changedSource.progress.phase, "source-changed"); assert.equal(changedSource.progress.floorApplied, false);
  assert.equal(changedSource.progress.completedSourceBytes, null);
  await writeFile(monitor.sourceManifest, originalSource);
  await writeFile(path.join(monitor.cache, "ranked-job-state.local.json"), json({ ...monitorState, status: "failed", error: "fixture revalidation failed" }));
  const failedRevalidation = await rankedJobStatus(monitor.cache);
  assert.equal(failedRevalidation.status, "failed"); assert.equal(failedRevalidation.progress.phase, "failed");
  assert.equal(failedRevalidation.progress.floorApplied, false); assert.equal(failedRevalidation.progress.completedSourceBytes, 0);
  assert.equal(failedRevalidation.progress.previouslyCompleted.completedSourceBytes, 4, "failure retains history without presenting it as current success");
  await writeFile(path.join(monitor.cache, "ranked-job-state.local.json"), json({ ...monitorState, children: { build: { pid: process.pid, status: "running" } } }));
  await writeFile(path.join(monitor.cache, "ranked-job-lock.local.json"), json({ controllerPid: 2147483647, token: "dead" }));
  const orphanedRevalidation = await rankedJobStatus(monitor.cache);
  assert.equal(orphanedRevalidation.status, "orphaned-children"); assert.equal(orphanedRevalidation.progress.floorApplied, false);
  assert.deepEqual(await read(monitorCheckpointFile), monitorCheckpoint, "all status paths remain read-only");
  await writeFile(path.join(batch.cache, "fake-mode.json"), json({}));
  const third = await runRankedJob("resume", { cache: batch.cache, pauseAfterArchives: 0 }, dependencies);
  assert.equal(third.status, "build-complete"); assert.equal(third.publicationPerformed, false); assert.equal(third.resumeReady, false);
  assert.equal(third.progress.downloadedVerifiedPercent, 100); assert.equal(third.progress.processingSourceVolumePercent, 100);
  assert.equal(third.checkpoints.build.archivesFinished, 3);
  assert.equal((await runRankedJob("resume", { cache: batch.cache }, dependencies)).status, "build-complete", "completed build is not launched again");
  await writeFile(path.join(batch.output, "diamond-all.json.gz"), "corrupt");
  assert.equal((await rankedJobStatus(batch.cache)).build, null, "missing or corrupt shards are not a completed build");
  await assert.rejects(runRankedJob("resume", { cache: batch.cache }, dependencies), /incomplete export/);

  const explicit = await fixture("explicit-pause");
  await writeFile(path.join(explicit.cache, "fake-mode.json"), json({ waitForPause: true }));
  const running = runRankedJob("run", explicit, dependencies);
  activeRuns.push({ cache: explicit.cache, run: running });
  void running.catch(() => {}); // The test awaits this after exercising status.
  await until(async () => (await rankedJobStatus(explicit.cache)).activeChildren.length === 2, "fake workers did not start");
  const during = await rankedJobStatus(explicit.cache); assert.equal(during.status, "running"); assert.ok(during.controller.alive);
  await assert.rejects(runRankedJob("resume", { cache: explicit.cache }, dependencies), /already owns/);
  const requested = await requestRankedPause(explicit.cache); assert.equal(requested.pauseRequested, true); assert.equal(requested.status, "pause-requested");
  assert.equal((await running).status, "paused");
  await writeFile(path.join(explicit.cache, "ranked-job-lock.local.json"), json({ controllerPid: 2147483647, token: "dead-controller" }));
  const stale = await rankedJobStatus(explicit.cache); assert.equal(stale.controller.alive, false); assert.equal(stale.resumeReady, true);
  const oldState = await read(path.join(explicit.cache, "ranked-job-state.local.json"));
  await writeFile(path.join(explicit.cache, "ranked-job-state.local.json"), json({ ...oldState, children: { build: { pid: process.pid, status: "running" } } }));
  assert.equal((await rankedJobStatus(explicit.cache)).status, "orphaned-children");
  await assert.rejects(runRankedJob("resume", { cache: explicit.cache }, dependencies), /children are still alive/);
  await writeFile(path.join(explicit.cache, "ranked-job-state.local.json"), json(oldState));
  await writeFile(explicit.sourceManifest, json({ changed: true }));
  await assert.rejects(runRankedJob("resume", { cache: explicit.cache }, dependencies), /source manifest changed/);

  const failed = await fixture("failed-child"); await writeFile(path.join(failed.cache, "fake-mode.json"), json({ fail: true }));
  const failure = await runRankedJob("run", failed, dependencies);
  assert.equal(failure.status, "failed"); assert.equal(failure.activeChildren.length, 0); assert.equal(failure.state.children.build.exitCode, 3);
  assert.equal(failure.checkpoints.download.status, "paused", "worker failure checkpoints the sibling instead of leaving it running");
  assert.equal(failure.resumeReady, true);
  const silent = await fixture("silent-child"); await writeFile(path.join(silent.cache, "fake-mode.json"), json({ silentExit: true }));
  const silentFailure = await runRankedJob("run", silent, dependencies);
  assert.equal(silentFailure.status, "failed"); assert.equal(silentFailure.activeChildren.length, 0);
  assert.match(silentFailure.state.children.build.error, /without a current pause/);
  const interrupted = await fixture("signal-pause");
  await writeFile(path.join(interrupted.cache, "fake-mode.json"), json({ waitForPause: true }));
  const signalRun = runRankedJob("run", interrupted, dependencies); void signalRun.catch(() => {});
  activeRuns.push({ cache: interrupted.cache, run: signalRun });
  await until(async () => (await rankedJobStatus(interrupted.cache)).activeChildren.length === 2, "signal workers did not start");
  process.emit("SIGINT");
  const signalResult = await signalRun; assert.equal(signalResult.status, "paused"); assert.equal(signalResult.activeChildren.length, 0);
  assert.match(signalResult.control.reason, /SIGINT|pause checkpoint/);
  const spawnFailure = await fixture("spawn-failure");
  const spawnResult = await runRankedJob("run", spawnFailure, { ...dependencies, nodeExecutable: path.join(temporary, "absent-node.exe") });
  assert.equal(spawnResult.status, "failed"); assert.equal(spawnResult.activeChildren.length, 0);
  const unsafe = await fixture("unsafe-output");
  await assert.rejects(runRankedJob("run", { ...unsafe, output: path.join(unsafe.cache, "public", "ranked") }, dependencies), /outside public/);
  console.log("Ranked job controller passed: checkpoint batches/resume, exact saved config, exclusive ownership, orphan safety, explicit pause, failure drain, verified completion, non-regressing progress during identity-checked cache revalidation, truthful current-run counters, and no publication.");
} finally {
  for (const item of activeRuns) await requestRankedPause(item.cache).catch(() => {});
  await Promise.allSettled(activeRuns.map(item => item.run));
  // The uniquely created test directory is the only recursive cleanup target.
  assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(temporary, { recursive: true, force: true });
}
