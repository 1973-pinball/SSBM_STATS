import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { OOTB5_EVIDENCE, sha256, validateOriginalAudit } from "./ootb5-recovery.mjs";
import { createRecoveredAudit } from "../revise-ootb5-source-audit.mjs";
import { archiveBundleStem, planArchiveSourcePopulation, assertArchiveSourcePayload } from "./archive-source-population.mjs";
import { receiptMatchesSourceHash, verifyAuditedSourceHash } from "./archive-source-integrity.mjs";
import { ARCHIVE_CONTENT_TABLES, computeArchiveContentSha256 } from "./archive-content-hash.mjs";

export const RECOVERY_PARSER_INPUTS = Object.freeze([
  "src/lib/parse.ts", "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts", "src/lib/types.ts",
  "src/lib/replayMetadata.ts", "scripts/analyze-nikki-bundle.mjs", "scripts/lib/archive-move-coverage.mjs", "package-lock.json",
]);
export const RECOVERY_BOUNDARY_CONTRACT = Object.freeze({
  evidence: OOTB5_EVIDENCE,
  baselineDatasetId: "nikki-2026-09-08-v11",
  baselineContentSha256: "081e7a273ff42c93a09d3e72d5ea216caaea24d80e507299e7a43d601020eb94",
  parserSha256: "cc6083652ac2bf22c3ac0eb7e2219e28215bb5721858c433963c19181751951e",
  oldSourceCount: 67, sourceCount: 68,
  oldReplayFiles: 159965, replayFiles: 161510,
  oldCompressedBytes: 65335000563, compressedBytes: 66151744566,
  oldParsed: 158884, oldFailed: 1081,
  dataAsOf: "2026-09-08", minimumVersion: 12,
});
const defaultRegistries = ["scripts/data/nikki-event-registry.json", "scripts/data/nikki-series-registry.json",
  "scripts/data/nikki-player-overrides.json", "scripts/data/interaction-pro-overrides.json"];
const loadOrder = ["archive_datasets", ...ARCHIVE_CONTENT_TABLES];
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const same = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const validCount = value => Number.isSafeInteger(value) && value >= 0;

async function directory(filename) {
  const info = await lstat(filename);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "Recovery inputs must be real directories, not links");
  return realpath(filename);
}
async function regularFile(filename) {
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Recovery evidence must be a regular file, not a link");
}
async function hashFile(filename) {
  await regularFile(filename);
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(filename)) digest.update(bytes);
  return digest.digest("hex");
}

/** Validate immutable inputs before any recovery curation or statistical comparison.
 * The second argument is an API-only synthetic-test contract; never expose it as a CLI option.
 * Reads one old/new payload pair at a time. No files are written or modified.
 */
