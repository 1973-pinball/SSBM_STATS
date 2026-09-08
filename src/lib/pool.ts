import type { GameRecord, ParsePassMode, ParseProgress } from "./types";
import { cachedIds, putRecords } from "./db";
import type { WorkerResult } from "../worker/parser.worker";
import type { ReplayFolder } from "./folders";

export interface DiscoveredFile {
  id: string;
  path: string;
  format: "slp" | "slpz";
  file: File;
  /**
   * Kept so the pipeline can re-stat the file immediately before reading it.
   * Absent on the <input webkitdirectory> path, which hands over File objects
   * with no way back to the entry.
   */
  handle?: FileSystemFileHandle;
}

const fileId = (path: string, f: File) => `${path}|${f.size}|${f.lastModified}`;

const replayFormat = (name: string): DiscoveredFile["format"] | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".slpz")) return "slpz";
  if (lower.endsWith(".slp")) return "slp";
  return null;
};

/**
 * A replay whose mtime is within seconds of now is almost certainly the game
 * that just ended: Slippi appends frames until it closes the file, so reading
 * it now yields a truncated parse where waiting yields the whole game. This is
 * a cheap first line, not the only one — Windows can report a stale mtime for a
 * file another process still holds open, which is why parse.ts independently
 * rejects a replay with no metadata block.
 */
const IN_PROGRESS_MS = 10_000;
const writtenJustNow = (f: File): boolean => {
  const age = Date.now() - f.lastModified;
  return age >= 0 && age < IN_PROGRESS_MS;
};

// getFile() is one OS roundtrip per replay; a big library walked sequentially
// turns every dashboard open into tens of seconds of IPC. Bounded concurrency
// keeps the scan fast without exhausting file-handle limits.
const GETFILE_CONCURRENCY = 64;

/** Recursively walk a FileSystemDirectoryHandle collecting supported replay files. */
export async function discoverFromHandle(dir: FileSystemDirectoryHandle, prefix = "", signal?: AbortSignal): Promise<DiscoveredFile[]> {
  // Phase 1: walk the tree (subdirectories in parallel), collecting handles.
  const found: { path: string; format: DiscoveredFile["format"]; handle: FileSystemFileHandle }[] = [];
  const walk = async (d: FileSystemDirectoryHandle, p: string): Promise<void> => {
    const subdirs: { handle: FileSystemDirectoryHandle; path: string }[] = [];
    for await (const [name, handle] of d.entries()) {
      signal?.throwIfAborted();
      const path = p ? `${p}/${name}` : name;
      if (handle.kind === "directory") {
        subdirs.push({ handle: handle as FileSystemDirectoryHandle, path });
      } else {
        const format = replayFormat(name);
        if (format) found.push({ path, format, handle: handle as FileSystemFileHandle });
      }
    }
    await Promise.all(subdirs.map(({ handle, path }) => walk(handle, path)));
  };
  await walk(dir, prefix);

  // Phase 2: materialize File objects with bounded concurrency. A getFile()
  // failure (typically the replay Slippi is writing right now) skips that
  // file instead of aborting the whole scan — it'll be picked up next visit.
  // The size/mtime captured here is only a pre-filter against the cache: by
  // the time the pipeline reads a file the snapshot may be stale, so it
  // re-stats through the handle first (see runParsePipeline).
  const out: (DiscoveredFile | null)[] = new Array(found.length).fill(null);
  let next = 0;
  const lane = async () => {
    while (next < found.length) {
      signal?.throwIfAborted();
      const i = next++;
      const entry = found[i]!;
      try {
        const file = await entry.handle.getFile();
        out[i] = {
          id: fileId(entry.path, file),
          path: entry.path,
          format: entry.format,
          file,
          handle: entry.handle,
        };
      } catch {
        // skip: locked or vanished mid-scan
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GETFILE_CONCURRENCY, found.length) }, lane));
  return out.filter((f): f is DiscoveredFile => f !== null);
}

