import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const OOTB5_EVIDENCE = Object.freeze({
  originalAuditSha256: "8f5a891b991081a3c8dc10e1f01e122ff95f2535f16d59bec1ec5cc86b8db59a",
  datasetId: "nikki-2026-09-08-v8",
  bundleStem: "ootb5",
  compressedBytes: 816744003,
  replayFiles: 1545,
});
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaPattern = /^[a-f0-9]{64}$/;

export function validateOriginalAudit(bytes, evidence = OOTB5_EVIDENCE) {
  assert.equal(sha256(bytes), evidence.originalAuditSha256, "Original audit hash differs from immutable evidence");
  const audit = JSON.parse(bytes);
  assert.equal(audit.dataset?.id, evidence.datasetId, "Original audit dataset differs");
  assert.ok(Array.isArray(audit.sources) && audit.sources.length === audit.dataset.archive_count, "Incomplete source audit");
  const sources = audit.sources.filter((source) => source.id === `${evidence.datasetId}:${evidence.bundleStem}`);
  assert.equal(sources.length, 1, "Audit must contain exactly one ootb5 source");
  const [source] = sources;
  assert.equal(source.sourceFilename, null, "Original audit must retain its explicit missing filename");
  assert.equal(source.compressed_bytes, evidence.compressedBytes, "Historical compressed size differs");
  assert.equal(source.replay_file_count, evidence.replayFiles, "Historical replay count differs");
  return audit;
}

export function validateProvenance(document, archiveSha256) {
  if (document === null || document === undefined) return {
    status: "awaiting-provenance",
    provenance: null,
    limitation: "Size, count, and archive integrity do not identify the original source. Independent provenance review is still required.",
  };
  assert.equal(document.schemaVersion, 1, "Unsupported provenance schema");
  assert.equal(document.bundleStem, "ootb5", "Provenance identifies another bundle");
  assert.ok(shaPattern.test(document.archiveSha256), "Provenance requires a lowercase SHA-256");
  assert.equal(document.archiveSha256, archiveSha256, "Provenance hash does not identify these archive bytes");
  assert.equal(document.originalUnmodified, true, "Provenance must attest an unmodified original");
  for (const field of ["reviewedBy", "evidenceReference"]) {
    assert.ok(typeof document[field] === "string" && document[field].trim(), `Provenance requires ${field}`);
  }
  assert.ok(typeof document.reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(document.reviewedAt)
    && Number.isFinite(Date.parse(document.reviewedAt)), "Provenance requires an ISO review timestamp");
  assert.ok(["historical-sha256", "owner-cache-attestation"].includes(document.basis), "Unsupported provenance basis");
  if (document.basis === "historical-sha256") {
    assert.equal(document.historicalSha256, archiveSha256, "Historical SHA-256 does not match the recovered bytes");
    return {
      status: "verified-historical-hash", provenance: document,
      limitation: "The recorded historical hash matches. The reviewer must independently establish that the referenced historical record predates recovery and is authentic; this tool does not authenticate that record.",
    };
  }
  assert.equal(document.historicalSha256, undefined, "Owner attestation must not imply an independently recorded historical hash");
  return {
    status: "verified-owner-attestation", provenance: document,
    limitation: "Source identity relies on the named owner's cache-history attestation. No pre-recovery cryptographic identity anchor has been verified; the newly computed hash only binds future processing.",
  };
}