export async function verifyRecoveryBoundary({ oldCache, cache, audit: auditPath, verification, provenance,
  beforeDir, afterDir, repo, registryFiles = defaultRegistries, acceptOwnerAttestation = false },
{ contract = RECOVERY_BOUNDARY_CONTRACT } = {}) {
  oldCache = await directory(path.resolve(oldCache));
  cache = await directory(path.resolve(cache));
  repo = await directory(path.resolve(repo));
  assert.ok(!inside(oldCache, cache) && !inside(cache, oldCache), "Original and recovery caches must be distinct, non-nested directories");
  beforeDir = await directory(path.resolve(beforeDir ?? path.join(oldCache, "public-export-v11")));
  afterDir = await directory(path.resolve(afterDir));
  assert.ok(!inside(oldCache, afterDir) && !inside(beforeDir, afterDir) && !inside(afterDir, beforeDir),
    "Recovery export must be separate from immutable baseline inputs");
  const inputFingerprints = [];
  const read = async (filename, kind) => {
    filename = path.resolve(filename);
    await regularFile(filename);
    const bytes = await readFile(filename);
    inputFingerprints.push({ kind, path: filename, sha256: sha256(bytes) });
    return bytes;
  };
  const json = async (filename, kind) => JSON.parse(await read(filename, kind));
  const originalBytes = await read(path.join(oldCache, "source-audit-2026-10-22.json"), "parent-audit");
  const oldAudit = validateOriginalAudit(originalBytes, contract.evidence);
  const newAuditBytes = await read(auditPath, "recovery-audit"), audit = JSON.parse(newAuditBytes);
  const verificationBytes = await read(verification, "source-verification");
  const provenanceBytes = await read(provenance, "source-provenance");
  const reconstructed = createRecoveredAudit(originalBytes, verificationBytes, provenanceBytes, {
    revision: audit.recoveryRevision?.id, createdAt: audit.recoveryRevision?.createdAt,
    acceptOwnerAttestation, evidence: contract.evidence,
  });
  same(audit, reconstructed, "Recovery audit is not the exact reviewed one-source revision of the pinned parent");
  assert.ok(typeof audit.recoveryRevision.createdAt === "string" && Number.isFinite(Date.parse(audit.recoveryRevision.createdAt)),
    "Recovery audit requires a valid creation timestamp");
  const newAuditSha256 = sha256(newAuditBytes), oldAuditSha256 = sha256(originalBytes);
  const resultDirectories = await Promise.all([oldCache, cache].map(root => directory(path.join(root, "results-v6"))));
  const receiptDirectories = await Promise.all([oldCache, cache].map(root => directory(path.join(root, "backfill-v6", "receipts"))));
  assert.ok(inside(oldCache, resultDirectories[0]) && inside(cache, resultDirectories[1])
    && inside(oldCache, receiptDirectories[0]) && inside(cache, receiptDirectories[1]), "Result and receipt paths escaped their own cache");
  const filenames = await Promise.all(resultDirectories.map(async dir => (await readdir(dir)).filter(name => name.endsWith(".json")).sort()));
  const oldPlan = planArchiveSourcePopulation(oldAudit, ["ootb5"], filenames[0]);
  const sourcePlan = planArchiveSourcePopulation(audit, [], filenames[1]);
  assert.equal(filenames[0].length, contract.oldSourceCount, "Original parsed bundle membership changed");
  assert.equal(filenames[1].length, contract.sourceCount, "Recovery parsed bundle membership is incomplete");
  for (const [plan, count, bytes] of [[oldPlan, contract.oldReplayFiles, contract.oldCompressedBytes],
    [sourcePlan, contract.replayFiles, contract.compressedBytes]]) {
    assert.equal(plan.metadata.expectedReplayFiles, count, "Audited replay population changed");
    assert.equal(plan.metadata.expectedCompressedBytes, bytes, "Audited compressed population changed");
  }
  for (const index of [0, 1]) {
    const receiptNames = (await readdir(receiptDirectories[index])).filter(name => name.endsWith(".json")).sort();
    same(receiptNames, filenames[index], "Receipts must exactly cover the selected parsed bundles");
  }
  const parserHash = createHash("sha256");
  for (const filename of RECOVERY_PARSER_INPUTS) {
    parserHash.update(filename); parserHash.update(await read(path.join(repo, filename), "parser-input"));
  }
  const parserSha256 = parserHash.digest("hex");
  assert.equal(parserSha256, contract.parserSha256, "Current parser differs from the frozen stats6 recovery baseline");
  const payloadFiles = filenames[1].map(name => path.join(resultDirectories[1], name));
  const oldPayloadFiles = filenames[0].map(name => path.join(resultDirectories[0], name));
  const counts = { oldParsed: 0, oldFailed: 0, newParsed: 0, newFailed: 0, recoveredParsed: 0, recoveredFailed: 0 };
  async function payload(index, filename, plan, auditSha256) {
    const fullPath = path.join(resultDirectories[index], filename);
    const bytes = await read(fullPath, index ? "recovery-payload" : "baseline-payload");
    const value = JSON.parse(bytes), source = plan.sourceByStem.get(archiveBundleStem(filename));
    assertArchiveSourcePayload(plan, filename, value);
    assert.equal(value.schemaVersion, 2, "Unsupported source payload schema");
    assert.equal(value.statsVersion, 6, "Source payload must retain stats6");
    assert.equal(value.statProfile, "dashboard-full-derived-v1", "Source payload must retain the full derived profile");
    assert.ok(Array.isArray(value.records) && value.records.length === source.replay_file_count,
      "Source record count differs from its audited replay count");
    let parsed = 0, failed = 0;
    for (const record of value.records) {
      assert.equal(typeof record.ok, "boolean", "Each source record must state parse success or failure");
      if (record.ok) { parsed++; assert.equal(record.statsVersion, 6, "Every successful record must retain stats6"); }
      else failed++;
    }
    assert.ok(validCount(value.parsed) && validCount(value.failed), "Invalid source parsed/failed counters");
    assert.equal(value.parsed, parsed, "Source parsed count does not reconcile");
    assert.equal(value.failed, failed, "Source failure count does not reconcile");
    const receipt = await json(path.join(receiptDirectories[index], filename), index ? "recovery-receipt" : "baseline-receipt");
    assert.equal(receipt.statsVersion, 6, "Receipt must retain stats6");
    same(receipt.specialMoveIds, [18, 19, 20, 21], "Receipt must cover all four special directions");
    assert.equal(receipt.parserSha256, parserSha256, "Receipt uses another parser fingerprint");
    assert.equal(receipt.auditSha256, auditSha256, "Receipt uses another source audit");
    assert.equal(receipt.bundle, value.bundle, "Receipt identifies another source");
    assert.equal(receipt.compressedBytes, source.compressed_bytes, "Receipt compressed size changed");
    assert.equal(receipt.outputSha256, sha256(bytes), "Receipt does not authenticate these result bytes");
    assert.ok(typeof receipt.output === "string" && path.resolve(receipt.output) === path.resolve(fullPath),
      "Receipt output location differs from the selected source result");
    assert.ok(receiptMatchesSourceHash(source, receipt), "Receipt does not bind the recovered archive SHA-256");
    counts[index ? "newParsed" : "oldParsed"] += parsed;
    counts[index ? "newFailed" : "oldFailed"] += failed;
    return value;
  }
  for (const filename of filenames[1]) {
    const current = await payload(1, filename, sourcePlan, newAuditSha256);
    if (archiveBundleStem(filename) === "ootb5") {
      counts.recoveredParsed = current.parsed; counts.recoveredFailed = current.failed;
      continue;
    }
    const previous = await payload(0, filename, oldPlan, oldAuditSha256);
    delete current.analyzedAt; delete previous.analyzedAt;
    same(current, previous, "An original source payload changed beyond its top-level analysis timestamp");
  }
  assert.equal(counts.oldParsed, contract.oldParsed, "Original parsed-file total changed");
  assert.equal(counts.oldFailed, contract.oldFailed, "Original failed-file total changed");
  assert.equal(counts.newParsed + counts.newFailed, contract.replayFiles, "New parse totals do not cover every source replay");
  assert.equal(counts.recoveredParsed + counts.recoveredFailed, contract.evidence.replayFiles, "Recovered parse totals do not reconcile");
  assert.ok(counts.recoveredParsed > 0, "Recovered source has no successfully parsed replays; original-cohort coverage cannot certify an entirely failed source");
  for (const [index, root, plan, auditSha256] of [[0, oldCache, oldPlan, oldAuditSha256], [1, cache, sourcePlan, newAuditSha256]]) {
    const state = await json(path.join(root, "backfill-v6", "state.json"), index ? "recovery-state" : "baseline-state");
    assert.equal(state.statsVersion, 6); assert.equal(state.auditSha256, auditSha256); assert.equal(state.parserSha256, parserSha256);
    assert.ok(state.finishedAt, "Backfill has not completed");
    assert.equal(state.expectedBundles, plan.metadata.includedBundles.length);
    assert.equal(state.expectedReplayFiles, plan.metadata.expectedReplayFiles);
    same(state.failures, [], "Backfill has orchestration failures");
    same(state.pending, [], "Backfill has pending sources");
    same((state.completed ?? []).map(row => archiveBundleStem(row.bundle)).sort(), plan.metadata.includedBundles,
      "Completed backfill sources do not exactly match the audit");
  }
  const recovered = sourcePlan.sourceByStem.get("ootb5");
  const archivePath = path.join(cache, "downloads", recovered.sourceFilename);
  await verifyAuditedSourceHash(recovered, archivePath);
  inputFingerprints.push({ kind: "recovered-original", path: archivePath, sha256: recovered.sourceSha256 });

  async function exportInput(dir, kind) {
    const manifest = await json(path.join(dir, "manifest.json"), `${kind}-manifest`);
    const qa = await json(path.join(dir, "qa.json"), `${kind}-qa`);
    const datasetRows = (await read(path.join(dir, "archive_datasets.ndjson"), `${kind}-dataset`)).toString("utf8")
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(datasetRows.length, 1, "Export must contain one dataset row");
    const [dataset] = datasetRows;
    assert.equal(manifest.schemaVersion, 1);
    same(manifest.loadOrder, loadOrder, "Unexpected archive export load order");
    assert.equal(dataset.id, manifest.datasetId); assert.equal(qa.datasetId, manifest.datasetId);
    assert.equal(dataset.content_sha256, manifest.contentSha256); assert.equal(qa.contentSha256, manifest.contentSha256);
    same(qa.tableCounts, manifest.tableCounts, "QA table counts differ from manifest");
    same(dataset.import_counts, manifest.tableCounts, "Dataset table counts differ from manifest");
    same(qa.sourcePopulation, manifest.sourcePopulation, "QA source population differs from manifest");
    for (const table of ARCHIVE_CONTENT_TABLES) {
      const filename = path.join(dir, `${table}.ndjson`);
      inputFingerprints.push({ kind: `${kind}-table`, path: filename, sha256: await hashFile(filename) });
    }
    assert.equal(await computeArchiveContentSha256({ dir, datasetRow: dataset }), manifest.contentSha256,
      "Export content differs from its recorded fingerprint");
    return { manifest, qa, dataset };
  }
  const baseline = await exportInput(beforeDir, "baseline-export"), after = await exportInput(afterDir, "recovery-export");
  assert.equal(baseline.manifest.datasetId, contract.baselineDatasetId, "Recovery baseline must be the published v11 revision");
  assert.equal(baseline.manifest.contentSha256, contract.baselineContentSha256, "Published v11 baseline fingerprint changed");
  same(baseline.manifest.sourcePopulation, { ...oldPlan.metadata, sourceAuditSha256: oldAuditSha256 }, "Baseline source coverage changed");
  same(after.manifest.sourcePopulation, { ...sourcePlan.metadata, sourceAuditSha256: newAuditSha256 }, "Recovery export does not cover exactly the revised source audit");
  const datasetPrefix = `nikki-${contract.dataAsOf}-v`;
  const version = after.manifest.datasetId?.startsWith(datasetPrefix) ? after.manifest.datasetId.slice(datasetPrefix.length) : "";
  assert.ok(/^[1-9]\d*$/.test(version) && Number.isSafeInteger(Number(version)) && Number(version) >= contract.minimumVersion,
    "Recovery requires a new immutable dataset version after v11 with the original source date");
  for (const [entry, plan, parsed] of [[baseline, oldPlan, counts.oldParsed], [after, sourcePlan, counts.newParsed]]) {
    assert.equal(entry.dataset.data_as_of, contract.dataAsOf, "Original replay snapshot date changed");
    assert.equal(entry.dataset.archive_count, plan.metadata.includedBundles.length);
    assert.equal(entry.dataset.replay_file_count, plan.metadata.expectedReplayFiles);
    assert.equal(entry.dataset.compressed_bytes, plan.metadata.expectedCompressedBytes);
    assert.equal(entry.dataset.parsed_replay_count, parsed);
  }
  assert.equal(after.dataset.parser_version, baseline.dataset.parser_version, "Public parser version changed");
  assert.equal(after.dataset.curation_version, baseline.dataset.curation_version, "Public curation version changed");
  const registryEntries = Array.isArray(registryFiles) ? registryFiles.map(filename => [filename, filename]) : Object.entries(registryFiles);
  const registryHashes = {};
  let supplementalHash = null;
  for (const [role, filename] of registryEntries) {
    const resolved = path.resolve(repo, filename);
    const digest = sha256(await read(resolved, "registry-input"));
    registryHashes[role] = digest;
    if (path.basename(resolved) === "interaction-pro-overrides.json") {
      assert.equal(supplementalHash, null, "Supplemental registry was provided more than once");
      supplementalHash = digest;
    }
  }
  assert.ok(supplementalHash, "Current reviewed supplemental Pro registry is required");
  assert.equal(baseline.qa.identity?.supplementalRegistrySha256, supplementalHash, "Supplemental identities differ from the preserved v11 QA evidence");
  assert.equal(after.qa.identity?.supplementalRegistrySha256, supplementalHash, "Recovery export omitted or changed supplemental Pro identities");
  return { oldCache, cache, beforeDir, afterDir, oldAudit, audit, oldAuditSha256, newAuditSha256, parserSha256,
    payloadFiles, oldPayloadFiles, inputFingerprints, sourcePlan, oldPlan, counts, registryHashes,
    baselineManifest: baseline.manifest, baselineDataset: baseline.dataset, baselineQa: baseline.qa,
    afterManifest: after.manifest, afterDataset: after.dataset, afterQa: after.qa,
    registryEvidenceLimit: "Supplemental identity bytes match preserved v11 QA. Other registry hashes bind this verification only; no missing historical registry hashes are inferred." };
}
