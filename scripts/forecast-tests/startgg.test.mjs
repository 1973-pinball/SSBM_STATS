import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createStartggClient, downloadEvent, fetchEventMetadata, STARTGG_ENDPOINT,
} from '../lib/forecast/startgg.mjs';
import { isVettedStartggReceiptQuery } from '../lib/forecast/corpus-source-readiness.mjs';

const TOKEN = 'forecast-unit-test-secret';
const QUERY = 'query TestEvent($id: ID!) { event(id: $id) { id } }';
const DATE = Date.parse('2026-09-04T12:00:00.000Z');
const SLUG = 'tournament/fixture-major/event/melee-singles';
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const success = data => jsonResponse({ data });

async function workspace(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'forecast-startgg-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return cacheDir;
}

function clientAt(cacheDir, extra = {}) {
  return createStartggClient({ token: TOKEN, cacheDir, minIntervalMs: 0, now: () => DATE, ...extra });
}

const scalar = name => ({ name, type: { kind: 'SCALAR', name: 'String' } });
const objectField = (name, type) => ({ name, type: { kind: 'OBJECT', name: type } });
const schemaFields = {
  Event: [
    ...['id', 'slug', 'name', 'startAt', 'entrantSizeMin', 'numEntrants', 'isOnline', 'type', 'state', 'teamRosterSize'].map(scalar),
    ...['tournament', 'videogame', 'phases'].map(name => objectField(name, name)),
  ],
  Phase: ['id', 'name', 'phaseOrder', 'bracketType', 'state', 'numSeeds'].map(scalar),
  Set: [
    ...['id', 'state', 'round', 'fullRoundText', 'winnerId', 'startedAt', 'completedAt', 'updatedAt', 'displayScore'].map(scalar),
    { name: 'slots', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'SetSlot' } } } },
    objectField('phaseGroup', 'PhaseGroup'),
  ],
  SetSlot: [...['id', 'slotIndex', 'prereqId', 'prereqType', 'prereqPlacement'].map(scalar), objectField('seed', 'Seed')],
  PhaseGroup: ['id', 'displayIdentifier', 'bracketType', 'state', 'startAt', 'numRounds'].map(scalar),
  Seed: [...['id', 'seedNum'].map(scalar), objectField('phaseGroup', 'PhaseGroup')],
};

function fixture() {
  const phase = { id: 20, name: 'Main bracket', bracketType: 'DOUBLE_ELIMINATION', phaseOrder: 1 };
  const event = {
    id: 10, slug: SLUG, name: 'Melee Singles', startAt: 1750000000,
    numEntrants: 3, entrantSizeMin: 1, teamRosterSize: null, isOnline: false,
    tournament: { id: 1, slug: 'tournament/fixture-major', name: 'Fixture Major', startAt: 1750000000, endAt: 1750100000, isOnline: false },
    videogame: { id: 1, name: 'Super Smash Bros. Melee' }, phases: [phase],
  };
  const entrants = [1, 2, 3].map(id => ({
    id, name: `Player ${id}`, participants: [{ id: id * 10, gamerTag: `Tag ${id}`, player: { id: id * 100 } }],
  }));
  const sets = [1, 2, 3].map(id => ({
    id: 1000 + id, state: id === 3 ? 1 : 3, round: id, fullRoundText: `Winners Round ${id}`,
    winnerId: id === 3 ? null : 1, startedAt: 1750000000 + id, completedAt: id === 3 ? null : 1750000300 + id,
    phaseGroup: { id: 300 + id, displayIdentifier: `A${id}` },
    slots: [1, 2].map(player => ({
      id: `${1000 + id}-${player}`, entrant: { id: player, name: `Player ${player}` },
      prereqId: 900 + id, prereqType: 'set', prereqPlacement: player,
      standing: { id: `standing-${id}-${player}`, placement: player, stats: { score: { label: 'Score', value: player === 1 ? 2 : 0 } } },
    })),
  }));
  const standings = entrants.map((entrant, index) => ({ id: 100 + index, entrant: { id: entrant.id }, placement: index + 1 }));
  const seeds = entrants.map((entrant, index) => ({ id: 200 + index, seedNum: index + 1, entrant: { id: entrant.id }, phaseGroup: { id: 301 } }));
  const phaseGroups = [1, 2, 3].map(id => ({ id: 300 + id, displayIdentifier: `A${id}`, bracketType: 'DOUBLE_ELIMINATION' }));
  return { event, entrants, sets, standings, seeds, phaseGroups };
}

