/** Assert terminal guards preserve positive usage on a sample of valid replays.
 * node --experimental-strip-types scripts/verify-special-replay-coverage.mjs <directory> [count]
 * Raw replay files remain local. Use diagnose-special-completeness for damaged files.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SlippiGame } from "@slippi/slippi-js/node";
import { createServer } from "vite";
import { createSpecialMovesAccumulator, addSpecialMovesFrame, finishSpecialMovesAccumulator } from "../src/lib/specialMoves.ts";

const [directory, count = "40"] = process.argv.slice(2);
assert.ok(directory, "Expected local replay directory");
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.slp$/i.test(entry.name) ? [path.join(dir, entry.name)] : []);
}
const files = walk(directory);
const step = Math.max(1, Math.floor(files.length / Number(count)));
const sample = files.filter((_, index) => index % step === 0).slice(0, Number(count));
assert.ok(sample.length);
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
let parser;
try { parser = await server.ssrLoadModule("/src/lib/parse.ts"); } finally { await server.close(); }
const versions = new Set();
const measured = { 18: 0, 19: 0, 20: 0, 21: 0 };
let parsed = 0;
let rolledBack = 0;
for (const file of sample) {
  const bytes = readFileSync(file);
  const raw = new SlippiGame(bytes);
  const settings = raw.getSettings();
  if (settings.isTeams || settings.players.length !== 2) continue;
  const result = parser.parseReplay("coverage", path.basename(file), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const frames = raw.getFrames();
  const acc = createSpecialMovesAccumulator(settings.players);
  for (let frame = -123; frame <= result.durationFrames; frame++) if (frames[frame]) addSpecialMovesFrame(acc, frames[frame]);
  const expected = finishSpecialMovesAccumulator(acc);
  for (const [slot, player] of settings.players.entries()) for (const moveId of [18, 19, 20, 21]) {
    const actualMove = result.players[slot].moveStats?.[moveId];
    const actual = actualMove?.attempts === undefined ? null : Object.fromEntries(["attempts", "hitAttempts", "noHitAttempts", "incompleteAttempts"].filter(key => actualMove[key] !== undefined).map(key => [key, actualMove[key]]));
    assert.deepEqual(actual, expected.get(player.playerIndex)[moveId], `${path.basename(file)} player ${player.playerIndex} move ${moveId}: terminal guard changed valid per-frame coverage`);
    if (actual) measured[moveId]++;
  }
  if (sample.length === 1) console.log(JSON.stringify({ file: path.basename(file), version: settings.slpVersion, usage: Object.fromEntries(expected) }));
  versions.add(settings.slpVersion);
  if (raw.getRollbackFrames().count > 0) rolledBack++;
  parsed++;
}
console.log(JSON.stringify({ parsed, versions: [...versions], measuredSides: measured, gamesWithRollbackFrames: rolledBack }));
