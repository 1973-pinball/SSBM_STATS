import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OOTB5_EVIDENCE, sha256, validateOriginalAudit, validateProvenance,
  inspectArchiveListings, verifyCandidate, writeRecoveryReport, runCommand,
} from "../lib/ootb5-recovery.mjs";

const names = "event/\nevent/Game_1.slp\nevent/Game_2.SLP\n";
const verbose = "drwxr-xr-x 0 0 0 0 Nov 7 2026 event/\n"
  + "-rw-r--r-- 0 0 0 10 Nov 7 2026 event/Game_1.slp\n"
  + "-rw-r--r-- 0 0 0 20 Nov 7 2026 event/Game_2.SLP\n";
const hex = "a".repeat(64);
const provenance = {
  schemaVersion: 1, bundleStem: "ootb5", archiveSha256: hex,
  reviewedBy: "Synthetic reviewer", reviewedAt: "2026-11-07T12:00:00Z",
  basis: "owner-cache-attestation", evidenceReference: "Synthetic evidence only", originalUnmodified: true,
};
const exampleAudit = (size = 816744003, replayFiles = 1545) => ({
  dataset: { id: OOTB5_EVIDENCE.datasetId, archive_count: 1 },
  sources: [{ id: `${OOTB5_EVIDENCE.datasetId}:ootb5`, compressed_bytes: size, replay_file_count: replayFiles, sourceFilename: null }],
});

test("historical evidence cannot be replaced by unpinned audit metadata", () => {
  const bytes = Buffer.from(JSON.stringify(exampleAudit()));
  assert.throws(() => validateOriginalAudit(bytes), /audit hash differs/);
  const fixtureEvidence = { ...OOTB5_EVIDENCE, originalAuditSha256: sha256(bytes) };
  assert.equal(validateOriginalAudit(bytes, fixtureEvidence).sources[0].sourceFilename, null);
  assert.throws(() => validateOriginalAudit(Buffer.concat([bytes, Buffer.from("\n")]), fixtureEvidence), /audit hash differs/);
  for (const [field, value, message] of [["compressed_bytes", 1, /compressed size/], ["replay_file_count", 1, /replay count/], ["sourceFilename", "ootb5.7z", /missing filename/]]) {
    const audit = exampleAudit(); audit.sources[0][field] = value;
    const changed = Buffer.from(JSON.stringify(audit));
    assert.throws(() => validateOriginalAudit(changed, { ...fixtureEvidence, originalAuditSha256: sha256(changed) }), message);
  }
});

test("size and count are never sufficient provenance", () => {
  assert.equal(validateProvenance(null, hex).status, "awaiting-provenance");
  const attested = validateProvenance(provenance, hex);
  assert.equal(attested.status, "verified-owner-attestation");
  assert.match(attested.limitation, /No pre-recovery cryptographic/);
  const historical = { ...provenance, basis: "historical-sha256", historicalSha256: hex };
  assert.equal(validateProvenance(historical, hex).status, "verified-historical-hash");
  assert.throws(() => validateProvenance({ ...historical, historicalSha256: "b".repeat(64) }, hex), /Historical SHA-256/);
  assert.throws(() => validateProvenance(provenance, "b".repeat(64)), /does not identify/);
  assert.throws(() => validateProvenance({ ...provenance, reviewedBy: " " }, hex), /reviewedBy/);
  assert.throws(() => validateProvenance({ ...provenance, originalUnmodified: false }, hex), /unmodified original/);
  assert.throws(() => validateProvenance({ ...provenance, historicalSha256: hex }, hex), /must not imply/);
});

test("listing counts regular replay files and preserves evidence digests", () => {
  const report = inspectArchiveListings(names, verbose, 2);
  assert.equal(report.replayFiles, 2);
  assert.equal(report.uncompressedBytes, 30);
  assert.equal(report.memberCount, 3);
  assert.equal(report.memberListingSha256, sha256(names));
  assert.throws(() => inspectArchiveListings(names, verbose, 3), /replay count/);
  assert.throws(() => inspectArchiveListings(names, verbose.split("\n").slice(1).join("\n"), 2), /formats disagree/);
});

for (const unsafe of ["../evil.slp", "/evil.slp", "C:/evil.slp", "\\\\server\\evil.slp", "x/../evil.slp", "x//evil.slp", "x/./evil.slp", "evil.slp:payload", "CON.slp", "evil. /game.slp", "x/.__special_moves_extraction_owner.json", "x/evil\t.slp"]) {
  test(`rejects unsafe member ${JSON.stringify(unsafe)}`, () => {
    assert.throws(() => inspectArchiveListings(`${unsafe}\n`, `-rw-r--r-- 0 0 0 10 Nov 7 2026 ${unsafe}\n`, 1));
  });
}