function fixtureFetch(data, calls, alter = value => value) {
  return async (url, init) => {
    assert.equal(url, STARTGG_ENDPOINT);
    assert.equal(init.redirect, 'error');
    const { query, variables } = JSON.parse(init.body);
    const operation = query.match(/^query (\w+)/)[1];
    calls.push({ operation, query, variables });
    if (operation === 'ForecastSchema') return success({ type: { name: variables.name, fields: schemaFields[variables.name] } });
    if (operation === 'ForecastEvent') return success({ event: data.event });
    const fields = {
      ForecastEntrants: 'entrants', ForecastSets: 'sets', ForecastSetsByPhaseGroups: 'sets', ForecastStandings: 'standings',
      ForecastPhaseSeeds: 'seeds', ForecastPhaseGroups: 'phaseGroups',
    };
    const field = fields[operation];
    assert.ok(field, `Unexpected operation ${operation}`);
    const parent = Object.hasOwn(variables, 'eventId') ? 'event' : 'phase';
    const rows = operation === 'ForecastSetsByPhaseGroups'
      ? data.sets.filter(row => variables.phaseGroupIds.includes(String(row.phaseGroup?.id)))
      : data[field];
    const connection = {
      pageInfo: { total: rows.length, totalPages: Math.ceil(rows.length / variables.perPage) },
      nodes: rows.slice((variables.page - 1) * variables.perPage, variables.page * variables.perPage),
    };
    return success({ [parent]: { id: variables[`${parent}Id`], [field]: alter(connection, { field, variables, query }) } });
  };
}

test('download progress reports checked page counts without changing source content', async t => {
  const cacheDir = await workspace(t);
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(fixture(), []) });
  const progress = [];
  const bundle = await downloadEvent(client, SLUG, { perPage: 2, onProgress: value => progress.push(value) });
  assert.equal(progress.length, 10);
  assert.deepEqual(progress[0], { collection: 'entrants', parent: 'event', parentId: '10', page: 1, totalPages: 2, rows: 2, total: 3 });
  assert.equal(progress.at(-1).rows, 3);
  const offline = createStartggClient({ cacheDir, offline: true });
  assert.deepEqual(await downloadEvent(offline, SLUG, { perPage: 2 }), bundle);
  assert.ok(!JSON.stringify(progress).includes(TOKEN));
});

test('cache is reproducible, canonicalizes variables, and works offline without credentials', async t => {
  const cacheDir = await workspace(t);
  let networkCalls = 0;
  const client = clientAt(cacheDir, { fetchImpl: async (url, init) => {
    networkCalls += 1;
    assert.equal(url, STARTGG_ENDPOINT);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, 'error');
    return success({ event: { id: 1 } });
  } });
  const first = await client.request(QUERY, { id: 1, filter: { b: 2, a: 1 } });
  first.event.id = 99;
  assert.deepEqual(await client.request(QUERY, { filter: { a: 1, b: 2 }, id: 1 }), { event: { id: 1 } });
  assert.equal(networkCalls, 1);
  const provenance = client.getRequestProvenance(QUERY, { id: 1, filter: { a: 1, b: 2 } });
  assert.equal(provenance.fetchedAt, '2026-09-04T12:00:00.000Z');
  const files = await readdir(cacheDir);
  assert.equal(files.length, 1);
  const saved = await readFile(join(cacheDir, files[0]), 'utf8');
  assert.ok(!saved.includes(TOKEN));
  assert.ok(!saved.includes('Authorization'));
  const offline = createStartggClient({ cacheDir, offline: true, fetchImpl: () => assert.fail('Offline network request') });
  assert.deepEqual(await offline.request(QUERY, { id: 1, filter: { b: 2, a: 1 } }), { event: { id: 1 } });
  assert.deepEqual(offline.getRequestProvenance(QUERY, { id: 1, filter: { b: 2, a: 1 } }), provenance);
  await assert.rejects(offline.request(QUERY, { id: 2 }), { code: 'OFFLINE_MISS' });
});

