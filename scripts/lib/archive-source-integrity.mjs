import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

/** Older audits contain only counts; a present digest must never silently opt out. */
export function auditedSourceHash(source) {
  if (!Object.hasOwn(source, "sourceSha256")) return null;
  if (typeof source.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceSha256)) {
    throw new Error(`Invalid audited source SHA-256: ${source.id ?? source.sourceFilename}`);
  }
  return source.sourceSha256;
}

export function sourceReceiptFields(source) {
  const sourceSha256 = auditedSourceHash(source);
  return sourceSha256 === null ? {} : { sourceSha256 };
}

export function receiptMatchesSourceHash(source, receipt) {
  const expected = auditedSourceHash(source);
  return expected === null || receipt.sourceSha256 === expected;
}

/** Bind every use of a recovered source to the exact bytes reviewed in its audit. */
export async function verifyAuditedSourceHash(source, filename) {
  const expected = auditedSourceHash(source);
  if (expected === null) return null;
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Audited source must be a regular file, not a link");
  if (before.size !== source.compressed_bytes) throw new Error(`Audited source byte count changed: ${source.sourceFilename}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  const after = await lstat(filename);
  if (!after.isFile() || after.isSymbolicLink()
    || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])) {
    throw new Error(`Audited source changed while hashing: ${source.sourceFilename}`);
  }
  const actual = digest.digest("hex");
  if (actual !== expected) throw new Error(`Audited source SHA-256 mismatch: ${source.sourceFilename}`);
  return actual;
}
