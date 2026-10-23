#!/usr/bin/env node
/** Bind exact stats-v4 -> v6 Down B withdrawals to original replay evidence. Local only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
const cacheDefault = path.join(homedir(), ".cache", "SSBM_DASHBOARD_nikki_archive");
const args = { cache: cacheDefault, diagnostics: null, output: null };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]?.replace(/^--/, "");
  assert.ok(name in args && process.argv[index + 1], "Expected --cache DIR [--diagnostics JSON] [--output JSON]");
  args[name] = process.argv[index + 1];
}
const cache = path.resolve(args.cache);
const diagnosticPath = args.diagnostics ?? path.join(cache, "specials-v6-completeness-diagnoses.local.json");
const outputPath = args.output ?? path.join(cache, "specials-v6-completeness-corrections.local.json");
const json = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fileHash(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
const member = (value) => value.replaceAll("\\", "/");
const stem = (value) => value.replace(/\.(7z|zip|json)$/i, "");
const usageFields = ["attempts", "hitAttempts", "noHitAttempts", "incompleteAttempts"];
const usage = (move) => Object.fromEntries(usageFields.filter((field) => move?.[field] !== undefined).map((field) => [field, move[field]]));
function priorFields(record) {
  const copy = structuredClone(record);
  delete copy.statsVersion;
  for (const side of copy.players ?? []) for (const id of [18, 19, 20, 21]) {
    const move = side.moveStats?.[id];
    if (!move) continue;
    usageFields.forEach((field) => { delete move[field]; });
    // A measurement can create an otherwise empty move row. Its removal does
    // not change landed/damage/kills, and is normalized only when all are zero.
    if (Object.values(move).every((value) => value === 0)) delete side.moveStats[id];
  }
  return copy;
}
const auditPath = path.join(cache, "source-audit-2026-10-22.json");
const [audit, state, diagnostics, beforeManifest] = await Promise.all([
  json(auditPath), json(path.join(cache, "backfill-v6/state.json")), json(diagnosticPath), json(path.join(cache, "public-export-v9/manifest.json")),
]);
const auditSha256 = await fileHash(auditPath);
assert.equal(state.statsVersion, 6); assert.equal(state.auditSha256, auditSha256);
assert.ok(state.finishedAt); assert.equal(state.completed.length, 67); assert.deepEqual(state.failures, []);
assert.equal(diagnostics.auditSha256, auditSha256);
assert.equal(diagnostics.parserSha256, state.parserSha256, "raw evidence uses the frozen final parser");
const evidence = new Map(diagnostics.cases.map((item) => [`${item.bundle}\0${member(item.file)}`, item]));
assert.equal(evidence.size, diagnostics.cases.length, "one raw evidence case per original replay");
const sources = audit.sources.filter((source) => source.sourceFilename).sort((a, b) => a.sourceFilename.localeCompare(b.sourceFilename));
const expectedFiles = sources.map((source) => `${stem(source.sourceFilename)}.json`).sort();
for (const version of [4, 6]) assert.deepEqual((await readdir(path.join(cache, `results-v${version}`))).filter((name) => name.endsWith(".json")).sort(), expectedFiles,
  "both result sets retain the exact reviewed source cohort");
const publicKeys = new Set((await readFile(path.join(cache, "public-export-v9/archive_games.ndjson"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).game_key));
const corrections = [], bundleFingerprints = [], checkedEvidence = new Set();
let recordsChecked = 0, parsed = 0, failed = 0;
for (const source of sources) {
  const filename = `${stem(source.sourceFilename)}.json`;
  const beforePath = path.join(cache, "results-v4", filename), afterPath = path.join(cache, "results-v6", filename);
  const [before, after, receipt, beforeSha256, afterSha256] = await Promise.all([
    json(beforePath), json(afterPath), json(path.join(cache, "backfill-v6/receipts", filename)), fileHash(beforePath), fileHash(afterPath),
  ]);
  assert.equal(receipt.statsVersion, 6); assert.equal(receipt.parserSha256, state.parserSha256);
  assert.equal(receipt.auditSha256, auditSha256); assert.equal(receipt.outputSha256, afterSha256);
  assert.equal(receipt.bundle, source.sourceFilename); assert.equal(receipt.compressedBytes, source.compressed_bytes);
  assert.equal(before.bundle, source.sourceFilename); assert.equal(after.bundle, source.sourceFilename);
  assert.equal(after.statsVersion, 6); assert.equal(before.statsVersion, 4);
  assert.equal(after.replayFiles, source.replay_file_count); assert.equal(after.records.length, source.replay_file_count);
  assert.equal(after.parsed, before.parsed); assert.equal(after.failed, before.failed);
  assert.equal(before.records.length, after.records.length);
  const oldRecords = new Map(before.records.map((record) => [record.file, record]));
  assert.equal(oldRecords.size, before.records.length, "source paths are unique within a bundle");
  for (const record of after.records) {
    recordsChecked++;
    const old = oldRecords.get(record.file);
    assert.ok(old); assert.equal(record.ok, old.ok);
    assert.deepEqual(priorFields(record), priorFields(old), "all pre-existing bounded-parser metadata and non-special-usage metrics remain exact");
    if (!record.ok) { failed++; continue; }
    parsed++; assert.equal(record.statsVersion, 6); assert.equal(old.statsVersion, 4);
    const rawKey = record.identityKey ?? `${source.sourceFilename}/${record.file}`;
    for (const [slot, side] of record.players.entries()) {
      const oldUsage = usage(old.players[slot].moveStats?.[21]), newUsage = usage(side.moveStats?.[21]);
      if (JSON.stringify(oldUsage) === JSON.stringify(newUsage)) continue;
      assert.ok(!record.isTeams && record.players.length === 2, "only measured singles can withdraw coverage");
      for (const field of usageFields) assert.ok(newUsage[field] === oldUsage[field] || newUsage[field] === undefined,
        "completeness corrections withdraw measurements; they never replace a count with a different count");
      assert.deepEqual(newUsage, {}, "invalid finalized frame coverage withdraws the entire Down B measurement");
      assert.equal(publicKeys.has(sha(`nikki-public-game-v1:${beforeManifest.datasetId}:${rawKey}`)), false,
        "a corrected named public game requires separately reviewed pairing-preserving handling");
      const evidenceKey = `${source.sourceFilename}\0${member(record.file)}`, proof = evidence.get(evidenceKey);
      assert.ok(proof, "every actual correction requires original replay evidence, not a candidate-list exemption");
      assert.equal(proof.correctedStatsVersion, 6); assert.equal(proof.specialsEqual, true);
      assert.equal(proof.bytes, record.bytes); assert.equal(proof.auditedCompressedBytes, source.compressed_bytes);
      assert.equal(proof.durationFrames, record.durationFrames);
      assert.ok(Number.isInteger(proof.lastFinalized) && Number.isInteger(proof.statsLastFrame));
      assert.ok(Array.isArray(proof.finalPosts) && proof.finalPosts.length === 2);
      const expectedLastFrame = Math.max(proof.statsLastFrame,
        Number.isInteger(proof.metadataLastFrame) ? proof.metadataLastFrame : proof.statsLastFrame);
      const completeFailure = proof.lastFinalized !== expectedLastFrame || Number.isInteger(proof.firstFinalizedRewrite?.frame)
        || Number.isInteger(proof.firstFinalizedRawRewrite?.frame)
        || proof.finalPosts.some((post) => !post.present);
      assert.ok(completeFailure, "raw evidence positively identifies an incomplete terminal frame or finalized-frame rewrite");
      const proofSide = proof.players.find((player) => player.playerIndex === side.playerIndex);
      assert.equal(proofSide?.characterId, side.characterId);
      assert.deepEqual(proofSide.bounded[21], newUsage); assert.deepEqual(proofSide.retained[21], newUsage);
      if (!checkedEvidence.has(evidenceKey)) {
        assert.equal((await stat(proof.localFile)).size, record.bytes);
        assert.equal(await fileHash(proof.localFile), proof.replaySha256);
        checkedEvidence.add(evidenceKey);
      }
      corrections.push({ bundle: source.sourceFilename, file: record.file, slot, playerIndex: side.playerIndex,
        characterId: side.characterId, durationFrames: record.durationFrames, bytes: record.bytes,
        recordIdentitySha256: sha(rawKey), replaySha256: proof.replaySha256,
        before: oldUsage, after: newUsage,
        evidence: { statsLastFrame: proof.statsLastFrame, metadataLastFrame: proof.metadataLastFrame,
          expectedLastFrame, lastFinalized: proof.lastFinalized, firstFinalizedRewrite: proof.firstFinalizedRewrite,
          firstFinalizedRawRewrite: proof.firstFinalizedRawRewrite ?? null, finalPosts: proof.finalPosts },
        reason: "Original replay cannot supply a complete immutable finalized-frame history; all Down B usage coverage is withdrawn." });
    }
  }
  bundleFingerprints.push({ bundle: source.sourceFilename, beforeSha256, afterSha256 });
  if (bundleFingerprints.length % 10 === 0) process.stderr.write(`Completeness QA checked ${bundleFingerprints.length}/${sources.length} bundles\n`);
}
assert.equal(recordsChecked, 159965); assert.equal(parsed, 158884); assert.equal(failed, 1081);
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), beforeStatsVersion: 4, statsVersion: 6,
  beforeDatasetId: beforeManifest.datasetId, beforeContentSha256: beforeManifest.contentSha256,
  parserSha256: state.parserSha256, auditSha256, diagnosticsSha256: await fileHash(diagnosticPath),
  recordsChecked, parsed, failed, correctedReplays: checkedEvidence.size, correctedSides: corrections.length,
  bundleFingerprints, corrections };
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, recordsChecked, correctedReplays: checkedEvidence.size, correctedSides: corrections.length, output: outputPath }));