test('rejects missing tokens, write operations, invalid inputs and token-bearing variables before networking', async t => {
  const cacheDir = await workspace(t);
  const noNetwork = () => assert.fail('Unexpected network request');
  const client = clientAt(cacheDir, { fetchImpl: noNetwork });
  await assert.rejects(client.request('mutation Change { updateEvent { id } }'), { code: 'INVALID_REQUEST' });
  await assert.rejects(client.request('query Read { event { id } } mutation Change { updateEvent { id } }'), { code: 'INVALID_REQUEST' });
  await assert.rejects(client.request(QUERY, { id: TOKEN }), { code: 'INVALID_REQUEST' });
  await assert.rejects(client.request(QUERY, { id: Infinity }), { code: 'INVALID_REQUEST' });
  const noToken = createStartggClient({ cacheDir, fetchImpl: noNetwork });
  await assert.rejects(noToken.request(QUERY, { id: 1 }), { code: 'AUTH' });
  assert.throws(() => createStartggClient({ cacheDir, offline: true, refresh: true }), { code: 'CONFIG' });
  assert.deepEqual(await readdir(cacheDir), []);
});

test('never caches GraphQL partial data, malformed responses, or credential reflection', async t => {
  const cacheDir = await workspace(t);
  for (const response of [
    { data: { event: { id: 1 } }, errors: [{ message: `Oops ${TOKEN}` }] },
    { success: false, message: 'Invalid query' }, { data: null }, { data: [] },
    { data: { event: { name: TOKEN } } },
  ]) {
    const client = clientAt(cacheDir, { fetchImpl: async () => jsonResponse(response) });
    await assert.rejects(client.request(QUERY, { id: 1 }), error => {
      assert.ok(!String(error.stack).includes(TOKEN));
      return ['INVALID_RESPONSE', 'CREDENTIAL_REFLECTION'].includes(error.code);
    });
    assert.deepEqual(await readdir(cacheDir), []);
  }
});

test('auth errors fail once without disclosing body or token', async t => {
  const cacheDir = await workspace(t);
  let calls = 0;
  const client = clientAt(cacheDir, { fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ success: false, message: `Invalid authentication token ${TOKEN}` }, 400);
  } });
  await assert.rejects(client.request(QUERY, { id: 1 }), error => error.code === 'AUTH' && !String(error).includes(TOKEN));
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(cacheDir), []);
});

test('retries rate limits with Retry-After and serializes concurrent request pacing', async t => {
  const cacheDir = await workspace(t);
  const waits = [];
  const starts = [];
  let clock = DATE;
  let calls = 0;
  const client = clientAt(cacheDir, {
    minIntervalMs: 1100, now: () => clock,
    sleepImpl: async ms => { waits.push(ms); clock += ms; },
    fetchImpl: async () => {
      starts.push(clock);
      calls += 1;
      if (calls === 1) return jsonResponse({ success: false, message: 'Rate limit exceeded - api-token' }, 429, { 'Retry-After': '3' });
      return success({ event: { id: calls } });
    },
  });
  await Promise.all([client.request(QUERY, { id: 1 }), client.request(QUERY, { id: 2 })]);
  assert.deepEqual(waits, [3000, 1100]);
  assert.deepEqual(starts, [DATE, DATE + 3000, DATE + 4100]);
});

