/** Exercise Vite's actual dev/preview HTTP stack, including browser-style decoding. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createServer, preview } from 'vite';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'ranked-static-check-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = gzipSync(JSON.stringify({ fixture: 'ranked compressed integrity', rows: [1, 2, 3] }));
const datasetId = 'Fixture_v1';
const relativeShard = `/ranked/${datasetId}/diamond-all.json.gz`;
const servers = [];

try {
  const outside = path.join(temporary, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'master-0.json.gz'), payload);
  for (const directory of ['public', 'dist']) {
    const root = path.join(temporary, directory);
    await mkdir(path.join(root, 'ranked', datasetId), { recursive: true });
    await writeFile(path.join(root, relativeShard.slice(1)), payload);
    await writeFile(path.join(root, 'ranked', 'manifest.json'), JSON.stringify({ fixture: true }));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Static fixture</title>');
    await symlink(outside, path.join(root, 'ranked', 'escaped'), 'junction');
  }
  const config = {
    configFile: path.join(repository, 'vite.config.ts'), root: temporary,
    publicDir: path.join(temporary, 'public'), build: { outDir: path.join(temporary, 'dist') },
    logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false, watch: null },
    preview: { host: '127.0.0.1', port: 0 },
  };
  const dev = await createServer(config); servers.push(dev);
  await dev.listen();
  const productionPreview = await preview(config); servers.push(productionPreview);
  for (const [name, server] of [['dev', dev], ['preview', productionPreview]]) {
    const address = server.httpServer.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const suffix of ['', '?cache-check=1']) {
      const response = await fetch(origin + relativeShard + suffix, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'application/gzip', name);
      assert.equal(response.headers.get('content-encoding'), null, name);
      assert.equal(Number(response.headers.get('content-length')), payload.length, name);
      const received = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(received, payload, `${name}: fetch must receive compressed bytes`);
      assert.equal(sha(received), sha(payload), `${name}: compressed integrity stays valid`);
    }
    const head = await fetch(origin + relativeShard, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-encoding'), null);
    assert.equal(Number(head.headers.get('content-length')), payload.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.deepEqual(await (await fetch(origin + '/ranked/manifest.json')).json(), { fixture: true });
    assert.equal((await fetch(origin + `/ranked/${datasetId}/master-25.json.gz`)).status, 404);
    const escape = await fetch(origin + '/ranked/escaped/master-0.json.gz');
    assert.equal(escape.status, 403, `${name}: a shard symlink cannot escape the serving directory`);
  }
  console.log('Ranked static serving passed: dev and preview preserve gzip bytes/hash, GET/HEAD/query behavior, ordinary manifests, missing shards, and symlink containment.');
} finally {
  for (const server of servers.reverse()) {
    if ('close' in server) await server.close();
    else await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
  const resolvedTemporary = path.resolve(temporary);
  assert.ok(resolvedTemporary.startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(resolvedTemporary, { recursive: true, force: true });
}
