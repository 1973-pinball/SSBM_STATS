import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RECOVERY_BOUNDARY_CONTRACT, RECOVERY_PARSER_INPUTS, verifyRecoveryBoundary } from "../lib/archive-recovery-boundary.mjs";
import { OOTB5_EVIDENCE, sha256 } from "../lib/ootb5-recovery.mjs";
import { createRecoveredAudit } from "../revise-ootb5-source-audit.mjs";
import { planArchiveSourcePopulation } from "../lib/archive-source-population.mjs";
import { ARCHIVE_CONTENT_TABLES, computeArchiveContentSha256 } from "../lib/archive-content-hash.mjs";

const put = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};
const get = async file => JSON.parse(await readFile(file, "utf8"));

async function fixture(t, { firstSourceReplayFiles = 1 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ssbm-recovery-boundary-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ssbm-recovery-boundary-"));
    await rm(directory, { recursive: true, force: true });
  });
  const oldCache = path.join(directory, "old"), cache = path.join(directory, "new"), repo = path.join(directory, "repo");
  await Promise.all([oldCache, cache, repo].map(dir => mkdir(dir)));
  const parserHash = createHash("sha256");
  for (const filename of RECOVERY_PARSER_INPUTS) {
    const content = `Synthetic frozen parser input: ${filename}`;
    await put(path.join(repo, filename), content);
    parserHash.update(filename); parserHash.update(content);
  }
  const parserSha256 = parserHash.digest("hex");
  const registry = "scripts/data/interaction-pro-overrides.json", registryText = JSON.stringify({ synthetic: true });
  await put(path.join(repo, registry), registryText);
  const recoveredBytes = Buffer.from("synthetic recovered original");
  const oldAudit = { dataset: { id: OOTB5_EVIDENCE.datasetId, archive_count: 3 }, sources: [
    { id: `${OOTB5_EVIDENCE.datasetId}:event-a`, sourceFilename: "event-a.7z", compressed_bytes: 10, replay_file_count: firstSourceReplayFiles },
    { id: `${OOTB5_EVIDENCE.datasetId}:event-b`, sourceFilename: "event-b.zip", compressed_bytes: 20, replay_file_count: 1 },
    { id: `${OOTB5_EVIDENCE.datasetId}:ootb5`, sourceFilename: null, compressed_bytes: recoveredBytes.length, replay_file_count: 1 },
  ] };
  const originalBytes = Buffer.from(JSON.stringify(oldAudit));
  const evidence = { ...OOTB5_EVIDENCE, originalAuditSha256: sha256(originalBytes), compressedBytes: recoveredBytes.length, replayFiles: 1 };
  const provenanceDoc = { schemaVersion: 1, bundleStem: "ootb5", archiveSha256: sha256(recoveredBytes),
    originalUnmodified: true, reviewedBy: "Synthetic reviewer", reviewedAt: "2026-11-07T00:00:00Z",
    evidenceReference: "Synthetic fixture only", basis: "historical-sha256", historicalSha256: sha256(recoveredBytes) };
  const provenanceBytes = Buffer.from(JSON.stringify(provenanceDoc));
  const report = { type: "recoveryVerification", schemaVersion: 1, bundleStem: "ootb5", originalAuditSha256: sha256(originalBytes),
    expected: { compressedBytes: recoveredBytes.length, replayFiles: 1 },
    archive: { compressedBytes: recoveredBytes.length, sha256: sha256(recoveredBytes), format: "7z", sourceFilename: "ootb5.7z" },
    replayFiles: 1, slpzFiles: 0, integrityTest: { passed: true }, provenanceEvidenceSha256: sha256(provenanceBytes),
    provenance: provenanceDoc, status: "verified-historical-hash" };
  const reportBytes = Buffer.from(JSON.stringify(report));
  const auditDoc = createRecoveredAudit(originalBytes, reportBytes, provenanceBytes, {
    revision: "ootb5-recovery-synthetic", createdAt: "2026-11-07T00:00:00Z", evidence,
  });
  const newAuditBytes = Buffer.from(JSON.stringify(auditDoc));
  const audit = path.join(cache, "audit.local.json"), verification = path.join(cache, "verification.local.json"), provenance = path.join(cache, "provenance.local.json");
  await put(path.join(oldCache, "source-audit-2026-10-22.json"), originalBytes);
  await put(audit, newAuditBytes); await put(verification, reportBytes); await put(provenance, provenanceBytes);
  await put(path.join(cache, "downloads", "ootb5.7z"), recoveredBytes);
  const makePayload = source => ({ schemaVersion: 2, statsVersion: 6, statProfile: "dashboard-full-derived-v1",
    bundle: source.sourceFilename, source: "https://replays.nikki.sh/", analyzedAt: "2026-10-23T00:00:00Z",
    replayFiles: source.replay_file_count, parsed: source.replay_file_count, failed: 0,
    records: Array.from({ length: source.replay_file_count }, (_, index) => ({ ok: true, statsVersion: 6,
      file: `game-${index}.slp`, identityKey: `${source.id}-${index}`, players: [{ characterId: 1, moveStats: { 18: {} } }] })) });
  for (const [root, sources, auditSha256] of [[oldCache, oldAudit.sources.filter(source => source.sourceFilename), sha256(originalBytes)],
    [cache, auditDoc.sources, sha256(newAuditBytes)]]) {
    for (const source of sources) {
      const stem = source.id.split(":").at(-1), output = path.join(root, "results-v6", `${stem}.json`);
      const value = makePayload(source);
      if (root === cache) value.analyzedAt = "2026-11-07T00:00:00Z";
      const outputBytes = Buffer.from(JSON.stringify(value));
      await put(output, outputBytes);
      await put(path.join(root, "backfill-v6", "receipts", `${stem}.json`), {
        bundle: source.sourceFilename, compressedBytes: source.compressed_bytes, statsVersion: 6, specialMoveIds: [18, 19, 20, 21],
        parserSha256, auditSha256, output, outputSha256: sha256(outputBytes),
        ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
      });
    }
    await put(path.join(root, "backfill-v6", "state.json"), { statsVersion: 6, parserSha256, auditSha256,
      finishedAt: "2026-11-07T00:00:00Z", expectedBundles: sources.length,
      expectedReplayFiles: sources.reduce((sum, source) => sum + source.replay_file_count, 0),
      failures: [], pending: [], completed: sources.map(source => ({ bundle: source.sourceFilename })) });
  }
  const oldPlan = planArchiveSourcePopulation(oldAudit, ["ootb5"], ["event-a.json", "event-b.json"]);
  const newPlan = planArchiveSourcePopulation(auditDoc, [], ["event-a.json", "event-b.json", "ootb5.json"]);
  const beforeDir = path.join(oldCache, "public-export-v11"), afterDir = path.join(cache, "public-export-v12");
  async function makeExport(dir, datasetId, plan, auditSha256) {
    const tableCounts = Object.fromEntries(["archive_datasets", ...ARCHIVE_CONTENT_TABLES].map(table => [table, table === "archive_datasets" ? 1 : 0]));
    const dataset = { id: datasetId, data_as_of: "2026-09-08", archive_count: plan.metadata.includedBundles.length,
      replay_file_count: plan.metadata.expectedReplayFiles, compressed_bytes: plan.metadata.expectedCompressedBytes,
      parsed_replay_count: plan.metadata.expectedReplayFiles, parser_version: "synthetic-parser", curation_version: "synthetic-curation",
      import_counts: tableCounts, content_sha256: null };
    for (const table of ARCHIVE_CONTENT_TABLES) await put(path.join(dir, `${table}.ndjson`), "");
    dataset.content_sha256 = await computeArchiveContentSha256({ dir, datasetRow: dataset });
    const manifest = { schemaVersion: 1, datasetId, contentSha256: dataset.content_sha256, loadOrder: ["archive_datasets", ...ARCHIVE_CONTENT_TABLES],
      sourcePopulation: { ...plan.metadata, sourceAuditSha256: auditSha256 }, tableCounts };
    await put(path.join(dir, "archive_datasets.ndjson"), `${JSON.stringify(dataset)}\n`);
    await put(path.join(dir, "manifest.json"), manifest);
    await put(path.join(dir, "qa.json"), { datasetId, contentSha256: dataset.content_sha256, tableCounts,
      sourcePopulation: manifest.sourcePopulation, identity: { supplementalRegistrySha256: sha256(registryText) } });
    return manifest;
  }
  const baseline = await makeExport(beforeDir, "nikki-2026-09-08-v11", oldPlan, sha256(originalBytes));
  await makeExport(afterDir, "nikki-2026-09-08-v12", newPlan, sha256(newAuditBytes));
  const contract = { ...RECOVERY_BOUNDARY_CONTRACT, evidence, parserSha256, baselineContentSha256: baseline.contentSha256,
    oldSourceCount: 2, sourceCount: 3, oldReplayFiles: firstSourceReplayFiles + 1, replayFiles: firstSourceReplayFiles + 2,
    oldCompressedBytes: 30, compressedBytes: 30 + recoveredBytes.length, oldParsed: firstSourceReplayFiles + 1, oldFailed: 0 };
  const options = { oldCache, cache, audit, verification, provenance, beforeDir, afterDir, repo, registryFiles: [registry] };
  const run = () => verifyRecoveryBoundary(options, { contract });
  const mutatePayload = async (stem, mutate, root = cache, updateReceipt = true) => {
    const file = path.join(root, "results-v6", `${stem}.json`), value = await get(file);
    mutate(value); await put(file, value);
    if (updateReceipt) {
      const receiptFile = path.join(root, "backfill-v6", "receipts", `${stem}.json`), receipt = await get(receiptFile);
      receipt.outputSha256 = sha256(await readFile(file)); await put(receiptFile, receipt);
    }
  };
  return { directory, options, contract, run, mutatePayload, makeExport, newPlan, newAuditBytes };
}

