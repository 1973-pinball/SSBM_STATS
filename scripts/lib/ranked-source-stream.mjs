/** Bounded streaming tar ingestion. Member paths are never used for extraction. */
import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { safeMemberName } from "../ranked-source-pilot.mjs";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export async function fileSha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
const tarString = (bytes, start, length) => bytes.subarray(start, start + length).toString("utf8").split("\0", 1)[0];
function tarNumber(bytes, start, length) {
  const raw = tarString(bytes, start, length).trim();
  assert.match(raw, /^[0-7]*$/, "unsupported tar numeric encoding");
  const value = raw ? Number.parseInt(raw, 8) : 0;
  assert.ok(Number.isSafeInteger(value) && value >= 0, "invalid tar size");
  return value;
}
function paxFields(bytes) {
  const fields = Object.create(null);
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at), length = Number(bytes.subarray(at, space).toString("ascii"));
    assert.ok(space > at && Number.isSafeInteger(length) && length > space - at + 1 && at + length <= bytes.length, "invalid PAX record");
    assert.equal(bytes[at + length - 1], 10);
    const text = bytes.subarray(space + 1, at + length - 1).toString("utf8"), equal = text.indexOf("=");
    assert.ok(equal > 0); fields[text.slice(0, equal)] = text.slice(equal + 1); at += length;
  }
  return fields;
}
export async function* inspectTarStream(stream, { maxReplayBytes = 64 * 1024 * 1024 } = {}) {
  const iterator = stream[Symbol.asyncIterator]();
  let remaining = Buffer.alloc(0), ended = false;
  async function read(size, allowEnd = false) {
    const output = Buffer.allocUnsafe(size); let used = 0;
    while (used < size) {
      if (!remaining.length) {
        const next = await iterator.next();
        if (next.done) { ended = true; if (allowEnd && used === 0) return null; throw new Error("truncated tar stream"); }
        remaining = Buffer.from(next.value);
      }
      const length = Math.min(size - used, remaining.length);
      remaining.copy(output, used, 0, length); used += length; remaining = remaining.subarray(length);
    }
    return output;
  }
  let local = {}, global = {}, longName = null, terminated = false;
  try {
    while (!ended) {
      const header = await read(512, true);
      if (!header) break;
      if (header.every(byte => byte === 0)) { terminated = true; break; }
      let checksum = 0;
      for (let i = 0; i < header.length; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
      assert.equal(checksum, tarNumber(header, 148, 8), "tar header checksum mismatch");
      const size = tarNumber(header, 124, 12), type = String.fromCharCode(header[156]);
      assert.ok(["0", "\0", "5", "x", "g", "L"].includes(type), "unsupported/link tar member type");
      assert.ok(size <= (["x", "g", "L"].includes(type) ? 1024 * 1024 : maxReplayBytes), "tar member exceeds supported bound");
      const payload = await read(size);
      if (size % 512) await read(512 - size % 512);
      if (type === "x") local = paxFields(payload);
      else if (type === "g") global = { ...global, ...paxFields(payload) };
      else if (type === "L") longName = tarString(payload, 0, size).replace(/\n$/, "");
      else {
        const fields = { ...global, ...local }, prefix = tarString(header, 345, 155);
        const name = safeMemberName(fields.path ?? longName ?? [prefix, tarString(header, 0, 100)].filter(Boolean).join("/"));
        if (fields.size !== undefined) assert.equal(Number(fields.size), size, "PAX size mismatch");
        local = {}; longName = null;
        if (type !== "5") { assert.ok(/\.slp$/i.test(name), "unexpected non-replay member"); yield { name, bytes: payload }; }
      }
    }
    assert.ok(terminated, "missing tar terminator");
    assert.ok(remaining.every(byte => byte === 0), "nonzero data after tar terminator");
    for (;;) { const next = await iterator.next(); if (next.done) break; assert.ok(Buffer.from(next.value).every(byte => byte === 0), "nonzero data after tar terminator"); }
  } finally { await iterator.return?.(); }
}
export function streamArchive(file) { return inspectTarStream(createReadStream(file).pipe(createGunzip())); }

/** Cached archives are immutable and checked against the pinned LFS digest.
 * A killed download leaves only `.partial`, never a valid cache entry. */
export async function ensureArchive(file, source, url, seedFile = null) {
  const existing = await stat(file).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) { assert.equal(existing.size, source.bytes); assert.equal(await fileSha256(file), source.sha256); return { downloadedBytes: 0 }; }
  const partial = `${file}.partial`;
  await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; });
  let input, downloadedBytes = 0;
  if (seedFile && await stat(seedFile).catch(() => null)) {
    assert.equal((await stat(seedFile)).size, source.bytes); assert.equal(await fileSha256(seedFile), source.sha256); input = createReadStream(seedFile);
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    assert.ok(response.ok, `archive HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length")); if (declared) assert.equal(declared, source.bytes);
    input = Readable.fromWeb(response.body); downloadedBytes = source.bytes;
  }
  const digest = createHash("sha256"); let bytes = 0;
  const verify = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > source.bytes) callback(new Error("archive exceeds pinned byte count"));
    else { digest.update(chunk); callback(null, chunk); }
  } });
  await pipeline(input, verify, createWriteStream(partial, { flags: "wx" }));
  assert.equal(bytes, source.bytes); assert.equal(digest.digest("hex"), source.sha256);
  await rename(partial, file);
  return { downloadedBytes };
}

export async function readJsonIfPresent(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
