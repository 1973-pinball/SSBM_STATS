/** Cached numerical fixtures exercise the actual build/export boundary without
 * raw replay data, network access, or modifying a production cache. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildRankedBaselines, rankedBuildIdentity } from "./build-ranked-baselines.mjs";
import { ACTIONS, createRankedAggregator, rankedExportRejectionReasons } from "./lib/ranked-aggregation.mjs";
import { sha256 } from "./lib/ranked-source-stream.mjs";
import { REPOSITORY, REVISION } from "./ranked-source-pilot.mjs";

const cache = await mkdtemp(path.join(tmpdir(), "ssbm-ranked-export-quality-"));
const { parserFingerprint } = await rankedBuildIdentity(), parsedDirectory = path.join(cache, "parsed", parserFingerprint);
await mkdir(parsedDirectory, { recursive: true }); await mkdir(path.join(cache, "archives"), { recursive: true });
const writeJson = (file, value) => writeFile(file, JSON.stringify(value) + "\n");
const side = characterId => ({ characterId, totalDamage: 20, neutralWins: 1, openingsPerKill: 2, damagePerOpening: 20, inputsPerMinute: 250,
  lCancelSuccess: 1, lCancelFail: 0, techs: { inPlace: 0, toward: 0, away: 0, missed: 0, wallSuccess: 0, wallMissed: 0 },
  actions: Object.fromEntries(ACTIONS.map(action => [action, 0])), moveStats: {} });
const record = () => ({ statsVersion: 10, durationFrames: 3600, stageId: 31, isTeams: false, winnerIndex: 0, players: [side(20), side(2)] });
function member(name, bytes) {
  const header = Buffer.alloc(512); header.write(name); header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.fill(32, 148, 156); header.write("0", 156);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
const good = record(), bad = record(); bad.players[0].actions.airDodges = -1; bad.players[1].totalDamage = 999;
const originals = new Map(), members = [];
for (const [label, raw, game] of [["zero", "good", good], ["negative", "bad", bad], ["negative-wrapper", "bad", bad], ["negative", "bad", bad]]) {
  const bytes = Buffer.from(`Generated export eligibility fixture ${label}`), hash = sha256(bytes);
  const result = { sha256: hash, bytes: bytes.length, rawCommandSha256: sha256(raw), tiers: ["diamond", "master"], playerIndexes: [0, 1],
    frameCount: 3724, lastFrame: 3600, endMethod: 2, reasons: [], record: game };
  const file = path.join(parsedDirectory, `${hash}.json`), value = JSON.stringify({ parserFingerprint, result }) + "\n";
  await writeFile(file, value); originals.set(file, value); members.push(member(`diamond-master-${members.length}.slp`, bytes));
}
const archive = gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])), archiveHash = sha256(archive);
await writeFile(path.join(cache, "archives", `${archiveHash}.tar.gz`), archive);
const sourceManifest = path.join(cache, "source-manifest.json");
await writeJson(sourceManifest, { repository: REPOSITORY, revision: REVISION, selectionMethod: "Generated export eligibility fixture only.",
  files: [{ path: "FOX/FOX_diamond-master_a1.tar.gz", bytes: archive.length, sha256: archiveHash }] });
const options = { sourceManifest, cache, datasetId: "ranked-export-quality-fixture", output: path.join(cache, "staged"), workers: 1, download: false, waitDownloads: false };
try {
  assert.deepEqual(rankedExportRejectionReasons({ record: good }), []);
  assert.deepEqual(rankedExportRejectionReasons({ record: bad }), ["invalid-air-dodge-count"]);
  const secondSlotInvalid = record(); secondSlotInvalid.players[1].actions.airDodges = -13;
  assert.deepEqual(rankedExportRejectionReasons({ record: secondSlotInvalid }), ["invalid-air-dodge-count"]);
  for (const value of [NaN, Infinity, 0.5, undefined]) {
    const malformed = record(); malformed.players[0].actions.airDodges = value;
    assert.deepEqual(rankedExportRejectionReasons({ record: malformed }), [], "the exclusion is limited to known negative integer counts");
    assert.throws(() => createRankedAggregator({ statsVersion: 10, interactionStatsVersion: 9 }).add({ sha256: sha256("malformed"), record: malformed, tiers: ["diamond", "master"] }), /invalid action airDodges/);
  }
  const built = await buildRankedBaselines(options);
  assert.equal(built.parsed, 0); assert.equal(built.reused, 3);
  assert.deepEqual(built.counts, { sourceArchives: 1, sourceBytes: archive.length, replayOccurrences: 4, uniqueReplays: 3,
    duplicateCopies: 1, wrapperDuplicateCopies: 1, acceptedGames: 1, rejectedGames: 1, rejections: { "invalid-air-dodge-count": 1 } });
  assert.deepEqual(built.exportQuality, { version: "ranked-export-quality-v1", invalidAirDodgeGames: 1, invalidAirDodgeSides: 1 });
  const manifest = JSON.parse(await readFile(path.join(options.output, "manifest.json")));
  assert.equal(manifest.exportQualityVersion, "ranked-export-quality-v1");
  for (const tier of ["diamond", "master"]) {
    const shard = JSON.parse(gunzipSync(await readFile(path.join(options.output, `${tier}-all.json.gz`))));
    const row = shard.rows.find(row => row.opponentCharacterId === null && row.stageId === null);
    assert.equal(row.playerGames, 1, "both slots from the invalid game are excluded");
    assert.equal(row.metrics.damageTotal, 20, "the otherwise-valid opponent does not leak into the cohort");
    assert.equal(row.metrics.actions.airDodges, 0, "a measured true zero is retained");
    assert.equal(row.coverage.actions.airDodges.playerGames, 1, "all accepted base observations remain complete");
  }
  execFileSync(process.execPath, ["scripts/verify-ranked-export.mjs", "--cache", cache, "--export", options.output], { encoding: "utf8", windowsHide: true });
  for (const [file, value] of originals) assert.equal(await readFile(file, "utf8"), value, "export gate never rewrites cached inspections");
  // Unrelated malformed measurements must still abort, never enter this narrow
  // exclusion rule or get converted to zero.
  const goodFile = [...originals].find(([, value]) => JSON.parse(value).result.record.players[0].actions.airDodges === 0)[0];
  const malformed = JSON.parse(originals.get(goodFile)); malformed.result.record.players[0].actions.rolls = -1;
  assert.deepEqual(rankedExportRejectionReasons(malformed.result), []); await writeJson(goodFile, malformed);
  const invalidOutput = path.join(cache, "invalid-output");
  await assert.rejects(buildRankedBaselines({ ...options, datasetId: "ranked-export-quality-hard-failure", output: invalidOutput }), /invalid action rolls/);
  assert.equal(Boolean(await stat(invalidOutput).catch(() => null)), false, "unrelated invalid data cannot produce a partial public export");
  assert.equal((await rankedBuildIdentity()).parserFingerprint, parserFingerprint);
} finally {
  const resolved = path.resolve(cache); assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith("ssbm-ranked-export-quality-"));
  await rm(resolved, { recursive: true });
}
console.log("Ranked export eligibility passed: whole-game exclusion, true-zero retention, byte/wrapper accounting, immutable cache, independent reconciliation, and unrelated hard failures.");
