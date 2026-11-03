#!/usr/bin/env node
/** Local, resumable ranked baseline build. This command never publishes or uploads. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename, stat, statfs, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { gzipSync, createGunzip } from "node:zlib";
import { build } from "vite";
import { REPOSITORY, REVISION, rankPairAgrees, safeMemberName } from "./ranked-source-pilot.mjs";
import { createRankedAggregator, rankedShards, rankedExportRejectionReasons, RANKED_SCHEMA_VERSION, RANKED_QUALITY_VERSION, RANKED_EXPORT_QUALITY_VERSION, RANKED_STAGES, RANKED_TIERS } from "./lib/ranked-aggregation.mjs";
import { sha256, ensureArchive, inspectTarStream, readJsonIfPresent } from "./lib/ranked-source-stream.mjs";
import { createRankedWrapperDeduplicator } from "./lib/ranked-deduplication.mjs";

export const QUALITY_GATES = [
  "Confirmed human singles with supported playable characters and one of the six standard tournament stages.",
  "At least 30 seconds, at most 8 minutes plus 10 seconds, and four stocks at the first recorded frame for both slots.",
  "Present resolved game-end event; no no-contest or LRAS ending.",
  "Contiguous frame IDs from -123 through the final frame, with both pre/post records for each actual player slot and valid finalized-frame integrity.",
  "Per-slot historical source tier labels agree across available metadata fields; every unordered source filename rank pair agrees with those actual slots.",
  "Overall/action metric computers available for both slots; headline damage and L-cancels agree with the independent library reader.",
  "Export eligibility excludes both player slots when either has a negative integer air-dodge count from the source action computer; counts are never clamped, and accepted games retain complete base-metric coverage.",
  "The bounded and retained parsers return exactly equal full records for every accepted replay; parser and audit source fingerprints remain fixed throughout the run.",
  "Identical replay bytes are counted once across archives. Distinct wrappers with identical raw commands are merged only when sanitized measurements, actual-slot tiers, and all quality/evidence checks also agree; conflicts stop the export.",
  "Anonymous tier labels are never player identities. No player balancing or unique-player count is inferred. Only Diamond and Master player slots are published; Platinum slots remain opponent and source evidence.",
];
const PARSE_SOURCES = ["src/lib/parse.ts", "src/lib/types.ts", "src/lib/replayMetadata.ts", "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts",
  "src/lib/interactionAnalysis.ts", "src/lib/defensiveInteractions.ts", "src/lib/recoveryInteractions.ts", "src/lib/punishContext.ts",
  "scripts/lib/ranked-parser-entry.ts", "scripts/lib/ranked-parse-worker.mjs", "scripts/lib/ranked-source-stream.mjs", "scripts/ranked-source-pilot.mjs", "package-lock.json"];
const SOURCES = [...PARSE_SOURCES, "scripts/lib/ranked-aggregation.mjs",
  "scripts/lib/ranked-deduplication.mjs", "scripts/build-ranked-baselines.mjs"];
const json = value => JSON.stringify(value) + "\n";
const pretty = value => JSON.stringify(value, null, 2) + "\n";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function replaceFile(from, to) {
  for (let attempt = 0;; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 49) throw error;
      await sleep(20);
    }
  }
}
class RankedPause extends Error { constructor(reason) { super(reason); this.name = "RankedPause"; } }
const fingerprints = async () => Object.fromEntries(await Promise.all(SOURCES.map(async file => [file, sha256(await readFile(file))])));
export async function rankedBuildIdentity() {
  const sourceFingerprints = await fingerprints();
  const parserFingerprint = sha256(json({ sourceFingerprints: Object.fromEntries(PARSE_SOURCES.map(file => [file, sourceFingerprints[file]])),
    qualityVersion: RANKED_QUALITY_VERSION, stages: RANKED_STAGES, tiers: RANKED_TIERS }));
  return { sourceFingerprints, parserFingerprint, buildFingerprint: sha256(json(sourceFingerprints)) };
}

async function* managedArchiveMembers(file) {
  const input = createReadStream(file), inflated = createGunzip();
  input.on("error", error => inflated.destroy(error)); input.pipe(inflated);
  try { yield* inspectTarStream(inflated); }
  finally { input.destroy(); inflated.destroy(); }
}

export class WorkerPool {
  constructor(size, parser) {
    this.available = []; this.waiting = []; this.workers = []; this.failure = null; this.closing = false;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL("./lib/ranked-parse-worker.mjs", import.meta.url), { workerData: { parser } });
      const entry = { worker, active: null, error: null };
      worker.on("message", message => {
        if (this.failure || this.closing) return;
        const active = entry.active; entry.active = null;
        if (message.error) active.reject(new Error(`${message.error.name}: ${message.error.message}`)); else active.resolve(message.result);
        const waiter = this.waiting.shift(); if (waiter) waiter.resolve(entry); else this.available.push(entry);
      });
      worker.on("error", error => this.fail(error));
      worker.on("exit", code => { if (!this.closing) this.fail(new Error(`ranked parser worker exited unexpectedly (${code})`)); });
      this.available.push(entry); this.workers.push(entry);
    }
  }
  fail(error) {
    if (this.failure || this.closing) return;
    this.failure = error;
    for (const entry of this.workers) { entry.active?.reject(error); entry.active = null; entry.worker.terminate().catch(() => {}); }
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
    this.available.length = 0;
  }
  async run(bytes) {
    if (this.failure) throw this.failure;
    const entry = this.available.pop() ?? await new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
    if (entry.error) throw entry.error;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Promise((resolve, reject) => { entry.active = { resolve, reject }; entry.worker.postMessage({ id: 0, buffer }, [buffer]); });
  }
  async close() { this.closing = true; await Promise.all(this.workers.map(entry => entry.worker.terminate())); }
}

export async function buildRankedBaselines(options) {
  const cache = path.resolve(options.cache), output = path.resolve(options.output), manifestFile = path.resolve(options.sourceManifest);
  const datasetId = options.datasetId, workers = Number(options.workers ?? 4), pauseAfterArchives = Number(options.pauseAfterArchives ?? 0);
  assert.match(datasetId, /^[a-z0-9][a-z0-9.-]+$/);
  assert.ok(Number.isSafeInteger(workers) && workers >= 1 && workers <= 8, "workers must be 1–8");
  assert.ok(Number.isSafeInteger(pauseAfterArchives) && pauseAfterArchives >= 0, "pause-after-archives must be a nonnegative integer; 0 means continuous");
  assert.ok(!output.split(path.sep).includes("public"), "Build into a staging directory; publication is a separate reviewed step");
  const existing = await stat(output).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) assert.equal((await readdir(output)).length, 0, "immutable output exists; choose a new staging directory");
  const sourceBytes = await readFile(manifestFile), source = JSON.parse(sourceBytes);
  assert.equal(source.repository, REPOSITORY); assert.equal(source.revision, REVISION);
  assert.ok(typeof source.selectionMethod === "string" && source.selectionMethod.length > 0 && source.files?.length > 0);
  const sourcePaths = new Set(), sourceDigests = new Set();
  for (const file of source.files) {
    assert.equal(safeMemberName(file.path), file.path); assert.ok(/^[A-Z0-9_]+\/[A-Z0-9_]+_(diamond|master|platinum)-(diamond|master|platinum)_[a-z0-9]+\.tar\.gz$/.test(file.path));
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0); assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!sourcePaths.has(file.path) && !sourceDigests.has(file.sha256), "duplicate source archive"); sourcePaths.add(file.path); sourceDigests.add(file.sha256);
  }
  await mkdir(cache, { recursive: true }); await mkdir(path.join(cache, "archives"), { recursive: true });
  const { sourceFingerprints, parserFingerprint, buildFingerprint } = await rankedBuildIdentity();
  const controlFile = path.join(cache, "ranked-job-control.json");
  const configuration = { sourceManifest: manifestFile, cache, datasetId, output, workers,
    download: options.download !== false, waitDownloads: options.waitDownloads === true, pauseAfterArchives, controlFile };
  await writeFile(path.join(cache, "ranked-build-config.local.json"), pretty(configuration));
  const parsedDirectory = path.join(cache, "parsed", parserFingerprint), parserDirectory = path.join(cache, "parsers", parserFingerprint);
  const memberDirectory = path.join(cache, "members");
  await mkdir(memberDirectory, { recursive: true });
  await mkdir(parsedDirectory, { recursive: true }); await mkdir(parserDirectory, { recursive: true });
  const parserFile = path.join(parserDirectory, "ranked-parser.mjs");
  await build({ configFile: false, logLevel: "silent", build: { ssr: path.resolve("scripts/lib/ranked-parser-entry.ts"), outDir: parserDirectory,
    emptyOutDir: false, minify: false, rollupOptions: { external: ["@slippi/slippi-js"], output: { entryFileNames: "ranked-parser.mjs", paths: { "@slippi/slippi-js": import.meta.resolve("@slippi/slippi-js") } } } } });
  const parser = await import(pathToFileURL(parserFile).href), statsVersion = parser.CURRENT_STATS_VERSION, interactionStatsVersion = parser.INTERACTION_STATS_VERSION;
  assert.ok(statsVersion >= 10, "Ranked corpus requires the finalized-frame parser fix and cache version 10 or later");
  const assertFrozen = async () => assert.equal(sha256(json(await fingerprints())), buildFingerprint, "parser/audit/build sources changed during build; restart using the verified parse cache");
  const pool = new WorkerPool(workers, parserFile), replays = new Map(), pending = new Set();
  const archiveReceipts = []; let firstError = null;
  const track = task => {
    pending.add(task);
    task.then(() => pending.delete(task), error => { firstError ??= error; pending.delete(task); });
    return task;
  };
  const drain = async all => {
    if (firstError) throw firstError;
    if (pending.size) { if (all) await Promise.all(pending); else await Promise.race(pending); }
    if (firstError) throw firstError;
  };
  let replayOccurrences = 0, parsed = 0, reused = 0, downloadedBytes = 0, archivesFinished = 0, currentArchive = null;
  let completedSourceBytes = 0;
  const totalSourceBytes = source.files.reduce((sum, file) => sum + file.bytes, 0);
  let archivesCompletedThisRun = 0, resumeArchiveSkips = 0, pauseReason = null;
  const cachedSummaries = new Map();
  const startedAt = new Date().toISOString(), progressFile = path.join(cache, `${datasetId}.progress.local.json`);
  let lastProgress = 0;
  async function progress(force = false, status = "running", reason = null) {
    // In-process observers can receive every checkpoint; CLI disk updates are
    // throttled while replay work proceeds continuously.
    if (!force && !options.onProgress && Date.now() - lastProgress < 10_000) return;
    lastProgress = Date.now();
    const report = { status, reason, datasetId, startedAt, updatedAt: new Date().toISOString(), parserFingerprint, statsVersion, workers, output,
      archivesFinished, archivesTotal: source.files.length, archivesCompletedThisRun, resumeArchiveSkips, pauseAfterArchives,
      completedSourceBytes, totalSourceBytes,
      currentArchive, replayOccurrences, uniqueReplays: replays.size, parsed, reused, pending: pending.size, downloadedBytes };
    await writeFile(`${progressFile}.tmp`, pretty(report)); await replaceFile(`${progressFile}.tmp`, progressFile);
    console.log(`Ranked: ${archivesFinished}/${source.files.length} archives; ${replays.size} unique replays; ${parsed} parsed, ${reused} cached; ${pending.size} pending`);
    await options.onProgress?.(report);
    return report;
  }
  async function checkPause() {
    const control = await readJsonIfPresent(controlFile);
    if (control) { assert.equal(typeof control.pauseRequested, "boolean", "invalid ranked pause control"); if (control.pauseRequested) throw new RankedPause("control-request"); }
  }
  async function checkedArchiveHash(file) {
    const digest = createHash("sha256"); let checkedAt = 0;
    for await (const chunk of createReadStream(file)) {
      if (Date.now() - checkedAt >= 1000) { await checkPause(); checkedAt = Date.now(); }
      digest.update(chunk);
    }
    return digest.digest("hex");
  }
  async function cachedSummary(replayHash, bytes) {
    if (cachedSummaries.has(replayHash)) { const result = cachedSummaries.get(replayHash); assert.equal(result.bytes, bytes); return result; }
    const prior = await readJsonIfPresent(path.join(parsedDirectory, replayHash + ".json"));
    if (!prior) return null;
    assert.equal(prior.parserFingerprint, parserFingerprint); assert.equal(prior.result.sha256, replayHash); assert.equal(prior.result.bytes, bytes);
    assert.ok(Array.isArray(prior.result.tiers) && Array.isArray(prior.result.reasons), "invalid cached inspection");
    if (!prior.result.reasons.length) assert.equal(prior.result.record?.statsVersion, statsVersion, "accepted cache lacks current full stats");
    const { record: _record, ...summary } = prior.result; cachedSummaries.set(replayHash, summary); return summary;
  }
  async function adoptMember(member, archive, bytes = null) {
    await checkPause(); if (firstError) throw firstError;
    replayOccurrences++;
    let entry = replays.get(member.sha256);
    if (!entry) {
      entry = { result: null, promise: null, rankPairConflict: false }; replays.set(member.sha256, entry);
      const prior = await cachedSummary(member.sha256, member.bytes);
      if (prior) { entry.result = prior; reused++; }
      else {
        assert.ok(bytes, "completed archive receipt lacks a verified parse; reopen source archive");
        const task = (async () => {
          const result = await pool.run(bytes); assert.equal(result.sha256, member.sha256); parsed++;
          const resultFile = path.join(parsedDirectory, member.sha256 + ".json");
          await writeFile(`${resultFile}.tmp`, json({ parserFingerprint, result })); await replaceFile(`${resultFile}.tmp`, resultFile);
          const { record: _record, ...summary } = result; entry.result = summary; entry.promise = null; cachedSummaries.set(member.sha256, summary); return summary;
        })();
        entry.promise = task; track(task);
      }
    }
    track((entry.promise ?? Promise.resolve(entry.result)).then(result => {
      const sides = result.tiers.map(tier => ({ tier }));
      if (!rankPairAgrees(sides, member.member) || !rankPairAgrees(sides, archive.path)) entry.rankPairConflict = true;
    }));
    if (pending.size >= workers * 2) await drain(false);
    await progress();
  }
  try {
    await progress(true);
    for (const archive of [...source.files].sort((a, b) => a.bytes - b.bytes || a.path.localeCompare(b.path))) {
      currentArchive = archive.path; await checkPause(); await assertFrozen();
      const disk = await statfs(cache); assert.ok(disk.bavail * disk.bsize > 8 * 1024 ** 3, "fewer than 8GiB free; retain checkpoint and free space before resuming");
      const archiveFile = path.join(cache, "archives", archive.sha256 + ".tar.gz");
      if (options.download === false) {
        let announced = false;
        while (!await stat(archiveFile).catch(error => { if (error.code !== "ENOENT") throw error; return null; })) {
          assert.ok(options.waitDownloads, `pinned archive is not downloaded: ${archive.path}`);
          if (!announced) { console.log(`Waiting for verified source archive ${archive.path}`); announced = true; }
          await checkPause(); await progress(); await sleep(1000); await assertFrozen();
        }
        assert.equal((await stat(archiveFile)).size, archive.bytes); assert.equal(await checkedArchiveHash(archiveFile), archive.sha256);
      } else {
        const seed = path.join(homedir(), ".cache", "SSBM_DASHBOARD_ranked_pilot", REVISION, "archives", path.basename(archive.path));
        downloadedBytes += (await ensureArchive(archiveFile, archive, `https://huggingface.co/datasets/${REPOSITORY}/resolve/${REVISION}/${archive.path}`, seed)).downloadedBytes;
      }
      const memberFile = path.join(memberDirectory, archive.sha256 + ".local.json");
      const priorMembers = await readJsonIfPresent(memberFile);
      let completeCache = Boolean(priorMembers);
      if (priorMembers) {
        assert.equal(priorMembers.archive, archive.path); assert.equal(priorMembers.sha256, archive.sha256); assert.equal(priorMembers.bytes, archive.bytes);
        assert.ok(Array.isArray(priorMembers.members) && priorMembers.members.length > 0, "invalid source member receipt");
        for (const member of priorMembers.members) {
          await checkPause(); assert.equal(safeMemberName(member.member), member.member); assert.match(member.sha256, /^[a-f0-9]{64}$/);
          assert.ok(Number.isSafeInteger(member.bytes) && member.bytes > 0 && member.bytes <= 64 * 1024 * 1024);
          if (!await cachedSummary(member.sha256, member.bytes)) completeCache = false;
        }
      }
      let members;
      if (completeCache) {
        members = priorMembers.members;
        for (const member of members) await adoptMember(member, archive);
        resumeArchiveSkips++;
      } else {
        members = [];
        for await (const raw of managedArchiveMembers(archiveFile)) {
          const member = { member: raw.name, sha256: sha256(raw.bytes), bytes: raw.bytes.length };
          await adoptMember(member, archive, raw.bytes); members.push(member);
        }
        archivesCompletedThisRun++;
      }
      await drain(true);
      const memberReceipt = Buffer.from(json({ archive: archive.path, sha256: archive.sha256, bytes: archive.bytes, members }));
      if (priorMembers) assert.equal(json(priorMembers), memberReceipt.toString(), "source member receipt changed");
      else { await writeFile(`${memberFile}.tmp`, memberReceipt); await replaceFile(`${memberFile}.tmp`, memberFile); }
      archiveReceipts.push({ archive: archive.path, sha256: archive.sha256, memberReceiptSha256: sha256(memberReceipt), members: members.length });
      archivesFinished++; completedSourceBytes += archive.bytes; await progress(true);
      if (pauseAfterArchives > 0 && archivesCompletedThisRun >= pauseAfterArchives) throw new RankedPause("archive-batch-limit");
    }
    await checkPause(); await drain(true); await assertFrozen();
  } catch (error) {
    if (!(error instanceof RankedPause)) throw error;
    await drain(true); pauseReason = error.message;
  } finally { await pool.close(); }
  if (pauseReason) {
    const report = await progress(true, "paused", pauseReason);
    return { ...report, ok: true, publicationPerformed: false };
  }

  const selectionFile = path.join(cache, `${datasetId}.selection.local.json`);
  const selectionBytes = Buffer.from(json({ datasetId, sourceManifestSha256: sha256(sourceBytes), parserFingerprint, archives: archiveReceipts,
    replays: [...replays].map(([sha256, entry]) => ({ sha256, sourceRankPairConflict: entry.rankPairConflict })).sort((a, b) => a.sha256.localeCompare(b.sha256)) }));
  await writeFile(selectionFile, selectionBytes);

  try {
  const aggregate = createRankedAggregator({ statsVersion, interactionStatsVersion });
  const rejections = {}, deduplicator = createRankedWrapperDeduplicator(); let rejectedGames = 0;
  const exportQuality = { version: RANKED_EXPORT_QUALITY_VERSION, invalidAirDodgeGames: 0, invalidAirDodgeSides: 0 };
  let aggregated = 0;
  for (const [replayHash, entry] of [...replays].sort(([a], [b]) => a.localeCompare(b))) {
    if (aggregated++ % 100 === 0) await checkPause();
    const { result } = await readJsonIfPresent(path.join(parsedDirectory, replayHash + ".json"));
    const reasons = [...new Set([...result.reasons, ...(entry.rankPairConflict ? ["source-rank-pair-conflict"] : []), ...rankedExportRejectionReasons(result)])];
    if (!deduplicator.add(result, reasons)) continue;
    if (reasons.includes("invalid-air-dodge-count")) {
      exportQuality.invalidAirDodgeGames++;
      exportQuality.invalidAirDodgeSides += result.record.players.filter(side => Number.isSafeInteger(side.actions?.airDodges) && side.actions.airDodges < 0).length;
    }
    if (reasons.length) { rejectedGames++; for (const reason of reasons) rejections[reason] = (rejections[reason] ?? 0) + 1; }
    else { assert.ok(result.record, "accepted replay lacks full record"); aggregate.add({ sha256: replayHash, record: result.record, tiers: result.tiers }); }
  }
  const allRows = aggregate.finish(), rows = allRows.filter(row => ["diamond", "master"].includes(row.tier)), tiers = {};
  for (const row of rows.filter(row => row.characterId === null && row.opponentCharacterId === null && row.stageId === null)) {
    tiers[row.tier] = { playerGames: row.playerGames, distinctGames: row.distinctGames, decidedPlayerGames: row.decidedPlayerGames, wins: row.wins };
  }
  const allTierTotals = allRows.filter(row => row.characterId === null && row.opponentCharacterId === null && row.stageId === null);
  assert.equal(allTierTotals.reduce((sum, tier) => sum + tier.playerGames, 0), aggregate.uniqueGames * 2);
  assert.equal(aggregate.uniqueGames + rejectedGames + deduplicator.duplicateCopies, replays.size);
  await checkPause(); await assertFrozen(); await mkdir(output, { recursive: true });
  const shards = [];
  for (const [name, shard] of rankedShards(rows, { datasetId, statsVersion, interactionStatsVersion })) {
    const bytes = gzipSync(Buffer.from(json(shard)), { level: 9 }); await writeFile(path.join(output, `${name}.json.gz`), bytes, { flag: "wx" });
    shards.push({ tier: shard.tier, characterId: shard.characterId, path: `/ranked/${datasetId}/${name}.json.gz`, encoding: "gzip", sha256: sha256(bytes), bytes: bytes.length, rows: shard.rows.length });
  }
  const manifest = { schemaVersion: RANKED_SCHEMA_VERSION, exportQualityVersion: RANKED_EXPORT_QUALITY_VERSION, datasetId, statsVersion, interactionStatsVersion, generatedAt: new Date().toISOString(),
    source: { repository: REPOSITORY, revision: REVISION, url: `https://huggingface.co/datasets/${REPOSITORY}/tree/${REVISION}`,
      selectionMethod: source.selectionMethod, archives: source.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), sourceManifestSha256: sha256(sourceBytes) },
    rankTiming: "unknown", rankSeason: null, rankDate: null, uniquePlayers: null,
    qualityGates: QUALITY_GATES,
    parser: { libraryVersion: JSON.parse(await readFile("node_modules/@slippi/slippi-js/package.json", "utf8")).version,
      sourceSha256: parserFingerprint, sourceFingerprints, qualityVersion: RANKED_QUALITY_VERSION },
    counts: { sourceArchives: source.files.length, sourceBytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
      replayOccurrences, uniqueReplays: replays.size, duplicateCopies: replayOccurrences - replays.size, wrapperDuplicateCopies: deduplicator.duplicateCopies,
      acceptedGames: aggregate.uniqueGames, rejectedGames, rejections }, tiers, shards };
  await writeFile(path.join(output, "manifest.json"), pretty(manifest), { flag: "wx" });
  const receipt = { ok: true, status: "complete", datasetId, startedAt, finishedAt: manifest.generatedAt, output, parserFingerprint, statsVersion, interactionStatsVersion,
    manifestSha256: sha256(await readFile(path.join(output, "manifest.json"))), exportQuality, counts: manifest.counts, tiers, rows: rows.length,
    shardBytes: shards.reduce((sum, shard) => sum + shard.bytes, 0), observedTierPlayerGames: Object.fromEntries(allTierTotals.map(row => [row.tier, row.playerGames])),
    selectionFile, selectionSha256: sha256(selectionBytes), parsed, reused, downloadedBytes, archivesCompletedThisRun, resumeArchiveSkips, publicationPerformed: false };
  await writeFile(path.join(cache, `${datasetId}.build.local.json`), pretty(receipt)); await progress(true, "complete"); console.log(pretty(receipt)); return receipt;
  } catch (error) {
    if (!(error instanceof RankedPause)) throw error;
    return { ...await progress(true, "paused", error.message), ok: true, publicationPerformed: false };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) { assert.ok(process.argv[i].startsWith("--") && process.argv[i + 1] !== undefined, "arguments require --key value"); args.set(process.argv[i].slice(2), process.argv[i + 1]); }
  for (const field of ["source-manifest", "cache", "dataset-id", "output"]) assert.ok(args.has(field), `--${field} is required`);
  for (const field of ["download", "wait-downloads"]) if (args.has(field)) assert.ok(["true", "false"].includes(args.get(field)), `--${field} requires true or false`);
  await buildRankedBaselines({ sourceManifest: args.get("source-manifest"), cache: args.get("cache"), datasetId: args.get("dataset-id"), output: args.get("output"),
    workers: args.get("workers"), download: args.get("download") !== "false", waitDownloads: args.get("wait-downloads") === "true",
    pauseAfterArchives: args.get("pause-after-archives") });
}
