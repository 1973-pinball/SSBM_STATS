#!/usr/bin/env node
/** Derive a new local audit; never mutate the pinned October 22 evidence. */
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OOTB5_EVIDENCE, sha256, validateOriginalAudit, validateProvenance } from "./lib/ootb5-recovery.mjs";
import { verifyAuditedSourceHash } from "./lib/archive-source-integrity.mjs";
import { planArchiveSourcePopulation } from "./lib/archive-source-population.mjs";

export function createRecoveredAudit(originalBytes, verificationBytes, provenanceBytes, {
  revision, acceptOwnerAttestation = false, createdAt = new Date().toISOString(),
  // Synthetic unit-test evidence only; the CLI always uses pinned evidence.
  evidence = OOTB5_EVIDENCE,
} = {}) {
  assert.match(revision ?? "", /^ootb5-recovery-[a-z0-9][a-z0-9._-]*$/, "Use a distinct ootb5-recovery-* revision ID");
  const original = validateOriginalAudit(originalBytes, evidence);
  assert.equal(original.recoveryRevision, undefined, "Parent must be the original audit");
  const report = JSON.parse(verificationBytes);
  assert.equal(report.type, "recoveryVerification");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.bundleStem, "ootb5");
  assert.equal(report.originalAuditSha256, sha256(originalBytes), "Verification uses another parent audit");
  assert.deepEqual(report.expected, { compressedBytes: evidence.compressedBytes, replayFiles: evidence.replayFiles });
  assert.equal(report.archive?.compressedBytes, evidence.compressedBytes);
  assert.match(report.archive?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(["7z", "zip"].includes(report.archive.format));
  assert.equal(report.archive.sourceFilename, `ootb5.${report.archive.format}`, "Unsafe or mismatched recovered filename");
  assert.equal(report.replayFiles, evidence.replayFiles);
  assert.equal(report.slpzFiles, 0);
  assert.equal(report.integrityTest?.passed, true, "Archive integrity was not verified");
  assert.equal(report.provenanceEvidenceSha256, sha256(provenanceBytes), "Provenance document changed since verification");
  const provenance = JSON.parse(provenanceBytes);
  const reviewed = validateProvenance(provenance, report.archive.sha256);
  assert.notEqual(reviewed.status, "awaiting-provenance", "A technical pass cannot establish source identity");
  assert.equal(report.status, reviewed.status, "Verification status disagrees with evidence");
  assert.deepEqual(report.provenance, provenance, "Verification provenance disagrees with reviewed evidence");
  if (reviewed.status === "verified-owner-attestation") {
    assert.equal(acceptOwnerAttestation, true,
      "Owner attestation has no historical cryptographic anchor; explicitly accept this basis after reviewing the evidence");
  }
  const revised = structuredClone(original);
  const source = revised.sources.find((row) => row.id === `${evidence.datasetId}:ootb5`);
  source.sourceFilename = report.archive.sourceFilename;
  source.sourceSha256 = report.archive.sha256;
  revised.recoveryRevision = {
    schemaVersion: 1, id: revision, createdAt,
    kind: "ootb5-original-source-recovery",
    parentAuditSha256: sha256(originalBytes),
    verificationReportSha256: sha256(verificationBytes),
    provenanceEvidenceSha256: sha256(provenanceBytes),
    assurance: reviewed.status,
    limitation: reviewed.limitation,
  };
  // Exercise the actual builder source contract, including unchanged v8 IDs.
  assert.ok(revised.sources.every((row) => row.sourceFilename), "Another source is unavailable");
  planArchiveSourcePopulation(revised, [], revised.sources.map((row) => row.sourceFilename.replace(/\.(7z|zip)$/i, ".json")));
  return revised;
}

export async function writeRecoveredAudit(output, audit) {
  assert.ok(output.endsWith(".local.json"), "Revised audit filename must end in .local.json");
  await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx" });
}

async function main() {
  const args = new Map();
  const allowed = ["--audit", "--archive", "--verification", "--provenance", "--revision", "--output", "--accept-owner-attestation"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert.ok(allowed.includes(key) && value && !args.has(key), "Expected unique --name value arguments");
    args.set(key, value);
  }
  for (const key of allowed.slice(0, 6)) assert.ok(args.has(key), `Required ${key}`);
  if (args.has("--accept-owner-attestation")) assert.equal(args.get("--accept-owner-attestation"), "true");
  const output = path.resolve(args.get("--output"));
  assert.ok(output.endsWith(".local.json"), "New audit must use a .local.json suffix");
  try { await access(output); throw new Error("Audit already exists; use a new revision filename"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const [originalBytes, verificationBytes, provenanceBytes] = await Promise.all(
    ["--audit", "--verification", "--provenance"].map((key) => readFile(path.resolve(args.get(key)))));
  const revised = createRecoveredAudit(originalBytes, verificationBytes, provenanceBytes, {
    revision: args.get("--revision"), acceptOwnerAttestation: args.get("--accept-owner-attestation") === "true",
  });
  const source = revised.sources.find((row) => row.id === `${OOTB5_EVIDENCE.datasetId}:ootb5`);
  // A stale report cannot enroll different same-size bytes into the new audit.
  await verifyAuditedSourceHash(source, path.resolve(args.get("--archive")));
  await writeRecoveredAudit(output, revised);
  console.log(JSON.stringify({ status: "new-local-audit-created", revision: revised.recoveryRevision.id,
    sourceCount: revised.sources.length, sourceSha256: source.sourceSha256,
    assurance: revised.recoveryRevision.assurance, auditSha256: sha256(await readFile(output)) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(`ootb5 audit revision rejected: ${error.message}`); process.exitCode = 1; }
}
