/** Regression: completed Unicode metadata must import; unfinished tails must not. */
import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SlippiGame } from "@slippi/slippi-js";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const START_AT = "2026-10-07T21:15:55.125-04:00";
const key = (text) => Buffer.concat([Buffer.from([0x55, Buffer.byteLength(text)]), Buffer.from(text)]);
const str = (text, mode = "bytes") => {
  const length = mode === "codepoints" ? [...text].length : mode === "utf16" ? text.length : Buffer.byteLength(text);
  return Buffer.concat([Buffer.from([0x53, 0x55, length]), Buffer.from(text)]);
};
const object = (entries) => Buffer.concat([
  Buffer.from("{"), ...entries.flatMap(([name, value]) => [key(name), value]), Buffer.from("}"),
]);
const int = (number) => { const bytes = Buffer.alloc(5); bytes[0] = 0x6c; bytes.writeInt32BE(number, 1); return bytes; };
function metadata({ names = ["Left", "Right"], modes = [], startAt = START_AT, lastFrame = int(3600), extra = [] } = {}) {
  return object([
    ...(startAt === null ? [] : [["startAt", str(startAt)]]),
    ["lastFrame", lastFrame],
    ["players", object(names.map((name, i) => [String(i), object([
      ["names", object([["netplay", str(name, modes[i])], ["code", str(`TEST#${i}`)]])],
    ])]))],
    ...extra,
  ]);
}

function replay(meta, padding = 0) {
  const start = Buffer.alloc(0x321);
  start[0] = 0x36;
  start[1] = 3;
  start.writeUInt16BE(31, 0x13);
  for (let i = 0; i < 4; i++) {
    start[0x65 + i * 0x24] = i === 1 ? 20 : 2;
    start[0x66 + i * 0x24] = i < 2 ? 0 : 3;
    start[0x67 + i * 0x24] = 4;
  }
  const filler = Buffer.alloc(padding);
  for (let i = 0; i < filler.length; i += 2) filler[i] = 0x40;
  const sizes = Buffer.from([0x35, 10, 0x36, 3, 0x20, 0x39, 0, 6, 0x40, 0, 1]);
  const raw = Buffer.concat([sizes, start, filler, Buffer.from([0x39, 2, 0xff, 0, 1, 0xff, 0xff])]);
  const prefix = Buffer.from([0x7b, 0x55, 3, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c, 0, 0, 0, 0]);
  prefix.writeUInt32BE(raw.length, 11);
  return Buffer.concat([prefix, raw, key("metadata"), meta, Buffer.from("}")]);
}

const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
let assertions = 0;

