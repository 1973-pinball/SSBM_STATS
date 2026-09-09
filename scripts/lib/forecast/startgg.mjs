/**
 * Local research ingestion only. No replay input, browser bundle, or cloud writes.
 * API contract checked against the official docs (2026-09-04):
 * https://developer.start.gg/docs/examples/queries/get-event/
 * https://developer.start.gg/docs/examples/queries/event-entrants/
 * https://developer.start.gg/docs/examples/queries/sets-in-event/
 * https://developer.start.gg/docs/examples/queries/set-score/
 * https://developer.start.gg/docs/examples/queries/event-standings/
 * https://developer.start.gg/docs/examples/queries/get-phase-seeding/
 * https://developer.start.gg/docs/examples/queries/phase-groups-in-phase/
 * https://developer.start.gg/docs/authentication/
 * https://developer.start.gg/docs/rate-limits/
 * https://developer.start.gg/reference/event.doc.html
 * https://developer.start.gg/reference/setslot.doc.html
 * https://smashgg-schema.netlify.app/reference/set.doc.html
 * https://smashgg-schema.netlify.app/reference/setfilters.doc.html
 *
 * The docs' /reference index currently returns 404, but individual type links
 * redirect to their generated schema on smashgg-schema.netlify.app. Optional
 * fields are also checked against authenticated, cached schema introspection.
 * Requests stay below the documented 80/minute and 1000-object query limits.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const STARTGG_ENDPOINT = 'https://api.start.gg/gql/alpha';
const CACHE_VERSION = 1;
const PAGE_SIZE = 25;
const SET_PAGINATION_LIMIT = 10000;
const PHASE_GROUP_SHARD_SIZE = 32;

export class StartggError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StartggError';
    this.code = code;
  }
}

const fail = (message, code = 'INVALID_RESPONSE') => { throw new StartggError(message, code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasId = value => isObject(value) && (typeof value.id === 'string' || Number.isSafeInteger(value.id));

function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  fail('Request variables must be plain JSON values.', 'INVALID_REQUEST');
}

function requestDescription(query, variables) {
  // Deliberately conservative: callers must send a named read-only query. Reject
  // write-operation tokens even inside strings; this API is not a general client.
  if (typeof query !== 'string' || !/^\s*query\s+[A-Za-z_][A-Za-z0-9_]*/.test(query)
      || /\b(?:mutation|subscription)\b/.test(query)) {
    fail('Only named read-only GraphQL queries are supported.', 'INVALID_REQUEST');
  }
  if (!isObject(variables)) fail('Request variables must be an object.', 'INVALID_REQUEST');
  const serialized = stableJson({ query, variables });
  return { key: hash(serialized), serialized, operation: query.match(/^\s*query\s+(\w+)/)[1] };
}

function assertCompleteResponse(response) {
  if (!isObject(response) || response.success === false
      || (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0))
      || !isObject(response.data)) {
    fail('Start.gg returned errors or an incomplete GraphQL response. Nothing from this response was cached.');
  }
}

function classifyFailure(response, status) {
  // Never include a server message, URL, request header, or native fetch error in
  // diagnostics: a proxy/server can reflect the Authorization header back to us.
  const message = isObject(response) ? String(response.message ?? '') : '';
  const errors = Array.isArray(response?.errors) ? response.errors : [];
  const messages = [message, ...errors.map(error => String(error?.message ?? ''))].join(' ');
  const codes = errors.map(error => error?.extensions?.code);
  if (status === 401 || status === 403 || /authenticat|invalid.*token|unauthorized|forbidden/i.test(messages)
      || codes.some(code => ['UNAUTHENTICATED', 'FORBIDDEN'].includes(code))) return 'AUTH';
  if (status === 429 || /rate.?limit|too many requests/i.test(messages)
      || codes.some(code => ['RATE_LIMITED', 'TOO_MANY_REQUESTS'].includes(code))) return 'RATE_LIMIT';
  if (status >= 500) return 'TRANSIENT';
  return null;
}

