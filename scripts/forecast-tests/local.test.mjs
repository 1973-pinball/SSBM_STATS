import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_ROOT, digest, loadToken, researchRoot, writeJson } from "../lib/forecast/local.mjs";
import { ROOT } from "../lib/liquipedia-data.mjs";

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ssbm-forecast-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("local environment token loading supports blank, quoted and exported values without expansion", async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, ".env.forecast.local");
  const prior = process.env.STARTGG_TOKEN;
  delete process.env.STARTGG_TOKEN;
  t.after(() => { if (prior === undefined) delete process.env.STARTGG_TOKEN; else process.env.STARTGG_TOKEN = prior; });
  assert.equal(await loadToken(file), undefined);
  for (const [body, expected] of [
    ["STARTGG_TOKEN=\n", undefined],
    ["export STARTGG_TOKEN='fixture-token'\n", "fixture-token"],
    ['STARTGG_TOKEN="fixture-token" # local\n', "fixture-token"],
    ["STARTGG_TOKEN=fixture-token # local\nOTHER=value", "fixture-token"],
    ["STARTGG_TOKEN=$(do-not-execute)\n", "$(do-not-execute)"],
  ]) {
    await writeFile(file, body);
    assert.equal(await loadToken(file), expected);
  }
  await writeFile(file, "STARTGG_TOKEN=one\nSTARTGG_TOKEN=two");
  await assert.rejects(loadToken(file), /Duplicate STARTGG_TOKEN/);
  process.env.STARTGG_TOKEN = "environment-token";
  assert.equal(await loadToken(file), "environment-token");
});

test("output roots cannot publish research data in this checkout or via symlink", async (t) => {
  const dir = await workspace(t);
  for (const child of ["", "public", "src/research", "dist/forecast", "scripts/data", ".git"]) {
    await assert.rejects(researchRoot(path.join(ROOT, child)), /ignored .forecast/);
  }
  const link = path.join(dir, "web-output");
  await symlink(path.join(ROOT, "public"), link);
  await assert.rejects(researchRoot(path.join(link, "forecast")), /ignored .forecast/);
  assert.equal(await researchRoot(DEFAULT_ROOT), DEFAULT_ROOT);
  assert.ok((await researchRoot(path.join(dir, "research"))).endsWith("/research"));
});

test("JSON artifacts are deterministic and SHA-checkable", async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, "data", "dataset.json");
  const value = { schemaVersion: 1, sets: [] };
  await writeJson(file, value);
  const body = await readFile(file, "utf8");
  assert.equal(body, JSON.stringify(value) + "\n");
  assert.equal(digest(body), digest(JSON.stringify(value) + "\n"));
});
