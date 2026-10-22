import assert from "node:assert/strict";
import { planArchiveSourcePopulation, assertArchiveSourcePayload, assertArchiveSourceDownload } from "./lib/archive-source-population.mjs";

const audit = {
  dataset: { id: "nikki-prior-v8", archive_count: 3 },
  sources: [
    { id: "nikki-prior-v8:event-one-main-stream", sourceFilename: "event-one-main-stream.7z", replay_file_count: 10, compressed_bytes: 100 },
    { id: "nikki-prior-v8:event-two", sourceFilename: "event-two.zip", replay_file_count: 20, compressed_bytes: 200 },
    { id: "nikki-prior-v8:ootb5", sourceFilename: null, replay_file_count: 5, compressed_bytes: 50 },
  ],
};
const results = ["event-one-main-stream.json", "event-two.json"];
const plan = planArchiveSourcePopulation(audit, ["ootb5"], results);
assert.deepEqual(plan.metadata.includedBundles, ["event-one-main-stream", "event-two"]);
assert.deepEqual(plan.metadata.excludedBundles, ["ootb5"]);
assert.equal(plan.metadata.expectedReplayFiles, 30);
assert.equal(plan.metadata.expectedCompressedBytes, 300);
assert.throws(() => planArchiveSourcePopulation(audit, ["ootb5"], results.slice(0, 1)), /missing=\[event-two\]/, "another missing original cannot pass");
assert.throws(() => planArchiveSourcePopulation(audit, ["ootb5"], [...results, "supernova-2026.json"]), /unexpected=\[supernova-2026\]/, "new source events cannot enter an original-only rebuild");
assert.throws(() => planArchiveSourcePopulation(audit, ["ootb5"], [...results, "ootb5.json"]), /unexpected=\[ootb5\]/, "explicit exclusions cannot silently return");
assert.throws(() => planArchiveSourcePopulation(audit, [], results), /missing=\[ootb5\]/, "omissions must be explicit");
assert.throws(() => planArchiveSourcePopulation(audit, ["unknown"], results), /not in the original dataset/);
assert.throws(() => planArchiveSourcePopulation(audit, ["ootb5"], [...results, results[0]]), /cohort differs/, "duplicate parse entries cannot inflate the set");
assert.throws(() => planArchiveSourcePopulation({ ...audit, sources: audit.sources.slice(0, 2) }, [], results), /complete original/);
assert.throws(() => planArchiveSourcePopulation({ ...audit, sources: [{ ...audit.sources[0], id: "another-v1:event-one-main-stream" }, ...audit.sources.slice(1)] }, ["ootb5"], results), /different dataset/);
assertArchiveSourcePayload(plan, results[0], { bundle: "event-one-main-stream.7z", replayFiles: 10 });
assertArchiveSourcePayload(plan, results[1], { bundle: "event-two.zip", replayFiles: 20 });
assert.throws(() => assertArchiveSourcePayload(plan, results[0], { bundle: "event-two.zip", replayFiles: 10 }), /does not belong/);
assert.throws(() => assertArchiveSourcePayload(plan, results[0], { bundle: "event-one-main-stream.7z", replayFiles: 9 }), /count drift/);
assertArchiveSourceDownload(plan, "event-two.zip", 200);
assert.throws(() => assertArchiveSourceDownload(plan, "event-two.zip", 199), /byte count drift/);
console.log("Archive source population passed: explicit exclusion, exact retained source set, no new events, and per-bundle count/byte checks.");