test('supports HTTP-date Retry-After and does not retry before an excessive server delay', async t => {
  const cacheDir = await workspace(t);
  const waits = [];
  let calls = 0;
  const client = clientAt(cacheDir, { sleepImpl: async ms => waits.push(ms), fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ errors: [{ message: 'Rate limit exceeded' }] }, 200, { 'Retry-After': new Date(DATE + 5000).toUTCString() });
    return success({ event: { id: 1 } });
  } });
  await client.request(QUERY, { id: 1 });
  assert.deepEqual(waits, [5000]);
  const stopped = clientAt(cacheDir, {
    sleepImpl: () => assert.fail('Should stop, not wait or retry early'),
    fetchImpl: async () => jsonResponse({}, 429, { 'Retry-After': '3600' }),
  });
  await assert.rejects(stopped.request(QUERY, { id: 2 }), { code: 'RATE_LIMIT' });
});

test('bounds retries for network failures, timeouts, and server outages', async t => {
  const cacheDir = await workspace(t);
  let calls = 0;
  const client = clientAt(cacheDir, { maxRetries: 2, sleepImpl: async () => {}, fetchImpl: async () => {
    calls += 1;
    throw new Error(`Network failure revealing ${TOKEN}`);
  } });
  await assert.rejects(client.request(QUERY, { id: 1 }), error => error.code === 'NETWORK' && !String(error.stack).includes(TOKEN));
  assert.equal(calls, 3);
  const timed = clientAt(cacheDir, { timeoutMs: 5, maxRetries: 0, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(timed.request(QUERY, { id: 2 }), { code: 'NETWORK' });
  calls = 0;
  const unavailable = clientAt(cacheDir, { maxRetries: 1, sleepImpl: async () => {}, fetchImpl: async () => { calls += 1; return jsonResponse({}, 503); } });
  await assert.rejects(unavailable.request(QUERY, { id: 3 }), { code: 'TRANSIENT' });
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(cacheDir), []);
});

test('checks cache checksums and preserves a good cache after a failed refresh', async t => {
  const cacheDir = await workspace(t);
  const client = clientAt(cacheDir, { fetchImpl: async () => success({ event: { id: 1 } }) });
  await client.request(QUERY, { id: 1 });
  const file = join(cacheDir, (await readdir(cacheDir))[0]);
  const original = await readFile(file, 'utf8');
  const refresh = clientAt(cacheDir, { refresh: true, fetchImpl: async () => jsonResponse({ data: { event: { id: 99 } }, errors: [{ message: 'partial' }] }) });
  await assert.rejects(refresh.request(QUERY, { id: 1 }));
  assert.equal(await readFile(file, 'utf8'), original);
  const tampered = JSON.parse(original);
  tampered.response.data.event.id = 666;
  await writeFile(file, JSON.stringify(tampered));
  const offline = createStartggClient({ cacheDir, offline: true });
  await assert.rejects(offline.request(QUERY, { id: 1 }), { code: 'CACHE_INVALID' });
});

test('downloads every page in every connection and reproduces the full bundle offline', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls) });
  const bundle = await downloadEvent(client, SLUG, { perPage: 2 });
  assert.equal(createHash('sha256').update(JSON.stringify(bundle) + '\n').digest('hex'),
    '9ec7c0d4f56b2afb8686fdbe9ec69a459f4151a96e2234408f99b41ac5b745dc',
    'Small-event source bytes must remain identical to the legacy-compatible fixture');
  assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(bundle.event, data.event);
  for (const field of ['entrants', 'sets', 'standings']) assert.deepEqual(bundle[field], data[field]);
  assert.deepEqual(bundle.seeds, data.seeds.map(seed => ({ ...seed, phase: data.event.phases[0] })));
  assert.deepEqual(bundle.phaseGroups, data.phaseGroups.map(group => ({ ...group, phase: data.event.phases[0] })));
  assert.ok(bundle.sets.some(set => set.state !== 3), 'Unfinished sets preserved for bracket forecasting');
  assert.deepEqual(bundle.provenance.availableOptionalFields.slotPrerequisites, ['prereqId', 'prereqType', 'prereqPlacement']);
  assert.deepEqual(bundle.provenance.availableOptionalFields.phaseGroupMetadata, ['bracketType', 'state', 'numRounds']);
  assert.equal(bundle.provenance.requests.length, calls.length);
  assert.equal(bundle.provenance.fetchedAt, '2026-09-04T12:00:00.000Z');
  assert.ok(calls.every(call => isVettedStartggReceiptQuery(call.query, call.operation)),
    'Every downloader query must remain inside the source-readiness contract');
  const paginated = calls.filter(call => call.variables.page);
  assert.equal(paginated.length, 10);
  for (const call of paginated) assert.equal(call.variables.perPage, 2);
  const sets = calls.find(call => call.operation === 'ForecastSets');
  assert.equal(createHash('sha256').update(sets.query).digest('hex'),
    '90ac61192102bcce7d100b93bf12713861898d32ea15c2d3213fca29ac936e67');
  assert.match(sets.query, /sortType: STANDARD/);
  assert.match(sets.query, /showByes: true hideEmpty: false/);
  assert.match(sets.query, /slots\(includeByes: true\)/);
  assert.match(sets.query, /prereqPlacement/);
  assert.doesNotMatch(sets.query, /prereqCondition/);
  assert.match(sets.query, /phaseGroup \{ id displayIdentifier\s+bracketType\s+state\s+startAt\s+numRounds \}/);
  const phaseGroups = calls.filter(call => call.operation === 'ForecastPhaseGroups');
  assert.ok(phaseGroups.length > 0);
  for (const call of phaseGroups) {
    assert.match(call.query, /nodes \{ id displayIdentifier\s+bracketType\s+state\s+numRounds \}/);
    assert.doesNotMatch(call.query, /startAt/);
  }
  const offline = createStartggClient({ cacheDir, offline: true, fetchImpl: () => assert.fail('Offline fetch') });
  assert.deepEqual(await downloadEvent(offline, SLUG, { perPage: 2 }), bundle);
});

