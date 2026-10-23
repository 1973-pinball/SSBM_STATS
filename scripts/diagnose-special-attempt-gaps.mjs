/** Trace an unavailable special's first rejected frame using an existing local
 * completeness proof. No parser writes, source uploads, or network calls.
 * --proof <completeness-report> --manifest <exact-gap-cases> --output <report>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SlippiGame } from "@slippi/slippi-js/node";
import { createSpecialMovesAccumulator, addSpecialMovesFrame, finishSpecialMovesAccumulator } from "../src/lib/specialMoves.ts";

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--proof", "--manifest", "--output"].includes(args[i]) && args[i + 1]);
  options[args[i].slice(2)] = args[i + 1];
}
for (const name of ["proof", "manifest", "output"]) assert.ok(options[name], `Missing --${name}`);
const readJson = file => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const proof = readJson(options.proof);
const manifest = readJson(options.manifest);
const targets = Array.isArray(manifest) ? manifest : manifest.cases;
const parserInputs = ["src/lib/parse.ts", "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts", "src/lib/types.ts", "src/lib/replayMetadata.ts", "scripts/analyze-nikki-bundle.mjs", "scripts/lib/archive-move-coverage.mjs", "package-lock.json"];
const fingerprint = () => {
  const hash = createHash("sha256");
  for (const file of parserInputs) { hash.update(file); hash.update(readFileSync(file)); }
  return hash.digest("hex");
};
assert.equal(fingerprint(), proof.parserSha256, "Completeness proof belongs to different parser inputs");
const normalize = file => file.replaceAll("\\", "/");
const rows = [];
for (const target of targets) {
  const row = proof.cases.find(entry => entry.bundle === target.bundle && normalize(entry.file) === normalize(target.file));
  assert.ok(row, "Target is missing from the raw completeness proof");
  const bytes = readFileSync(row.localFile);
  assert.equal(bytes.length, row.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), row.replaySha256);
  const game = new SlippiGame(bytes);
  const settings = game.getSettings();
  const frames = game.getFrames();
  const acc = createSpecialMovesAccumulator(settings.players);
  assert.ok(acc);
  const track = target.moveId === 21 ? acc.downB.players.find(player => player.playerIndex === target.playerIndex)
    : acc.players.find(player => player.playerIndex === target.playerIndex)?.moves[target.moveId];
  assert.ok(track);
  const snap = n => {
    const player = frames[n]?.players?.[target.playerIndex];
    return { frame: n, state: player?.post?.actionStateId, counter: player?.post?.actionStateCounter,
      air: player?.post?.isAirborne, buttons: player?.pre?.physicalButtons ?? player?.pre?.buttons,
      internal: player?.post?.internalCharacterId, stocks: player?.post?.stocksRemaining };
  };
  let firstFailure = null;
  const bowEntries = [];
  for (let n = -123; n <= row.durationFrames; n++) {
    if (!frames[n]) continue;
    const before = track.attemptsKnown;
    const now = snap(n), previous = snap(n - 1);
    if (target.moveId === 18 && [6, 20].includes(now.internal) && now.state >= 344 && now.state <= 349 &&
        !(previous.state >= 344 && previous.state <= 349)) bowEntries.push({ previous, current: now });
    addSpecialMovesFrame(acc, frames[n]);
    if (before && !track.attemptsKnown && !firstFailure) firstFailure = {
      frame: n, countsAtFailure: { ...track.counts }, context: Array.from({ length: 9 }, (_, i) => snap(n - 4 + i)),
    };
  }
  const finalUsage = finishSpecialMovesAccumulator(acc).get(target.playerIndex);
  rows.push({ ...row, targetPlayerIndex: target.playerIndex, targetMoveId: target.moveId, firstFailure, bowEntries, finalUsage });
}
assert.equal(fingerprint(), proof.parserSha256, "Parser inputs changed during diagnosis");
writeFileSync(options.output, `${JSON.stringify({ generatedAt: new Date().toISOString(), parserSha256: proof.parserSha256,
  auditSha256: proof.auditSha256, completenessProof: options.proof, caseCount: rows.length, cases: rows }, null, 2)}\n`);
console.log(JSON.stringify({ output: options.output, cases: rows.map(row => ({ file: row.file, firstFailure: row.firstFailure, finalUsage: row.finalUsage, observedBowEntries: row.bowEntries.length })) }, null, 2));
