import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArchiveRecovery } from "../verify-archive-recovery.mjs";
import { REPOSITORY, createRecoveryExportFixture, readJson, readRows, put, putRows, resealExport } from "./fixtures/recovery-export-fixture.mjs";

test("complete recovery pipeline accepts real-builder synthetic exports and rejects tampering before readiness", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "ssbm-recovery-pipeline-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ssbm-recovery-pipeline-"));
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await createRecoveryExportFixture(directory), { options, dependencies } = fixture.pipeline;
  const noReport = report => assert.rejects(readFile(report), { code: "ENOENT" });
  const withReport = name => ({ ...options, report: path.join(directory, `${name}.local.json`) });

  await t.test("source lineage, full reconstruction, reconciliation and production selectors produce a bound local report", async () => {
    const report = await verifyArchiveRecovery(options, dependencies);
    assert.equal(report.status, "validated-local-candidate");
    assert.equal(report.publicationAuthorized, false);
    assert.equal(report.sourcePopulation.includedBundles.length, 68);
    assert.equal(report.recoveryCounts.uniqueGames, 31);
    assert.equal(report.reconciliation.newUniqueGames, 1);
    assert.equal(report.reconciliation.addedDuplicateCopies, 3);
    assert.ok(report.inputFingerprints.length > 300);
    assert.ok(report.selectors);
    assert.deepEqual(await readJson(options.report), report);
  });

  await t.test("an existing readiness report is immutable", async () => {
    const original = await readFile(options.report);
    await assert.rejects(verifyArchiveRecovery(options, dependencies), /already exists/);
    assert.deepEqual(await readFile(options.report), original);
  });

  await t.test("readiness cannot be written inside old cache or either immutable export", async () => {
    for (const protectedDirectory of [options.oldCache, options.beforeDir, options.afterDir]) {
      const report = path.join(protectedDirectory, "forbidden.local.json");
      await assert.rejects(verifyArchiveRecovery({ ...options, report }, dependencies), /outside immutable inputs and exports/);
      await noReport(report);
    }
  });

  await t.test("forged parse receipt fails without creating a readiness report", async () => {
    const file = path.join(options.cache, "backfill-v6", "receipts", "aaa.json"), bytes = await readFile(file);
    const selected = withReport("forged-receipt");
    try {
      await put(file, { ...JSON.parse(bytes), outputSha256: "0".repeat(64) });
      await assert.rejects(verifyArchiveRecovery(selected, dependencies), /authenticate these result bytes/);
      await noReport(selected.report);
    } finally { await writeFile(file, bytes); }
  });

  await t.test("same-size recovered source substitution fails without a readiness report", async () => {
    const file = path.join(options.cache, "downloads", "ootb5.7z"), bytes = await readFile(file);
    const selected = withReport("source-substitution");
    try {
      await writeFile(file, Buffer.alloc(bytes.length));
      await assert.rejects(verifyArchiveRecovery(selected, dependencies), /SHA-256 mismatch/);
      await noReport(selected.report);
    } finally { await writeFile(file, bytes); }
  });

  await t.test("resealing an invented zero denominator cannot produce readiness", async () => {
    const selected = withReport("invented-zero"), dir = options.afterDir;
    const files = ["archive_game_players.ndjson", "archive_datasets.ndjson", "manifest.json", "qa.json"];
    const saved = await Promise.all(files.map(async name => [name, await readFile(path.join(dir, name))]));
    try {
      const rows = await readRows(dir, "archive_game_players");
      const unknown = rows.find(row => row.character_id === 1 && row.move_stats[19].attempts === undefined);
      assert.ok(unknown); unknown.move_stats[19].attempts = 0;
      await putRows(dir, "archive_game_players", rows); await resealExport(dir);
      await assert.rejects(verifyArchiveRecovery(selected, dependencies), /independent public rows differ/);
      await noReport(selected.report);
    } finally {
      for (const [name, bytes] of saved) await writeFile(path.join(dir, name), bytes);
    }
  });

  await t.test("CLI has no sample profile or synthetic contract escape hatch", () => {
    for (const flag of ["--profile", "--contract"]) {
      const result = spawnSync(process.execPath, ["scripts/verify-archive-recovery.mjs", flag, "sample"],
        { cwd: REPOSITORY, windowsHide: true, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no sample\/recovery bypass flags/);
    }
  });
});