test('metadata-only resolution does not download entrants or sets', async t => {
  const cacheDir = await workspace(t);
  const calls = [];
  const data = fixture();
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls) });
  assert.deepEqual(await fetchEventMetadata(client, SLUG), data.event);
  assert.deepEqual(calls.map(call => call.operation), ['ForecastSchema', 'ForecastSchema', 'ForecastEvent']);
  await assert.rejects(fetchEventMetadata(client, 'https://other.invalid/event/melee'), { code: 'INVALID_REQUEST' });
});

test('pagination fails closed on short pages, changing totals, duplicate IDs, and null records', async t => {
  for (const mode of ['short', 'changed', 'duplicate', 'null', 'missingTotal']) {
    await t.test(mode, async t => {
      const cacheDir = await workspace(t);
      const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(fixture(), [], (connection, { field, variables }) => {
        if (field !== 'entrants') return connection;
        if (mode === 'short' && variables.page === 1) connection.nodes.pop();
        if (mode === 'changed' && variables.page === 2) connection.pageInfo = { total: 4, totalPages: 2 };
        if (mode === 'duplicate' && variables.page === 2) connection.nodes[0].id = 1;
        if (mode === 'null' && variables.page === 1) connection.nodes[0] = null;
        if (mode === 'missingTotal') delete connection.pageInfo.total;
        return connection;
      }) });
      await assert.rejects(downloadEvent(client, SLUG, { perPage: 2 }));
    });
  }
});

test('pagination safety bound errors rather than returning a partial bundle', async t => {
  const cacheDir = await workspace(t);
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(fixture(), []) });
  await assert.rejects(downloadEvent(client, SLUG, { perPage: 2, maxPages: 1 }), { code: 'PAGINATION_LIMIT' });
});

