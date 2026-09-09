import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, readJson, writeJson } from "../lib/forecast/local.mjs";
import { ROOT, readDataset } from "../lib/liquipedia-data.mjs";

const run = (args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/forecast.mjs"), ...args], { encoding: "utf8", env: { ...process.env, STARTGG_TOKEN: "" } });
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ssbm-forecast-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("CLI can bootstrap real registry and report status with no token or network", async (t) => {
  const root = await workspace(t);
  const result = run(["registry", "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const registry = await readJson(path.join(root, "registry.json"));
  assert.equal(registry.events.length, readDataset().majors.length);
  assert.ok(registry.counts.offline > 100);
  assert.equal(run(["status", "--root", root]).status, 0);
  assert.match(run(["normalize", "--root", root]).stderr, /No downloaded events/);
  const emptyMappings = path.join(root, "empty-mappings.json");
  await writeJson(emptyMappings, { schemaVersion: 1, mappings: [] });
  assert.match(run(["download", "--all-mapped", "--root", root, "--mappings", emptyMappings]).stderr, /No verified mappings/);
  assert.match(run(["status", "--offline", "--refresh"]).stderr, /mutually exclusive/);
});

async function fixture(t) {
  const root = await workspace(t);
  // Synthetic source IDs/results, tied to the real registry name only to test the
  // join. All artifacts stay in a temporary directory, never the real cache.
  const slug = "tournament/riptide-2025-4/event/melee-singles";
  const startAt = Date.parse("2025-09-05T16:00:00Z") / 1000;
  const bundle = {
    schemaVersion: 1,
    event: { id: 101, name: "Melee Singles", slug, startAt, isOnline: false, entrantSizeMin: 1,
      videogame: { id: 1, name: "Super Smash Bros. Melee" },
      tournament: { id: 201, name: "Riptide 2025", startAt, endAt: startAt + 172800, isOnline: false } },
    entrants: [11, 12].map((id) => ({ id, name: "Synthetic " + id, participants: [{ id: id + 10, gamerTag: "Synthetic " + id, player: { id: id + 100 } }] })),
    sets: [{ id: 301, state: 3, winnerId: 11, round: 1, fullRoundText: "Winners Round 1",
      slots: [11, 12].map((id, i) => ({ id: id + 1000, entrant: { id }, standing: { stats: { score: { value: i ? 1 : 2 } } } })) }],
    seeds: [11, 12].map((id, i) => ({ id: id + 2000, entrant: { id }, seedNum: i + 1, phase: { id: 401, name: "Pools", phaseOrder: 1 } })),
    standings: [{ id: 501, entrant: { id: 11 }, placement: 1 }, { id: 502, entrant: { id: 12 }, placement: 2 }],
    phaseGroups: [],
    provenance: { source: "start.gg", fetchedAt: "2026-09-04T12:00:00Z", requests: [{ requestHash: "synthetic-only", fetchedAt: "2026-09-04T12:00:00Z" }] },
  };
  await writeJson(path.join(root, "mappings.json"), { schemaVersion: 1, mappings: [{
    majorName: "Riptide 2025", year: 2025, eventSlug: slug, confidence: "verified", eventId: 101, tournamentId: 201,
    evidenceUrl: "https://www.start.gg/" + slug, notes: "Synthetic test metadata. Not a real source mapping.",
  }] });
  const sha256 = digest(JSON.stringify(bundle) + "\n");
  const file = "raw/" + sha256 + ".json";
  await writeJson(path.join(root, file), bundle);
  await writeJson(path.join(root, "downloads.json"), { schemaVersion: 1, events: [{ slug, eventId: "101", file, sha256 }] });
  return { root, bundle, file };
}

test("CLI source-to-dataset run is deterministic, local-only, and preserves quality/seed warnings", async (t) => {
  const { root } = await fixture(t);
  const first = run(["normalize", "--root", root]);
  assert.equal(first.status, 0, first.stderr);
  const manifest = await readJson(path.join(root, "latest.json"));
  const data = await readJson(path.join(root, manifest.dataset));
  assert.equal(data.quality.counts.eligibleSets, 1);
  assert.equal(data.events[0].major.name, "Riptide 2025");
  assert.equal(data.seeds[0].usableAsPreEventFeature, null);
  assert.equal(data.standings[0].usableAsPreEventFeature, false);
  assert.match(manifest.outcomeReconciliation.report,
    /^datasets\/[a-f0-9]{64}\/outcome-reconciliation-[a-f0-9]{64}\.json$/);
  const outcomeBody = await readFile(path.join(root, manifest.outcomeReconciliation.report), "utf8");
  const outcome = JSON.parse(outcomeBody);
  assert.equal(digest(outcomeBody), manifest.outcomeReconciliation.sha256);
  assert.equal(outcome.datasetSha256, manifest.sha256);
  assert.equal(outcome.advisoryOnly, true);
  assert.equal(outcome.counts.mismatches, 2);
  assert.equal(outcome.counts.reviewEvents, 1);
  assert.equal(data.sets[0].eligible, true, "outcome review signals must not alter training eligibility");
  assert.equal(manifest.uploads, false);
  assert.equal(manifest.sha256, digest(await readFile(path.join(root, manifest.dataset), "utf8")));
  assert.equal(run(["normalize", "--root", root]).status, 0);
  assert.deepEqual(await readJson(path.join(root, "latest.json")), manifest);
});

test("CLI rejects altered source bodies and path traversal before normalization", async (t) => {
  const { root, bundle, file } = await fixture(t);
  await writeJson(path.join(root, file), { ...bundle, sets: [] });
  assert.match(run(["normalize", "--root", root]).stderr, /hash mismatch/);
  const index = await readJson(path.join(root, "downloads.json"));
  index.events[0].file = "../outside.json";
  await writeJson(path.join(root, "downloads.json"), index);
  assert.match(run(["normalize", "--root", root]).stderr, /Invalid bundle path/);
});

test("CLI refuses unverified majors, never advertising a normalized dataset", async (t) => {
  const { root } = await fixture(t);
  const mappings = await readJson(path.join(root, "mappings.json"));
  mappings.mappings[0].confidence = "candidate";
  await writeJson(path.join(root, "mappings.json"), mappings);
  assert.match(run(["normalize", "--root", root]).stderr, /No downloaded events have verified/);
  assert.equal(await readJson(path.join(root, "latest.json"), null), null);
});

test("CLI evaluation verifies input, writes local reproducible diagnostics and never productizes", async (t) => {
  const root = await workspace(t);
  const events = [1, 2].map((i) => ({
    id: "event" + i, name: "Synthetic Event " + i, eligible: true,
    chronology: { reportedEventStartAt: i * 100, reportedTournamentStartAt: i * 100 - 5,
      reportedEventEndAt: i * 100 + 50, reportedTournamentEndAt: i * 100 + 60 },
  }));
  const dataset = {
    schemaVersion: 1, events, seeds: [], provenance: [], players: [], aliases: [], standings: [],
    entrants: events.flatMap((e) => ["a", "b"].map((p) => ({ id: e.id + p, eventId: e.id }))),
    sets: events.map((e) => ({
      id: e.id + "set", eventId: e.id, eligible: true, playerIds: ["a", "b"],
      entrantIds: [e.id + "a", e.id + "b"], winnerPlayerId: "a",
    })),
  };
  const sha256 = digest(JSON.stringify(dataset) + "\n");
  const file = "datasets/" + sha256 + "/dataset.json";
  await writeJson(path.join(root, file), dataset);
  await writeJson(path.join(root, "latest.json"), { dataset: file, sha256 });
  const result = run(["evaluate", "--root", root, "--strict-seeds"]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readJson(path.join(root, "latest-evaluation.json"));
  assert.equal(manifest.productize, false);
  assert.equal(manifest.uploads, false);
  const report = await readJson(path.join(root, manifest.report));
  const predictions = await readJson(path.join(root, manifest.predictions));
  assert.equal(predictions.length, 1);
  assert.equal(report.outOfSample.models.length, 6);
  assert.equal(report.completeModelSuite, true);
  assert.deepEqual(report.pendingModels, []);
  assert.equal(report.seeds.allowHistorical, false);
  assert.match(await readFile(path.join(root, manifest.markdown), "utf8"), /experimental/);
  assert.match(await readFile(path.join(root, manifest.calibration), "utf8"), /held-out calibration/);
  assert.match(await readFile(path.join(root, manifest.calibrationInSample), "utf8"), /not validation/);
  assert.equal(run(["evaluate", "--root", root, "--strict-seeds"]).status, 0);
  assert.deepEqual(await readJson(path.join(root, "latest-evaluation.json")), manifest);
  await writeJson(path.join(root, "mappings.json"), { schemaVersion: 99 });
  assert.equal(run(["evaluate", "--root", root, "--strict-seeds"]).status, 0,
    "Immutable evaluation must not depend on current registry mappings");
  assert.equal(run(["storage", "--root", root]).status, 0);
  const storage = await readJson(path.join(root, (await readJson(path.join(root, "latest-storage.json"))).report));
  assert.equal(storage.predictionRows, 1);
  assert.equal(storage.projection.tables.find((r) => r.table === "predictions_one_run").rows, 1);
  await writeJson(path.join(root, manifest.predictions), []);
  assert.match(run(["storage", "--root", root]).stderr, /artifact hash mismatch/);
  await writeJson(path.join(root, file), { ...dataset, sets: [] });
  assert.match(run(["evaluate", "--root", root]).stderr, /hash mismatch/);
  await writeJson(path.join(root, "latest.json"), { dataset: "../outside.json", sha256 });
  assert.match(run(["evaluate", "--root", root]).stderr, /No valid normalized dataset/);
});

test("CLI storage measures normalized data, stays local, and fails closed for stale or changed inputs", async (t) => {
  const { root } = await fixture(t);
  assert.equal(run(["normalize", "--root", root]).status, 0);
  const result = run(["storage", "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const source = await readJson(path.join(root, "latest.json"));
  const manifest = await readJson(path.join(root, "latest-storage.json"));
  const report = await readJson(path.join(root, manifest.report));
  assert.equal(manifest.uploads, false);
  assert.equal(report.datasetBytes, source.datasetBytes);
  assert.equal(report.predictionRows, 0);
  assert.match(await readFile(path.join(root, manifest.markdown), "utf8"), /No evaluation selected/);
  assert.equal(report.inventory.categories.find((r) => r.category === "raw").files, 1);
  assert.equal(report.projection.scenarios.length, 3);
  assert.equal(run(["storage", "--root", root]).status, 0);
  assert.deepEqual(await readJson(path.join(root, "latest-storage.json")), manifest);
  await writeJson(path.join(root, "latest-evaluation.json"), { sourceDatasetSha256: "different" });
  assert.match(run(["storage", "--root", root]).stderr, /different dataset/);
  await writeJson(path.join(root, "latest-evaluation.json"), { sourceDatasetSha256: source.sha256, predictions: "../outside.json" });
  assert.match(run(["storage", "--root", root]).stderr, /Invalid evaluation artifact path/);
  const data = await readJson(path.join(root, source.dataset));
  await writeJson(path.join(root, source.dataset), { ...data, sets: [] });
  assert.match(run(["storage", "--root", root]).stderr, /hash mismatch/);
});