/** One combined parse queue; an unavailable drive does not block the other roots. */
export async function discoverFromFolders(folders: readonly ReplayFolder[], signal?: AbortSignal) {
  const files: DiscoveredFile[] = [];
  const unavailable: ReplayFolder[] = [];
  for (const folder of folders) {
    signal?.throwIfAborted();
    try {
      const prefix = folder.id ? `${folder.id}/${folder.handle.name}` : "";
      const discovered = await discoverFromHandle(folder.handle, prefix, signal);
      for (const file of discovered) files.push(file);
    } catch {
      signal?.throwIfAborted();
      unavailable.push(folder);
    }
  }
  return { files, unavailable };
}

/** Fallback for <input webkitdirectory> file lists. */
export function discoverFromFileList(files: FileList, prefix = ""): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const file of Array.from(files)) {
    const format = replayFormat(file.name);
    if (!format) continue;
    const relativePath = file.webkitRelativePath || file.name;
    const path = prefix ? `${prefix}/${relativePath}` : relativePath;
    out.push({ id: fileId(path, file), path, format, file });
  }
  return out;
}

// One transaction now fills one storage pack. The old 25-record batch paid ten
// transactions (and ten trailing-pack reads/writes) for the same 250 records.
const BATCH_FLUSH = 250;

// UI record delivery is throttled by time, not batch size: every append
// invalidates App's memoized resolve+sort of the entire library, so per-batch
// delivery on a 30k-file parse would mean ~1,200 full re-resolves — during
// syncFolder with the whole dashboard mounted. Progress counts only re-render
// the progress bar / topbar button, so they may go out more often.
const UI_RECORDS_MS = 1000;
const UI_PROGRESS_MS = 250;

/**
 * Above this size, either preview or full-record delivery creates more pressure
 * than useful feedback: every delivery makes React rebuild the full id map,
 * content dedup, resolution, and sorted game arrays. These runs skip the
 * preview entirely, commit full records continuously to IndexedDB, and let
 * every caller reconcile from storage once the run finishes.
 */
const LARGE_IMPORT_MIN = 5_000;

/** Parsed records that could not be written to IndexedDB (quota, private browsing). */
export class RecordSaveError extends Error {
  constructor(unsaved: number, cause: Error) {
    super(
      `Couldn't save ${unsaved.toLocaleString()} parsed game${unsaved === 1 ? "" : "s"} to the local replay cache — ` +
        `your browser may be blocking storage or out of space (${cause.message}).`,
    );
    this.name = "RecordSaveError";
  }
}

/**
 * Below this many new files the preview pass is pure overhead: the full parse
 * is already over in seconds, so a second walk of the same files only delays
 * it. This matters for a first-run import, not an incremental rescan.
 */
const HEADER_PASS_MIN = 250;

/**
 * Parse all not-yet-cached files across a pool of web workers.
 *
 * A medium import runs two passes over the same queue. The first reads only each
 * replay's settings, metadata and game-end blocks — never a frame, which is
 * where nearly all of the cost of a parse lives — and streams the results to
 * the dashboard as a preview without caching them, filling in game counts, win
 * rates, matchups, opponents and sessions in a fraction of the time. Showing
 * those is safe because the header ladder is a strict subset of the full one
 * (see decideWinner in parse.ts): it can leave a result undetermined, never
 * disagree about one, so nothing on screen is corrected out from under the user
 * when the real numbers land. What it cannot fill in is the execution metrics,
 * which is why its records carry `statsLevel: "header"` and every averaging
 * selector filters them out.
 *
 * The second pass is the authoritative one — full stats, written to IndexedDB,
 * replacing the previews in React state by id. Both passes drive one pool of
 * workers, because spawning them twice would re-parse the slippi-js bundle in
 * every worker.
 *
 * Streams progress and flushes records to IndexedDB in batches so the dashboard
 * can render while parsing continues.
 */