test('empty future events can retain metadata with zero paginated records', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  data.event.phases = [];
  for (const field of ['entrants', 'sets', 'standings', 'seeds', 'phaseGroups']) data[field] = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, []) });
  const bundle = await downloadEvent(client, SLUG);
  assert.deepEqual(bundle.entrants, []);
  assert.deepEqual(bundle.sets, []);
  assert.deepEqual(bundle.phaseGroups, []);
});

test('oversized set connections use complete disjoint phase-group shards and reproduce offline', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  const calls = [];
  const progress = [];
  const options = { perPage: 2, setPaginationLimit: 2 };
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls) });
  const bundle = await downloadEvent(client, SLUG, { ...options, onProgress: row => progress.push(row) });
  assert.deepEqual(bundle.sets, data.sets);
  assert.deepEqual(bundle.phaseGroups, data.phaseGroups.map(group => ({ ...group, phase: data.event.phases[0] })));
  assert.deepEqual(bundle.provenance.setPagination, {
    strategy: 'phase-group-shards-v1', eventTotal: 3,
    connectionRowLimit: 2, initialShardGroupLimit: 32,
    shards: [{ phaseGroupIds: ['301'], total: 1 }, { phaseGroupIds: ['302', '303'], total: 2 }],
  });
  const eventProbes = calls.filter(call => call.operation === 'ForecastSets');
  assert.equal(eventProbes.length, 1, 'Never fetch/reuse an ordinary-event partial prefix');
  const shardCalls = calls.filter(call => call.operation === 'ForecastSetsByPhaseGroups');
  assert.deepEqual(shardCalls.map(call => call.variables.phaseGroupIds), [['301', '302', '303'], ['301'], ['302', '303']]);
  for (const call of shardCalls) {
    assert.equal(call.query.slice(call.query.indexOf('nodes {')), eventProbes[0].query.slice(eventProbes[0].query.indexOf('nodes {')));
    assert.match(call.query, /\$phaseGroupIds: \[ID\]!/);
    assert.match(call.query, /showByes: true hideEmpty: false phaseGroupIds: \$phaseGroupIds/);
    assert.match(call.query, /slots\(includeByes: true\)/);
  }
  assert.equal(calls.filter(call => call.operation === 'ForecastPhaseGroups').length, 2, 'Use the complete early-discovered groups again without refetching');
  const firstShard = calls.findIndex(call => call.operation === 'ForecastSetsByPhaseGroups');
  assert.ok(calls.slice(0, firstShard).filter(call => call.operation === 'ForecastPhaseGroups').length === 2);
  const shardProgress = progress.filter(row => row.phaseGroupIds);
  assert.equal(shardProgress.length, 3);
  assert.ok(shardProgress.every(row => row.shardGroupCount === row.phaseGroupIds.length));
  assert.ok(progress.filter(row => row.collection !== 'sets').every(row => !Object.hasOwn(row, 'shardGroupCount')));
  const offline = createStartggClient({ cacheDir, offline: true, fetchImpl: () => assert.fail('Offline shard fetch') });
  assert.deepEqual(await downloadEvent(offline, SLUG, options), bundle);
});

test('default 10,000-row cap detects oversized metadata before requesting ordinary page two', async t => {
  const cacheDir = await workspace(t);
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(fixture(), calls, (connection, { field, variables }) => {
    if (field === 'sets' && !variables.phaseGroupIds) {
      connection.pageInfo = { total: 10001, totalPages: Math.ceil(10001 / variables.perPage) };
    }
    return connection;
  }) });
  // The tiny fixture cannot supply 10,001 distinct rows. The strategy must
  // switch immediately, then reject the final union rather than invent rows.
  await assert.rejects(downloadEvent(client, SLUG, { perPage: 2 }), { code: 'PAGINATION_INCOMPLETE' });
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSets').map(call => call.variables.page), [1]);
  assert.ok(calls.some(call => call.operation === 'ForecastSetsByPhaseGroups'));
});