test("verified recovery binds 2 unchanged originals plus 1 restored source with only analysis timestamps changed", async t => {
  const f = await fixture(t), result = await f.run();
  assert.deepEqual(result.counts, { oldParsed: 2, oldFailed: 0, newParsed: 3, newFailed: 0, recoveredParsed: 1, recoveredFailed: 0 });
  assert.equal(result.payloadFiles.length, 3); assert.equal(result.oldPayloadFiles.length, 2);
  assert.equal(result.parserSha256, f.contract.parserSha256);
  assert.equal(result.afterManifest.datasetId, "nikki-2026-09-08-v12");
  assert.ok(result.inputFingerprints.some(row => row.kind === "recovered-original"));
  assert.match(result.registryEvidenceLimit, /no missing historical registry hashes/);
});

test("production contract cannot accept synthetic audit evidence", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyRecoveryBoundary(f.options), /Original audit hash/);
});

test("changed old metrics or unknown coverage fail even when new receipts are rehashed", async t => {
  const f = await fixture(t);
  await f.mutatePayload("event-a", value => { value.records[0].players[0].moveStats[18].attempts = 0; });
  await assert.rejects(f.run(), /changed beyond/);
});

test("retained old record ordering is part of the immutable payload comparison", async t => {
  const f = await fixture(t, { firstSourceReplayFiles: 2 });
  await f.mutatePayload("event-a", value => { value.records.reverse(); });
  await assert.rejects(f.run(), /changed beyond/);
});