export async function runParsePipeline(
  files: DiscoveredFile[],
  onProgress: (p: ParseProgress, newRecords: GameRecord[]) => void,
  // Aborting (App's reset) must stop DB writes and callbacks immediately —
  // a pipeline that keeps committing after clearAll() resurrects the old
  // folder's records into the wiped cache and the fresh React state.
  signal?: AbortSignal,
): Promise<void> {
  const cached = await cachedIds();
  // Newest first. Total parse time is unchanged, but the records that reach the
  // dashboard first are then the ones a player actually wants to see — this
  // week's games rather than whatever the directory walk happened to hit first.
  const queue = files
    .filter((f) => !cached.has(f.id))
    .sort((a, b) => b.file.lastModified - a.file.lastModified);
  const largeImport = queue.length >= LARGE_IMPORT_MIN;
  // A preview makes medium imports feel instant, but at several thousand
  // pending files it becomes a second in-memory library and a second full walk
  // of the folder. Memory-safe runs show progress and perform only the
  // authoritative pass.
  const willPreview = queue.length >= HEADER_PASS_MIN && !largeImport;
  const progress: ParseProgress = {
    pass: willPreview ? "header" : "full",
    // Progress describes work in this run only. Cached files have their own
    // counter; seeding `done` with them made a repair appear frozen at exactly
    // the user's old game count while its first real replay was still parsing.
    total: queue.length,
    done: 0,
    skippedCached: files.length - queue.length,
    failed: 0,
    unreadable: 0,
    deferred: 0,
  };
  // This emit is what the bar paints before a single worker starts, so it has to
  // already describe the pass about to run — labelling it "full" here made the
  // UI flash "Parsing replays… 0 / N" for a frame before the preview relabelled
  // it, which reads as the parse restarting.
  onProgress({ ...progress }, []);
  if (queue.length === 0) return;

  // Logical cores are not a useful worker count by themselves: on hybrid CPUs
  // they include efficiency cores, and slippi-js used to retain ~100 MB of
  // frame objects per worker. The streaming parser below removes that peak, but
  // memory bandwidth still flattens before every logical core is busy. A
  // two-round, 240-game local benchmark of the final bounded parser measured
  // 44.7/52.5/54.8 games/s at 4/6/8 workers respectively, so eight is the
  // measured ceiling rather than a guess at "all cores". Large imports still
  // skip the preview pass, but on machines that expose enough memory/core
  // budget they can run wider than the old three-worker fallback. Browsers
  // that withhold `deviceMemory` remain conservative.
  const cores = navigator.hardwareConcurrency || 4;
  const memoryGb = navigator.deviceMemory ?? 0;
  const hasMemory = memoryGb >= 8;
  const workerCap = largeImport
    ? hasMemory && cores >= 8 ? 6 : hasMemory && cores >= 6 ? 4 : 3
    : hasMemory && cores >= 8 ? 8 : hasMemory && cores >= 6 ? 6 : 4;
  const workerCount = Math.max(1, Math.min(cores, workerCap));
  interface Slot {
    worker: Worker;
    job: DiscoveredFile | null;
    dead: boolean;
  }
  const slots: Slot[] = Array.from({ length: workerCount }, () => ({
    worker: new Worker(new URL("../worker/parser.worker.ts", import.meta.url), { type: "module" }),
    job: null,
    dead: false,
  }));

  let pendingDb: GameRecord[] = [];
  let pendingUi: GameRecord[] = [];
  let lastProgressEmit = 0;
  let lastRecordsEmit = 0;

  const emitUi = () => {
    if (signal?.aborted) return;
    const now = Date.now();
    if (now - lastProgressEmit < UI_PROGRESS_MS) return;
    lastProgressEmit = now;
    let batch: GameRecord[] = [];
    if (pendingUi.length && now - lastRecordsEmit >= UI_RECORDS_MS) {
      lastRecordsEmit = now;
      batch = pendingUi;
      pendingUi = [];
    }
    onProgress({ ...progress }, batch);
  };

  /** Hand over everything buffered, throttles ignored. */
  const drainUi = () => {
    if (signal?.aborted) return;
    const batch = pendingUi;
    pendingUi = [];
    onProgress({ ...progress }, batch);
  };

  // DB writes are chained so batches commit in order and a rejection can't
  // escape as an unhandled rejection mid-pipeline — the chain never rejects;
  // failures are captured here and surfaced after the worker loop settles.
  let flushChain: Promise<void> = Promise.resolve();
  let flushError: Error | null = null;
  let unsaved = 0;

  const flush = () => {
    if (!pendingDb.length || signal?.aborted) return;
    const batch = pendingDb;
    pendingDb = [];
    flushChain = flushChain.then(async () => {
      try {
        await putRecords(batch);
      } catch (err) {
        flushError ??= err instanceof Error ? err : new Error(String(err));
        unsaved += batch.length;
      }
    });
  };

  /**
   * Drive the pool once over the queue. The preview pass writes nothing: a file
   * it cannot read or parse is simply left out, because the full pass reaches
   * that same file moments later and is the one whose verdict — record or
   * tombstone — gets cached.
   */
  const runPass = (mode: ParsePassMode): Promise<void> => {
    const persist = mode === "full";
    // Pass-local copy: a dying worker requeues its job onto this list, and that
    // must not lengthen the other pass's work.
    const work = [...queue];
    let next = 0;

    return new Promise<void>((resolve, reject) => {
      let inFlight = 0;

      const feed = (slot: Slot) => {
        if (slot.dead) return;
        // Once a cache write fails, later ones will too (quota, private
        // browsing) — stop starting new files instead of parsing into batches
        // that can't be saved.
        if (next >= work.length || flushError || signal?.aborted) {
          if (inFlight === 0) resolve();
          return;
        }
        const job = work[next++]!;
        slot.job = job;
        inFlight++;
        // Retire the job without producing a record. Nothing lands in `seen`,
        // which is precisely what lets the next scan come back for it.
        const retire = (deferred: boolean) => {
          inFlight--;
          slot.job = null;
          progress.done++;
          // The non-deferred path here is a getFile() throw: the file could not
          // be opened at all, so nothing was cached and the next scan retries it.
          if (deferred) progress.deferred++;
          else progress.unreadable++;
          emitUi(); // read failures must still move the bar
          feed(slot);
        };
        void (async () => {
          let { file, id } = job;
          if (job.handle) {
            // Re-stat immediately before reading. The File from discovery is a
            // snapshot of size+mtime taken during the walk, and Chrome fails the
            // read when the file has changed since — which is exactly the replay
            // of the game you just finished. Re-fetching here shrinks that window
            // from "however long the scan took" to microseconds, and gives the
            // record an id that matches the bytes we actually parse.
            file = await job.handle.getFile();
            id = fileId(job.path, file);
            // It moved on since discovery and we already hold this exact version.
            if (id !== job.id && cached.has(id)) return retire(true);
            // Deferring is only useful when a rescan can come back for the file.
            // The webkitdirectory path has no handle and no rescan, so there it
            // is better to parse what we have than to drop the file silently.
            if (writtenJustNow(file)) return retire(true);
          }
          // Unread: the worker does the I/O. See the Job comment in the worker.
          slot.worker.postMessage({ id, path: job.path, format: job.format, file, mode });
        })().catch(() => retire(false));
      };

      const alive = slots.filter((s) => !s.dead);
      if (alive.length === 0) {
        reject(new Error("All parse workers failed to start (often a stale tab after a site update)."));
        return;
      }

      for (const slot of alive) {
        slot.worker.onmessage = (e: MessageEvent) => {
          inFlight--;
          slot.job = null;
          progress.done++;
          const res = e.data as WorkerResult;
          if (res.ok && res.record) {
            if (persist) pendingDb.push(res.record);
            // Medium runs stream their useful header preview and full records.
            // A memory-safe run has no header pass and keeps authoritative rows
            // out of React's whole-library recompute loop; the final storage
            // reconciliation installs them all at once.
            if (!persist || !largeImport) pendingUi.push(res.record);
          } else if (res.readFailed) {
            // The read is the worker's job now, so its failures arrive here
            // rather than as a rejected promise on the feed path. Counted, but
            // never cached, so the file stays eligible for the next scan.
            progress.unreadable++;
          } else if (res.incomplete) {
            // Read mid-write: the file is fine, we were early. No tombstone —
            // keeping its id out of `seen` is what lets the next scan pick up
            // the finished game. Caching the fragment instead would shadow that
            // game permanently (see IncompleteReplayError in parse.ts).
            progress.deferred++;
          } else {
            // Parsed and failed. Unlike the two above this one IS cached, as a
            // tombstone whose id goes into `seen`, so no later scan will return
            // to it. Counted separately so the UI does not tell the user to
            // refresh for a file that a refresh cannot help.
            progress.failed++;
            // Store a tombstone so corrupt files are not re-parsed every visit.
            if (persist) {
              const tombstone: GameRecord = {
                id: res.id,
                path: res.path,
                playedAt: null,
                durationFrames: 0,
                stageId: -1,
                gameType: "unknown",
                isTeams: false,
                players: [],
                winnerIndex: null,
                winnerTeamId: null,
                parseError: res.error ?? "parse failed",
              };
              pendingDb.push(tombstone);
              if (!largeImport) pendingUi.push(tombstone);
            }
          }
          if (pendingDb.length >= BATCH_FLUSH) flush();
          emitUi();
          feed(slot);
        };
        // A worker that dies — most commonly its script 404ing because a new
        // deploy replaced the hashed chunk while this tab was open — never posts
        // a message, which used to hang the pipeline at "0 / N" forever. The
        // file is fine, so requeue it (no tombstone) and drop the worker; when
        // every worker is gone, fail loudly instead of waiting.
        slot.worker.onerror = () => {
          slot.dead = true;
          slot.worker.terminate();
          if (slot.job) {
            inFlight--;
            work.push(slot.job);
            slot.job = null;
          }
          const stillAlive = slots.filter((s) => !s.dead);
          if (stillAlive.length === 0) {
            reject(new Error("All parse workers failed to start (often a stale tab after a site update)."));
            return;
          }
          // Wake idle survivors so the requeued job isn't stranded.
          for (const s of stillAlive) if (s.job === null) feed(s);
        };
        feed(slot);
      }
    });
  };

  try {
    // Preview pass — medium imports only, see HEADER_PASS_MIN. Its counters were
    // set above so the very first frame the user sees is already correct.
    if (willPreview) {
      await runPass("header");
      if (signal?.aborted) return;
      // Hand the last previews over before the counters reset, or they would be
      // reported under the full pass's numbers.
      drainUi();
      // Errors and deferrals here were provisional — the full pass re-decides
      // every one of them — so they start clean rather than being counted twice.
      progress.failed = 0;
      progress.unreadable = 0;
      progress.deferred = 0;
    }

    progress.pass = "full";
    progress.total = queue.length;
    progress.done = 0;
    await runPass("full");
  } finally {
    // Terminate on rejection too — a failed pipeline must not leak the pool.
    slots.forEach((s) => s.worker.terminate());
  }

  if (signal?.aborted) return; // parsed-but-unflushed records are dropped by design
  flush();
  await flushChain;
  if (signal?.aborted) return;
  // Trailing delivery for ordinary runs. Large runs intentionally withheld
  // full rows from React; all three callers reconcile those from IndexedDB once
  // this promise resolves.
  drainUi();
  if (flushError) throw new RecordSaveError(unsaved, flushError);
}
