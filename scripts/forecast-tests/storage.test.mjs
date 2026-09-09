import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJson, writeText } from "../lib/forecast/local.mjs";
import { inventoryStorage, projectStorage, storageMarkdown } from "../lib/forecast/storage.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ssbm-forecast-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const dataset = () => ({ schemaVersion: 1, events: [{ id: "event" }], players: [{ id: "p", tag: "é" }],
  aliases: [], entrants: [], seeds: [], sets: [], standings: [], provenance: [] });

test("storage inventory measures all retained artifact categories without opening contents", async (t) => {
  const root = await workspace(t);
  await writeText(path.join(root, "cache/a.json"), "é");
  await writeText(path.join(root, "raw/a.json"), "123");
  await writeText(path.join(root, "datasets/old/dataset.json"), "12345");
  await writeText(path.join(root, "datasets/new/dataset.json"), "1234567");
  await writeText(path.join(root, "reports/a/predictions.json"), "1234");
  await writeText(path.join(root, "latest.json"), "12");
  const measured = await inventoryStorage(root);
  assert.equal(measured.bytes, 23);
  assert.equal(measured.fileCount, 6);
  assert.equal(measured.categories.find((r) => r.category === "datasets").bytes, 12);
  assert.equal(measured.categories.find((r) => r.category === "cache").bytes, 2);
  await writeJson(path.join(root, "storage-reports/old/storage.json"), { ignored: true });
  await writeJson(path.join(root, "latest-storage.json"), { ignored: true });
  assert.deepEqual(await inventoryStorage(root), measured);
});

test("storage refuses links and temporary writes instead of traversing or claiming complete sizes", async (t) => {
  const root = await workspace(t);
  await symlink(tmpdir(), path.join(root, "escape"));
  await assert.rejects(inventoryStorage(root), /symbolic links/);
  const other = await workspace(t);
  await writeText(path.join(other, "active.tmp"), "partial");
  await assert.rejects(inventoryStorage(other), /other CLI writers/);
});

test("projections report measured JSON payload with explicit non-measured scenario assumptions", () => {
  const d = dataset();
  const projection = projectStorage(d, { predictions: [{ p: 0.5 }] });
  assert.equal(projection.tables.find((r) => r.table === "players").jsonPayloadBytes,
    Buffer.byteLength(JSON.stringify(d.players[0])));
  assert.equal(projection.tables.find((r) => r.table === "predictions_one_run").rows, 1);
  assert.equal(projection.tables.find((r) => r.table === "sets").rows, 0);
  for (const scenario of projection.scenarios) {
    assert.equal(scenario.totalBytes, scenario.tableBytes + scenario.indexBytes);
    assert.equal(scenario.withHeadroomBytes, Math.ceil(scenario.totalBytes * 1.3));
    assert.equal(scenario.tables.find((r) => r.table === "sets").totalBytes, 0);
  }
  assert.match(projection.status, /not-measured-postgres/);
  assert.ok(projection.scenarios[2].totalBytes >= projection.scenarios[0].totalBytes);
  assert.throws(() => projectStorage({ ...d, sets: undefined }), /Missing canonical/);
  assert.throws(() => projectStorage({ ...d, schemaVersion: 2 }), /Unsupported/);
  assert.match(storageMarkdown({ datasetBytes: 1024, predictionRows: 1,
    inventory: { categories: [], fileCount: 0, bytes: 0, allocatedBytes: null }, projection }), /not measured sizes or bounds/);
});
