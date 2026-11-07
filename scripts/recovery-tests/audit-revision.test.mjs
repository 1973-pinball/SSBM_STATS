import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRecoveredAudit, writeRecoveredAudit } from "../revise-ootb5-source-audit.mjs";
import { OOTB5_EVIDENCE, sha256 } from "../lib/ootb5-recovery.mjs";
import { planArchiveSourcePopulation } from "../lib/archive-source-population.mjs";

function fixture(basis = "historical-sha256") {
  const parent = { observedAt: "2026-10-22T13:34:23.312Z", dataset: { id: OOTB5_EVIDENCE.datasetId, archive_count: 2 },
    sources: [
      { id: `${OOTB5_EVIDENCE.datasetId}:existing`, sourceFilename: "existing.7z", compressed_bytes: 100, replay_file_count: 3 },
      { id: `${OOTB5_EVIDENCE.datasetId}:ootb5`, sourceFilename: null, compressed_bytes: 816744003, replay_file_count: 1545 },
    ] };
  const originalBytes = Buffer.from(JSON.stringify(parent));
  const evidence = { ...OOTB5_EVIDENCE, originalAuditSha256: sha256(originalBytes) };
  const archiveSha256 = "b".repeat(64);
  const provenance = { schemaVersion: 1, bundleStem: "ootb5", archiveSha256,
    reviewedBy: "Synthetic reviewer", reviewedAt: "2026-11-07T15:00:00Z", basis,
    evidenceReference: "Synthetic historical record", originalUnmodified: true,
    ...(basis === "historical-sha256" ? { historicalSha256: archiveSha256 } : {}) };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance));
  const report = { type: "recoveryVerification", schemaVersion: 1, bundleStem: "ootb5",
    originalAuditSha256: sha256(originalBytes), expected: { compressedBytes: 816744003, replayFiles: 1545 },
    archive: { sha256: archiveSha256, compressedBytes: 816744003, format: "7z", sourceFilename: "ootb5.7z" },
    replayFiles: 1545, slpzFiles: 0, integrityTest: { passed: true }, provenance,
    provenanceEvidenceSha256: sha256(provenanceBytes),
    status: basis === "historical-sha256" ? "verified-historical-hash" : "verified-owner-attestation" };
  const options = { evidence, revision: "ootb5-recovery-synthetic", createdAt: "2026-11-07T16:00:00Z" };
  const build = (override = {}, opts = {}, provBytes = provenanceBytes) =>
    createRecoveredAudit(originalBytes, Buffer.from(JSON.stringify({ ...report, ...override })), provBytes, { ...options, ...opts });
  return { parent, originalBytes, provenanceBytes, report, options, build };
}

test("new audit preserves every historical field and enrolls only the existing missing row", () => {
  const f = fixture(), revised = f.build();
  const restored = structuredClone(revised);
  delete restored.recoveryRevision;
  restored.sources[1].sourceFilename = null;
  delete restored.sources[1].sourceSha256;
  assert.deepEqual(restored, f.parent);
  assert.equal(revised.recoveryRevision.parentAuditSha256, sha256(f.originalBytes));
  assert.equal(revised.recoveryRevision.provenanceEvidenceSha256, sha256(f.provenanceBytes));
  const plan = planArchiveSourcePopulation(revised, [], ["existing.json", "ootb5.json"]);
  assert.deepEqual(plan.metadata.includedBundles, ["existing", "ootb5"]);
  assert.deepEqual(plan.metadata.excludedBundles, []);
  assert.equal(plan.metadata.expectedReplayFiles, 1548);
  assert.equal(f.parent.sources[1].sourceFilename, null);
});

test("technical-only, failed integrity and inconsistent reports cannot revise source coverage", () => {
  const f = fixture();
  for (const override of [
    { status: "awaiting-provenance" }, { integrityTest: { passed: false } }, { replayFiles: 1544 },
    { slpzFiles: 1 }, { originalAuditSha256: "f".repeat(64) },
    { archive: { ...f.report.archive, sourceFilename: "../ootb5.7z" } },
    { provenanceEvidenceSha256: "e".repeat(64) },
    { provenance: { ...f.report.provenance, reviewedBy: "different reviewer" } },
  ]) assert.throws(() => f.build(override));
});

test("owner attestation requires explicit acceptance and remains labeled as unanchored", () => {
  const f = fixture("owner-cache-attestation");
  assert.throws(() => f.build(), /explicitly accept/);
  const revised = f.build({}, { acceptOwnerAttestation: true });
  assert.equal(revised.recoveryRevision.assurance, "verified-owner-attestation");
  assert.match(revised.recoveryRevision.limitation, /No pre-recovery cryptographic/);
});

test("changed parent or provenance bytes and malformed revision IDs fail", () => {
  const f = fixture();
  assert.throws(() => createRecoveredAudit(Buffer.concat([f.originalBytes, Buffer.from(" ")]),
    Buffer.from(JSON.stringify(f.report)), f.provenanceBytes, f.options), /audit hash/);
  assert.throws(() => f.build({}, {}, Buffer.concat([f.provenanceBytes, Buffer.from(" ")])), /Provenance document changed/);
  assert.throws(() => f.build({}, { revision: "v10" }), /revision ID/);
  assert.throws(() => f.build({}, { revision: "ootb5-recovery-../overwrite" }), /revision ID/);
});

test("new audits are exclusive-create local evidence and never overwrite a parent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ootb5-audit-test-"));
  const output = path.join(directory, "revised.local.json");
  try {
    await writeFile(output, "immutable sentinel");
    await assert.rejects(writeRecoveredAudit(output, fixture().build()), { code: "EEXIST" });
    assert.equal(await readFile(output, "utf8"), "immutable sentinel");
    await assert.rejects(writeRecoveredAudit(path.join(directory, "public.json"), {}), /local.json/);
    const fresh = path.join(directory, "fresh.local.json");
    await writeRecoveredAudit(fresh, fixture().build());
    assert.equal(JSON.parse(await readFile(fresh, "utf8")).sources[1].sourceFilename, "ootb5.7z");
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ootb5-audit-test-"));
    await rm(directory, { recursive: true });
  }
});