test("parsed and failed counters must agree with actual records", async t => {
  const f = await fixture(t);
  await f.mutatePayload("ootb5", value => { value.parsed = 0; value.failed = 1; });
  await assert.rejects(f.run(), /parsed count does not reconcile/);
});

test("an entirely failed recovered source cannot borrow coverage from the original cohort", async t => {
  const f = await fixture(t);
  await f.mutatePayload("ootb5", value => {
    value.records = value.records.map(record => ({ ok: false, file: record.file, error: "Synthetic parse failure" }));
    value.parsed = 0;
    value.failed = value.replayFiles;
  });
  await assert.rejects(f.run(), /no successfully parsed replays/);
});

test("forged receipt output hashes and source hashes fail", async t => {
  const f = await fixture(t);
  const receiptFile = path.join(f.options.cache, "backfill-v6", "receipts", "ootb5.json"), receipt = await get(receiptFile);
  await put(receiptFile, { ...receipt, outputSha256: "0".repeat(64) });
  await assert.rejects(f.run(), /authenticate these result bytes/);
  await put(receiptFile, { ...receipt, sourceSha256: "0".repeat(64) });
  await assert.rejects(f.run(), /recovered archive SHA-256/);
});

test("missing old bundle, unexpected new bundle and extra receipt fail membership checks", async t => {
  const f = await fixture(t);
  const file = path.join(f.options.cache, "results-v6", "event-b.json"), bytes = await readFile(file);
  await rm(file); await assert.rejects(f.run(), /missing=\[event-b\]/); await put(file, bytes);
  const extra = path.join(f.options.cache, "results-v6", "unreviewed.json");
  await put(extra, "{}"); await assert.rejects(f.run(), /unexpected=\[unreviewed\]/); await rm(extra);
  await put(path.join(f.options.cache, "backfill-v6", "receipts", "unreviewed.json"), "{}");
  await assert.rejects(f.run(), /Receipts must exactly cover/);
});