test('unstable synthetic preview ordering falls back to one official phase group per shard', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  data.sets = data.sets.map((row, index) => ({ ...row, id: `preview_${row.phaseGroup.id}_1_${index}` }));
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls, (connection, { field, variables }) => {
    if (field === 'sets' && !variables.phaseGroupIds && variables.page === 2) {
      connection.nodes[0] = { ...connection.nodes[0], id: data.sets[0].id };
    }
    return connection;
  }) });
  const bundle = await downloadEvent(client, SLUG, { perPage: 2 });
  assert.deepEqual(new Set(bundle.sets.map(row => row.id)), new Set(data.sets.map(row => row.id)));
  assert.equal(bundle.provenance.setPagination.strategy, 'phase-group-shards-preview-order-v1');
  assert.equal(bundle.provenance.setPagination.initialShardGroupLimit, 1);
  assert.equal(bundle.provenance.setPagination.eventTotal, data.sets.length);
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSetsByPhaseGroups')
    .map(call => call.variables.phaseGroupIds), [['301'], ['302'], ['303']]);
});

test('global STANDARD set overlap falls back to complete official phase-group shards and replays offline', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  const calls = [];
  const options = { perPage: 2 };
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls, (connection, { field, variables }) => {
    if (field === 'sets' && !variables.phaseGroupIds && variables.page === 2) {
      connection.nodes[0] = { ...connection.nodes[0], id: data.sets[0].id };
    }
    return connection;
  }) });
  const bundle = await downloadEvent(client, SLUG, options);
  assert.deepEqual(bundle.sets, data.sets);
  assert.deepEqual(bundle.provenance.setPagination, {
    strategy: 'phase-group-shards-global-order-v1', eventTotal: 3,
    connectionRowLimit: 10000, initialShardGroupLimit: 32,
    reason: 'unstable event-wide STANDARD ordering repeated a source set ID across pages',
    shards: [{ phaseGroupIds: ['301', '302', '303'], total: 3 }],
  });
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSets').map(call => call.variables.page), [1, 2]);
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSetsByPhaseGroups')
    .map(call => [call.variables.phaseGroupIds, call.variables.page]), [
    [['301', '302', '303'], 1], [['301', '302', '303'], 2],
  ]);
  const offline = createStartggClient({ cacheDir, offline: true, fetchImpl: () => assert.fail('Offline fetch') });
  assert.deepEqual(await downloadEvent(offline, SLUG, options), bundle);
});

test('global overlap recovery still rejects a real duplicate across replacement phase-group shards', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  const original = data.sets[0];
  data.phaseGroups = Array.from({ length: 35 }, (_, index) => ({ id: 301 + index, displayIdentifier: `A${index}` }));
  data.sets = data.phaseGroups.map((group, index) => ({ ...original, id: 1001 + index, phaseGroup: group }));
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls, (connection, { field, variables }) => {
    if (field !== 'sets') return connection;
    if (!variables.phaseGroupIds && variables.page === 2) {
      connection.nodes[0] = { ...connection.nodes[0], id: data.sets[0].id };
    }
    if (variables.phaseGroupIds?.includes('333')) {
      connection.nodes[0] = { ...connection.nodes[0], id: data.sets[0].id };
    }
    return connection;
  }) });
  await assert.rejects(downloadEvent(client, SLUG), { code: 'PAGINATION_DUPLICATE' });
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSetsByPhaseGroups')
    .map(call => [call.variables.phaseGroupIds.length, call.variables.page]), [[32, 1], [32, 2], [3, 1]]);
});

test('initial shards contain at most 32 official groups and reconcile all groups', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  const original = data.sets[0];
  data.phaseGroups = Array.from({ length: 35 }, (_, index) => ({ id: 301 + index, displayIdentifier: `A${index}` }));
  data.sets = data.phaseGroups.map((group, index) => ({ ...original, id: 1001 + index, phaseGroup: group }));
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls) });
  const bundle = await downloadEvent(client, SLUG, { setPaginationLimit: 34 });
  assert.equal(bundle.sets.length, 35);
  assert.deepEqual(bundle.provenance.setPagination.shards.map(shard => [shard.phaseGroupIds.length, shard.total]), [[32, 32], [3, 3]]);
  assert.ok(calls.filter(call => call.operation === 'ForecastSetsByPhaseGroups').every(call => call.variables.phaseGroupIds.length <= 32));
});

