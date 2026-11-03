/** Synthetic replay regressions for dateless EOF and finalized-history rewrites.
 * No downloaded replay bytes, identities or production writes.
 */
import assert from "node:assert/strict";
import { SlippiGame, GameMode } from "@slippi/slippi-js";
import { createServer } from "vite";

const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const LAST = 5200;

function gameStart() {
  const bytes = Buffer.alloc(0x321);
  bytes[0] = 0x36; bytes[1] = 3; bytes[2] = 16;
  bytes.writeUInt16BE(31, 0x13);
  bytes[0x1a4] = GameMode.ONLINE;
  bytes.write("mode.ranked.synthetic", 0x2be, "ascii");
  for (let side = 0; side < 4; side++) {
    bytes[0x65 + side * 0x24] = side === 1 ? 24 : 2;
    bytes[0x66 + side * 0x24] = side < 2 ? 0 : 3;
    bytes[0x67 + side * 0x24] = 4;
  }
  return bytes;
}

function frameCommands(frame, { lag = 0, landing = false, final = LAST } = {}) {
  const commands = [];
  for (const side of [0, 1]) {
    const pre = Buffer.alloc(0x40), post = Buffer.alloc(0x55);
    pre[0] = 0x37; pre.writeInt32BE(frame, 1); pre[5] = side;
    pre.writeUInt16BE(frame % 2 ? 0x100 : 0, 0x31);
    post[0] = 0x38; post.writeInt32BE(frame, 1); post[5] = side;
    post[7] = side === 0 ? 1 : 23;
    post.writeUInt16BE(side === 0 && landing ? 70 : 14, 0x8);
    post.writeFloatBE(side === 0 ? -15 : 15, 0xa);
    post.writeFloatBE(1, 0x12);
    post.writeFloatBE(60, 0x1a);
    post[0x20] = 255;
    // Distinct penultimate/final observations make the missing-END lookup explicit.
    post[0x21] = side === 0 ? 2 : frame === final ? 0 : 1;
    post.writeFloatBE(landing ? 1 : frame + 124, 0x22);
    post[0x32] = 2;
    post[0x33] = side === 0 && landing ? 1 : 0;
    commands.push(pre, post);
  }
  const bookend = Buffer.alloc(9);
  bookend[0] = 0x3c; bookend.writeInt32BE(frame, 1); bookend.writeInt32BE(frame - lag, 5);
  commands.push(bookend);
  return commands;
}

function replay({ end = true, rewrite = false, normalRollback = false, final = LAST } = {}) {
  const sizes = [[0x36, 0x320], [0x37, 0x3f], [0x38, 0x54], [0x3c, 8], [0x39, 6]];
  const commands = [Buffer.from([0x35, 1 + sizes.length * 3, ...sizes.flatMap(([id, size]) => [id, size >> 8, size & 255])]), gameStart()];
  const lag = normalRollback ? 7 : 0;
  for (let frame = -123; frame <= final; frame++) {
    commands.push(...frameCommands(frame, { lag, final }));
    if (normalRollback && frame === 3000) {
      for (let rollback = 2997; rollback <= 3000; rollback++) commands.push(...frameCommands(rollback, { lag, final, landing: rollback === 2998 }));
    }
  }
  if (rewrite) {
    // By now frame 100 was finalized and consumed in an earlier bounded batch.
    commands.push(...frameCommands(100, { landing: true, final }));
    commands.push(...frameCommands(final, { final }));
  }
  if (end) commands.push(Buffer.from([0x39, 2, 0xff, 0, 1, 0xff, 0xff]));
  const raw = Buffer.concat(commands);
  const prefix = Buffer.from([0x7b, 0x55, 3, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c, 0, 0, 0, 0]);
  prefix.writeUInt32BE(raw.length, 11);
  return Buffer.concat([prefix, raw, Buffer.from([0x55, 8]), Buffer.from("metadata{}"), Buffer.from("}")]);
}

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{ name: "parser-frame-storage-verification", transform(source, id) {
    if (id.endsWith("/src/lib/parse.ts")) return source + "\nexport { installStreamingFrameSummary as testStreamingFrames };\n";
  } }],
});

try {
  const { parseReplay, parseReplayRetainedForVerification, parseHeader, testStreamingFrames } = await server.ssrLoadModule("/src/lib/parse.ts");
  const parseBoth = bytes => {
    const bounded = parseReplay("synthetic", "synthetic.slp", arrayBuffer(bytes));
    const retained = parseReplayRetainedForVerification("synthetic", "synthetic.slp", arrayBuffer(bytes));
    assert.deepEqual(bounded, retained, "bounded parsing must match the final retained timeline");
    return bounded;
  };
  const noEnd = replay({ end: false });
  const partial = parseBoth(noEnd);
  assert.equal(partial.playedAt, null);
  assert.equal(partial.winnerIndex, null, "zero terminal stocks cannot manufacture an END event");
  assert.deepEqual(partial.players.map(side => side.stocksRemaining), [2, 1], "library's penultimate observation survives the final flush");
  assert.equal(parseHeader("synthetic", "synthetic.slp", arrayBuffer(noEnd)).durationFrames, 0, "empty metadata remains empty");

  const complete = parseBoth(replay());
  assert.equal(complete.winnerIndex, 0);
  assert.deepEqual(complete.players.map(side => side.stocksRemaining), [2, 0]);
  assert.equal(complete.players[0].lCancelSuccess, 0);
  assert.equal(complete.players[0].moveStats[18].attempts, 0, "clean timeline retains measured special zero");

  const ordinaryRollback = parseBoth(replay({ normalRollback: true }));
  assert.equal(ordinaryRollback.players[0].lCancelSuccess, 1, "unfinalized rollback uses its revised frame once");
  assert.equal(ordinaryRollback.players[0].moveStats[18].attempts, 0, "ordinary rollback preserves special coverage");

  const rewritten = parseBoth(replay({ rewrite: true }));
  assert.equal(rewritten.players[0].lCancelSuccess, 1, "a revised finalized frame changes the headline count");
  assert.equal(rewritten.players[0].moveStats[13].lcSuccess, 1, "the final timeline also updates per-move L-cancels");
  for (const side of rewritten.players) {
    for (const id of [18, 19, 20, 21]) assert.equal(side.moveStats?.[id]?.attempts, undefined, "raw integrity failure must remain unavailable");
    assert.equal(side.defense, undefined);
    assert.equal(side.recovery, undefined);
    assert.equal(side.punish, undefined);
  }

  // Exercise the actual library indexes, not an implementation-shaped mock.
  // Increasing replay duration must not retain all ordinary finalized frames.
  for (const final of [5200, 12000]) {
    const game = new SlippiGame(arrayBuffer(replay({ final })));
    const streaming = testStreamingFrames(game);
    assert.ok(streaming);
    let peak = 0;
    const addFrame = game.statsComputer.addFrame.bind(game.statsComputer);
    game.statsComputer.addFrame = frame => { addFrame(frame); peak = Math.max(peak, Object.keys(game.parser.frames).length); };
    game.getGameEnd(); streaming.flush();
    assert.ok(peak <= 2050, `normal finalized-frame storage remains bounded (${peak})`);
    assert.equal(Object.keys(game.parser.frames).length, 2);
    assert.equal(Object.keys(game.statsComputer.frames).length, 1);
  }
  console.log("Ranked parser regressions passed: missing-END stocks/results, final-history corrections, ordinary rollback, fail-closed coverage, and bounded normal frame storage.");
} finally { await server.close(); }