function retryDelay(header, attempt, now, limit) {
  let delay = Math.min(1000 * 2 ** attempt, 30000);
  if (header) {
    const seconds = Number(header);
    const explicit = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(explicit)) delay = Math.max(delay, explicit);
  }
  // Do not clamp Retry-After and retry earlier than the service asked. Stop and
  // let the operator resume if its requested wait exceeds our bounded run budget.
  if (delay > limit) fail('Start.gg requested a long rate-limit pause. Resume the download later.', 'RATE_LIMIT');
  return Math.max(0, delay);
}

/**
 * Successful request envelopes are content checked and atomically written.
 * Cached hits work without a token, including in offline mode. Refresh is an
 * explicit source re-fetch; the caller should use a new output snapshot for it.
 * Timing/fetch hooks exist for deterministic tests, not CLI tuning.
 */
export function createStartggClient({
  token, cacheDir, offline = false, refresh = false, fetchImpl = globalThis.fetch,
  minIntervalMs = 1100, timeoutMs = 30000, maxRetries = 3,
  maxRetryAfterMs = 120000, sleepImpl = sleep, now = Date.now,
} = {}) {
  if (typeof cacheDir !== 'string' || cacheDir.trim() === '') fail('A local cache directory is required.', 'CONFIG');
  if (offline && refresh) fail('Offline and refresh cannot be combined.', 'CONFIG');
  if (token !== undefined && (typeof token !== 'string' || /[\r\n]/.test(token))) fail('Invalid Start.gg token configuration.', 'CONFIG');
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5
      || !Number.isFinite(maxRetryAfterMs) || maxRetryAfterMs < 0) fail('Invalid request timing configuration.', 'CONFIG');
  const credential = token?.trim();
  const directory = resolve(cacheDir);
  const provenance = new Map();
  let lastStarted = -Infinity;
  let queue = Promise.resolve();

  const containsCredential = text => credential && (text.includes(credential) || text.includes(JSON.stringify(credential).slice(1, -1)));
  const describe = (query, variables) => {
    const description = requestDescription(query, variables);
    if (containsCredential(description.serialized)) fail('Credentials must not be included in query text or variables.', 'INVALID_REQUEST');
    return description;
  };
  const remember = (description, envelope) => {
    const record = {
      source: 'start.gg', requestHash: description.key, operation: description.operation,
      fetchedAt: envelope.fetchedAt, responseHash: envelope.responseHash,
    };
    provenance.set(description.key, record);
    return structuredClone(envelope.response.data);
  };

  async function runRequest(query, variables) {
    const description = describe(query, variables);
    const file = resolve(directory, `${description.key}.json`);
    if (!refresh) {
      let cached;
      try { cached = await readFile(file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') fail('Unable to read local Start.gg cache.', 'CACHE_READ'); }
      if (cached !== undefined) {
        let envelope;
        try { envelope = JSON.parse(cached); }
        catch { fail('Invalid local Start.gg cache JSON. Use --refresh to replace it.', 'CACHE_INVALID'); }
        if (containsCredential(cached) || envelope?.schemaVersion !== CACHE_VERSION
            || envelope.source !== 'start.gg' || envelope.endpoint !== STARTGG_ENDPOINT
            || envelope.requestHash !== description.key || stableJson(envelope.request) !== description.serialized
            || typeof envelope.fetchedAt !== 'string' || !Number.isFinite(Date.parse(envelope.fetchedAt))
            || !isObject(envelope.response) || envelope.responseHash !== hash(stableJson(envelope.response))) {
          fail('Invalid local Start.gg cache envelope. Use --refresh to replace it.', 'CACHE_INVALID');
        }
        assertCompleteResponse(envelope.response);
        return remember(description, envelope);
      }
    }
    if (offline) fail(`Offline cache miss for ${description.operation} (${description.key.slice(0, 12)}).`, 'OFFLINE_MISS');
    if (!credential) fail('A local STARTGG_TOKEN is required for uncached requests.', 'AUTH');

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const pacing = Math.max(0, lastStarted + minIntervalMs - now());
      if (pacing > 0) await sleepImpl(pacing);
      lastStarted = now();
      const controller = new AbortController();
      let timer;
      let reply;
      let response;
      try {
        // The timeout covers both the fetch and body read, even if a test/custom
        // fetch implementation ignores AbortSignal.
        ({ reply, response } = await Promise.race([
          (async () => {
            const result = await fetchImpl(STARTGG_ENDPOINT, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
              body: description.serialized,
            });
            let parsed;
            try { parsed = await result.json(); } catch { parsed = null; }
            return { reply: result, response: parsed };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
          }),
        ]));
      } catch {
        if (attempt === maxRetries) fail('Start.gg request failed or timed out. Retry later.', 'NETWORK');
        await sleepImpl(retryDelay(null, attempt, now(), maxRetryAfterMs));
        continue;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      const failure = classifyFailure(response, reply.status);
      if (failure === 'AUTH') fail('Start.gg rejected authentication. Check the local token and its expiry.', 'AUTH');
      if (failure === 'RATE_LIMIT' || failure === 'TRANSIENT') {
        if (attempt === maxRetries) fail('Start.gg remained unavailable after bounded retries. Resume later.', failure);
        await sleepImpl(retryDelay(reply.headers?.get('retry-after'), attempt, now(), maxRetryAfterMs));
        continue;
      }
      if (!reply.ok) fail(`Start.gg HTTP request failed (${Number(reply.status)}).`, 'HTTP');
      assertCompleteResponse(response);
      // Only successful GraphQL data is persisted; no headers/error payloads.
      const cachedResponse = { data: response.data };
      const serializedResponse = stableJson(cachedResponse);
      if (containsCredential(serializedResponse)) fail('The source response unexpectedly contains a credential; it was not cached.', 'CREDENTIAL_REFLECTION');
      const envelope = {
        schemaVersion: CACHE_VERSION, source: 'start.gg', endpoint: STARTGG_ENDPOINT,
        requestHash: description.key, request: { query, variables },
        fetchedAt: new Date(now()).toISOString(),
        responseHash: hash(serializedResponse), response: cachedResponse,
      };
      const temporary = resolve(directory, `.${description.key}.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch {
        await unlink(temporary).catch(() => {});
        fail('Unable to save the local Start.gg cache; download stopped.', 'CACHE_WRITE');
      }
      return remember(description, envelope);
    }
    fail('Start.gg retry budget exhausted.', 'NETWORK');
  }

  return {
    request(query, variables = {}) {
      // Serialize every request on this client, including concurrent callers, so
      // the rate limit applies across pagination branches and retry attempts.
      const result = queue.then(() => runRequest(query, structuredClone(variables)));
      queue = result.catch(() => {});
      return result;
    },
    getRequestProvenance(query, variables = {}) {
      return structuredClone(provenance.get(describe(query, variables).key) ?? null);
    },
  };
}

// entrantSizeMin is deprecated but still documented and useful as a fallback
// when a historical event has null teamRosterSize.
const TYPE_FIELDS = 'fields(includeDeprecated: true) { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }';
const SCHEMA_QUERY = `query ForecastSchema($name: String!) { type: __type(name: $name) { name ${TYPE_FIELDS} } }`;

function namedType(type) {
  while (type?.ofType) type = type.ofType;
  return type;
}

function fieldsOf(data, type) {
  if (!Array.isArray(data?.type?.fields)) fail(`Start.gg does not expose the required ${type} schema.`, 'SCHEMA');
  return new Map(data.type.fields.map(field => [field.name, namedType(field.type)]));
}

function requiredFields(fields, names, type) {
  for (const name of names) if (!fields.has(name)) fail(`Start.gg ${type} schema is missing required field ${name}.`, 'SCHEMA');
}

function scalars(fields, names) {
  return names.filter(name => ['SCALAR', 'ENUM'].includes(fields.get(name)?.kind)).join('\n');
}

function validateSlug(eventSlug) {
  if (typeof eventSlug !== 'string' || !/^tournament\/[^/?#\s]+\/event\/[^/?#\s]+$/.test(eventSlug)) {
    fail('Use an event slug of the form tournament/<name>/event/<name>.', 'INVALID_REQUEST');
  }
}

async function eventMetadata(request, eventSlug) {
  validateSlug(eventSlug);
  const schema = async type => fieldsOf(await request(SCHEMA_QUERY, { name: type }), type);
  const eventFields = await schema('Event');
  const phaseFields = await schema('Phase');
  requiredFields(eventFields, ['id', 'slug', 'name', 'startAt', 'tournament', 'videogame', 'phases', 'entrantSizeMin'], 'Event');
  const phaseSelection = `id name ${scalars(phaseFields, ['phaseOrder', 'bracketType', 'state', 'numSeeds'])}`;
  let rosterSelection = scalars(eventFields, ['teamRosterSize']);
  if (eventFields.get('teamRosterSize')?.kind === 'OBJECT') {
    const roster = await schema(eventFields.get('teamRosterSize').name);
    const selection = scalars(roster, ['minPlayers', 'maxPlayers']);
    if (selection) rosterSelection = `teamRosterSize { ${selection} }`;
  }
  const query = `query ForecastEvent($slug: String!) {
    event(slug: $slug) {
      id slug name startAt entrantSizeMin ${scalars(eventFields, ['numEntrants', 'isOnline', 'type', 'state'])}
      ${rosterSelection}
      tournament { id slug name startAt endAt isOnline }
      videogame { id name }
      phases { ${phaseSelection} }
    }
  }`;
  const { event } = await request(query, { slug: eventSlug });
  if (!hasId(event) || event.slug !== eventSlug || !hasId(event.tournament) || !hasId(event.videogame)
      || !Array.isArray(event.phases) || event.phases.some(phase => !hasId(phase))) fail('Event metadata is incomplete or the slug did not resolve.');
  if (new Set(event.phases.map(phase => String(phase.id))).size !== event.phases.length) fail('Event has duplicate phase IDs.');
  return event;
}

/** Resolve an explicitly supplied mapping without downloading the full event. */
export async function fetchEventMetadata(client, eventSlug) {
  return eventMetadata((query, variables) => client.request(query, variables), eventSlug);
}

async function paginate(request, query, variables, parent, field, {
  perPage = PAGE_SIZE, maxPages = 10000, onProgress,
  maxTotal = Infinity, onOversized, validateRow,
} = {}) {
  const rows = [];
  const ids = new Set();
  let expectedTotal;
  let expectedPages;
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await request(query, { ...variables, page, perPage });
    const entity = data[parent];
    const connection = entity?.[field];
    if (!hasId(entity) || String(entity.id) !== String(variables[`${parent}Id`])
        || !isObject(connection) || !Array.isArray(connection.nodes)) fail(`Incomplete ${field} response.`);
    const { total, totalPages } = connection.pageInfo ?? {};
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(totalPages) || totalPages < 0
        || (total > 0 && totalPages !== Math.ceil(total / perPage))
        || (total === 0 && totalPages > 1)) fail(`Invalid ${field} pagination metadata.`);
    if (page === 1) { expectedTotal = total; expectedPages = totalPages; }
    if (total !== expectedTotal || totalPages !== expectedPages) fail(`The ${field} collection changed during pagination. Refresh and retry.`, 'PAGINATION_CHANGED');
    const expectedLength = Math.min(perPage, Math.max(0, total - (page - 1) * perPage));
    if (connection.nodes.length !== expectedLength) fail(`Incomplete ${field} page; refusing a truncated dataset.`, 'PAGINATION_INCOMPLETE');
    for (const row of connection.nodes) {
      if (!hasId(row)) fail(`A ${field} record has no source ID.`);
      const id = String(row.id);
      if (ids.has(id)) {
        // Before an event begins, Start.gg synthesizes `preview_` bracket rows.
        // STANDARD ordering is not stable across page boundaries when many of
        // those rows share the same display key. A real duplicated source ID
        // still fails closed; callers may replace only this preview collection
        // with disjoint one-phase-group shards.
        const code = field === 'sets' && id.startsWith('preview_')
          ? 'PAGINATION_PREVIEW_ORDER' : 'PAGINATION_DUPLICATE';
        fail(`Repeated source ID while paginating ${field}; refresh and retry.`, code);
      }
      validateRow?.(row);
      ids.add(id);
      rows.push(row);
    }
    onProgress?.({ collection: field, parent, parentId: String(entity.id), page, totalPages, rows: rows.length, total });
    // Inspect only a validated first page before switching strategy. Its rows
    // are deliberately not combined with the replacement shard collection.
    if (page === 1 && total > maxTotal) {
      if (!onOversized) fail(`The ${field} collection exceeds the source pagination limit.`, 'PAGINATION_LIMIT');
      return onOversized(total);
    }
    if (page >= totalPages) {
      if (rows.length !== total) fail(`Incomplete ${field} dataset.`, 'PAGINATION_INCOMPLETE');
      return rows;
    }
  }
  fail(`The ${field} collection exceeds the pagination safety limit; no partial bundle was returned.`, 'PAGINATION_LIMIT');
}

/**
 * The source caps one set connection at 10,000 rows. Partition an oversized
 * event by its complete official phase-group list; groups are disjoint, and
 * every leaf is fetched in full. No ordinary-event or oversized-shard prefix is
 * reused. SetFilters.phaseGroupIds ([ID]) was source-schema-verified 2026-09-04.
 */
async function paginateSetShards(request, query, eventId, phaseGroups, expectedTotal, pageOptions, limit,
  initialShardGroupLimit = PHASE_GROUP_SHARD_SIZE) {
  const groupIds = phaseGroups.map(group => String(group.id)).sort();
  if (!groupIds.length) fail('An oversized event has no official phase groups; refusing an incomplete set collection.', 'PAGINATION_INCOMPLETE');
  if (new Set(groupIds).size !== groupIds.length) fail('Repeated official phase-group ID across phases; refusing overlapping set shards.', 'PAGINATION_DUPLICATE');
  const leaves = [];
  async function fetchShard(ids) {
    const allowedGroups = new Set(ids);
    let split = false;
    const rows = await paginate(request, query, { eventId, phaseGroupIds: ids }, 'event', 'sets', {
      ...pageOptions,
      maxTotal: limit,
      validateRow: row => {
        if (!hasId(row.phaseGroup) || !allowedGroups.has(String(row.phaseGroup.id))) {
          fail('A set lies outside its requested official phase-group shard; refusing the collection.', 'PAGINATION_MEMBERSHIP');
        }
      },
      onProgress: progress => pageOptions.onProgress?.({ ...progress, phaseGroupIds: [...ids], shardGroupCount: ids.length }),
      onOversized: async total => {
        if (ids.length === 1) fail('A single phase group exceeds the source set pagination limit; no partial event was returned.', 'PAGINATION_LIMIT');
        split = true;
        const middle = Math.floor(ids.length / 2);
        const left = await fetchShard(ids.slice(0, middle));
        const right = await fetchShard(ids.slice(middle));
        if (left.length + right.length !== total) {
          fail('Set shard totals changed during partitioning; refresh and retry.', 'PAGINATION_CHANGED');
        }
        return [...left, ...right];
      },
    });
    if (!split) leaves.push({ phaseGroupIds: [...ids], total: rows.length });
    return rows;
  }
  const sets = [];
  const seen = new Set();
  for (let offset = 0; offset < groupIds.length; offset += initialShardGroupLimit) {
    const rows = await fetchShard(groupIds.slice(offset, offset + initialShardGroupLimit));
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) fail('Repeated set ID across phase-group shards; refusing an overlapping event collection.', 'PAGINATION_DUPLICATE');
      seen.add(id);
      sets.push(row);
    }
  }
  if (sets.length !== expectedTotal) {
    fail('Phase-group set union does not equal the original event total; refresh and retry.', 'PAGINATION_INCOMPLETE');
  }
  return { sets, leaves };
}

/**
 * Download the whole event, including unfinished sets needed for a future
 * bracket simulator. Normalization, not acquisition, excludes these from fit.
 * A bundle is returned only after every connection has been exhausted.
 */
export async function downloadEvent(client, eventSlug, {
  perPage = PAGE_SIZE, maxPages = 10000, onProgress,
  // Internal fixture hook only; the CLI cannot raise or change the source cap.
  setPaginationLimit = SET_PAGINATION_LIMIT,
} = {}) {
  validateSlug(eventSlug);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > PAGE_SIZE
      || !Number.isInteger(maxPages) || maxPages < 1
      || !Number.isSafeInteger(setPaginationLimit) || setPaginationLimit < 1
      || setPaginationLimit > SET_PAGINATION_LIMIT) fail('Invalid pagination configuration.', 'CONFIG');
  const requests = [];
  const request = async (query, variables = {}) => {
    const data = await client.request(query, variables);
    const metadata = client.getRequestProvenance(query, variables);
    if (!metadata) fail('Missing source request provenance.', 'PROVENANCE');
    requests.push(metadata);
    return data;
  };
  const schema = async type => fieldsOf(await request(SCHEMA_QUERY, { name: type }), type);
  // Separate small introspection requests avoid the API's nested-object limit.
  const event = await eventMetadata(request, eventSlug);
  const setFields = await schema('Set');
  const groupFields = await schema('PhaseGroup');
  const seedFields = await schema('Seed');
  requiredFields(setFields, ['id', 'state', 'round', 'fullRoundText', 'winnerId', 'slots', 'phaseGroup'], 'Set');
  const slotType = setFields.get('slots')?.name;
  if (!slotType) fail('Start.gg Set slots schema is incomplete.', 'SCHEMA');
  const slotFields = await schema(slotType);
  const groupSelection = `id displayIdentifier ${scalars(groupFields, ['bracketType', 'state', 'startAt', 'numRounds', 'firstRoundTime', 'groupTypeId'])}`;

  const entrantsQuery = `query ForecastEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id entrants(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages }
      nodes { id name participants { id gamerTag player { id } } }
    } }
  }`;
  const setsQuery = `query ForecastSets($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id sets(page: $page perPage: $perPage sortType: STANDARD filters: { showByes: true hideEmpty: false }) {
      pageInfo { total totalPages }
      nodes {
        id state round fullRoundText winnerId
        ${scalars(setFields, ['startAt', 'startedAt', 'completedAt', 'createdAt', 'updatedAt', 'displayScore', 'identifier', 'lPlacement', 'wPlacement'])}
        ${setFields.has('winnerProgressionSeed') ? 'winnerProgressionSeed { id }' : ''}
        ${setFields.has('loserProgressionSeed') ? 'loserProgressionSeed { id }' : ''}
        phaseGroup { ${groupSelection} }
        slots(includeByes: true) {
          id ${scalars(slotFields, ['slotIndex', 'prereqId', 'prereqType', 'prereqPlacement', 'prereqCondition'])}
          entrant { id name }
          ${slotFields.has('seed') ? 'seed { id seedNum }' : ''}
          standing { id placement stats { score { label value } } }
        }
      }
    } }
  }`;
  // Derive only the name/argument/filter differences, retaining the exact same
  // node selection and keeping the existing small-event query bytes unchanged.
  const shardSetsQuery = setsQuery
    .replace('query ForecastSets($eventId: ID!,', 'query ForecastSetsByPhaseGroups($eventId: ID!, $phaseGroupIds: [ID]!,')
    .replace('hideEmpty: false }', 'hideEmpty: false phaseGroupIds: $phaseGroupIds }');
  const standingsQuery = `query ForecastStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id standings(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages }
      nodes { id placement entrant { id name } }
    } }
  }`;
  const seedsQuery = `query ForecastPhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) { id seeds(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages }
      nodes { id seedNum ${scalars(seedFields, ['groupSeedNum', 'isBye', 'progressionSeedId', 'updatedAt'])}
        entrant { id } ${seedFields.has('phaseGroup') ? 'phaseGroup { id displayIdentifier }' : ''} }
    } }
  }`;
  const groupsQuery = `query ForecastPhaseGroups($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) { id phaseGroups(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages }
      nodes { ${groupSelection} }
    } }
  }`;
  const pageOptions = { perPage, maxPages, onProgress };
  const eventVariables = { eventId: event.id };
  const entrants = await paginate(request, entrantsQuery, eventVariables, 'event', 'entrants', pageOptions);
  const earlyPhaseGroups = new Map();
  const officialPhaseGroups = async () => {
    const groups = [];
    for (const phase of event.phases) {
      const phaseId = String(phase.id);
      const rows = earlyPhaseGroups.has(phaseId) ? earlyPhaseGroups.get(phaseId)
        : await paginate(request, groupsQuery, { phaseId: phase.id }, 'phase', 'phaseGroups', pageOptions);
      earlyPhaseGroups.set(phaseId, rows);
      groups.push(...rows);
    }
    return groups;
  };
  let setPagination;
  let observedSetTotal;
  let sets;
  try {
    sets = await paginate(request, setsQuery, eventVariables, 'event', 'sets', {
      ...pageOptions,
      onProgress: progress => {
        if (progress.page === 1) observedSetTotal = progress.total;
        onProgress?.(progress);
      },
      maxTotal: setPaginationLimit,
      onOversized: async total => {
        const result = await paginateSetShards(request, shardSetsQuery, event.id,
          await officialPhaseGroups(), total, pageOptions, setPaginationLimit);
        setPagination = {
          strategy: 'phase-group-shards-v1', eventTotal: total,
          connectionRowLimit: setPaginationLimit, initialShardGroupLimit: PHASE_GROUP_SHARD_SIZE,
          shards: result.leaves,
        };
        return result.sets;
      },
    });
  } catch (error) {
    if (error?.code !== 'PAGINATION_PREVIEW_ORDER' || !Number.isSafeInteger(observedSetTotal)) throw error;
    const initialShardGroupLimit = 1;
    const result = await paginateSetShards(request, shardSetsQuery, event.id,
      await officialPhaseGroups(), observedSetTotal, pageOptions, setPaginationLimit, initialShardGroupLimit);
    setPagination = {
      strategy: 'phase-group-shards-preview-order-v1', eventTotal: observedSetTotal,
      connectionRowLimit: setPaginationLimit, initialShardGroupLimit,
      reason: 'unstable event-wide ordering of synthetic preview set IDs',
      shards: result.leaves,
    };
    sets = result.sets;
  }
  const standings = await paginate(request, standingsQuery, eventVariables, 'event', 'standings', pageOptions);
  const seeds = [];
  const phaseGroups = [];
  for (const phase of event.phases) {
    const variables = { phaseId: phase.id };
    const phaseSeeds = await paginate(request, seedsQuery, variables, 'phase', 'seeds', pageOptions);
    const groups = earlyPhaseGroups.has(String(phase.id)) ? earlyPhaseGroups.get(String(phase.id))
      : await paginate(request, groupsQuery, variables, 'phase', 'phaseGroups', pageOptions);
    seeds.push(...phaseSeeds.map(seed => ({ ...seed, phase: { ...phase } })));
    phaseGroups.push(...groups.map(group => ({ ...group, phase: { ...phase } })));
  }
  // Cache-derived timestamps, not the current clock, make offline reruns identical.
  const fetchedAt = requests.map(item => item.fetchedAt).sort().at(-1);
  return {
    schemaVersion: 1, event, entrants, sets, standings, seeds, phaseGroups,
    provenance: {
      source: 'start.gg', fetchedAt, requests,
      ...(setPagination ? { setPagination } : {}),
      availableOptionalFields: {
        setTimestamps: ['startAt', 'startedAt', 'completedAt', 'createdAt', 'updatedAt'].filter(name => setFields.has(name)),
        slotPrerequisites: ['prereqId', 'prereqType', 'prereqPlacement', 'prereqCondition'].filter(name => slotFields.has(name)),
        progressionSeeds: ['winnerProgressionSeed', 'loserProgressionSeed'].filter(name => setFields.has(name)),
        phaseGroupMetadata: ['bracketType', 'state', 'startAt', 'numRounds', 'firstRoundTime', 'groupTypeId'].filter(name => groupFields.has(name)),
        teamRosterSize: Object.hasOwn(event, 'teamRosterSize'),
      },
    },
  };
}
