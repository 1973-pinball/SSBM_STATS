/** Offline download interruption tests. No network or replay corpus required. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadRankedSource, RankedDownloadPaused, runRankedDownloadWorkers, REPOSITORY, REVISION } from './download-ranked-sources.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'ssbm-ranked-download-'));
const originalFetch = globalThis.fetch;
const bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251));
const source = { path: 'FOX/FOX_master-master_a2.tar.gz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const final = path.join(directory, source.sha256 + '.tar.gz'), partial = final + '.partial';
try {
  let pause = false, cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 65536)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': String(bytes.length) } });
  const interrupted = downloadRankedSource(source, directory, async () => pause);
  const checkedInterruption = assert.rejects(interrupted, RankedDownloadPaused);
  const deadline = Date.now() + 5000;
  while ((await stat(partial).catch(() => ({ size: 0 }))).size < 65536) {
    assert.ok(Date.now() < deadline, 'first chunk did not reach the partial file');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  pause = true;
  await checkedInterruption;
  assert.ok(cancelled, 'pausing must cancel a stalled network body');
  assert.equal(await stat(final).catch(() => null), null, 'an interrupted file must never become a verified archive');
  const checkpoint = await readFile(partial);
  assert.equal(checkpoint.length, 65536);
  assert.deepEqual(checkpoint, bytes.subarray(0, checkpoint.length));

  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Range, `bytes=${checkpoint.length}-`);
    return new Response(bytes.subarray(checkpoint.length), { status: 206, headers: {
      'content-length': String(bytes.length - checkpoint.length),
      'content-range': `bytes ${checkpoint.length}-${bytes.length - 1}/${bytes.length}`,
    } });
  };
  assert.equal((await downloadRankedSource(source, directory)).cached, false);
  assert.deepEqual(await readFile(final), bytes, 'resume must append exactly the missing range');
  assert.equal(await stat(partial).catch(() => null), null);

  globalThis.fetch = async () => { throw new Error('verified source must not be downloaded again'); };
  await assert.rejects(downloadRankedSource(source, directory, async () => true), RankedDownloadPaused);
  assert.equal((await downloadRankedSource(source, directory)).cached, true);

  await rm(final);
  await writeFile(partial, bytes.subarray(0, 16384));
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  await downloadRankedSource(source, directory);
  assert.deepEqual(await readFile(final), bytes, 'a server ignoring Range must restart, not append a second full body');

  await rm(final);
  await writeFile(partial, bytes);
  globalThis.fetch = async () => { throw new Error('complete partial needs verification only'); };
  await downloadRankedSource(source, directory);
  assert.deepEqual(await readFile(final), bytes);

  // Force all six workers past the initial queue-length observation before any
  // pause check resolves. Only one may consume the final item after that await.
  let release, pauseChecks = 0;
  const barrier = new Promise(resolve => { release = resolve; }), visited = [];
  await runRankedDownloadWorkers([source], 6, async () => {
    if (++pauseChecks === 6) release();
    await barrier; return false;
  }, async file => { assert.ok(file, 'a drained queue must never dispatch undefined'); visited.push(file); });
  assert.equal(pauseChecks, 6); assert.deepEqual(visited, [source], 'the final source is dispatched exactly once');
  await runRankedDownloadWorkers([source], 6, async () => true, async () => assert.fail('a paused queue must not dispatch work'));

  // Keep the real CLI's 130-file release contract intact and verify its complete
  // concurrent cached path, receipt totals, and lack of network dependency.
  const cliCache = path.join(directory, 'cli-cache'), archives = path.join(cliCache, 'archives');
  await mkdir(archives, { recursive: true });
  const pairs = ['diamond-diamond', 'master-master', 'master-diamond', 'diamond-platinum', 'master-platinum'], files = [];
  for (let i = 0; i < 130; i++) {
    const character = `FIXTURE_${String.fromCharCode(65 + Math.floor(i / pairs.length))}`;
    const payload = Buffer.from(`Generated cached download fixture ${i}`), sha256 = createHash('sha256').update(payload).digest('hex');
    files.push({ path: `${character}/${character}_${pairs[i % pairs.length]}_a1.tar.gz`, bytes: payload.length, sha256 });
    await writeFile(path.join(archives, `${sha256}.tar.gz`), payload);
  }
  const manifestFile = path.join(directory, 'cli-source.json'), compressedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  await writeFile(manifestFile, JSON.stringify({ repository: REPOSITORY, revision: REVISION, compressedBytes, files }));
  const noNetwork = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline CLI fixture attempted network access"); };');
  const output = execFileSync(process.execPath, ['--import', noNetwork, 'scripts/download-ranked-sources.mjs', '--manifest', manifestFile,
    '--cache', cliCache, '--concurrency', '6'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const receipt = JSON.parse(await readFile(path.join(cliCache, 'download-receipt.json')));
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.completed, 130); assert.equal(receipt.completedBytes, compressedBytes); assert.deepEqual(receipt.failures, []);
  const completions = output.split('\n').filter(line => line.startsWith('{"completed":')).map(line => JSON.parse(line));
  assert.equal(completions.length, 130); assert.equal(new Set(completions.map(item => item.path)).size, 130); assert.ok(completions.every(item => item.cached));
  console.log('Ranked downloads preserve/resume partial bytes, reuse verified archives, safely drain one item across six workers, and complete the offline 130-file concurrent CLI receipt.');
} finally {
  globalThis.fetch = originalFetch;
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('ssbm-ranked-download-'));
  await rm(resolved, { recursive: true });
}
