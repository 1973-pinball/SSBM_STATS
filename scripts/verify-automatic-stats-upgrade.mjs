/** Whole-library upgrade planning against real selectors and cached identities. */
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, envDir: false,
  server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { createStatsUpgradeInventory, planAutomaticStatsUpgrade, statsUpgradeAttemptKey } =
    await server.ssrLoadModule('/src/lib/automaticStatsUpgrade.ts');
  const { CURRENT_STATS_VERSION } = await server.ssrLoadModule('/src/lib/types.ts');
  const { dedupeRecords } = await server.ssrLoadModule('/src/lib/dedupe.ts');
  const record = (n, version = 6, extras = {}) => ({
    id: `replays/${n}.slp|100|200`, path: `replays/${n}.slp`, statsVersion: version,
    playedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), durationFrames: 3600,
    stageId: 31, isTeams: false,
    players: [0, 1].map(port => ({ port, connectCode: `PLAYER#${port}`, characterId: 2,
      techs: {}, actions: { crouchCancels: 0 } })),
    ...extras,
  });
  const file = rec => ({ id: rec.id, path: rec.path, format: 'slp', file: { lastModified: 200 } });
  const plan = (records, inventory, attempted = new Set(), unavailable = new Set(), limit) =>
    planAutomaticStatsUpgrade(records, inventory, attempted, unavailable, limit);

  const old = Array.from({ length: 207 }, (_, i) => record(i, 6 + i % 4,
    i % 7 === 0 ? { isTeams: true, players: [0, 1, 2, 3].map(port => ({ port, characterId: 2,
      connectCode: `TEAM#${port}`, techs: {}, actions: { crouchCancels: 0 } })) } : {}));
  const excluded = [record(300, CURRENT_STATS_VERSION), record(301, CURRENT_STATS_VERSION + 1),
    record(302, 6, { statsLevel: 'header' }), record(303, 6, { parseError: 'previous failure' })];
  const records = Object.freeze([...old, ...excluded]);
  const before = structuredClone(records);
  const files = Object.freeze(records.map(file));
  const inventory = createStatsUpgradeInventory(files, records);
  assert.ok(inventory.successfulFileIds.has(old[0].id));
  assert.ok(!inventory.successfulFileIds.has(excluded[2].id), 'header previews cannot prove a successful cached full parse');
  assert.ok(!inventory.successfulFileIds.has(excluded[3].id), 'failure-only records cannot use the trusted-success fast path');
  const attempted = new Set();
  const first = plan(records, inventory, attempted);
  assert.equal(first.files.length, 50, 'default background batches stay bounded');
  assert.equal(first.targets.length, 50);
  assert.deepEqual(first.targets.map(rec => rec.id), old.slice(-50).reverse().map(rec => rec.id), 'cache-order selection is deterministic');
  assert.equal(attempted.size, 0, 'planning does not mark files as dispatched');
  const dispatched = [];
  for (;;) {
    const batch = plan(records, inventory, attempted);
    if (!batch.files.length) break;
    assert.ok(batch.files.length <= 50);
    assert.equal(new Set(batch.files.map(item => item.id)).size, batch.files.length);
    dispatched.push(...batch.targets);
    for (const rec of batch.targets) attempted.add(statsUpgradeAttemptKey(rec));
  }
  assert.equal(dispatched.length, old.length, 'successive batches reach older records beyond the latest150');
  assert.equal(new Set(dispatched.map(rec => rec.id)).size, old.length, 'failed/deferred attempted versions do not loop');
  assert.ok(dispatched.some(rec => rec.isTeams), 'teams are included independently of the active dashboard filter');
  assert.deepEqual(records, before, 'planning preserves the usable saved records');
  assert.deepEqual(plan(records, inventory, attempted).files, []);

  const upgraded = old.map(rec => ({ ...rec, statsVersion: CURRENT_STATS_VERSION }));
  assert.deepEqual(plan(upgraded, createStatsUpgradeInventory(files, upgraded)).files, [], 'saved current versions survive a fresh-session attempt set');
  const partial = old.map((rec, i) => i < 100 ? { ...rec, statsVersion: CURRENT_STATS_VERSION } : rec);
  const resumed = plan(partial, createStatsUpgradeInventory(files, partial));
  assert.ok(resumed.targets.every(rec => rec.statsVersion < CURRENT_STATS_VERSION), 'restart resumes only unupgraded records');
  assert.equal(resumed.targets[0].id, old.at(-1).id);

  const late = record(400, 9);
  const lateInventory = createStatsUpgradeInventory([...files, file(late)], [...records, late]);
  assert.deepEqual(plan([...records, late], lateInventory, attempted).targets, [late], 'late cloud records join the queue without releasing prior attempt guards');
  const historicalCloud = [record(401, 5), record(402, 6, { statsVersion: undefined })];
  assert.deepEqual(plan(historicalCloud, createStatsUpgradeInventory(historicalCloud.map(file), [])).targets,
    historicalCloud.toReversed(), 'cloud-only historical payloads with old or missing version markers remain eligible');
  const repairedCopy = { ...late, statsVersion: CURRENT_STATS_VERSION, id: 'other/current.slp|100|200' };
  assert.deepEqual(plan(dedupeRecords([late, repairedCopy]), lateInventory).files, [], 'late stale cloud aliases cannot downgrade an already upgraded game');
  const futureCopy = { ...late, statsVersion: CURRENT_STATS_VERSION + 1, id: 'other/future.slp|100|200' };
  for (const copies of [[late, futureCopy], [futureCopy, late]]) {
    assert.deepEqual(plan(copies, lateInventory).files, [], 'known future-version game aliases block an automatic downgrade before compatibility deduplication');
    assert.deepEqual(plan([...copies, historicalCloud[0]], lateInventory).missingKeys,
      [statsUpgradeAttemptKey(historicalCloud[0])], 'future protection is scoped to that game and leaves unrelated old games eligible');
  }

  const original = record(500, 8);
  const alias = { ...original, id: 'a/moved.slp|100|999', path: 'a/moved.slp' };
  const otherAlias = { ...original, id: 'z/moved.slp|100|888', path: 'z/moved.slp' };
  const unrelated = record(501, 8);
  const exactInventory = createStatsUpgradeInventory([file(alias), file(original), file(unrelated)], [alias, original, unrelated]);
  assert.deepEqual(plan([original], exactInventory).files.map(item => item.id), [original.id], 'exact file identity wins over moved aliases');
  const aliases = createStatsUpgradeInventory([file(otherAlias), file(alias), file(unrelated)], [otherAlias, alias, unrelated]);
  assert.deepEqual(plan([original], aliases).files.map(item => item.id), [alias.id], 'one deterministic proven alias is used');
  const cloudCopy = { ...original, id: 'cloud/newer.slp|100|777', path: 'cloud/newer.slp', statsVersion: 9 };
  assert.deepEqual(plan([cloudCopy, alias], aliases).files.map(item => item.id), [alias.id],
    'a raw local copy may provide the proven file for its preferred cloud alias');
  assert.equal(statsUpgradeAttemptKey(alias), statsUpgradeAttemptKey(original));
  assert.deepEqual(plan([alias], aliases, new Set([statsUpgradeAttemptKey(original)])).files, [], 'moved copies share attempts');
  assert.equal(plan([original, alias], exactInventory).files.length, 1, 'duplicate cached aliases never dispatch twice');
  const conflict = { ...unrelated, id: alias.id };
  const ambiguous = createStatsUpgradeInventory([file(alias)], [alias, conflict]);
  assert.deepEqual(plan([original], ambiguous).files, [], 'conflicting cached identities cannot authorize an alias');
  const exactOwner = { ...unrelated, id: alias.id, path: alias.path };
  const reserved = plan([exactOwner, original], createStatsUpgradeInventory([file(alias)], [alias]));
  assert.deepEqual(reserved.targets.map(rec => rec.id), [exactOwner.id], 'an alias cannot take another target\'s exact file');
  const uncachedAlias = createStatsUpgradeInventory([file(alias)], []);
  assert.deepEqual(plan([original], uncachedAlias).files, [], 'a matching filename or size is not game-identity evidence');
  const dateless = { ...original, playedAt: null };
  const datelessAlias = { ...alias, playedAt: null };
  assert.deepEqual(plan([dateless], createStatsUpgradeInventory([file(datelessAlias)], [datelessAlias])).files, [], 'dateless copies are not inferred to match');

  const missing = plan([original], createStatsUpgradeInventory([], [original]));
  assert.deepEqual(missing.files, []);
  assert.deepEqual(missing.missingKeys, [statsUpgradeAttemptKey(original)]);
  const unavailable = new Set(missing.missingKeys);
  assert.deepEqual(plan([original], exactInventory, new Set(), unavailable).files, [], 'unchanged unavailable inventory does not loop');
  assert.deepEqual(plan([original], exactInventory).files.map(item => item.id), [original.id], 'a refreshed accessible inventory can release only the missing-file guard');
  assert.deepEqual(plan([original], exactInventory, new Set([statsUpgradeAttemptKey(original)])).files, [], 'new inventory does not automatically retry failed parsed versions');
  assert.equal(plan(old, inventory, new Set(), new Set(), 3).files.length, 3, 'caller batch budget is honored');
  for (const invalid of [0, -1, 1.5, Infinity, NaN]) assert.deepEqual(plan(old, inventory, new Set(), new Set(), invalid).files, [], 'invalid budgets cannot start an unbounded run');

  // Exercise the actual pipeline's new background budget and trusted-success
  // optimization. The existing replay-retry verifier covers durable failure,
  // abort, and transaction rollback semantics with the same real DB helpers.
  const { db } = await server.ssrLoadModule('/src/lib/db.ts');
  const { runParsePipeline } = await server.ssrLoadModule('/src/lib/pool.ts');
  const originals = [record(600, 9), record(601, 8)];
  const failure = record(602, 9, { playedAt: null, parseError: 'cached failure' });
  const saved = [{ id: 1, records: structuredClone([...originals, failure]) }];
  const seen = new Set([...originals, failure].map(rec => rec.id));
  let cacheReads = 0;
  db.seen.toCollection = () => ({ primaryKeys: async () => [...seen] });
  db.seen.bulkPut = async rows => { for (const row of rows) seen.add(row.id); };
  db.packs.toArray = async () => { cacheReads++; return structuredClone(saved); };
  db.packs.orderBy = () => ({ last: async () => undefined });
  db.packs.add = async pack => { saved.push({ id: saved.length + 1, records: structuredClone(pack.records) }); };
  db.transaction = async (...args) => args.at(-1)();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWorker = globalThis.Worker;
  let created = 0, active = 0, peak = 0;
  const parsedIds = [];
  const recordById = new Map(originals.map(rec => [rec.id, rec]));
  globalThis.Worker = class {
    constructor() { created++; active++; peak = Math.max(peak, active); }
    postMessage(job) {
      parsedIds.push(job.id);
      queueMicrotask(() => this.onmessage({ data: { ok: true, record: { ...recordById.get(job.id), statsVersion: CURRENT_STATS_VERSION } } }));
    }
    terminate() { active--; }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 16, deviceMemory: 16 } });
  try {
    const pipelineFiles = originals.map(rec => ({ ...file(rec), file: new File([new Uint8Array(100)], rec.path, { lastModified: 200 }) }));
    const trusted = createStatsUpgradeInventory(pipelineFiles, originals).successfulFileIds;
    await runParsePipeline(pipelineFiles, () => {}, undefined, { forceIds: new Set(originals.map(rec => rec.id)), knownSuccessfulIds: trusted, maxWorkers: 2 });
    assert.equal(created, 2); assert.equal(peak, 2); assert.equal(active, 0, 'background workers are capped and cleaned up');
    assert.deepEqual(parsedIds.sort(), originals.map(rec => rec.id).sort());
    assert.equal(cacheReads, 0, 'proven successful cached slots do not rescan the full packed library each batch');
    const oldAndNew = saved.flatMap(pack => pack.records);
    assert.ok(originals.every(rec => oldAndNew.some(row => row.id === rec.id && row.statsVersion === rec.statsVersion)), 'forced upgrades retain old usable rows until replacement is durable');
    assert.ok(dedupeRecords(oldAndNew).filter(rec => !rec.parseError).every(rec => rec.statsVersion === CURRENT_STATS_VERSION));
    await runParsePipeline([{ ...file(failure), file: new File([new Uint8Array(100)], failure.path, { lastModified: 200 }) }], () => {}, undefined,
      { forceIds: new Set([failure.id]), knownSuccessfulIds: trusted, maxWorkers: 2 });
    assert.equal(cacheReads, 1, 'unproven force IDs retain the real failure-only lookup');
    assert.equal(created, 2, 'a cached failure cannot be retried through the optimization');
  } finally {
    globalThis.Worker = originalWorker;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }

  console.log('Automatic stats upgrades passed: bounded whole-library/teams planning, restart/late arrivals, current/future exclusions, alias/missing guards, two-worker budget, preserved saved versions, and trusted-cache/failure boundaries.');
} finally { await server.close(); }
