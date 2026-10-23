#!/usr/bin/env node
/**
 * Resume a local archive backfill as completed downloads become available.
 * Raw replay bytes stay local; this script performs no network requests.
 *
 * node scripts/backfill-nikki-archive.mjs --cache CACHE --audit AUDIT.json --watch true
 * --workers is capped at 8; one next archive extracts during the current parse.
 * At most two owned extraction directories exist. --limit can bound a smoke run; --results overrides
 * results-v5. Missing source filenames (e.g. ootb5) remain explicitly excluded.
 * Originals are retained. Only this script's marked extraction staging is
 * removed, and only after an independently validated result is installed.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_STATS_VERSION, ARCHIVE_SPECIAL_MOVE_IDS, assertArchiveSpecialMeasurements } from "./lib/archive-move-coverage.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || process.argv[i + 1] === undefined) throw new Error("Expected --name value arguments");
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
if (!args.has("cache") || !args.has("audit")) throw new Error("Usage: backfill-nikki-archive.mjs --cache CACHE --audit AUDIT.json [--watch true] [--workers 8]");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.resolve(args.get("cache"));
const downloads = path.join(cache, "downloads");
const work = path.join(cache, `backfill-v${ARCHIVE_STATS_VERSION}`);
const extractionRoot = path.join(work, "extracted");
const receipts = path.join(work, "receipts");
const results = path.resolve(args.get("results") ?? path.join(cache, `results-v${ARCHIVE_STATS_VERSION}`));
const immutableV4 = path.resolve(cache, "results-v4");
const relativeToV4 = path.relative(immutableV4, results);
if (!relativeToV4 || (!relativeToV4.startsWith("..") && !path.isAbsolute(relativeToV4))) {
  throw new Error("Stats-v4 results are immutable; select a separate stats-v5 results directory");
}
const statePath = path.join(work, "state.json");
const lockPath = path.join(work, "pipeline.lock");
const watch = args.get("watch") === "true";
const workers = Math.max(1, Math.min(8, Number(args.get("workers") ?? 8) || 8));
const limit = Math.max(1, Number(args.get("limit") ?? Infinity));
const OWNER = ".__special_moves_extraction_owner.json";
const auditText = await readFile(path.resolve(args.get("audit")), "utf8");
const audit = JSON.parse(auditText);
const sources = audit.sources.filter((source) => source.sourceFilename).sort((a, b) => a.compressed_bytes - b.compressed_bytes);
const excluded = audit.sources.filter((source) => !source.sourceFilename).map((source) => ({ id: source.id, reason: "Source unavailable; excluded by the backfill request." }));
for (const source of sources) {
  if (path.basename(source.sourceFilename) !== source.sourceFilename || !/\.(7z|zip)$/i.test(source.sourceFilename)) throw new Error(`Unsafe source filename: ${source.sourceFilename}`);
  if (!Number.isSafeInteger(source.compressed_bytes) || source.compressed_bytes <= 0 || !Number.isSafeInteger(source.replay_file_count)) throw new Error(`Invalid audited counts: ${source.sourceFilename}`);
}
await Promise.all([mkdir(downloads, { recursive: true }), mkdir(extractionRoot, { recursive: true }), mkdir(receipts, { recursive: true }), mkdir(results, { recursive: true })]);
if (existsSync(immutableV4)) {
  const relative = path.relative(await realpath(immutableV4), await realpath(results));
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Results destination resolves into immutable stats-v4 results");
}
const parserInputs = ["src/lib/parse.ts", "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts", "src/lib/types.ts", "src/lib/replayMetadata.ts", "scripts/analyze-nikki-bundle.mjs", "scripts/lib/archive-move-coverage.mjs", "package-lock.json"];
async function parserFingerprint() {
  const hash = createHash("sha256");
  for (const name of parserInputs) { hash.update(name); hash.update(await readFile(path.join(repo, name))); }
  return hash.digest("hex");
}
async function fileHash(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
const parserHash = await parserFingerprint();
if (existsSync(lockPath)) {
  const previous = JSON.parse(await readFile(lockPath, "utf8"));
  let alive = false;
  try { process.kill(previous.pid, 0); alive = true; } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (alive) throw new Error(`Backfill already running with PID ${previous.pid}`);
  unlinkSync(lockPath);
}
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
process.once("exit", () => {
  try { if (JSON.parse(readFileSync(lockPath, "utf8")).pid === process.pid) unlinkSync(lockPath); } catch { /* Never remove an unrelated lock. */ }
});

