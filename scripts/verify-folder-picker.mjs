/**
 * Exercise App's folder buttons in an isolated Chromium profile, using synthetic
 * local files and OPFS handles only. No cloud credentials, telemetry, or replays.
 * Run: node scripts/verify-folder-picker.mjs (set CHROME_BIN outside macOS).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createServer } from "vite";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), "ssbm-folder-picker-"));
const server = await createServer({
  configFile: false,
  envDir: temp, // Never load the developer's Supabase configuration.
  cacheDir: join(temp, "vite"),
  define: {
    __BUILD_ID__: JSON.stringify("folder-picker-check"),
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(""),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(""),
  },
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: {
    noDiscovery: true,
    include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "dexie", "recharts", "@slippi/slippi-js"],
  },
  plugins: [{
    name: "folder-picker-check",
    configureServer(s) {
      s.middlewares.use("/__folder_check", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await s.transformIndexHtml("/__folder_check",
          '<div id="root"></div><script type="module" src="/folder-check.js"></script>'));
      });
    },
    resolveId(id) { if (id === "/folder-check.js") return "\0folder-check"; },
    load(id) {
      if (id !== "\0folder-check") return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import '/src/index.css';
        import * as db from '/src/lib/db.ts';
        import { generateDemoRecords, DEMO_ACCOUNTS } from '/src/lib/demo.ts';
        window.checkDb = db;
        window.checkErrors = [];
        window.checkWorkerAttempts = 0;
        window.checkScans = 0;
        const seenCollection = db.db.seen.toCollection.bind(db.db.seen);
        db.db.seen.toCollection = (...args) => {
          window.checkScans++;
          return seenCollection(...args);
        };
        window.addEventListener('error', e => window.checkErrors.push(e.message));
        window.addEventListener('unhandledrejection', e => window.checkErrors.push(String(e.reason)));
        await db.clearAll();
        await db.putRecords(generateDemoRecords(3).map((r, i) => ({ ...r,
          playedAt: new Date(Date.UTC(2026, 9, 6, 12, i)).toISOString(),
        })));
        await db.setMyAccounts(DEMO_ACCOUNTS);
        if (new URL(location.href).searchParams.has('native')) {
          window.showDirectoryPicker = async () => {
            if (!window.checkNextFolder) throw new DOMException('Cancelled', 'AbortError');
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle(window.checkNextFolder, { create: true });
          };
        } else {
          delete window.showDirectoryPicker;
        }
        class CheckParserWorker {
          onmessage = null;
          onerror = null;
          postMessage(job) {
            window.checkWorkerAttempts++;
            const data = window.checkParseSucceeds
              ? { ok: true, id: job.id, path: job.path, record: {
                  ...generateDemoRecords(1)[0], id: job.id, path: job.path,
                  playedAt: new Date(job.file.lastModified).toISOString(),
                  ...(window.checkUnmatched ? { players: generateDemoRecords(1)[0].players.map((p, i) => ({
                    ...p, connectCode: 'OTHER#' + i,
                  })) } : {}),
                } }
              : { ok: false, id: job.id, path: job.path, error: 'synthetic parse failed' };
            setTimeout(() => this.onmessage?.({ data }), 0);
          }
          terminate() {}
        }
        Object.defineProperty(window, 'Worker', { value: CheckParserWorker, configurable: true });
        const { default: App } = await import('/src/App.tsx');
        createRoot(document.getElementById('root')).render(React.createElement(App));
      `;
    },
  }],
});
let chrome;
let socket;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${join(temp, "chrome")}`, "about:blank",
  ], { stdio: "ignore" });
  let launchError;
  chrome.on("error", (err) => { launchError = err; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try {
      port = Number((await readFile(join(temp, "chrome/DevToolsActivePort"), "utf8")).split("\n")[0]);
      break;
    } catch { await pause(100); }
  }
  assert.ok(port, "Chromium must start; set CHROME_BIN to its executable");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let next = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(expression)) return;
      await pause(50);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  };
  const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(label)})`;
  const click = (label) => evaluate(`${button(label)}.click()`);
  const ready = (label) => waitFor(`Boolean(${button(label)} && !${button(label)}.disabled)`);
  const open = async (query = "") => {
    const navigation = await send("Page.navigate", { url: `${origin}/__folder_check${query}` });
    assert.equal(navigation.errorText, undefined);
    await ready(query ? "Connect replay folder" : "Add folder");
  };
  const selectFolder = async (path) => {
    await click("Add folder");
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[webkitdirectory]" });
    await send("DOM.setFileInputFiles", { nodeId, files: [path] });
  };
  const savedIds = () => evaluate("checkDb.allRecords().then(records => records.map(r => r.id).sort())");
  const failedBadge = () => evaluate("Array.from(document.querySelectorAll('.tag')).find(e => e.textContent.trim() === '1 failed replay')?.title ?? null");
  const selectFiles = async (path) => {
    await click("Add replay files");
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file]:not([webkitdirectory])" });
    await send("DOM.setFileInputFiles", { nodeId, files: [path] });
  };

  await send("Page.enable");
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  await open();
  const originalIds = await savedIds();
  const empty = join(temp, "empty");
  await mkdir(empty);
  await selectFolder(empty);
  await ready("Add folder");
  await ready("Add replay files");
  await ready("Change folder");

  const unrelated = join(temp, "documents");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "notes.txt"), "Synthetic folder with no replay files.");
  await selectFolder(unrelated);
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('No .slp or .slpz replays')");
  await ready("Add folder");

  // Older fallback browsers may provide no cancel event at all. The UI must
  // remain usable after opening, before receiving either change or cancel.
  await click("Add folder");
  await ready("Add folder");
  await evaluate("document.querySelector('input[webkitdirectory]').dispatchEvent(new Event('cancel', { bubbles: true }))");
  await ready("Add folder");
  assert.deepEqual(await savedIds(), originalIds, "empty picks and cancellation preserve cached stats");
  assert.deepEqual(await evaluate("checkErrors"), []);

  await open("?native=1");
  await evaluate("window.checkNextFolder = 'Slippi-A'");
  await click("Connect replay folder");
  await ready("Add folder");
  await ready("Refresh");
  await waitFor("checkDb.getReplayFolders().then(folders => folders.length === 1)");
  await evaluate(`
    (async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle("Slippi-A");
      const replay = await folder.getFileHandle("manual-refresh.slp", { create: true });
      const writable = await replay.createWritable();
      await writable.write(new Uint8Array([1, 2, 3, 4]));
      await writable.close();
      window.checkRealDateNow = Date.now;
      Date.now = () => window.checkRealDateNow() + 20_000;
    })()
  `);
  await click("Refresh");
  await waitFor("checkDb.allRecords().then(records => records.some(r => r.path.endsWith('/manual-refresh.slp') && r.parseError))");
  await ready("Refresh");
  const refreshedIds = await savedIds();
  assert.ok((await failedBadge())?.includes("again to retry"));
  const firstAttempts = await evaluate("window.checkWorkerAttempts");
  const firstScans = await evaluate("window.checkScans");
  await evaluate("Date.now = () => window.checkRealDateNow() + 80_000; window.dispatchEvent(new Event('focus'))");
  await waitFor(`window.checkScans > ${firstScans}`);
  await ready("Refresh");
  assert.equal(await evaluate("window.checkWorkerAttempts"), firstAttempts, "background refresh leaves corruption cached");
  assert.ok(await failedBadge(), "background scans preserve the cached failure warning");
  await click("Refresh");
  await ready("Refresh");
  assert.equal(await evaluate("window.checkWorkerAttempts"), firstAttempts + 1, "explicit Refresh retries the same failed version");
  assert.deepEqual(await savedIds(), refreshedIds, "repeated failures do not accumulate rows");
  assert.ok(await failedBadge(), "an unsuccessful retry remains visible");
  await click("Add folder");
  await ready("Refresh");
  assert.equal(await evaluate("window.checkWorkerAttempts"), firstAttempts + 2, "re-picking the same folder retries failures");
  assert.deepEqual(await savedIds(), refreshedIds);
  await evaluate("window.checkParseSucceeds = true");
  await click("Refresh");
  await ready("Refresh");
  assert.equal(await evaluate("window.checkWorkerAttempts"), firstAttempts + 3);
  assert.deepEqual(await savedIds(), refreshedIds, "successful retry replaces the failed same-ID row");
  assert.equal(await failedBadge(), null, "successful recovery removes the cached failure warning");
  assert.equal(await evaluate("checkDb.allRecords().then(records => records.filter(r => r.parseError).length)"), 0);

  const pickedReplay = join(temp, "picked-retry.slp");
  await writeFile(pickedReplay, "Synthetic selected replay");
  await evaluate("window.checkParseSucceeds = false");
  await selectFiles(pickedReplay);
  await ready("Refresh");
  await waitFor("checkDb.allRecords().then(records => records.some(r => r.path === 'picked-retry.slp' && r.parseError))");
  const pickedIds = await savedIds();
  const pickedAttempts = await evaluate("window.checkWorkerAttempts");
  await evaluate("window.checkParseSucceeds = true");
  await selectFiles(pickedReplay);
  await ready("Refresh");
  assert.equal(await evaluate("window.checkWorkerAttempts"), pickedAttempts + 1, "re-selecting files retries their failed version");
  assert.deepEqual(await savedIds(), pickedIds);
  assert.equal(await failedBadge(), null);
  await waitFor("document.querySelector('[aria-label=\"Replay import report\"]')?.textContent.includes('1 file parsed')");

  // Mark's failure mode: an older library remains visible, a newer file parses
  // without any error badge, yet the user's accounts match none of its players.
  const newerReplay = join(temp, "after-cutoff.slp");
  await writeFile(newerReplay, "Synthetic newer replay with another account");
  await utimes(newerReplay, new Date("2026-10-07T12:00:00Z"), new Date("2026-10-07T12:00:00Z"));
  await evaluate("window.checkUnmatched = true");
  await selectFiles(newerReplay);
  await ready("Refresh");
  await waitFor("document.querySelector('[aria-label=\"Replay import report\"]')?.textContent.includes('no player matching your saved accounts')");
  const reportText = await evaluate("document.querySelector('[aria-label=\"Replay import report\"]').textContent");
  assert.ok(reportText.includes("1 file parsed"));
  assert.ok(reportText.includes("0 of 1 inspected games"));
  assert.ok(reportText.includes("Oct 7, 2026"), "report dates come from the selected replay");
  assert.equal(await failedBadge(), null, "account mismatches are not parse failures");
  await ready("Check my accounts");
  if (process.env.IMPORT_REPORT_SCREENSHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(process.env.IMPORT_REPORT_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  const afterNewerIds = await savedIds();
  const attemptsBeforeCached = await evaluate("window.checkWorkerAttempts");
  await selectFiles(newerReplay);
  await ready("Refresh");
  await waitFor("document.querySelector('[aria-label=\"Replay import report\"]')?.textContent.includes('0 files parsed · 1 already scanned')");
  assert.ok(await evaluate("document.querySelector('[aria-label=\"Replay import report\"]').textContent.includes('no player matching your saved accounts')"), "a repeated selection still explains its cached game's exclusion");
  assert.ok(await evaluate("document.querySelector('[aria-label=\"Replay import report\"]').textContent.includes('1 previously cached game')"));
  assert.equal(await evaluate("window.checkWorkerAttempts"), attemptsBeforeCached);
  assert.deepEqual(await savedIds(), afterNewerIds, "cached-only report preserves imported and older games");
  await evaluate("window.checkNextFolder = 'Slippi-B'");
  await click("Add folder");
  await ready("Refresh");
  await waitFor("checkDb.getReplayFolders().then(folders => folders.length === 2)");
  const folderIds = await evaluate("checkDb.getReplayFolders().then(folders => folders.map(f => f.id))");
  await click("Add folder"); // Re-pick B: its cache namespace must survive.
  await ready("Refresh");
  assert.deepEqual(await evaluate("checkDb.getReplayFolders().then(folders => folders.map(f => f.id))"), folderIds);
  await evaluate("window.checkNextFolder = null");
  await click("Add folder");
  await ready("Add folder");
  assert.deepEqual(await savedIds(), afterNewerIds, "adding, re-picking and cancelling preserve cached stats");
  assert.deepEqual(await evaluate("checkErrors"), []);
  console.log("Folder picker checks passed: empty/cancel recovery, explicit folder/file retries, background skips, persistent failure warnings, successful recovery, per-file import reports with an older library, cached-only reports, and preservation of cached stats.");
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, pause(3000)]);
  }
  await server.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