function safeMember(name) {
  const normalized = name.replaceAll("\\", "/").replace(/\/$/, "");
  // Windows extraction must not admit ADS, device names, lossy trailing dots,
  // Unicode/case aliases, or the backfill's extraction ownership marker.
  const hasControl = [...normalized].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  assert.ok(normalized && !normalized.startsWith("/") && !hasControl && !/[:<>"|?*]/.test(normalized), "Unsafe archive member path");
  const parts = normalized.split("/");
  for (const part of parts) {
    assert.ok(part && part !== "." && part !== ".." && !/[. ]$/.test(part), "Unsafe archive member path component");
    assert.ok(!/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part), "Windows device name in archive");
    assert.notEqual(part.toLowerCase(), ".__special_moves_extraction_owner.json", "Reserved backfill ownership marker in archive");
  }
  return normalized.normalize("NFC").toLowerCase();
}

export function inspectArchiveListings(namesText, verboseText, expectedReplayFiles = OOTB5_EVIDENCE.replayFiles) {
  const lines = (value) => value.split(/\r?\n/).filter((line) => line.length);
  const names = lines(namesText), details = lines(verboseText);
  assert.ok(names.length && names.length === details.length, "Archive listing formats disagree or are empty");
  const members = new Map();
  let replayFiles = 0, slpzFiles = 0, uncompressedBytes = 0;
  for (let i = 0; i < names.length; i++) {
    const member = safeMember(names[i]);
    assert.ok(!members.has(member), "Duplicate or case-colliding archive member");
    const detail = details[i];
    assert.ok(/^[d-]/.test(detail), "Links or special archive entries are not supported");
    assert.ok(!/ -> | link to /.test(detail), "Linked archive entry is not supported");
    const match = detail.match(/^([d-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/);
    assert.ok(match, "Cannot safely read tar verbose listing; use the existing bsdtar-compatible toolchain");
    const size = Number(match[2]);
    assert.ok(Number.isSafeInteger(size) && size >= 0, "Invalid archive entry size");
    uncompressedBytes += size;
    assert.ok(Number.isSafeInteger(uncompressedBytes), "Uncompressed archive size overflow");
    members.set(member, match[1]);
    if (match[1] === "-") {
      if (/\.slp(?:z)?$/i.test(member)) replayFiles++;
      if (/\.slpz$/i.test(member)) slpzFiles++;
    }
  }
  for (const member of members.keys()) {
    const parents = member.split("/");
    while (parents.pop() && parents.length) {
      assert.notEqual(members.get(parents.join("/")), "-", "Archive file shadows a directory");
    }
  }
  assert.equal(replayFiles, expectedReplayFiles, "Archive replay count differs from historical evidence");
  assert.equal(slpzFiles, 0, "Existing backfill does not support .slpz source members");
  return { replayFiles, slpzFiles, memberCount: names.length, uncompressedBytes,
    memberListingSha256: sha256(namesText), verboseListingSha256: sha256(verboseText) };
}

export function runCommand(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "", overflow = false;
    const maximum = 64 * 1024 * 1024;
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (stdout.length > maximum) { overflow = true; child.kill(); }
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
      if (stderr.length > maximum) { overflow = true; child.kill(); }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      // Even a warning may represent an incomplete read. Do not manufacture a
      // successful integrity receipt from a partially readable archive.
      if (overflow || code !== 0 || stderr.trim()) {
        reject(new Error(`${path.basename(program)} failed (exit ${code ?? signal}, output overflow ${overflow}, stderr ${Boolean(stderr.trim())}); no verification report created`));
      } else resolve(stdout);
    });
  });
}

async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

function assertCandidateStat(stat, expectedBytes) {
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Recovered source must be a regular file, not a link or directory");
  assert.equal(stat.size, expectedBytes, "Compressed size differs from historical evidence");
}

export async function verifyCandidate({ archive, audit, provenance = null, sevenZip = "7z" }, {
  // Test seams are intentionally unavailable as CLI flags. A synthetic fixture
  // cannot weaken the production command's pinned historical evidence.
  evidence = OOTB5_EVIDENCE, command = runCommand,
} = {}) {
  archive = path.resolve(archive);
  const auditBytes = await readFile(audit);
  validateOriginalAudit(auditBytes, evidence);
  const before = await lstat(archive);
  assertCandidateStat(before, evidence.compressedBytes);
  const handle = await open(archive, "r");
  const magic = Buffer.alloc(6);
  try { await handle.read(magic, 0, magic.length, 0); } finally { await handle.close(); }
  const format = magic.equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ? "7z"
    : magic.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? "zip" : null;
  assert.ok(format, "Recovered source must have an original 7z or ZIP archive signature");
  const archiveSha256 = await fileHash(archive);
  const tarVersion = (await command("tar", ["--version"])).trim();
  const names = await command("tar", ["-tf", archive]);
  const verbose = await command("tar", ["-tvf", archive]);
  const listing = inspectArchiveListings(names, verbose, evidence.replayFiles);
  // 7-Zip t decompresses and tests member checksums without extracting files.
  // stdin is closed; encrypted inputs cannot wait for an interactive password.
  const integrityOutput = await command(sevenZip, ["t", "-y", "-bd", "--", archive]);
  const afterSha256 = await fileHash(archive);
  const after = await lstat(archive);
  assertCandidateStat(after, evidence.compressedBytes);
  assert.equal(afterSha256, archiveSha256, "Recovered archive changed during verification");
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
    assert.equal(after[field], before[field], "Recovered archive filesystem identity changed during verification");
  }
  const provenanceBytes = provenance ? await readFile(provenance) : null;
  const reviewed = validateProvenance(provenanceBytes ? JSON.parse(provenanceBytes) : null, archiveSha256);
  return {
    type: "recoveryVerification", schemaVersion: 1, bundleStem: "ootb5", verifiedAt: new Date().toISOString(),
    originalAuditSha256: sha256(auditBytes),
    expected: { compressedBytes: evidence.compressedBytes, replayFiles: evidence.replayFiles },
    archive: { path: archive, sha256: archiveSha256, compressedBytes: before.size, sourceFilename: `ootb5.${format}`, format },
    ...listing,
    integrityTest: { passed: true, tool: sevenZip, outputSha256: sha256(integrityOutput),
      version: integrityOutput.split(/\r?\n/).find((line) => /7-Zip|7z \(/i.test(line))?.trim() ?? "Version not reported in test output" },
    listingTool: { tool: "tar", version: tarVersion },
    ...reviewed,
    provenanceEvidenceSha256: provenanceBytes ? sha256(provenanceBytes) : null,
    privacy: "Local evidence only: contains an absolute cache path and provenance notes. Do not upload this report or replay bytes.",
  };
}

export async function writeRecoveryReport(file, report) {
  assert.ok(file.endsWith(".local.json"), "Recovery reports must use a .local.json suffix");
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}
