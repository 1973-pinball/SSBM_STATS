/** Pure source-ingestion boundaries; no network, real replays or production writes. */
import assert from "node:assert/strict";
import { candidateRejectionReasons, inspectTar, rankPairAgrees, resolveSideTier, safeMemberName, sha256, SAMPLES } from "./ranked-source-pilot.mjs";

assert.ok(SAMPLES.reduce((sum, file) => sum + file.bytes, 0) < 15_000_000);
for (const file of SAMPLES) assert.match(file.sha256, /^[a-f0-9]{64}$/);

const diamond = resolveSideTier({ playerIndex: 0, displayName: "Diamond Player" });
const master = resolveSideTier({ playerIndex: 1, displayName: "Master Player" });
assert.equal(diamond.tier, "diamond");
assert.equal(diamond.timing, "unknown");
assert.equal(master.tier, "master");
assert.equal(rankPairAgrees([diamond, master], "master-diamond-abcd.slp"), true, "sorted filename does not change player-port rank");
assert.equal(rankPairAgrees([master, diamond], "master-diamond-abcd.slp"), true);
assert.equal(rankPairAgrees([master, master], "master-master-abcd.slp"), true, "same-tier sides stay independent, including dittos");
assert.equal(rankPairAgrees([diamond, diamond], "master-diamond-abcd.slp"), false);
assert.equal(resolveSideTier({ displayName: "Grandmaster Player" }).tier, null);
assert.equal(resolveSideTier({ displayName: "Diamond Player extra" }).tier, null);
assert.equal(resolveSideTier({}).tier, null, "missing per-side evidence remains unknown");
assert.equal(resolveSideTier({ displayName: "Master Player", netplay: { name: "Diamond Player" } }).status, "conflict");
assert.equal(resolveSideTier({ displayName: "Master Player" }, { names: { netplay: "Diamond Player" } }).tier, null);
assert.equal(rankPairAgrees([resolveSideTier({}), resolveSideTier({})], "master-master-abcd.slp"), false, "same-tier filenames cannot manufacture side evidence");

function tarMember(name, body = Buffer.from("replay bytes"), type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return Buffer.concat([header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]);
}
const completeTar = (...members) => Buffer.concat([...members, Buffer.alloc(1024)]);
const original = Buffer.from("identical replay content");
const entries = inspectTar(completeTar(tarMember("one/replay.slp", original), tarMember("two/copy.slp", original)));
assert.equal(entries.length, 2);
assert.equal(new Set(entries.map(entry => sha256(entry.bytes))).size, 1, "content dedupe ignores source paths and anonymous names");
assert.notEqual(sha256(original), sha256(Buffer.from("unrelated replay content")), "repeated rank labels cannot merge different replay bytes");
assert.equal(safeMemberName("./nested/file.slp"), "nested/file.slp");
for (const name of ["../x.slp", "nested/../../x.slp", "/abs.slp", "C:/abs.slp", "nested\\x.slp"]) {
  assert.throws(() => inspectTar(completeTar(tarMember(name))), /tar member/);
}
for (const type of ["1", "2", "3", "6"]) assert.throws(() => inspectTar(completeTar(tarMember("link.slp", Buffer.alloc(0), type))), /unsupported\/link/);
const corrupt = completeTar(tarMember("x.slp")); corrupt[0] ^= 1;
assert.throws(() => inspectTar(corrupt), /checksum/);
assert.throws(() => inspectTar(tarMember("x.slp")), /terminator/);
assert.throws(() => inspectTar(completeTar(tarMember("x.txt"))), /non-replay/);

const candidate = {
  full: {}, rankPairAgreement: true, isTeams: false, stageId: 31,
  sides: [{ preFrames: 1000, postFrames: 1000 }, { preFrames: 1000, postFrames: 1000 }],
  end: { gameEndMethod: 2 }, retainedParity: { equal: true },
  frames: { count: 1000, firstFrame: -123, lastFrame: 876, guardFinalizedLastFrame: 876, missingFrameIds: 0 },
};
assert.deepEqual(candidateRejectionReasons(candidate), []);
assert.ok(candidateRejectionReasons({ ...candidate, end: null }).includes("missing-or-unresolved-end-event"));
assert.ok(candidateRejectionReasons({ ...candidate, retainedParity: { equal: false } }).includes("bounded-retained-parser-parity-failed"));
assert.ok(candidateRejectionReasons({ ...candidate, frames: { ...candidate.frames, guardFinalizedLastFrame: null } }).includes("finalized-frame-integrity-failed"));
assert.ok(candidateRejectionReasons({ ...candidate, rankPairAgreement: false }).includes("tier-evidence-unresolved-or-conflicting"));
console.log("Ranked pilot boundaries passed: per-slot evidence, unknown/conflicting ranks, content hashes, safe tar handling, and completeness/parity gates.");