test('shards reject short pages, changed subdivision totals, misplaced sets and cross-shard duplicate IDs', async t => {
  for (const [mode, code] of [
    ['short', 'PAGINATION_INCOMPLETE'], ['changed', 'PAGINATION_CHANGED'],
    ['wrong-group', 'PAGINATION_MEMBERSHIP'], ['missing-group', 'PAGINATION_MEMBERSHIP'],
    ['duplicate', 'PAGINATION_DUPLICATE'],
  ]) {
    await t.test(mode, async t => {
      const cacheDir = await workspace(t);
      const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(fixture(), [], (connection, { variables }) => {
        const groups = variables.phaseGroupIds;
        if (!groups) return connection;
        if (mode === 'changed' && groups.length === 3) connection.pageInfo = { total: 4, totalPages: 2 };
        if (mode === 'short' && groups.length === 2) connection.nodes.pop();
        if (mode === 'wrong-group' && groups.length === 1) connection.nodes[0].phaseGroup.id = 999;
        if (mode === 'missing-group' && groups.length === 1) connection.nodes[0].phaseGroup = null;
        // Each duplicate row still claims a group within its own requested
        // shard: membership alone must not hide a cross-shard ID collision.
        if (mode === 'duplicate' && groups.length === 2) connection.nodes[0].id = 1001;
        return connection;
      }) });
      await assert.rejects(downloadEvent(client, SLUG, { perPage: 2, setPaginationLimit: 2 }), { code });
    });
  }
});

test('missing or overlapping official phase groups cannot yield a completed large-event bundle', async t => {
  for (const mode of ['missing', 'empty', 'overlap']) {
    await t.test(mode, async t => {
      const cacheDir = await workspace(t);
      const data = fixture();
      if (mode === 'missing') data.phaseGroups.pop();
      if (mode === 'empty') data.phaseGroups = [];
      if (mode === 'overlap') data.event.phases.push({ ...data.event.phases[0], id: 21 });
      const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, []) });
      await assert.rejects(downloadEvent(client, SLUG, { perPage: 2, setPaginationLimit: 2 }), {
        code: mode === 'overlap' ? 'PAGINATION_DUPLICATE' : 'PAGINATION_INCOMPLETE',
      });
    });
  }
});

test('an oversized single phase group fails closed without fetching past its first page', async t => {
  const cacheDir = await workspace(t);
  const data = fixture();
  data.phaseGroups = [data.phaseGroups[0]];
  for (const row of data.sets) row.phaseGroup = data.phaseGroups[0];
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(data, calls) });
  await assert.rejects(downloadEvent(client, SLUG, { perPage: 2, setPaginationLimit: 2 }), { code: 'PAGINATION_LIMIT' });
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSetsByPhaseGroups').map(call => call.variables.page), [1]);
});

test('a set total exactly at the cap keeps ordinary pagination, and the internal cap cannot exceed the source limit', async t => {
  const cacheDir = await workspace(t);
  const calls = [];
  const client = clientAt(cacheDir, { fetchImpl: fixtureFetch(fixture(), calls) });
  const bundle = await downloadEvent(client, SLUG, { perPage: 2, setPaginationLimit: 3 });
  assert.ok(!bundle.provenance.setPagination);
  assert.deepEqual(calls.filter(call => call.operation === 'ForecastSets').map(call => call.variables.page), [1, 2]);
  assert.ok(!calls.some(call => call.operation === 'ForecastSetsByPhaseGroups'));
  for (const setPaginationLimit of [0, -1, 0.5, 10001, Infinity]) {
    await assert.rejects(downloadEvent(client, SLUG, { setPaginationLimit }), { code: 'CONFIG' });
  }
});