test("rejects case aliases, file/directory collisions, links and compressed replays", () => {
  assert.throws(() => inspectArchiveListings(names.replace("Game_2.SLP", "GAME_1.SLP"), verbose, 2), /Duplicate/);
  assert.throws(() => inspectArchiveListings(names, verbose.replace("drwxr-xr-x", "-rwxr-xr-x"), 2), /shadows a directory/);
  assert.throws(() => inspectArchiveListings(names, verbose.replace("-rw-r--r--", "lrw-r--r--"), 2), /Links or special/);
  assert.throws(() => inspectArchiveListings(names, verbose.replace("-rw-r--r--", "hrw-r--r--"), 2), /Links or special/);
  assert.throws(() => inspectArchiveListings(names.replace("Game_1.slp", "Game_1.slpz"), verbose, 2), /does not support .slpz/);
});

test("rejects Windows superscript device digits and console aliases", () => {
  for (const name of ["COM¹.slp", "COM².slp", "LPT³.slp", "CONIN$.slp", "CONOUT$.slp"]) {
    assert.throws(() => inspectArchiveListings(`${name}\n`, `-rw-r--r-- 0 0 0 10 Nov 7 2026 ${name}\n`, 1), /device name/);
  }
});

async function withFixture(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ssbm-ootb5-test-"));
  try {
    const archive = path.join(directory, "renamed-original.bin"), audit = path.join(directory, "audit.json");
    const content = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.from("synthetic-not-an-archive")]);
    const auditBytes = Buffer.from(JSON.stringify(exampleAudit(content.length, 2)));
    await writeFile(archive, content);
    await writeFile(audit, auditBytes);
    const evidence = { ...OOTB5_EVIDENCE, originalAuditSha256: sha256(auditBytes), compressedBytes: content.length, replayFiles: 2 };
    const calls = [];
    const command = async (program, args) => {
      calls.push([program, args]);
      if (args[0] === "--version") return "bsdtar synthetic test";
      if (args[0] === "-tf") return names;
      if (args[0] === "-tvf") return verbose;
      if (args[0] === "t") return "7-Zip synthetic test runner\nEverything is Ok\n";
      throw new Error("Unexpected test command");
    };
    await callback({ directory, archive, audit, content, evidence, command, calls });
  } finally {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith("ssbm-ootb5-test-"));
    await rm(absolute, { recursive: true, force: true });
  }
}

test("candidate orchestration uses actual integrity test and records no false provenance", async () => {
  await withFixture(async ({ archive, audit, evidence, command, calls, content }) => {
    const report = await verifyCandidate({ archive, audit, sevenZip: "test-7z" }, { evidence, command });
    assert.equal(report.status, "awaiting-provenance");
    assert.equal(report.archive.sha256, sha256(content));
    assert.equal(report.archive.sourceFilename, "ootb5.7z");
    assert.equal(report.integrityTest.passed, true);
    assert.deepEqual(calls.at(-1), ["test-7z", ["t", "-y", "-bd", "--", archive]]);
  });
});

test("candidate rejects truncated, corrupt, and changing archives", async () => {
  await withFixture(async ({ archive, audit, evidence, command, content }) => {
    await writeFile(archive, content.subarray(1));
    await assert.rejects(verifyCandidate({ archive, audit }, { evidence, command }), /Compressed size/);
    await writeFile(archive, content);
    await assert.rejects(verifyCandidate({ archive, audit }, { evidence, command: async (program, args) => {
      if (args[0] === "t") throw new Error("Synthetic CRC failure");
      return command(program, args);
    } }), /CRC failure/);
    await assert.rejects(verifyCandidate({ archive, audit }, { evidence, command: async (program, args) => {
      if (args[0] === "t") {
        const changed = Buffer.from(content); changed[changed.length - 1] ^= 1;
        await writeFile(archive, changed);
      }
      return command(program, args);
    } }), /changed during verification/);
  });
});

test("reports cannot overwrite existing evidence", async () => {
  await withFixture(async ({ directory }) => {
    const report = path.join(directory, "report.local.json");
    await writeRecoveryReport(report, { status: "synthetic" });
    const before = await readFile(report);
    await assert.rejects(writeRecoveryReport(report, { status: "replacement" }), { code: "EEXIST" });
    assert.deepEqual(await readFile(report), before);
    await assert.rejects(writeRecoveryReport(path.join(directory, "public.json"), {}), /local.json/);
  });
});

test("command runner treats nonzero exits and stderr warnings as failures", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(2)"]), /exit 2/);
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stderr.write('warning')"]), /stderr true/);
  assert.equal(await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
});

test("listing parser accepts the installed bsdtar's real ZIP listing", async (context) => {
  try {
    const version = await runCommand("tar", ["--version"]);
    if (!/bsdtar/i.test(version)) { context.skip("tar is not bsdtar"); return; }
  } catch { context.skip("bsdtar is unavailable"); return; }
  await withFixture(async ({ directory }) => {
    await writeFile(path.join(directory, "Game.slp"), "Synthetic replay bytes; not a valid SLP.");
    const archive = path.join(directory, "real-listing.zip");
    await runCommand("tar", ["--format=zip", "-cf", archive, "-C", directory, "Game.slp"]);
    const actualNames = await runCommand("tar", ["-tf", archive]);
    const actualVerbose = await runCommand("tar", ["-tvf", archive]);
    assert.equal(inspectArchiveListings(actualNames, actualVerbose, 1).replayFiles, 1);
  });
});