try {
  const { parseReplay, parseHeader, parseHeaderFile, IncompleteReplayError, ReplayMetadataError } = await server.ssrLoadModule("/src/lib/parse.ts");
  const { readReplayMetadata, MAX_METADATA_BYTES } = await server.ssrLoadModule("/src/lib/replayMetadata.ts");
  const readers = [
    ["full", bytes => parseReplay("same-file", "same-file.slp", arrayBuffer(bytes))],
    ["header", bytes => parseHeader("same-file", "same-file.slp", arrayBuffer(bytes))],
    ["ranged", bytes => parseHeaderFile("same-file", "same-file.slp", new File([bytes], "same-file.slp"))],
  ];
  async function rejectsEverywhere(bytes, ErrorType, label) {
    for (const [name, read] of readers) {
      await assert.rejects(async () => read(bytes), ErrorType, `${label}: ${name}`);
      assertions++;
    }
  }
  async function imports(bytes, expectedDate, label) {
    const results = [];
    for (const [name, read] of readers) {
      const record = await read(bytes);
      assert.equal(record.playedAt, expectedDate, `${label}: ${name}`);
      results.push(record);
      assertions++;
    }
    assert.deepEqual(results[1], results[2], `${label}: whole/ranged header parity`);
    return results;
  }

  for (const [label, names, modes] of [
    ["ASCII", ["Left", "Right"], []],
    ["valid UTF-8", ["ェnoonェ", "😀Fox"], []],
    ["legacy BMP character count", ["ェnoonェ", "Right"], ["codepoints"]],
    ["legacy emoji scalar count", ["😀Fox", "Right"], ["codepoints"]],
    ["legacy emoji UTF-16 count", ["😀Fox", "Right"], ["utf16"]],
    ["mixed correct and legacy name", ["ェnoonェ", "😀Fox"], ["bytes", "utf16"]],
    ["literal syntax inside name", ["ェ}U{S#[]ェ", "Right"], ["codepoints"]],
    ["four names with mixed conventions", ["ェnoonェ", "😀Fox", "éName", "Normal"], ["codepoints", "utf16", "bytes"]],
  ]) {
    const bytes = replay(metadata({ names, modes }));
    const parsed = readReplayMetadata(new SlippiGame(arrayBuffer(bytes)), bytes);
    assert.deepEqual(Object.values(parsed.players).map(p => p.names.netplay), names, label);
    const results = await imports(bytes, START_AT, label);
    const normal = await imports(replay(metadata({ names })), START_AT, `${label} baseline`);
    assert.deepEqual(results, normal, `${label}: unchanged records after recovery`);
  }
  await imports(replay(metadata({ startAt: null })), null, "legacy missing date stays supported");

  const broken = { names: ["ェnoonェ", "Right"], modes: ["codepoints"] };
  for (const date of ["yesterday", "2026-02-30T12:00:00Z", "2026-10-07T12:00:00", "2026-10-07T25:00:00Z", null]) {
    await rejectsEverywhere(replay(metadata({ ...broken, startAt: date })), ReplayMetadataError, `untrusted recovery timestamp ${date}`);
  }
  const hugeFrame = Buffer.alloc(9);
  hugeFrame[0] = 0x44;
  hugeFrame.writeDoubleBE(2 ** 31, 1);
  for (const lastFrame of [int(-124), hugeFrame, str("3600")]) {
    await rejectsEverywhere(replay(metadata({ ...broken, lastFrame })), ReplayMetadataError, "invalid recovery frame bound/type");
  }
  // A duplicate field is never a safe recovery, even if both values are plausible.
  await rejectsEverywhere(replay(metadata({ ...broken, extra: [["lastFrame", int(3600)]] })), ReplayMetadataError, "duplicate frame field");
  await rejectsEverywhere(replay(metadata({ ...broken, extra: [["startAt", str(START_AT)]] })), ReplayMetadataError, "duplicate timestamp");
  await rejectsEverywhere(replay(metadata({ extra: [["consoleNick", str("ェnameェ", "codepoints")]] })), ReplayMetadataError, "no repair outside netplay names");
  await rejectsEverywhere(replay(metadata({ ...broken, extra: [["future", Buffer.from([0x21])]] })), ReplayMetadataError, "unsupported completed encoding");
  await rejectsEverywhere(replay(metadata({ ...broken, extra: [["badLength", Buffer.from([0x53, 0x6c, 0x7f, 0xff, 0xff, 0xff])]] })), ReplayMetadataError, "oversized declared string");

  let nested = str("leaf");
  for (let depth = 0; depth < 15; depth++) nested = object([["nested", nested]]);
  await rejectsEverywhere(replay(metadata({ ...broken, extra: [["depth", nested]] })), ReplayMetadataError, "recovery nesting limit");
  const many = Buffer.concat([Buffer.from("["), Buffer.alloc(2200, 0x5a), Buffer.from("]")]);
  await rejectsEverywhere(replay(metadata({ ...broken, extra: [["many", many]] })), ReplayMetadataError, "recovery value limit");

  // Every byte boundary, including inside a multi-byte name and between the
  // metadata and outer closing braces, must stay retryable without a record.
  for (const [label, meta] of [["normal", metadata()], ["legacy Unicode", metadata(broken)]]) {
    const bytes = replay(meta);
    const rawEnd = 15 + bytes.readUInt32BE(11);
    for (let end = rawEnd; end < bytes.length; end++) {
      await rejectsEverywhere(bytes.subarray(0, end), IncompleteReplayError, `${label} truncation ${end - rawEnd}`);
    }
  }
  const unfinished = replay(metadata());
  unfinished.writeUInt32BE(0, 11);
  await rejectsEverywhere(unfinished, IncompleteReplayError, "raw length not finalized");
  const outOfBounds = replay(metadata());
  outOfBounds.writeUInt32BE(0xffff_ffff, 11);
  await rejectsEverywhere(outOfBounds, IncompleteReplayError, "raw data still incomplete");

  const overLimit = replay(Buffer.alloc(MAX_METADATA_BYTES + 1, 0x20));
  assert.throws(() => readReplayMetadata({ getMetadata() { assert.fail("oversized tail reached native decoder"); } }, overLimit), ReplayMetadataError);
  await rejectsEverywhere(overLimit, ReplayMetadataError, "metadata input byte limit");

  // Ranged preview must keep the original optimization, even during recovery.
  const large = replay(metadata(broken), 4 * 1024 * 1024);
  const file = new File([large], "large.slp");
  let bytesRead = 0;
  file.arrayBuffer = () => assert.fail("ranged preview read the whole replay");
  const originalSlice = file.slice.bind(file);
  file.slice = (start, end) => {
    const part = originalSlice(start, end);
    bytesRead += part.size;
    return part;
  };
  assert.equal((await parseHeaderFile("large", "large.slp", file)).playedAt, START_AT);
  assert.ok(bytesRead < 70 * 1024, `ranged preview read ${bytesRead} bytes`);

  // Optional LOCAL public-issue fixtures; never fetch or commit raw replays.
  // node scripts/verify-replay-metadata.mjs <local-fixture-directory>
  const fixtureDirectory = process.argv[2];
  let fixtures = 0;
  if (fixtureDirectory) {
    for (const filename of readdirSync(fixtureDirectory).filter(name => name.endsWith(".slp"))) {
      const bytes = readFileSync(join(fixtureDirectory, filename));
      const recovered = readReplayMetadata(new SlippiGame(arrayBuffer(bytes)), bytes);
      assert.ok(recovered.startAt, `${filename}: original timestamp`);
      const results = await imports(bytes, recovered.startAt, filename);
      const rawEnd = 15 + bytes.readUInt32BE(11);
      // Produce a valid comparison envelope with unchanged raw game data and
      // semantically identical metadata. All stats and identities must match.
      const { encode } = await import("@shelacek/ubjson");
      const normalized = Buffer.concat([bytes.subarray(0, rawEnd), key("metadata"), Buffer.from(encode(recovered)), Buffer.from("}")]);
      const baseline = await imports(normalized, recovered.startAt, `${filename} normalized`);
      assert.deepEqual(results, baseline, `${filename}: unchanged complete GameRecords`);
      fixtures++;
    }
  }
  console.log(`Replay metadata regressions passed (${assertions} parser assertions, ${fixtures} local fixtures; ranged preview ${bytesRead} bytes).`);
} finally {
  await server.close();
}
