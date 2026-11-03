#!/usr/bin/env node
/** Public-artifact gate: no credentials, private cache, or raw replay access. */
import assert from "node:assert/strict";
import { readFile, writeFile, stat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const tiers = ["diamond", "master"], characters = Array.from({ length: 26 }, (_, index) => index), stages = [2, 3, 8, 28, 31, 32];
const fields = ["playerGames", "decidedPlayerGames", "wins"];
const key = row => JSON.stringify([row.tier, row.characterId, row.opponentCharacterId, row.stageId]);

/** Side-count partitions are disjoint. Distinct games may overlap across the
 * two character dimensions, whereas stage partitions are truly disjoint. */
export function verifyRankedPartitions(rows, manifest) {
  const indexed = new Map(rows.map(row => [key(row), row])); assert.equal(indexed.size, rows.length);
  let partitions = 0;
  for (const row of rows) {
    assert.ok(row.playerGames > 0 && row.distinctGames > 0 && row.playerGames <= row.distinctGames * 2);
    assert.ok(row.wins <= row.distinctGames && row.wins <= row.decidedPlayerGames && row.decidedPlayerGames <= row.playerGames);
    for (const [dimension, values] of [["characterId", characters], ["opponentCharacterId", characters], ["stageId", stages]]) {
      if (row[dimension] !== null) continue;
      const children = values.map(value => indexed.get(key({ ...row, [dimension]: value }))).filter(Boolean);
      assert.ok(children.length > 0, `subtotal has no detailed cells: ${key(row)} ${dimension}`);
      for (const field of fields) assert.equal(children.reduce((sum, child) => sum + child[field], 0), row[field], `${key(row)} ${dimension}/${field} partition`);
      const distinctSum = children.reduce((sum, child) => sum + child.distinctGames, 0);
      assert.ok(Math.max(...children.map(child => child.distinctGames)) <= row.distinctGames && row.distinctGames <= distinctSum, "distinct-game union bounds");
      if (dimension === "stageId" || (dimension === "characterId" && row.opponentCharacterId !== null)
        || (dimension === "opponentCharacterId" && row.characterId !== null)) assert.equal(distinctSum, row.distinctGames, "disjoint distinct-game partition");
      partitions++;
    }
  }
  const coverage = {};
  for (const tier of tiers) {
    const whole = indexed.get(key({ tier, characterId: null, opponentCharacterId: null, stageId: null }));
    assert.ok(whole, `missing ${tier} whole-cohort row`);
    assert.deepEqual(manifest.tiers[tier], Object.fromEntries([...fields, "distinctGames"].map(field => [field, whole[field]])));
    const observed = characters.filter(characterId => indexed.has(key({ tier, characterId, opponentCharacterId: null, stageId: null })));
    coverage[tier] = { characters: observed, missingCharacters: characters.filter(character => !observed.includes(character)), playerGames: whole.playerGames, distinctGames: whole.distinctGames };
  }
  const accepted = manifest.counts.acceptedGames;
  assert.ok(Math.max(...tiers.map(tier => coverage[tier].distinctGames)) <= accepted
    && accepted <= tiers.reduce((sum, tier) => sum + coverage[tier].distinctGames, 0), "published tiers cover the accepted game union");
  return { partitions, coverage };
}

export async function verifyRankedPublication(options = {}) {
  const directory = options.dir ? path.resolve(options.dir) : path.resolve("public/ranked");
  const source = JSON.parse(await readFile(path.resolve(options.sourceManifest ?? "scripts/data/ranked-source-manifest.json"), "utf8"));
  const remote = options.baseUrl ? new URL(options.baseUrl) : null;
  if (remote) assert.ok(["https:", "http:"].includes(remote.protocol) && !remote.username && !remote.password);
  let temporary = null, consumerDirectory = directory;
  const headerChecks = [];
  async function fetchBytes(asset, stable = false) {
    const response = await fetch(new URL(asset, remote), { cache: "no-cache", signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200, `HTTP ${asset}`);
    const cacheControl = response.headers.get("cache-control") ?? "", encoding = response.headers.get("content-encoding");
    if (stable) assert.ok(/(?:^|,)\s*max-age=0(?:,|$)/i.test(cacheControl) && /must-revalidate/i.test(cacheControl) && !/immutable/i.test(cacheControl), "current manifest must revalidate");
    else assert.ok(/immutable/i.test(cacheControl) && /max-age=31536000/.test(cacheControl), `versioned asset must cache immutably: ${asset}`);
    if (asset.endsWith(".json.gz")) assert.notEqual(encoding, "gzip", "opaque gzip shard must not be transparently decompressed by an HTTP content-encoding header");
    headerChecks.push({ path: asset, cacheControl, contentEncoding: encoding });
    return Buffer.from(await response.arrayBuffer());
  }
  try {
    const manifestBytes = remote ? await fetchBytes("/ranked/manifest.json", true) : await readFile(path.join(directory, "manifest.json"));
    const manifest = JSON.parse(manifestBytes); assert.match(manifest.datasetId, /^[a-z0-9][a-z0-9._-]*$/i);
    const versionedDirectory = path.join(directory, manifest.datasetId);
    const nested = !remote && Boolean(await stat(path.join(versionedDirectory, "manifest.json")).catch(() => null));
    if (nested) { assert.deepEqual(await readFile(path.join(versionedDirectory, "manifest.json")), manifestBytes, "current manifest must be an exact copy of the immutable version"); consumerDirectory = versionedDirectory; }
    if (remote) {
      assert.deepEqual(await fetchBytes(`/ranked/${manifest.datasetId}/manifest.json`), manifestBytes, "live stable pointer and immutable manifest differ");
      if (options.dir) assert.deepEqual(await readFile(path.join(directory, "manifest.json")), manifestBytes, "live manifest differs from expected local export");
      temporary = await mkdtemp(path.join(tmpdir(), "ssbm-ranked-publication-")); consumerDirectory = temporary;
      await writeFile(path.join(temporary, "manifest.json"), manifestBytes);
    }
    assert.equal(manifest.source.repository, source.repository); assert.equal(manifest.source.revision, source.revision);
    assert.equal(manifest.source.selectionMethod, source.selectionMethod);
    const ordered = files => files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(ordered(manifest.source.archives), ordered(source.files), "public source population differs from pinned selection (semantic/EOL-independent comparison)");
    for (const field of ["sourceArchives", "sourceBytes", "replayOccurrences", "uniqueReplays", "duplicateCopies", "wrapperDuplicateCopies", "acceptedGames", "rejectedGames"]) {
      assert.ok(Number.isSafeInteger(manifest.counts[field]) && manifest.counts[field] >= 0, `invalid ${field} count`);
    }
    assert.equal(manifest.counts.sourceArchives, source.files.length); assert.equal(manifest.counts.sourceBytes, source.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.equal(manifest.counts.duplicateCopies, manifest.counts.replayOccurrences - manifest.counts.uniqueReplays);
    assert.equal(manifest.counts.acceptedGames + manifest.counts.rejectedGames + manifest.counts.wrapperDuplicateCopies, manifest.counts.uniqueReplays);
    assert.deepEqual(Object.keys(manifest.tiers).sort(), [...tiers].sort(), "this release publishes Diamond and Master only");
    const rows = [], shardKeys = new Set(); let compressedBytes = 0;
    for (const entry of manifest.shards) {
      assert.ok(tiers.includes(entry.tier)); assert.ok(entry.characterId === null || characters.includes(entry.characterId));
      assert.equal(entry.path, `/ranked/${manifest.datasetId}/${entry.tier}-${entry.characterId ?? "all"}.json.gz`); assert.equal(entry.encoding, "gzip");
      const shardKey = `${entry.tier}/${entry.characterId}`; assert.ok(!shardKeys.has(shardKey)); shardKeys.add(shardKey);
      const payload = remote ? await fetchBytes(entry.path) : await readFile(path.join(consumerDirectory, path.basename(entry.path)));
      assert.equal(payload.length, entry.bytes); assert.equal(hash(payload), entry.sha256); assert.ok(payload[0] === 0x1f && payload[1] === 0x8b, "expected opaque gzip payload");
      if (temporary) await writeFile(path.join(temporary, path.basename(entry.path)), payload);
      const shard = JSON.parse(gunzipSync(payload, { maxOutputLength: 128 * 1024 * 1024 }));
      for (const field of ["schemaVersion", "datasetId", "statsVersion", "interactionStatsVersion"]) assert.equal(shard[field], manifest[field]);
      assert.equal(shard.tier, entry.tier); assert.equal(shard.characterId, entry.characterId); assert.equal(shard.rows.length, entry.rows);
      rows.push(...shard.rows); compressedBytes += payload.length;
    }
    assert.ok(manifest.shards.length <= 54); // Missing genuine tier/character cells are reported, never invented.
    const reconciled = verifyRankedPartitions(rows, manifest);
    // Reuse the application's existing consumer verification path, including
    // its actual parseRankedManifest/parseRankedShard functions loaded via Vite.
    const clientValidation = execFileSync(process.execPath, ["scripts/verify-ranked-benchmarks.mjs", "--dataset-root", consumerDirectory], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    assert.ok(clientValidation.includes("Actual ranked publication accepted by consumer"));
    const report = { ok: true, datasetId: manifest.datasetId, checkedAt: new Date().toISOString(), manifestSha256: hash(manifestBytes),
      sourceArchives: source.files.length, sourceBytes: manifest.counts.sourceBytes, shards: manifest.shards.length, expectedMaximumShards: 54,
      rows: rows.length, compressedBytes, countPartitionsChecked: reconciled.partitions, coverage: reconciled.coverage,
      consumerValidation: "actual parseRankedManifest + parseRankedShard", stablePointerChecked: Boolean(remote || nested),
      source: remote?.origin ?? consumerDirectory, httpCacheChecks: remote ? headerChecks.length : null, writesToProduction: false };
    if (options.report) await writeFile(path.resolve(options.report), JSON.stringify({ ...report, httpHeaders: headerChecks }, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2)); return report;
  } finally {
    if (temporary) {
      const resolved = path.resolve(temporary);
      assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith("ssbm-ranked-publication-"));
      await rm(resolved, { recursive: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) { assert.ok(process.argv[i].startsWith("--") && process.argv[i + 1], "arguments require --key value"); args.set(process.argv[i].slice(2), process.argv[i + 1]); }
  assert.ok([...args.keys()].every(key => ["dir", "base-url", "source-manifest", "report"].includes(key)), "unknown verification argument");
  await verifyRankedPublication({ dir: args.get("dir"), baseUrl: args.get("base-url"), sourceManifest: args.get("source-manifest"), report: args.get("report") });
}
