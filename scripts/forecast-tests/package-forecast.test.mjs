import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectBackupFiles, packageForecast, verifyForecastBackup } from "../package-forecast.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "forecast-package-"));
  t.after(async () => {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("forecast-package-"));
    await rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(temp, "source", ".forecast");
  async function write(relative, value) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const body = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
    await writeFile(file, body);
    return file;
  }
  const datasetBody = '{"events":[],"sets":[]}\n';
  const datasetHash = hash(datasetBody);
  const dataset = `datasets/${datasetHash}/dataset.json`;
  await write(dataset, datasetBody);
  await write(`datasets/${datasetHash}/quality.json`, { valid: true });
  await write(`datasets/${datasetHash}/private.slp`, "excluded replay");
  await write("latest.json", { schemaVersion: 1, dataset, sha256: datasetHash });
  const comparison = { sourceDatasetSha256: datasetHash };
  const predictions = [];
  const runHash = hash(JSON.stringify({ report: comparison, predictions }));
  const report = `reports/${runHash}/comparison.json`;
  const predictionsFile = `reports/${runHash}/predictions.json`;
  await write(report, comparison);
  await write(predictionsFile, predictions);
  await write(`reports/${runHash}/comparison.md`, "Evaluation");
  await write("latest-evaluation.json", { schemaVersion: 1, runHash, sourceDatasetSha256: datasetHash, report, predictions: predictionsFile });
  const upcoming = { schemaVersion: 1, event: { id: 1661592 }, entrants: [{ id: 1, name: "Player", participants: [{ id: 2, gamerTag: "Player", player: { id: 3 } }] }],
    seeds: [], sets: [], standings: [], phaseGroups: [], provenance: { transport: "startgg-public-legacy-v1", publicSourceAudit: { collectionsReconciled: true }, requests: [] } };
  const bundleBody = JSON.stringify(upcoming) + "\n";
  const bundle = await write(`public-raw/${hash(bundleBody)}.json`, bundleBody);
  const forecastEventId = "startgg:event:1661592";
  const modelBody = JSON.stringify({ sourceDatasetSha256: datasetHash, forecastEventId,
    sourceSnapshotSha256: hash(bundleBody), snapshot: { cutoff: 1 } }) + "\n";
  const modelHash = hash(modelBody);
  const model = `models/${modelHash}.json`;
  await write(model, modelBody);
  await write("latest-model.json", { schemaVersion: 1, model, sha256: modelHash, sourceDatasetSha256: datasetHash, forecastEventId });
  await write(".env.forecast.local", "excluded credential");
  await write("public-source-cache/response.json", "excluded source response");
  await write(`public-raw/${"f".repeat(64)}.json`, "excluded unrelated event");
  return { temp, root, bundle, write, dataset, model, upcoming, report };
}

test("backup contains only allowlisted artifacts and restores with verified checksums", async (t) => {
  const input = await fixture(t);
  const output = path.join(input.temp, "backup.tgz");
  const result = await packageForecast({ root: input.root, bundle: input.bundle, output });
  assert.equal(result.sha256, hash(await readFile(output)));
  assert.match(await readFile(`${output}.sha256`, "utf8"), new RegExp(`^${result.sha256}  backup\\.tgz`));
  assert.equal(result.hasModel, true);
  assert.equal(result.hasEvaluation, true);
  const listing = execFileSync("tar", ["-tzf", output], { encoding: "utf8", windowsHide: true, shell: false }).trim().split(/\r?\n/);
  assert.ok(listing.includes(".forecast/backup-manifest.json"));
  assert.ok(listing.every((file) => file.startsWith(".forecast/")));
  assert.ok(!listing.some((file) => /(?:source-cache|\.env|\.slp|f{64})/.test(file)));
  const restore = path.join(input.temp, "restored");
  await mkdir(restore);
  execFileSync("tar", ["-xzf", output, "-C", restore], { windowsHide: true, shell: false });
  assert.equal((await verifyForecastBackup(path.join(restore, ".forecast"))).verified, true);
  await writeFile(path.join(restore, ".forecast", input.dataset), "changed");
  await assert.rejects(verifyForecastBackup(path.join(restore, ".forecast")), /checksum mismatch/);
});

test("packaging rejects changed model bytes and participant profile fields", async (t) => {
  const input = await fixture(t);
  const oldReport = await readFile(path.join(input.root, input.report));
  const changedReport = JSON.parse(oldReport);
  changedReport.changedMetric = 0.9;
  await input.write(input.report, changedReport);
  await assert.rejects(collectBackupFiles(input), /Evaluation dataset or run checksum mismatch/);
  await writeFile(path.join(input.root, input.report), oldReport);
  const oldModel = await readFile(path.join(input.root, input.model));
  await input.write(input.model, "changed");
  await assert.rejects(collectBackupFiles(input), /model checksum/);
  await writeFile(path.join(input.root, input.model), oldModel);
  input.upcoming.entrants[0].participants[0].email = "private@example.invalid";
  const body = JSON.stringify(input.upcoming) + "\n";
  const bundle = await input.write(`public-raw/${hash(body)}.json`, body);
  await assert.rejects(collectBackupFiles({ root: input.root, bundle }), /participant profile fields/);
  delete input.upcoming.entrants[0].participants[0].email;
  input.upcoming.event.id = 1661593;
  const differentBody = JSON.stringify(input.upcoming) + "\n";
  const differentBundle = await input.write(`public-raw/${hash(differentBody)}.json`, differentBody);
  await assert.rejects(collectBackupFiles({ root: input.root, bundle: differentBundle }), /does not match the selected upcoming event snapshot/);
  await assert.rejects(collectBackupFiles({ root: input.root, bundle: path.join(input.root, "public-source-cache/response.json") }), /Invalid public bundle path/);
  await rm(path.join(input.root, "latest-model.json"));
  await rm(path.join(input.root, "latest-evaluation.json"));
  const withoutOptional = await collectBackupFiles(input);
  assert.equal(withoutOptional.hasModel, false);
  assert.equal(withoutOptional.hasEvaluation, false);
  assert.ok(!withoutOptional.files.some((file) => file.startsWith("models/") || file.startsWith("reports/")));
});
