/** Exercise the generated classic service worker with its real bundled runtime.
 * This checks build artifacts and worker lifecycle/routing, not browser UI/installability.
 * Run after npm run build; an alternate build directory may be passed as argument.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(repository, process.argv[2] ?? 'dist');
const origin = 'https://pwa.test';
const urlOf = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
const pathnameOf = value => new URL(urlOf(value)).pathname;

function artifact(url) {
  const parsed = new URL(url, origin);
  assert.equal(parsed.origin, origin, 'The worker must only load same-origin build artifacts');
  const filename = path.resolve(directory, '.' + decodeURIComponent(parsed.pathname));
  assert.ok(filename.startsWith(directory + path.sep), 'Build artifact path stays within dist');
  return filename;
}

function filesIn(folder, prefix = '') {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? filesIn(path.join(folder, entry.name), name + '/') : [name];
  });
}

async function verify() {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.webmanifest'), 'utf8'));
  for (const [key, value] of Object.entries({ id: '/', scope: '/', start_url: '/', name: 'SSBM Stats', short_name: 'SSBM Stats', display: 'standalone', theme_color: '#121022', background_color: '#121022' })) {
    assert.equal(manifest[key], value, `Manifest ${key}`);
  }
  assert.deepEqual(manifest.icons, [
    { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
    { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
  assert.deepEqual(manifest.shortcuts.map(shortcut => shortcut.url), ['/?view=overview', '/?view=community', '/?view=liquipedia']);
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap(shortcut => shortcut.icons)]) {
    assert.ok(statSync(artifact(icon.src)).size > 0, `Manifest icon exists: ${icon.src}`);
  }

  // Registration belongs to the app, whose callbacks defer reloads during parsing.
  const html = readFileSync(path.join(directory, 'index.html'), 'utf8');
  // Inspect generated HTML only; this is not an HTML sanitizer. Browsers accept
  // whitespace, attributes, and a slash on script end tags, so count those too.
  const scripts = [...html.matchAll(/<script(?=[\s/>])([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi)]
    .filter(([, attributes]) => !/type=["']application\/ld\+json["']/i.test(attributes));
  assert.equal(scripts.length, 1, 'Only the application script registers the worker');
  assert.match(scripts[0][1], /type=["']module["']/);
  const applicationUrl = scripts[0][1].match(/src=["']([^"']+)["']/)?.[1];
  assert.ok(applicationUrl, 'Application module has a source');
  const application = readFileSync(artifact(applicationUrl), 'utf8');
  for (const contract of ['/sw.js', 'ssbm:offline-ready', 'ssbm:update-applied']) {
    assert.ok(application.includes(contract), `Built registration preserves ${contract}`);
  }

  const stores = new Map();
  const listeners = new Map();
  const fetched = new Set();
  let skipWaiting = 0;
  let claims = 0;
  let offline = false;
  let context;
  class WorkerRequest extends Request {
    constructor(input, options) {
      super(typeof input === 'string' ? new URL(input, origin) : input, options);
    }
  }
  const matches = (key, request, options = {}) => request === undefined || (
    options.ignoreSearch ? pathnameOf(key) === pathnameOf(request) : key === urlOf(request)
  );
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request, options) {
          const entry = [...entries].find(([key]) => matches(key, request, options));
          return entry?.[1].clone();
        },
        async put(request, response) { entries.set(urlOf(request), response.clone()); },
        async keys(request, options) {
          return [...entries.keys()].filter(key => matches(key, request, options)).map(key => new WorkerRequest(key));
        },
        async delete(request) { return entries.delete(urlOf(request)); },
      };
    },
    async match(request, options = {}) {
      for (const name of options.cacheName ? [options.cacheName] : stores.keys()) {
        const result = await (await this.open(name)).match(request, options);
        if (result) return result;
      }
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  class FetchEvent {}
  const worker = {
    URL, Request: WorkerRequest, Response, Headers, FetchEvent, console, setTimeout, clearTimeout,
    location: new URL('/sw.js', origin), registration: { scope: origin + '/' }, caches,
    clients: { async claim() { claims++; } },
    async skipWaiting() { skipWaiting++; },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    importScripts(...urls) {
      for (const url of urls) vm.runInContext(readFileSync(artifact(url), 'utf8'), context, { filename: pathnameOf(url), timeout: 5000 });
    },
    async fetch(request) {
      assert.equal(offline, false, `Offline requests must use precache: ${urlOf(request)}`);
      fetched.add(pathnameOf(request));
      return new Response(readFileSync(artifact(urlOf(request))), { status: 200 });
    },
  };
  worker.self = worker;
  context = vm.createContext(worker);
  // Evaluating the real worker also rejects duplicate normalized URLs with
  // conflicting revisions, which a successful bundler build cannot detect.
  vm.runInContext(readFileSync(path.join(directory, 'sw.js'), 'utf8'), context, { filename: 'sw.js', timeout: 5000 });
  // Original Workbox classic builds use an asynchronous AMD loader.
  await new Promise(resolve => setImmediate(resolve));

  async function dispatch(type, properties = {}) {
    const pending = [];
    let response;
    const event = Object.assign(type === 'fetch' ? new FetchEvent() : {}, properties, {
      type,
      waitUntil(promise) { pending.push(Promise.resolve(promise)); },
      respondWith(promise) { response = Promise.resolve(promise); pending.push(response); },
    });
    for (const callback of listeners.get(type) ?? []) {
      const result = callback(event);
      if (result?.then) pending.push(result);
    }
    // Workbox can extend the event lifetime while handling earlier promises.
    for (let index = 0; index < pending.length; index++) await pending[index];
    return response ? await response : undefined;
  }

  assert.ok(listeners.has('install') && listeners.has('activate') && listeners.has('fetch'), 'Worker registers lifecycle and request handlers');
  await dispatch('install');
  const currentCaches = [...stores.keys()];
  assert.equal(currentCaches.length, 1, 'Installation creates one precache');
  const obsoleteCache = `workbox-precache-v1-${origin}/`;
  const unrelatedCache = 'other-app-data';
  const staleUrl = origin + '/assets/removed-in-new-deploy.js';
  await (await caches.open(obsoleteCache)).put(staleUrl, new Response('old worker generation'));
  await (await caches.open(unrelatedCache)).put(origin + '/saved-data', new Response('keep me'));
  await (await caches.open(currentCaches[0])).put(staleUrl, new Response('old deploy asset'));
  await dispatch('activate');
  assert.ok(skipWaiting > 0, 'New workers activate immediately');
  assert.ok(claims > 0, 'Activated workers claim existing clients');
  assert.ok(!stores.has(obsoleteCache), 'Activation removes obsolete Workbox cache generations');
  assert.equal(await (await caches.match(origin + '/saved-data', { cacheName: unrelatedCache })).text(), 'keep me', 'Activation preserves unrelated caches');
  assert.equal(await caches.match(staleUrl, { cacheName: currentCaches[0] }), undefined, 'Activation removes assets absent from the new deploy');

  const cached = new Set();
  for (const name of currentCaches) {
    const entries = stores.get(name);
    for (const [key, response] of entries) {
      cached.add(pathnameOf(key));
      const bytes = readFileSync(artifact(key));
      assert.deepEqual(Buffer.from(await response.clone().arrayBuffer()), bytes, `Precache bytes: ${pathnameOf(key)}`);
      const revision = new URL(key).searchParams.get('__WB_REVISION__');
      if (revision) assert.equal(revision, createHash('md5').update(bytes).digest('hex'), `Revision hashes original bytes: ${pathnameOf(key)}`);
    }
  }
  const seoPages = ['about', 'metrics', 'melee-majors'];
  const files = filesIn(directory);
  const shell = files.filter(file => /\.(js|css|html|svg|png|woff2)$/.test(file)
    && !/^(share|ranked)\//.test(file)
    && !seoPages.some(page => file === `${page}.html`)
    && file !== 'sw.js' && !/^workbox-[^/]+\.js$/.test(file));
  for (const file of [...shell, 'manifest.webmanifest']) {
    assert.ok(cached.has('/' + file), `Full offline shell includes ${file}`);
  }
  const largeReference = files.find(file => /^assets\/interaction-benchmarks-.*\.js$/.test(file));
  assert.ok(largeReference, 'Lazy interaction reference exists');
  const referenceSize = statSync(artifact('/' + largeReference)).size;
  assert.ok(referenceSize > 2 * 1024 * 1024 && referenceSize < 5 * 1024 * 1024, 'Large interaction reference exercises the raised precache limit');
  for (const url of cached) {
    assert.ok(!/^\/(share|ranked)\//.test(url), `Heavy optional data stays out of precache: ${url}`);
    assert.ok(!seoPages.some(page => url === `/${page}.html`), `Post-build SEO page stays out of precache: ${url}`);
  }

  offline = true;
  const navigation = pathname => {
    const request = new WorkerRequest(new URL(pathname, origin));
    // Node's Request does not accept the browser-only navigate mode.
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    return dispatch('fetch', { request });
  };
  const shellBytes = readFileSync(path.join(directory, 'index.html'));
  for (const pathname of ['/', '/?view=overview', '/?view=community', '/?view=liquipedia', '/some-app-route', '/about-game']) {
    const response = await navigation(pathname);
    assert.ok(response, `SPA navigation is handled: ${pathname}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), shellBytes, `Offline SPA fallback: ${pathname}`);
  }
  for (const page of seoPages) {
    for (const suffix of ['', '/', '.html', '.html/', '?utm_source=check', '/?fbclid=check', '.html?s=20', '.html/?utm_source=check']) {
      assert.equal(await navigation('/' + page + suffix), undefined, `SEO navigation bypasses SPA: /${page}${suffix}`);
    }
  }
  for (const pathname of ['/ranked/manifest.json', '/ranked/example/diamond-all.json.gz?check=1', '/some-uncached.json']) {
    const request = new WorkerRequest(new URL(pathname, origin));
    assert.equal(await dispatch('fetch', { request }), undefined, `Uncached data passes through: ${pathname}`);
    if (pathname.startsWith('/ranked/')) assert.equal(await navigation(pathname), undefined, `Ranked navigation bypasses SPA: ${pathname}`);
  }
  for (const file of shell.filter(file => file.startsWith('assets/'))) {
    const response = await dispatch('fetch', { request: new WorkerRequest(new URL('/' + file, origin)) });
    assert.ok(response, `Lazy asset is served offline: ${file}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(artifact('/' + file)), `Offline asset bytes: ${file}`);
  }
  console.log(`PWA verification passed: ${cached.size} cached assets, ${fetched.size} fetched paths, manifest and byte revisions, manual registration, install/activate, offline lazy assets, SPA fallback, SEO and ranked exclusions.`);
}

try { await verify(); }
catch (error) {
  console.error(`PWA verification failed: ${error.message ?? error}`);
  // VM stacks can include an entire minified bundle as a source excerpt.
  const frames = error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6);
  if (frames?.length) console.error(frames.join('\n'));
  process.exitCode = 1;
}