test("changed parent, additional audit mutation and duplicate source rows cannot enter a revision", async t => {
  const f = await fixture(t), original = await get(f.options.audit);
  await put(f.options.audit, { ...original, unauthorizedChange: true });
  await assert.rejects(f.run(), /exact reviewed one-source revision/);
  await put(f.options.audit, { ...original, sources: [...original.sources, original.sources[0]] });
  await assert.rejects(f.run(), /exact reviewed one-source revision/);
  await put(f.options.audit, original);
  const parentFile = path.join(f.options.oldCache, "source-audit-2026-10-22.json");
  await put(parentFile, Buffer.concat([await readFile(parentFile), Buffer.from("\n")]));
  await assert.rejects(f.run(), /Original audit hash/);
});

test("old immutable dataset IDs cannot be reused even with self-consistent export hashes", async t => {
  const f = await fixture(t);
  await f.makeExport(f.options.afterDir, "nikki-2026-09-08-v10", f.newPlan, sha256(f.newAuditBytes));
  await assert.rejects(f.run(), /new immutable dataset version/);
});

test("modified recovered archive or frozen parser fails", async t => {
  const f = await fixture(t), archive = path.join(f.options.cache, "downloads", "ootb5.7z"), bytes = await readFile(archive);
  await put(archive, Buffer.alloc(bytes.length));
  await assert.rejects(f.run(), /SHA-256 mismatch/);
  await put(archive, bytes);
  await put(path.join(f.options.repo, RECOVERY_PARSER_INPUTS[0]), "changed parser");
  await assert.rejects(f.run(), /Current parser differs/);
});

test("cache isolation, receipt locations, state completeness and preserved Pro registry are enforced", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyRecoveryBoundary({ ...f.options, cache: f.options.oldCache }, { contract: f.contract }), /distinct, non-nested/);
  const receiptFile = path.join(f.options.cache, "backfill-v6", "receipts", "event-a.json"), receipt = await get(receiptFile);
  await put(receiptFile, { ...receipt, output: path.join(f.options.oldCache, "results-v6", "event-a.json") });
  await assert.rejects(f.run(), /output location/); await put(receiptFile, receipt);
  const stateFile = path.join(f.options.cache, "backfill-v6", "state.json"), state = await get(stateFile);
  await put(stateFile, { ...state, pending: [{ bundle: "ootb5.7z" }] });
  await assert.rejects(f.run(), /pending sources/); await put(stateFile, state);
  await put(path.join(f.options.repo, f.options.registryFiles[0]), "changed registry");
  await assert.rejects(f.run(), /Supplemental identities differ/);
});
