import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditedSourceHash, verifyAuditedSourceHash, sourceReceiptFields, receiptMatchesSourceHash } from "../lib/archive-source-integrity.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const source = (bytes) => ({ id: "fixture:ootb5", sourceFilename: "ootb5.7z", compressed_bytes: bytes.length,
  replay_file_count: 1, sourceSha256: hash(bytes) });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "ssbm-source-integrity-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ssbm-source-integrity-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("missing digest preserves legacy audit behavior, but a present invalid digest cannot opt out", async () => {
  assert.equal(auditedSourceHash({}), null);
  assert.equal(await verifyAuditedSourceHash({}, "not-a-file"), null);
  for (const sourceSha256 of [undefined, null, "", false, 0, "a".repeat(63), "A".repeat(64), "x".repeat(64)]) {
    assert.throws(() => auditedSourceHash({ sourceSha256 }), /Invalid audited source SHA-256/);
  }
});

test("matching bytes pass; same-size substitution and truncation fail", async (t) => {
  const directory = await fixture(t), filename = path.join(directory, "ootb5.7z");
  const bytes = Buffer.from("original archive bytes"), audited = source(bytes);
  await writeFile(filename, bytes);
  assert.equal(await verifyAuditedSourceHash(audited, filename), audited.sourceSha256);
  await writeFile(filename, Buffer.alloc(bytes.length, 0));
  await assert.rejects(verifyAuditedSourceHash(audited, filename), /SHA-256 mismatch/);
  await writeFile(filename, "short");
  await assert.rejects(verifyAuditedSourceHash(audited, filename), /byte count changed/);
});

test("hashed sources require an existing regular file", async (t) => {
  const directory = await fixture(t), audited = source(Buffer.from("original"));
  await assert.rejects(verifyAuditedSourceHash(audited, directory), /regular file/);
  await assert.rejects(verifyAuditedSourceHash(audited, path.join(directory, "absent")), { code: "ENOENT" });
});

test("hashed sources reject symlinks", async (t) => {
  const directory = await fixture(t), audited = source(Buffer.from("original"));
  const target = path.join(directory, "target"), link = path.join(directory, "link");
  await writeFile(target, "original");
  try { await symlink(target, link); }
  catch (error) {
    if (error.code !== "EPERM") throw error;
    t.skip("This Windows account cannot create symlinks (EPERM).");
    return;
  }
  await assert.rejects(verifyAuditedSourceHash(audited, link), /regular file/);
});

test("new receipts must carry the exact audited digest; old audit receipts remain compatible", () => {
  const audited = source(Buffer.from("original"));
  assert.deepEqual(sourceReceiptFields(audited), { sourceSha256: audited.sourceSha256 });
  assert.equal(receiptMatchesSourceHash(audited, {}), false);
  assert.equal(receiptMatchesSourceHash(audited, { sourceSha256: "0".repeat(64) }), false);
  assert.equal(receiptMatchesSourceHash(audited, sourceReceiptFields(audited)), true);
  assert.deepEqual(sourceReceiptFields({}), {});
  assert.equal(receiptMatchesSourceHash({}, {}), true);
});

test("backfill refuses to reuse a valid output receipt after same-size archive substitution", async (t) => {
  const directory = await fixture(t), downloads = path.join(directory, "downloads");
  const results = path.join(directory, "results-v6"), receipts = path.join(directory, "backfill-v6", "receipts");
  await Promise.all([mkdir(downloads), mkdir(results), mkdir(receipts, { recursive: true })]);
  const audited = source(Buffer.from("original"));
  const auditText = JSON.stringify({ sources: [audited] }), auditPath = path.join(directory, "audit.json");
  await writeFile(auditPath, auditText);
  await writeFile(path.join(downloads, audited.sourceFilename), "replaced");
  const output = path.join(results, "ootb5.json"), outputText = "{}";
  await writeFile(output, outputText);
  const parserHash = createHash("sha256");
  for (const name of ["src/lib/parse.ts", "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts", "src/lib/types.ts",
    "src/lib/replayMetadata.ts", "scripts/analyze-nikki-bundle.mjs", "scripts/lib/archive-move-coverage.mjs", "package-lock.json"]) {
    parserHash.update(name); parserHash.update(await readFile(path.join(repo, name)));
  }
  await writeFile(path.join(receipts, "ootb5.json"), JSON.stringify({ bundle: audited.sourceFilename,
    compressedBytes: audited.compressed_bytes, sourceSha256: audited.sourceSha256, statsVersion: 6,
    parserSha256: parserHash.digest("hex"), auditSha256: hash(auditText), output, outputSha256: hash(outputText) }));
  const result = spawnSync(process.execPath, ["scripts/backfill-nikki-archive.mjs", "--cache", directory,
    "--audit", auditPath, "--workers", "1", "--watch", "false"], { cwd: repo, windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SHA-256 mismatch/);
  assert.equal(await readFile(output, "utf8"), outputText);
});

test("builder rejects a substituted audited archive before changing an existing export", async (t) => {
  const directory = await fixture(t), downloads = path.join(directory, "downloads");
  const results = path.join(directory, "results"), output = path.join(directory, "export");
  await Promise.all([mkdir(downloads), mkdir(results), mkdir(output)]);
  const audited = source(Buffer.from("original"));
  const auditPath = path.join(directory, "audit.json"), curationPath = path.join(directory, "curation.json");
  await writeFile(auditPath, JSON.stringify({ dataset: { id: "fixture", archive_count: 1 }, sources: [audited] }));
  await writeFile(curationPath, "{}");
  await writeFile(path.join(results, "ootb5.json"), "{}");
  await writeFile(path.join(downloads, audited.sourceFilename), "replaced");
  await writeFile(path.join(output, "untouched.txt"), "published fixture");
  const result = spawnSync(process.execPath, ["scripts/build-nikki-public-archive.mjs", "--results", results,
    "--downloads", downloads, "--curation", curationPath, "--source-audit", auditPath,
    "--output", output, "--data-as-of", "2026-09-08", "--version", "v99"],
  { cwd: repo, windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SHA-256 mismatch/);
  assert.equal(await readFile(path.join(output, "untouched.txt"), "utf8"), "published fixture");
});
