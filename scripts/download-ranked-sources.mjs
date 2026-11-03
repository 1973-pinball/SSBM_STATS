#!/usr/bin/env node
// Fetch complete, pinned public source archives into an operator-local cache.
// No replays, credentials, or per-game identities are published by this tool.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'erickfm/melee-ranked-replays';
export const REVISION = 'ef54ddc230e01373ff2a179b49a7e559af788081';
const PAIRS = ['diamond-diamond', 'master-master', 'master-diamond', 'diamond-platinum', 'master-platinum'];
const SOURCE_PATH = /^[A-Z_]+\/[A-Z_]+_(diamond-diamond|master-master|master-diamond|diamond-platinum|master-platinum)_[am][1-6]\.tar\.gz$/;
const json = value => JSON.stringify(value, null, 2) + '\n';

export function selectSources(inventory) {
  assert.equal(inventory.revision, REVISION, 'inventory must match pinned revision');
  const candidates = inventory.entries.filter(entry => entry.type === 'file' && SOURCE_PATH.test(entry.path));
  const characters = [...new Set(candidates.map(entry => entry.path.split('/')[0]))].sort();
  assert.equal(characters.length, 26, 'expected all 26 character folders');
  const files = [];
  for (const character of characters) for (const pair of PAIRS) {
    const options = candidates.filter(entry => entry.path.startsWith(`${character}/${character}_${pair}_`))
      .sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
    assert.ok(options.length, `missing stratum: ${character}/${pair}`);
    const selected = options[0];
    assert.equal(selected.size, selected.lfs?.size, 'LFS and tree sizes must agree');
    assert.match(selected.lfs?.oid ?? '', /^[0-9a-f]{64}$/, 'missing source checksum');
    files.push({ path: selected.path, bytes: selected.size, sha256: selected.lfs.oid });
  }
  files.sort((a, b) => a.bytes - b.bytes || a.path.localeCompare(b.path));
  return {
    repository: REPOSITORY, revision: REVISION,
    selectionMethod: 'Complete smallest compressed shard per character folder and relevant rank pair (26 characters × diamond-diamond, master-master, master-diamond, diamond-platinum, master-platinum). Deterministic convenience sample, not random, representative, or the complete ranked mirror. Ties use path order.',
    sourceUrl: `https://huggingface.co/datasets/${REPOSITORY}/tree/${REVISION}`,
    compressedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(file, directory) {
  assert.ok(SOURCE_PATH.test(file.path), 'invalid pinned source path');
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  const destination = path.join(directory, `${file.sha256}.tar.gz`);
  const existing = await stat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) {
    assert.equal(existing.size, file.bytes, `cached size mismatch: ${file.path}`);
    assert.equal(await hashFile(destination), file.sha256, `cached checksum mismatch: ${file.path}`);
    return { ...file, destination, cached: true };
  }
  const free = await statfs(directory);
  assert.ok(free.bavail * free.bsize > file.bytes + 25_000_000_000, 'insufficient disk headroom for source + 25 GB reserve');
  const partial = `${destination}.partial`;
  let offset = (await stat(partial).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }))?.size ?? 0;
  assert.ok(offset <= file.bytes, 'partial download exceeds pinned size');
  if (offset < file.bytes) {
    const url = `https://huggingface.co/datasets/${REPOSITORY}/resolve/${REVISION}/${file.path.split('/').map(encodeURIComponent).join('/')}?download=true`;
    const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(3_600_000) });
    assert.ok(response.ok, `source download HTTP ${response.status}: ${file.path}`);
    if (offset && response.status === 200) offset = 0;
    if (response.status === 206) {
      assert.equal(response.headers.get('content-range'), `bytes ${offset}-${file.bytes - 1}/${file.bytes}`, 'unexpected resumed content range');
    } else assert.equal(response.status, 200, 'unexpected download status');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) assert.equal(Number(contentLength), file.bytes - offset, 'unexpected source response length');
    let received = offset;
    const bound = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > file.bytes) callback(new Error('download exceeds pinned source size'));
      else callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
    assert.equal(received, file.bytes, 'incomplete source download');
  }
  assert.equal(await hashFile(partial), file.sha256, `download checksum mismatch: ${file.path}`);
  await rename(partial, destination);
  return { ...file, destination, cached: false };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
  const cache = path.resolve(option('--cache', path.join(homedir(), '.cache', 'SSBM_DASHBOARD_ranked_baselines')));
  await mkdir(cache, { recursive: true });
  const inventoryPath = option('--inventory', null);
  const manifest = inventoryPath
    ? selectSources(JSON.parse(await readFile(inventoryPath, 'utf8')))
    : JSON.parse(await readFile(option('--manifest', new URL('./data/ranked-source-manifest.json', import.meta.url)), 'utf8'));
  assert.equal(manifest.repository, REPOSITORY);
  assert.equal(manifest.revision, REVISION);
  assert.equal(manifest.files.length, 130);
  assert.equal(manifest.compressedBytes, manifest.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
  assert.ok(manifest.files.every(file => SOURCE_PATH.test(file.path) && /^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0));
  const manifestPath = path.join(cache, 'source-manifest.json');
  await writeFile(manifestPath, json(manifest));
  console.log(json({ manifestPath, files: manifest.files.length, compressedBytes: manifest.compressedBytes }));
  if (args.includes('--select-only')) return;
  const directory = path.join(cache, 'archives');
  await mkdir(directory, { recursive: true });
  const concurrency = Number(option('--concurrency', '3'));
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 6);
  const pending = [...manifest.files];
  let completed = 0, completedBytes = 0;
  const failures = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (pending.length) {
      const file = pending.shift();
      try {
        let result;
        for (let attempt = 1; attempt <= 4; attempt++) {
          try { result = await download(file, directory); break; }
          catch (error) {
            if (attempt === 4) throw error;
            console.error(json({ retry: attempt, path: file.path, message: error.message }));
            await new Promise(resolve => setTimeout(resolve, attempt * 2000));
          }
        }
        completed++; completedBytes += file.bytes;
        console.log(json({ completed, total: manifest.files.length, completedBytes, path: file.path, cached: result.cached }));
      } catch (error) { failures.push({ path: file.path, message: error.message }); console.error(json(failures.at(-1))); }
    }
  }));
  await writeFile(path.join(cache, 'download-receipt.json'), json({ revision: REVISION, completedAt: new Date().toISOString(), completed, completedBytes, failures }));
  assert.equal(failures.length, 0, 'some pinned source downloads failed; rerun to resume');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