const state = {
  startedAt: new Date().toISOString(), updatedAt: null, pid: process.pid,
  auditSha256: createHash("sha256").update(auditText).digest("hex"), parserSha256: parserHash,
  statsVersion: ARCHIVE_STATS_VERSION, specialMoveIds: ARCHIVE_SPECIAL_MOVE_IDS,
  workers, expectedBundles: sources.length, expectedReplayFiles: sources.reduce((sum, source) => sum + source.replay_file_count, 0),
  excluded, current: null, prefetch: null, completed: [], failures: [], pending: [],
};
let saveChain = Promise.resolve();
function save() {
  state.updatedAt = new Date().toISOString();
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  saveChain = saveChain.then(async () => {
    const temporary = `${statePath}.partial`;
    await writeFile(temporary, snapshot);
    await rename(temporary, statePath);
  });
  return saveChain;
}
function command(program, arguments_, { capture = false, log = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, arguments_, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", (chunk) => {
      if (capture) {
        output += chunk;
        if (output.length > 64 * 1024 * 1024) child.kill();
      } else process.stdout.write(chunk);
      log?.write(chunk);
    });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16000); if (!capture) process.stderr.write(chunk); log?.write(chunk); });
    child.once("error", reject);
    // The process can exit before its piped output finishes draining. Archive
    // member counts must use all bytes, and extraction cleanup must wait for
    // every child handle to close.
    child.once("close", (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${program} exited ${code ?? signal}: ${errors.trim()}`)));
  });
}
const replayName = (name) => /\.slp(?:z)?$/i.test(name);
async function inspectArchive(archive, source) {
  const names = (await command("tar", ["-tf", archive], { capture: true })).split(/\r?\n/).filter(Boolean);
  for (const name of names) {
    const normalized = name.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").includes("..") || normalized.split("/").includes(OWNER)) throw new Error(`Unsafe archive member: ${name}`);
  }
  const replayCount = names.filter(replayName).length;
  if (replayCount !== source.replay_file_count) throw new Error(`Archive contains ${replayCount} replays; audit requires ${source.replay_file_count}`);
  // Links and special filesystem objects are unnecessary for replay inputs.
  const listing = (await command("tar", ["-tvf", archive], { capture: true })).split(/\r?\n/).filter(Boolean);
  let uncompressedBytes = 0;
  for (const line of listing) {
    if (!/^[d-]/.test(line)) throw new Error(`Unsupported archive entry type: ${line.slice(0, 160)}`);
    const size = line.match(/^[d-]\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/);
    if (!size) throw new Error(`Cannot determine extracted size: ${line.slice(0, 160)}`);
    uncompressedBytes += Number(size[1]);
  }
  const disk = await statfs(cache);
  if (disk.bavail * disk.bsize < uncompressedBytes + 8 * 1024 ** 3) throw new Error(`Insufficient staging space for ${uncompressedBytes} extracted bytes plus 8 GiB reserve`);
  return { replayCount, compressedReplayFiles: names.filter((name) => /\.slpz$/i.test(name)).length, uncompressedBytes };
}
async function inspectExtraction(root) {
  let replays = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Extracted link is not allowed: ${entry.name}`);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
      else if (entry.isFile() && replayName(entry.name)) replays++;
    }
  }
  await walk(root);
  return replays;
}
async function validateResult(filename, source) {
  const payload = JSON.parse(await readFile(filename, "utf8"));
  if (payload.schemaVersion !== 2 || payload.statsVersion !== ARCHIVE_STATS_VERSION || payload.bundle !== source.sourceFilename || payload.statProfile !== "dashboard-full-derived-v1") throw new Error("Result profile, stats version, or source identity does not match");
  if (payload.replayFiles !== source.replay_file_count || payload.records?.length !== source.replay_file_count) throw new Error("Result replay count does not match audit");
  let parsed = 0, failed = 0, playerSides = 0;
  const specialMoves = Object.fromEntries(ARCHIVE_SPECIAL_MOVE_IDS.map((id) => [id, {
    attemptSides: 0, outcomeSides: 0, attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0,
  }]));
  const errorCounts = new Map();
  for (const record of payload.records) {
    if (!record.ok) { failed++; errorCounts.set(record.error, (errorCounts.get(record.error) ?? 0) + 1); continue; }
    parsed++;
    assertArchiveSpecialMeasurements(record, `${source.sourceFilename}/${record.file}`);
    for (const side of record.players) {
      playerSides++;
      for (const moveId of ARCHIVE_SPECIAL_MOVE_IDS) {
        const move = side.moveStats?.[moveId], totals = specialMoves[moveId];
        if (move?.attempts !== undefined) {
          totals.attemptSides++; totals.attempts += move.attempts;
        }
        if (move?.hitAttempts !== undefined) {
          totals.outcomeSides++;
          for (const field of ["hitAttempts", "noHitAttempts", "incompleteAttempts"]) totals[field] += move[field];
        }
      }
    }
  }
  if (parsed !== payload.parsed || failed !== payload.failed || parsed + failed !== source.replay_file_count) throw new Error("Result parsed/failed totals do not reconcile");
  return { bundle: source.sourceFilename, replayFiles: payload.replayFiles, parsed, failed, playerSides, specialMoves,
    errors: [...errorCounts].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([message, total]) => ({ message, total })), output: filename };
}
async function removeOwnedExtraction(directory, source) {
  // Validate exact resolved absolute paths before any recursive deletion.
  const base = await realpath(extractionRoot), target = await realpath(directory);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || (await lstat(directory)).isSymbolicLink()) throw new Error("Refusing extraction cleanup outside the owned staging root");
  const owner = JSON.parse(await readFile(path.join(target, OWNER), "utf8"));
  if (owner.bundle !== source.sourceFilename || owner.auditSha256 !== state.auditSha256) throw new Error("Extraction cleanup ownership mismatch");
  await rm(target, { recursive: true, force: false });
}
const completed = new Set(), failed = new Set();
let processed = 0, stopRequested = false;
process.on("SIGINT", () => { stopRequested = true; process.stderr.write("Stopping after the current parse and pending extraction finish.\n"); });
process.on("SIGTERM", () => { stopRequested = true; });
function locations(source) {
  const bundle = source.sourceFilename, stem = bundle.replace(/\.(7z|zip)$/i, "");
  return { bundle, stem, archive: path.join(downloads, bundle), output: path.join(results, `${stem}.json`),
    receiptPath: path.join(receipts, `${stem}.json`), directory: path.join(extractionRoot, stem) };
}
async function finish(source, summary, reused = false) {
  completed.add(source.sourceFilename); processed++;
  state.completed.push({ ...summary, auditedCompressedBytes: source.compressed_bytes, reused, completedAt: new Date().toISOString() });
  process.stdout.write(`${reused ? "REUSED" : "COMPLETED"} ${source.sourceFilename}: ${summary.parsed}/${summary.replayFiles} parsed, ${summary.failed} failed; ${completed.size}/${sources.length} bundles\n`);
  await save();
}
async function resumeResult(source) {
  const { bundle, output, receiptPath, directory } = locations(source);
  if (!existsSync(output) || !existsSync(receiptPath)) return false;
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.statsVersion !== ARCHIVE_STATS_VERSION || receipt.parserSha256 !== parserHash || receipt.auditSha256 !== state.auditSha256 ||
      receipt.bundle !== bundle || receipt.compressedBytes !== source.compressed_bytes ||
      receipt.output !== output || receipt.outputSha256 !== await fileHash(output)) return false;
  const summary = await validateResult(output, source);
  if (existsSync(directory)) await removeOwnedExtraction(directory, source);
  await finish(source, summary, true);
  return true;
}
async function nextSource(reserved = null) {
  state.pending = [];
  // Prioritize leftover owned staging after an interrupted extraction. This keeps
  // a resumed run within its two-directory bound before starting fresh staging.
  const ordered = [...sources].sort((a, b) => Number(existsSync(locations(b).directory)) - Number(existsSync(locations(a).directory)));
  for (const source of ordered) {
    const { bundle, archive } = locations(source);
    if (source === reserved || completed.has(bundle) || failed.has(bundle)) continue;
    let download;
    try { download = await stat(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!download || download.size !== source.compressed_bytes) {
      state.pending.push({ bundle, expectedBytes: source.compressed_bytes, currentBytes: download?.size ?? null });
      continue;
    }
    return source;
  }
  return null;
}
async function progress(job, stage, inspection = job.inspection ?? {}) {
  job.progress = { bundle: job.source.sourceFilename, stage, ...inspection };
  state[job.role] = job.progress;
  await save();
}
async function prepare(job) {
  const { source } = job, { bundle, archive, directory } = locations(source);
  if (await parserFingerprint() !== parserHash) throw new Error("Parser source changed during the backfill; restart to use one consistent parser");
  await progress(job, "inspecting-archive");
  const inspection = await inspectArchive(archive, source);
  job.inspection = inspection;
  if (inspection.compressedReplayFiles) throw new Error(`Archive has ${inspection.compressedReplayFiles} .slpz files; analyzer must decode them before processing`);
  if (existsSync(directory)) await removeOwnedExtraction(directory, source);
  // The current bundle is fully extracted before prefetch starts. Its complete
  // footprint is already charged against statfs free space, reserving room for
  // both bundles plus 8 GiB. Only one tar process can run at a time.
  const existing = await readdir(extractionRoot, { withFileTypes: true });
  if (existing.filter((entry) => entry.isDirectory()).length >= 2) throw new Error("Refusing to create more than two extraction directories");
  await mkdir(directory);
  await writeFile(path.join(directory, OWNER), JSON.stringify({ bundle, auditSha256: state.auditSha256 }));
  await progress(job, "extracting");
  await command("tar", ["-xf", archive, "-C", directory]);
  const extractedCount = await inspectExtraction(directory);
  if (extractedCount !== source.replay_file_count) throw new Error(`Extracted ${extractedCount} replays; expected ${source.replay_file_count}`);
  await progress(job, "ready");
}
function startPreparation(source, role) {
  const job = { source, role, progress: null, inspection: null, promise: null };
  // Resolve failures into values immediately so a failed lookahead never creates
  // an unhandled rejection while the current parser is still running.
  job.promise = prepare(job).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  return job;
}
async function parsePrepared(job) {
  const { source } = job, { bundle, stem, output, receiptPath, directory } = locations(source);
  await progress(job, "parsing");
  if (await parserFingerprint() !== parserHash) throw new Error("Parser source changed before parsing this bundle");
  const temporaryOutput = `${output}.partial-${process.pid}`;
  const log = createWriteStream(path.join(work, `${stem}.log`), { flags: "a" });
  try { await command(process.execPath, [path.join(repo, "scripts/analyze-nikki-bundle.mjs"), "--bundle", bundle, "--dir", directory, "--output", temporaryOutput, "--workers", String(workers)], { log }); }
  finally { log.end(); }
  if (await parserFingerprint() !== parserHash) throw new Error("Parser source changed while processing this bundle; its output was not installed");
  const summary = await validateResult(temporaryOutput, source);
  const outputSha256 = await fileHash(temporaryOutput);
  await rename(temporaryOutput, output);
  summary.output = output;
  const receiptTemporary = `${receiptPath}.partial`;
  await writeFile(receiptTemporary, `${JSON.stringify({ bundle, compressedBytes: source.compressed_bytes,
    statsVersion: ARCHIVE_STATS_VERSION, specialMoveIds: ARCHIVE_SPECIAL_MOVE_IDS,
    parserSha256: parserHash, auditSha256: state.auditSha256, output, outputSha256, validatedAt: new Date().toISOString() }, null, 2)}\n`);
  await rename(receiptTemporary, receiptPath);
  await removeOwnedExtraction(directory, source);
  await finish(source, summary);
}
let current = null, prefetch = null;
try {
  // Validate every reusable receipt before scheduling extraction. No v5 output
  // is trusted merely because its shape or numeric stats version matches.
  for (const source of sources) {
    if (processed >= limit || stopRequested) break;
    await resumeResult(source);
  }
  while (completed.size < sources.length && processed < limit && !stopRequested) {
    if (!current) {
      const source = await nextSource();
      if (!source) {
        state.current = null; state.prefetch = null; await save();
        if (!watch) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      current = startPreparation(source, "current");
    }
    const prepared = await current.promise;
    if (!prepared.ok) throw prepared.error;
    const next = !stopRequested && processed + 1 < limit ? await nextSource(current.source) : null;
    if (next) prefetch = startPreparation(next, "prefetch");
    await parsePrepared(current);
    current = prefetch; prefetch = null;
    if (current) current.role = "current";
    state.current = current?.progress ?? null; state.prefetch = null; await save();
  }
  // A graceful stop waits for the one pending extraction to close its files.
  // It leaves marked staging for the next run and never kills a parser.
  if (current) {
    const prepared = await current.promise;
    if (!prepared.ok) throw prepared.error;
  }
  state.finishedAt = new Date().toISOString(); await save();
  process.stdout.write(`${JSON.stringify({ completed: completed.size, failed: failed.size, pending: sources.length - completed.size - failed.size, stopped: stopRequested, state: statePath })}\n`);
} catch (error) {
  // Keep a failed extraction for diagnosis, but stop rather than accumulate a
  // third staging directory. Wait for the other owned child before unlocking.
  if (prefetch) await prefetch.promise;
  if (current) await current.promise;
  const bundle = current?.source.sourceFilename ?? null;
  const message = error instanceof Error ? error.message : String(error);
  if (bundle) failed.add(bundle);
  state.failures.push({ bundle, message, at: new Date().toISOString() });
  state.finishedAt = new Date().toISOString(); await save();
  process.stderr.write(`FAILED ${bundle ?? "resume"}: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (JSON.parse(readFileSync(lockPath, "utf8")).pid === process.pid) unlinkSync(lockPath);
}
