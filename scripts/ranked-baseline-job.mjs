#!/usr/bin/env node
/** Operator-local supervision only. This command never publishes or kills PIDs. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CACHE = path.join(homedir(), ".cache", "SSBM_DASHBOARD_ranked_baselines");
const FILES = { config: "ranked-job-config.local.json", state: "ranked-job-state.local.json", lock: "ranked-job-lock.local.json", control: "ranked-job-control.json", checkpoint: "ranked-job-checkpoint.local.json" };
const json = value => JSON.stringify(value, null, 2) + "\n";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileAt = (cache, name) => path.join(cache, FILES[name]);
async function readJson(filename, transient = false) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || transient && error instanceof SyntaxError) return null; throw error; }
}
async function writeJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json(value), { flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        // Windows can briefly deny replacing a file while status reads it.
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 50) throw error;
        await delay(20);
      }
    }
  }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
const liveChildren = state => Object.entries(state?.children ?? {})
  .filter(([, child]) => child.status === "running" && alive(child.pid)).map(([name, child]) => ({ name, pid: child.pid }));

/** The OS releases this exclusive lock even on a crash. The JSON PID receipt
 * remains for status and orphan checks, so a stale file is never a mutex. */
async function acquireLock(cache) {
  const key = sha(process.platform === "win32" ? cache.toLowerCase() : cache).slice(0, 28);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\ssbm-ranked-${key}`
    : process.platform === "linux" ? `\0ssbm-ranked-${key}`
      : { host: "127.0.0.1", port: 40000 + Number.parseInt(key.slice(0, 6), 16) % 20000, exclusive: true };
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", error => { if (error.code === "EADDRINUSE") reject(new Error("A ranked job controller already owns this cache lock.")); else reject(error); });
    server.listen(address, resolve);
  });
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function resolvedDestination(destination) {
  try { return await realpath(destination); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(destination); assert.notEqual(parent, destination);
    return path.join(await resolvedDestination(parent), path.basename(destination));
  }
}
function numberOption(value, fallback, minimum, maximum, name) {
  const result = Number(value ?? fallback);
  assert.ok(Number.isSafeInteger(result) && result >= minimum && result <= maximum, `invalid ${name}`);
  return result;
}
async function configuration(cache, options, saved, command) {
  if (command === "resume") {
    assert.ok(saved?.schemaVersion === 1, "No saved job config. Start with run and the desired settings.");
    for (const key of Object.keys(options)) assert.ok(["cache", "pauseAfterArchives"].includes(key), "resume reuses saved settings; only --cache and --pause-after-archives may override them");
  }
  const config = command === "resume" ? { ...saved } : {
    schemaVersion: 1, cache,
    sourceManifest: path.resolve(options.sourceManifest ?? path.join(REPO, "scripts/data/ranked-source-manifest.json")),
    datasetId: options.datasetId ?? "ranked-hf-ef54ddc-v1",
    output: path.resolve(options.output ?? path.join(cache, "staged-v1")),
    workers: numberOption(options.workers, 8, 1, 8, "workers"),
    concurrency: numberOption(options.concurrency, 6, 1, 6, "concurrency"),
    pauseAfterArchives: numberOption(options.pauseAfterArchives, 0, 0, Number.MAX_SAFE_INTEGER, "pause-after-archives"),
  };
  assert.equal(config.cache, cache, "saved cache path differs from this job");
  assert.match(config.datasetId, /^[a-z0-9][a-z0-9.-]+$/);
  config.workers = numberOption(config.workers, 8, 1, 8, "workers");
  config.concurrency = numberOption(config.concurrency, 6, 1, 6, "concurrency");
  config.pauseAfterArchives = numberOption(options.pauseAfterArchives ?? config.pauseAfterArchives, 0, 0, Number.MAX_SAFE_INTEGER, "pause-after-archives");
  config.sourceManifest = await realpath(config.sourceManifest);
  config.output = await resolvedDestination(config.output);
  assert.ok(!config.output.split(path.sep).some(part => part.toLowerCase() === "public"), "Output must be a local staging directory, outside public.");
  const sourceHash = sha(await readFile(config.sourceManifest));
  if (command === "resume") assert.equal(sourceHash, config.sourceManifestSha256, "saved source manifest changed; use run with an explicit new selection");
  config.sourceManifestSha256 = sourceHash;
  return config;
}
async function completedBuild(config) {
  if (!config) return null;
  const manifestPath = path.join(config.output, "manifest.json");
  const [manifest, receipt] = await Promise.all([readJson(manifestPath), readJson(path.join(config.cache, `${config.datasetId}.build.local.json`))]);
  if (!manifest || !receipt) return null;
  if (manifest.datasetId !== config.datasetId || receipt.datasetId !== config.datasetId || !receipt.ok
    || path.resolve(receipt.output) !== config.output || manifest.source?.sourceManifestSha256 !== config.sourceManifestSha256
    || receipt.manifestSha256 !== sha(await readFile(manifestPath))) return null;
  if (!Array.isArray(manifest.shards) || !manifest.shards.length) return null;
  for (const shard of manifest.shards) {
    if (typeof shard.path !== "string" || !shard.path.startsWith(`/ranked/${config.datasetId}/`)) return null;
    let bytes;
    try { bytes = await readFile(path.join(config.output, path.basename(shard.path))); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (bytes.length !== shard.bytes || sha(bytes) !== shard.sha256) return null;
  }
  return { datasetId: config.datasetId, output: config.output, manifestSha256: receipt.manifestSha256, publicationPerformed: false };
}
async function sourceIdentity(cache, config) {
  const bytes = await readFile(config?.sourceManifest ?? path.join(cache, "source-manifest.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!bytes) return null;
  let source;
  try { source = JSON.parse(bytes); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (!Array.isArray(source.files) || !source.files.every(file => Number.isSafeInteger(file.bytes) && file.bytes > 0)) return null;
  return { files: source.files, sha256: sha(bytes), expectedBytes: source.files.reduce((sum, file) => sum + file.bytes, 0) };
}
const count = value => Number.isSafeInteger(value) && value >= 0;
function checkpointMatches(checkpoint, config, source) {
  return Boolean(checkpoint?.schemaVersion === 1 && config && source && source.sha256 === config.sourceManifestSha256
    && checkpoint.datasetId === config.datasetId && checkpoint.sourceManifestSha256 === source.sha256
    && /^[a-f0-9]{64}$/.test(checkpoint.parserFingerprint ?? "") && checkpoint.totalSourceBytes === source.expectedBytes
    && count(checkpoint.completedSourceBytes) && checkpoint.completedSourceBytes <= source.expectedBytes
    && count(checkpoint.archivesFinished) && checkpoint.archivesFinished <= source.files.length && count(checkpoint.uniqueReplays));
}
function freshProgress(progress, state, config, source) {
  return Boolean(progress && state && config && source && progress.datasetId === config.datasetId
    && typeof progress.output === "string" && path.resolve(progress.output) === config.output
    && Number.isFinite(Date.parse(state.startedAt)) && Date.parse(progress.startedAt) >= Date.parse(state.startedAt)
    && Date.parse(progress.updatedAt) >= Date.parse(progress.startedAt)
    && /^[a-f0-9]{64}$/.test(progress.parserFingerprint ?? "") && progress.totalSourceBytes === source.expectedBytes
    && count(progress.completedSourceBytes) && progress.completedSourceBytes <= source.expectedBytes
    && count(progress.uniqueReplays) && count(progress.archivesFinished) && progress.archivesFinished <= source.files.length);
}
/** Only the controller writes this history, at a drained checkpoint. Status
 * reads never promote old work into newly verified current-run counters. */
async function retainCheckpoint(config, state) {
  const [source, progress, previous] = await Promise.all([sourceIdentity(config.cache, config),
    readJson(path.join(config.cache, `${config.datasetId}.progress.local.json`), true), readJson(fileAt(config.cache, "checkpoint"), true)]);
  if (source?.sha256 !== config.sourceManifestSha256 || !freshProgress(progress, state, config, source)
    || !["paused", "complete"].includes(progress.status) || progress.pending !== 0
    || Object.values(state.children ?? {}).some(child => child.status === "failed")) return;
  if (checkpointMatches(previous, config, source) && previous.parserFingerprint === progress.parserFingerprint
    && (progress.completedSourceBytes < previous.completedSourceBytes || progress.uniqueReplays < previous.uniqueReplays)) return;
  await writeJson(fileAt(config.cache, "checkpoint"), { schemaVersion: 1, datasetId: config.datasetId,
    sourceManifestSha256: source.sha256, parserFingerprint: progress.parserFingerprint, recordedAt: new Date().toISOString(),
    verifiedAt: progress.updatedAt, progressStartedAt: progress.startedAt, completedSourceBytes: progress.completedSourceBytes,
    totalSourceBytes: progress.totalSourceBytes, archivesFinished: progress.archivesFinished, uniqueReplays: progress.uniqueReplays });
}
async function progressTotals(cache, config, progress, state, status, checkpoint) {
  const source = await sourceIdentity(cache, config);
  if (!source) return null;
  const expectedBytes = source.expectedBytes;
  let downloadedVerifiedBytes = 0, verifiedArchives = 0;
  // Final digest-named files are installed only after downloader hash checks.
  // Do not count growing .partial sizes or rehash the corpus on every status.
  await Promise.all(source.files.map(async file => {
    const info = await stat(path.join(cache, "archives", file.sha256 + ".tar.gz")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.size === file.bytes) { downloadedVerifiedBytes += file.bytes; verifiedArchives++; }
  }));
  const sourceMatches = source.sha256 === config?.sourceManifestSha256;
  const fresh = freshProgress(progress, state, config, source);
  const previous = checkpointMatches(checkpoint, config, source) ? checkpoint : null;
  const failed = state?.status === "failed" || Object.values(state?.children ?? {}).some(child => child.status === "failed");
  const healthy = ["running", "pause-requested", "paused", "build-complete"].includes(status) && !failed;
  const sameParser = Boolean(fresh && previous && progress.parserFingerprint === previous.parserFingerprint);
  const floorApplied = Boolean(sourceMatches && sameParser && healthy
    && (progress.completedSourceBytes < previous.completedSourceBytes || progress.uniqueReplays < previous.uniqueReplays));
  const completedSourceBytes = sourceMatches && fresh ? Math.max(progress.completedSourceBytes, floorApplied ? previous.completedSourceBytes : 0) : null;
  const observedUniqueReplays = sourceMatches && fresh ? Math.max(progress.uniqueReplays, floorApplied ? previous.uniqueReplays : 0) : null;
  let phase = "processing";
  if (failed) phase = "failed";
  else if (!sourceMatches) phase = "source-changed";
  else if (!healthy) phase = status === "orphaned-children" ? "orphaned-children" : "interrupted";
  else if (!fresh) phase = previous ? "checking-parser-identity" : "starting";
  else if (previous && !sameParser) phase = "parser-changed";
  else if (status === "paused" || status === "build-complete") phase = status;
  else if (floorApplied) phase = "revalidating-cache";
  return { expectedBytes, downloadedVerifiedBytes, downloadedVerifiedPercent: expectedBytes ? 100 * downloadedVerifiedBytes / expectedBytes : null,
    verifiedArchives, expectedArchives: source.files.length, completedSourceBytes,
    processingSourceVolumePercent: completedSourceBytes !== null && expectedBytes ? 100 * completedSourceBytes / expectedBytes : null,
    phase, floorApplied, completedWorkBasis: floorApplied ? "previous-checkpoint-and-current-run" : fresh && sourceMatches ? "current-run" : "unavailable",
    processingPercentMeaning: "Compressed source-volume proxy, not replay-count or time remaining. Previously completed work is distinct from this run's cache revalidation; total replay count is unknown until scanning finishes.",
    observedUniqueReplays,
    currentRun: fresh ? { startedAt: progress.startedAt, updatedAt: progress.updatedAt, parserFingerprint: progress.parserFingerprint,
      completedSourceBytes: progress.completedSourceBytes, processingSourceVolumePercent: 100 * progress.completedSourceBytes / expectedBytes,
      observedUniqueReplays: progress.uniqueReplays, archivesFinished: progress.archivesFinished, resumeArchiveSkips: progress.resumeArchiveSkips ?? 0 } : null,
    previouslyCompleted: previous ? { verifiedAt: previous.verifiedAt, parserFingerprint: previous.parserFingerprint,
      completedSourceBytes: previous.completedSourceBytes, processingSourceVolumePercent: 100 * previous.completedSourceBytes / expectedBytes,
      observedUniqueReplays: previous.uniqueReplays, archivesFinished: previous.archivesFinished,
      parserIdentityConfirmedForCurrentRun: sameParser, newlyVerifiedThisRun: false } : null };
}
export async function rankedJobStatus(cachePath = DEFAULT_CACHE) {
  const cache = await resolvedDestination(path.resolve(cachePath));
  const [config, state, lock, control, checkpoint] = await Promise.all(Object.keys(FILES).map(name => readJson(fileAt(cache, name), true)));
  const datasetId = config?.datasetId ?? "ranked-hf-ef54ddc-v1";
  const [buildProgress, downloadProgress, complete] = await Promise.all([
    readJson(path.join(cache, `${datasetId}.progress.local.json`), true),
    readJson(path.join(cache, "download-receipt.json"), true), completedBuild(config),
  ]);
  const controllerAlive = Boolean(lock && alive(lock.controllerPid));
  const children = liveChildren(state);
  const heartbeat = Date.parse(state?.heartbeatAt ?? "");
  let status;
  if (controllerAlive) status = state?.status === "failed" ? "failed" : control?.pauseRequested ? "pause-requested" : "running";
  else if (children.length) status = "orphaned-children";
  else if (complete) status = "build-complete";
  else if (state?.status === "failed") status = "failed";
  else if (state?.status === "paused" || buildProgress?.status === "paused") status = "paused";
  else status = config ? "resume-ready" : "not-configured";
  return { status, cache, config, pauseRequested: control?.pauseRequested === true, control,
    controller: { pid: lock?.controllerPid ?? null, alive: controllerAlive, heartbeatAt: state?.heartbeatAt ?? null,
      heartbeatStale: Boolean(controllerAlive && (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 10_000)) },
    activeChildren: children, resumeReady: Boolean(config && !controllerAlive && !children.length && !complete),
    state, checkpoints: { build: buildProgress, download: downloadProgress }, progress: await progressTotals(cache, config, buildProgress, state, status, checkpoint), build: complete, publicationPerformed: false };
}
export async function requestRankedPause(cachePath = DEFAULT_CACHE, reason = "Operator requested pause") {
  const cache = await resolvedDestination(path.resolve(cachePath)); await mkdir(cache, { recursive: true });
  await writeJson(fileAt(cache, "control"), { pauseRequested: true, requestedAt: new Date().toISOString(), reason });
  return rankedJobStatus(cache);
}

/** Script entry injection is only for isolated tests; normal CLI runs the two
 * repository workers. No fake worker can be selected through a public flag. */
export async function runRankedJob(command, options = {}, dependencies = {}) {
  assert.ok(["run", "resume", "pause", "status"].includes(command), "Expected run, resume, pause, or status.");
  if (command === "status") return rankedJobStatus(options.cache);
  if (command === "pause") return requestRankedPause(options.cache);
  const cachePath = path.resolve(options.cache ?? DEFAULT_CACHE); await mkdir(cachePath, { recursive: true });
  const cache = await realpath(cachePath), releaseLock = await acquireLock(cache);
  const token = randomUUID(), childRuns = []; let state = null, interval = null, save = Promise.resolve();
  const persist = () => {
    if (state) { state.heartbeatAt = new Date().toISOString(); const snapshot = structuredClone(state); save = save.then(() => writeJson(fileAt(cache, "state"), snapshot)); }
    return save;
  };
  const pause = reason => requestRankedPause(cache, reason);
  const signal = () => { void pause("Controller received SIGINT/SIGTERM").catch(error => console.error(error)); };
  try {
    const priorState = await readJson(fileAt(cache, "state"));
    assert.equal(liveChildren(priorState).length, 0, "Previous controller children are still alive. Request pause and wait for their checkpoints before resuming.");
    const savedConfig = await readJson(fileAt(cache, "config"));
    const config = await configuration(cache, options, savedConfig, command);
    const complete = await completedBuild(config);
    if (complete) { await writeJson(fileAt(cache, "config"), config); return { status: "build-complete", build: complete, publicationPerformed: false }; }
    const entries = await readdir(config.output).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    assert.equal(entries.length, 0, "Staging output contains an incomplete export. Preserve it and use run with a new --output directory.");
    const downloader = dependencies.downloadScript ?? path.join(REPO, "scripts/download-ranked-sources.mjs");
    const builder = dependencies.buildScript ?? path.join(REPO, "scripts/build-ranked-baselines.mjs");
    await Promise.all([stat(downloader), stat(builder)]);
    // Capture a legacy controller's final checkpoint before the new builder
    // replaces its progress file with lower cache-revalidation counters.
    if (savedConfig?.sourceManifestSha256 === config.sourceManifestSha256 && savedConfig?.datasetId === config.datasetId
      && priorState && ["paused", "build-complete"].includes(priorState.status)) await retainCheckpoint(config, priorState);
    await writeJson(fileAt(cache, "config"), config);
    await writeJson(fileAt(cache, "control"), { pauseRequested: false });
    const startedAt = new Date().toISOString();
    state = { schemaVersion: 1, token, controllerPid: process.pid, startedAt, heartbeatAt: startedAt, status: "running", children: {}, publicationPerformed: false };
    await writeJson(fileAt(cache, "lock"), { token, controllerPid: process.pid, startedAt }); await persist();
    process.on("SIGINT", signal); process.on("SIGTERM", signal);
    const logDirectory = path.join(cache, "job-logs"); await mkdir(logDirectory, { recursive: true });
    async function start(name, script, args, nodeFlags = []) {
      const log = path.join(logDirectory, `${startedAt.replace(/[:.]/g, "-")}-${name}.log`), handle = await open(log, "a");
      let child;
      let run;
      try {
        child = spawn(dependencies.nodeExecutable ?? process.execPath, [...nodeFlags, script, ...args],
          // Keep terminal Ctrl+C in the controller; children drain through the
          // shared control file. Retain handles and await them despite detaching.
          { cwd: dependencies.cwd ?? REPO, windowsHide: true, detached: true, stdio: ["ignore", handle.fd, handle.fd] });
        const entry = state.children[name] = { pid: child.pid ?? null, status: "running", log, exitCode: null, signal: null };
        const done = new Promise(resolve => {
          child.once("error", error => { entry.status = "failed"; entry.error = error.message; entry.exitCode = 1; resolve(); });
          child.once("exit", (code, exitSignal) => { entry.exitCode = code; entry.signal = exitSignal; entry.status = code === 0 ? "exited" : "failed"; resolve(); });
        });
        run = { entry, done }; childRuns.push(run);
      } finally { await handle.close(); }
      await persist(); return run;
    }
    const download = await start("download", downloader, ["--cache", cache, "--manifest", config.sourceManifest, "--concurrency", String(config.concurrency)]);
    const build = await start("build", builder, ["--source-manifest", config.sourceManifest, "--cache", cache, "--dataset-id", config.datasetId,
      "--output", config.output, "--workers", String(config.workers), "--download", "false", "--wait-downloads", "true", "--pause-after-archives", String(config.pauseAfterArchives)], ["--max-old-space-size=16384"]);
    const startedMs = Date.parse(startedAt);
    const fresh = async filename => (await stat(filename).catch(error => { if (error.code === "ENOENT") return null; throw error; }))?.mtimeMs >= startedMs;
    interval = setInterval(() => { void persist().catch(error => console.error(error)); }, 1000);
    let lastProgress = 0;
    while (download.entry.status === "running" || build.entry.status === "running") {
      const control = await readJson(fileAt(cache, "control"), true);
      if (!control?.pauseRequested) {
        const buildFile = path.join(cache, `${config.datasetId}.progress.local.json`), downloadFile = path.join(cache, "download-receipt.json");
        const [buildProgress, downloadProgress] = await Promise.all([readJson(buildFile, true), readJson(downloadFile, true)]);
        const buildPaused = buildProgress?.status === "paused" && await fresh(buildFile);
        const downloadPaused = downloadProgress?.status === "paused" && await fresh(downloadFile);
        if (build.entry.status === "exited" && !buildPaused && !await completedBuild(config)) {
          build.entry.status = "failed"; build.entry.error = "Builder exited without a current pause checkpoint or verified export.";
        }
        if (download.entry.status === "exited" && !downloadPaused && !(downloadProgress?.status === "completed" && await fresh(downloadFile))) {
          download.entry.status = "failed"; download.entry.error = "Downloader exited without a current completion or pause receipt.";
        }
        if (build.entry.status === "failed" || download.entry.status === "failed") await pause("A child failed; checkpointing the remaining worker");
        else if (buildPaused) await pause(buildProgress.reason ?? "Builder reached its pause checkpoint");
        else if (downloadPaused) await pause("Downloader reached its pause checkpoint");
      }
      if ((await readJson(fileAt(cache, "control"), true))?.pauseRequested) state.status = "pausing";
      if (Date.now() - lastProgress >= 10_000) {
        lastProgress = Date.now(); const report = await rankedJobStatus(cache);
        (dependencies.onProgress ?? (value => console.log(json(value))))({ status: report.status, ...report.progress });
      }
      await delay(dependencies.pollIntervalMs ?? 250);
    }
    await Promise.all([download.done, build.done]);
    const finalProgressFile = path.join(cache, `${config.datasetId}.progress.local.json`);
    if ((await readJson(finalProgressFile, true))?.status === "paused" && await fresh(finalProgressFile)) await pause("Builder reached its pause checkpoint");
    if (download.entry.status === "failed" || build.entry.status === "failed") state.status = "failed";
    else if (await completedBuild(config)) state.status = "build-complete";
    else if ((await readJson(fileAt(cache, "control"), true))?.pauseRequested) state.status = "paused";
    else { state.status = "failed"; state.error = "Children exited without a pause checkpoint or a verified build receipt."; }
    state.finishedAt = new Date().toISOString();
    if (["paused", "build-complete"].includes(state.status)) await retainCheckpoint(config, state);
    await persist();
  } catch (error) {
    if (state) {
      state.status = "failed"; state.error = error.message;
      try { await pause("Controller failed; checkpointing workers"); }
      catch (pauseError) { state.pauseRequestError = pauseError.message; console.error(`Could not persist pause request: ${pauseError.message}. Still waiting for owned workers.`); }
      await Promise.all(childRuns.map(child => child.done)); await persist();
    }
    throw error;
  } finally {
    if (interval) clearInterval(interval);
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
    try {
      await save;
      const lock = await readJson(fileAt(cache, "lock"));
      if (lock?.token === token) await unlink(fileAt(cache, "lock"));
    } finally { await releaseLock(); }
  }
  return rankedJobStatus(cache);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2), options = {};
  const flags = { "--cache": "cache", "--source-manifest": "sourceManifest", "--dataset-id": "datasetId", "--output": "output", "--workers": "workers", "--concurrency": "concurrency", "--pause-after-archives": "pauseAfterArchives" };
  try {
    for (let i = 0; i < args.length; i += 2) { assert.ok(flags[args[i]] && args[i + 1] !== undefined, `Unknown or incomplete flag: ${args[i]}`); options[flags[args[i]]] = args[i + 1]; }
    if (["pause", "status"].includes(command)) assert.ok(Object.keys(options).every(key => key === "cache"), `${command} only accepts --cache`);
    const result = await runRankedJob(command, options); console.log(json(result));
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
