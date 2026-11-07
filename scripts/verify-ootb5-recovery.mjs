#!/usr/bin/env node
/** Local-only source verification. Never reparses, extracts, publishes, or edits an existing audit. */
import { access } from "node:fs/promises";
import { verifyCandidate, writeRecoveryReport } from "./lib/ootb5-recovery.mjs";

const usage = "node scripts/verify-ootb5-recovery.mjs --archive FILE --audit ORIGINAL.json --report NEW.local.json [--seven-zip EXE] [--provenance REVIEW.local.json]";
try {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!["--archive", "--audit", "--report", "--seven-zip", "--provenance"].includes(name) || !value || name in options) throw new Error(usage);
    options[name] = value;
  }
  if (!["--archive", "--audit", "--report"].every((name) => options[name])) throw new Error(usage);
  if (!options["--report"].endsWith(".local.json")) throw new Error("Report must use a .local.json suffix");
  try { await access(options["--report"]); throw new Error("Report already exists; select a new immutable report filename"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const report = await verifyCandidate({ archive: options["--archive"], audit: options["--audit"],
    provenance: options["--provenance"], sevenZip: options["--seven-zip"] ?? "7z" });
  await writeRecoveryReport(options["--report"], report);
  console.log(JSON.stringify({ status: report.status, sha256: report.archive.sha256, compressedBytes: report.archive.compressedBytes,
    replayFiles: report.replayFiles, integrityPassed: report.integrityTest.passed, limitation: report.limitation }, null, 2));
  if (report.status === "awaiting-provenance") process.exitCode = 2;
} catch (error) {
  console.error(`ootb5 verification rejected: ${error.message}`);
  process.exitCode = 1;
}
