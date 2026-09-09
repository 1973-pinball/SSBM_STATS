import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { attachMajor, normalizeEventSlug } from "./registry.mjs";
import { digest } from "./local.mjs";

const COLLECTIONS = ["entrants", "sets", "seeds", "standings", "phaseGroups"];
const STARTGG_ENDPOINT = "https://api.start.gg/gql/alpha";
const PAGINATION_OPERATIONS = Object.freeze({
  ForecastEntrants: { parent: "event", field: "entrants", parentVariable: "eventId" },
  ForecastSets: { parent: "event", field: "sets", parentVariable: "eventId" },
  ForecastSetsByPhaseGroups: { parent: "event", field: "sets", parentVariable: "eventId", shard: true },
  ForecastStandings: { parent: "event", field: "standings", parentVariable: "eventId" },
  ForecastPhaseSeeds: { parent: "phase", field: "seeds", parentVariable: "phaseId" },
  ForecastPhaseGroups: { parent: "phase", field: "phaseGroups", parentVariable: "phaseId" },
});
const SET_PAGINATION_STRATEGIES = new Set([
  "phase-group-shards-v1",
  "phase-group-shards-preview-order-v1",
  "phase-group-shards-global-order-v1",
]);
const compare = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const byEvent = (a, b) => a.year - b.year || compare(a.name, b.name) || compare(a.id, b.id);
const unique = (values) => [...new Set(values)].sort(compare);
const validSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positiveId = (value) => /^[1-9]\d*$/.test(String(value ?? ""));
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plainObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Value is not stable JSON");
}

function containedBy(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inspectParent(root, rootReal, name) {
  const directory = path.join(root, name);
  const issues = [];
  let directoryReal = null;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) issues.push(`${name}_parent_symlink`);
    else if (!info.isDirectory()) issues.push(`${name}_parent_not_directory`);
    directoryReal = await realpath(directory);
    if (!containedBy(rootReal, directoryReal)) issues.push(`${name}_parent_outside_root`);
  } catch (error) {
    issues.push(error?.code === "ENOENT" ? `${name}_parent_missing` : `${name}_parent_unreadable`);
  }
  return { directory, directoryReal, issues };
}

async function sourceContext(root) {
  let rootReal;
  try { rootReal = await realpath(root); }
  catch { rootReal = path.resolve(root); }
  return {
    root: path.resolve(root),
    rootReal,
    raw: await inspectParent(root, rootReal, "raw"),
    cache: await inspectParent(root, rootReal, "cache"),
    receipts: new Map(),
  };
}

async function readContainedRegularFile(context, parent, basename) {
  if (parent.issues.length) return { issues: parent.issues };
  const file = path.join(parent.directory, basename);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return { issues: [`${path.basename(parent.directory)}_file_not_regular`] };
    const actual = await realpath(file);
    if (!containedBy(context.rootReal, actual) || !containedBy(parent.directoryReal, actual)) {
      return { issues: [`${path.basename(parent.directory)}_file_outside_root`] };
    }
    return { body: await readFile(actual, "utf8"), issues: [] };
  } catch (error) {
    const prefix = path.basename(parent.directory);
    return { issues: [error?.code === "ENOENT" ? `${prefix}_file_missing` : `${prefix}_file_unreadable`] };
  }
}

function countDuplicates(rows, field) {
  const counts = new Map();
  for (const row of rows) counts.set(String(row?.[field] ?? ""), (counts.get(String(row?.[field] ?? "")) ?? 0) + 1);
  return counts;
}

function sameJson(left, right) {
  try { return stableJson(left) === stableJson(right); }
  catch { return false; }
}

function operationFromQuery(query) {
  return typeof query === "string" ? query.match(/^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null : null;
}

function graphqlTokens(source) {
  if (typeof source !== "string") return null;
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^[\s,]+/);
    if (whitespace) { index += whitespace[0].length; continue; }
    if (rest[0] === "#") {
      const newline = rest.indexOf("\n");
      index += newline < 0 ? rest.length : newline;
      continue;
    }
    const name = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) { tokens.push(name[0]); index += name[0].length; continue; }
    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) { tokens.push(number[0]); index += number[0].length; continue; }
    if ("!$():=@[]{|}&".includes(rest[0])) { tokens.push(rest[0]); index += 1; continue; }
    return null;
  }
  return tokens;
}

function matchingBrace(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index] === "{") depth += 1;
    else if (tokens[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function fieldSelectionRange(tokens, name) {
  const ranges = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== name) continue;
    let selection = index + 1;
    if (tokens[selection] === "(") {
      let depth = 1;
      while (++selection < tokens.length && depth > 0) {
        if (tokens[selection] === "(") depth += 1;
        else if (tokens[selection] === ")") depth -= 1;
      }
    }
    if (tokens[selection] !== "{") continue;
    const end = matchingBrace(tokens, selection);
    if (end < 0) return null;
    ranges.push({ start: selection, end });
  }
  return ranges.length === 1 ? ranges[0] : null;
}

function selectionShell(query, field) {
  const tokens = graphqlTokens(query);
  if (!tokens) return null;
  const range = fieldSelectionRange(tokens, field);
  if (!range) return null;
  return [...tokens.slice(0, range.start + 1), "*", ...tokens.slice(range.end)].join(" ");
}

function parseSelection(tokens) {
  let position = 0;
  function parseFields() {
    if (tokens[position++] !== "{") return null;
    const fields = [];
    while (position < tokens.length && tokens[position] !== "}") {
      const name = tokens[position++];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "") || tokens[position] === ":") return null;
      let args = null;
      if (tokens[position] === "(") {
        const start = position;
        let depth = 0;
        do {
          if (tokens[position] === "(") depth += 1;
          else if (tokens[position] === ")") depth -= 1;
          position += 1;
        } while (position < tokens.length && depth > 0);
        if (depth !== 0) return null;
        args = tokens.slice(start, position).join(" ");
      }
      const selection = tokens[position] === "{" ? parseFields() : null;
      if (tokens[position] === "@" || tokens[position] === "...") return null;
      fields.push({ name, args, selection });
    }
    if (tokens[position++] !== "}") return null;
    return fields;
  }
  const fields = parseFields();
  return fields && position === tokens.length ? fields : null;
}

const scalarField = (required = false) => ({ required });
const objectField = (children, required = false, options = {}) => ({ children, required, ...options });

function matchesSelection(fields, specification) {
  if (!Array.isArray(fields)) return false;
  const byName = new Map();
  for (const field of fields) {
    if (byName.has(field.name) || !specification[field.name]) return false;
    byName.set(field.name, field);
  }
  for (const [name, expected] of Object.entries(specification)) {
    const field = byName.get(name);
    if (!field) {
      if (expected.required) return false;
      continue;
    }
    if ((field.args ?? null) !== (expected.args ?? null)) return false;
    if (expected.children) {
      if (field.selection == null) {
        if (!expected.allowScalar) return false;
      } else if (!matchesSelection(field.selection, expected.children)
          || expected.minChildren && field.selection.length < expected.minChildren) return false;
    } else if (field.selection != null) return false;
  }
  return true;
}

const ID_ONLY = Object.freeze({ id: scalarField(true) });
const NODE_SELECTIONS = {
  ForecastEntrants: {
    id: scalarField(true),
    name: scalarField(true),
    participants: objectField({
      id: scalarField(true),
      gamerTag: scalarField(true),
      player: objectField(ID_ONLY, true),
    }, true),
  },
  ForecastSets: {
    id: scalarField(true), state: scalarField(true), round: scalarField(true),
    fullRoundText: scalarField(true), winnerId: scalarField(true),
    startAt: scalarField(), startedAt: scalarField(), completedAt: scalarField(),
    createdAt: scalarField(), updatedAt: scalarField(), displayScore: scalarField(),
    identifier: scalarField(), lPlacement: scalarField(), wPlacement: scalarField(),
    winnerProgressionSeed: objectField(ID_ONLY), loserProgressionSeed: objectField(ID_ONLY),
    phaseGroup: objectField({
      id: scalarField(true), displayIdentifier: scalarField(true), bracketType: scalarField(),
      state: scalarField(), startAt: scalarField(), numRounds: scalarField(),
      firstRoundTime: scalarField(), groupTypeId: scalarField(),
    }, true),
    slots: objectField({
      id: scalarField(true), slotIndex: scalarField(), prereqId: scalarField(),
      prereqType: scalarField(), prereqPlacement: scalarField(), prereqCondition: scalarField(),
      entrant: objectField({ id: scalarField(true), name: scalarField(true) }, true),
      seed: objectField({ id: scalarField(true), seedNum: scalarField(true) }),
      standing: objectField({
        id: scalarField(true), placement: scalarField(true),
        stats: objectField({
          score: objectField({ label: scalarField(true), value: scalarField(true) }, true),
        }, true),
      }, true),
    }, true, { args: "( includeByes : true )" }),
  },
  ForecastStandings: {
    id: scalarField(true), placement: scalarField(true),
    entrant: objectField({ id: scalarField(true), name: scalarField(true) }, true),
  },
  ForecastPhaseSeeds: {
    id: scalarField(true), seedNum: scalarField(true), groupSeedNum: scalarField(),
    isBye: scalarField(), progressionSeedId: scalarField(), updatedAt: scalarField(),
    entrant: objectField(ID_ONLY, true),
    phaseGroup: objectField({ id: scalarField(true), displayIdentifier: scalarField(true) }),
  },
  ForecastPhaseGroups: {
    id: scalarField(true), displayIdentifier: scalarField(true), bracketType: scalarField(),
    state: scalarField(), startAt: scalarField(), numRounds: scalarField(),
    firstRoundTime: scalarField(), groupTypeId: scalarField(),
  },
};
NODE_SELECTIONS.ForecastSetsByPhaseGroups = NODE_SELECTIONS.ForecastSets;
Object.freeze(NODE_SELECTIONS);

const EVENT_SELECTION = Object.freeze({
  id: scalarField(true), slug: scalarField(true), name: scalarField(true), startAt: scalarField(true),
  entrantSizeMin: scalarField(true), numEntrants: scalarField(), isOnline: scalarField(),
  type: scalarField(), state: scalarField(),
  teamRosterSize: objectField({ minPlayers: scalarField(), maxPlayers: scalarField() }, false,
    { allowScalar: true, minChildren: 1 }),
  tournament: objectField({
    id: scalarField(true), slug: scalarField(true), name: scalarField(true), startAt: scalarField(true),
    endAt: scalarField(true), isOnline: scalarField(true),
  }, true),
  videogame: objectField({ id: scalarField(true), name: scalarField(true) }, true),
  phases: objectField({
    id: scalarField(true), name: scalarField(true), phaseOrder: scalarField(),
    bracketType: scalarField(), state: scalarField(), numSeeds: scalarField(),
  }, true),
});

function shellFromFixture(query, field) {
  const shell = selectionShell(query, field);
  if (!shell) throw new Error(`Invalid internal ${field} query contract`);
  return shell;
}

const PAGINATION_QUERY_SHELLS = Object.freeze({
  ForecastEntrants: shellFromFixture(`query ForecastEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id entrants(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages } nodes { id }
    } }
  }`, "nodes"),
  ForecastSets: shellFromFixture(`query ForecastSets($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id sets(page: $page perPage: $perPage sortType: STANDARD filters: { showByes: true hideEmpty: false }) {
      pageInfo { total totalPages } nodes { id }
    } }
  }`, "nodes"),
  ForecastSetsByPhaseGroups: shellFromFixture(`query ForecastSetsByPhaseGroups($eventId: ID!, $phaseGroupIds: [ID]!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id sets(page: $page perPage: $perPage sortType: STANDARD filters: { showByes: true hideEmpty: false phaseGroupIds: $phaseGroupIds }) {
      pageInfo { total totalPages } nodes { id }
    } }
  }`, "nodes"),
  ForecastStandings: shellFromFixture(`query ForecastStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) { id standings(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages } nodes { id }
    } }
  }`, "nodes"),
  ForecastPhaseSeeds: shellFromFixture(`query ForecastPhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) { id seeds(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages } nodes { id }
    } }
  }`, "nodes"),
  ForecastPhaseGroups: shellFromFixture(`query ForecastPhaseGroups($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) { id phaseGroups(query: { page: $page perPage: $perPage }) {
      pageInfo { total totalPages } nodes { id }
    } }
  }`, "nodes"),
});
const EVENT_QUERY_SHELL = shellFromFixture(
  "query ForecastEvent($slug: String!) { event(slug: $slug) { id } }", "event",
);
const SCHEMA_QUERY_TOKENS = graphqlTokens(`query ForecastSchema($name: String!) {
  type: __type(name: $name) {
    name fields(includeDeprecated: true) {
      name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
    }
  }
}`)?.join(" ");

/** A semantic allowlist for the downloader's read-only GraphQL operations. */
export function isVettedStartggReceiptQuery(query, expectedOperation = operationFromQuery(query)) {
  const tokens = graphqlTokens(query);
  if (!tokens || operationFromQuery(query) !== expectedOperation) return false;
  if (expectedOperation === "ForecastSchema") return tokens.join(" ") === SCHEMA_QUERY_TOKENS;
  const field = expectedOperation === "ForecastEvent" ? "event" : "nodes";
  const range = fieldSelectionRange(tokens, field);
  if (!range) return false;
  const shell = [...tokens.slice(0, range.start + 1), "*", ...tokens.slice(range.end)].join(" ");
  const selection = parseSelection(tokens.slice(range.start, range.end + 1));
  if (expectedOperation === "ForecastEvent") {
    return shell === EVENT_QUERY_SHELL && matchesSelection(selection, EVENT_SELECTION);
  }
  return shell === PAGINATION_QUERY_SHELLS[expectedOperation]
    && matchesSelection(selection, NODE_SELECTIONS[expectedOperation]);
}

async function cachedReceipt(context, requestHash) {
  if (context.receipts.has(requestHash)) return context.receipts.get(requestHash);
  const pending = (async () => {
    const source = await readContainedRegularFile(context, context.cache, `${requestHash}.json`);
    if (source.issues.length) return { issues: source.issues.map((issue) => `request_${issue}`) };
    let envelope;
    try { envelope = JSON.parse(source.body); }
    catch { return { issues: ["invalid_request_cache_json"] }; }
    const issues = [];
    const operation = operationFromQuery(envelope?.request?.query);
    let calculatedRequestHash = null;
    let calculatedResponseHash = null;
    try {
      calculatedRequestHash = digest(stableJson({ query: envelope?.request?.query, variables: envelope?.request?.variables }));
      calculatedResponseHash = digest(stableJson(envelope?.response));
    } catch {
      issues.push("invalid_request_cache_envelope");
    }
    if (envelope?.schemaVersion !== 1 || envelope?.source !== "start.gg" || envelope?.endpoint !== STARTGG_ENDPOINT
        || envelope?.requestHash !== requestHash || calculatedRequestHash !== requestHash
        || !validSha256(envelope?.responseHash) || envelope?.responseHash !== calculatedResponseHash
        || !Number.isFinite(Date.parse(envelope?.fetchedAt)) || !operation
        || !plainObject(envelope?.response) || !plainObject(envelope.response.data)
        || envelope.response.success === false
        || envelope.response.errors !== undefined && (!Array.isArray(envelope.response.errors) || envelope.response.errors.length > 0)) {
      issues.push("invalid_request_cache_envelope");
    }
    if (operation && !isVettedStartggReceiptQuery(envelope?.request?.query, operation)) {
      issues.push("invalid_request_query_contract");
    }
    return {
      issues: unique(issues),
      envelope,
      operation,
      variables: envelope?.request?.variables,
      data: envelope?.response?.data,
    };
  })();
  context.receipts.set(requestHash, pending);
  return pending;
}

function paginationReceipt(receipt) {
  const specification = PAGINATION_OPERATIONS[receipt.operation];
  if (!specification || !plainObject(receipt.variables)) return null;
  const { page, perPage } = receipt.variables;
  const requestedParentId = receipt.variables[specification.parentVariable];
  const entity = receipt.data?.[specification.parent];
  const connection = entity?.[specification.field];
  const { total, totalPages } = connection?.pageInfo ?? {};
  if (!positiveId(requestedParentId) || !Number.isSafeInteger(page) || page < 1
      || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 25
      || !plainObject(entity) || String(entity.id ?? "") !== String(requestedParentId)
      || !plainObject(connection) || !Array.isArray(connection.nodes)
      || connection.nodes.some((row) => !plainObject(row)
        || !(typeof row.id === "string" && row.id !== "") && !Number.isSafeInteger(row.id))
      || !Number.isSafeInteger(total) || total < 0
      || !Number.isSafeInteger(totalPages) || totalPages < 0
      || total > 0 && totalPages !== Math.ceil(total / perPage)
      || total === 0 && totalPages > 1) return null;
  if (page > Math.max(1, totalPages)) return null;
  const expectedLength = Math.min(perPage, Math.max(0, total - (page - 1) * perPage));
  if (connection.nodes.length !== expectedLength) return null;
  return {
    ...specification,
    operation: receipt.operation,
    requestedParentId: String(requestedParentId),
    page,
    perPage,
    total,
    totalPages,
    nodes: connection.nodes,
    phaseGroupIds: specification.shard ? receipt.variables.phaseGroupIds : null,
  };
}

function auditPageSeries(pages, {
  issue, issues, expectedParentId, expectedRows = null, expectedTotal = null, complete = true,
}) {
  if (!pages.length || pages.some((page) => page.requestedParentId !== String(expectedParentId))) {
    issues.push(issue);
    return false;
  }
  const first = pages[0];
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const pageNumbers = sorted.map((page) => page.page);
  const terminalPage = first.totalPages === 0 ? 1 : first.totalPages;
  const expectedPages = Array.from({ length: complete ? terminalPage : Math.max(...pageNumbers) }, (_, index) => index + 1);
  if (new Set(pageNumbers).size !== pageNumbers.length || !sameJson(pageNumbers, expectedPages)
      || !complete && Math.max(...pageNumbers) > terminalPage
      || sorted.some((page) => page.perPage !== first.perPage || page.total !== first.total
        || page.totalPages !== first.totalPages)
      || expectedTotal != null && first.total !== expectedTotal) {
    issues.push(issue);
    return false;
  }
  if (complete) {
    const rows = sorted.flatMap((page) => page.nodes);
    if (rows.length !== first.total || expectedRows != null && !sameJson(rows, expectedRows)) {
      issues.push(issue);
      return false;
    }
  }
  return true;
}

function stripPhase(row) {
  if (!plainObject(row)) return row;
  const { phase: _phase, ...source } = row;
  return source;
}

function auditOrdinaryCollection(pages, bundle, operation, expectedRows, issues) {
  auditPageSeries(pages.filter((page) => page.operation === operation), {
    issue: `invalid_${PAGINATION_OPERATIONS[operation].field}_pagination_receipts`,
    issues,
    expectedParentId: bundle.event.id,
    expectedRows,
    expectedTotal: expectedRows.length,
  });
}

function phaseRows(bundle, field, phaseId) {
  return bundle[field]
    .filter((row) => String(row?.phase?.id ?? "") === String(phaseId))
    .map(stripPhase);
}

function auditPhaseCollections(pages, bundle, operation, issues) {
  const { field } = PAGINATION_OPERATIONS[operation];
  const operationPages = pages.filter((page) => page.operation === operation);
  const phaseIds = bundle.event.phases.map((phase) => String(phase?.id ?? ""));
  const phasesById = new Map(bundle.event.phases.map((phase) => [String(phase?.id ?? ""), phase]));
  if (phaseIds.some((id) => !positiveId(id)) || new Set(phaseIds).size !== phaseIds.length
      || operationPages.some((page) => !phaseIds.includes(page.requestedParentId))
      || bundle[field].some((row) => !sameJson(row?.phase, phasesById.get(String(row?.phase?.id ?? ""))))) {
    issues.push(`invalid_${field}_pagination_receipts`);
    return;
  }
  for (const phaseId of phaseIds) {
    const expectedRows = phaseRows(bundle, field, phaseId);
    auditPageSeries(operationPages.filter((page) => page.requestedParentId === phaseId), {
      issue: `invalid_${field}_pagination_receipts`,
      issues,
      expectedParentId: phaseId,
      expectedRows,
      expectedTotal: expectedRows.length,
    });
  }
}

function normalizedGroupIds(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.map(String);
  if (ids.some((id) => !positiveId(id)) || new Set(ids).size !== ids.length) return null;
  return [...ids].sort(compare);
}

const groupKey = (ids) => ids.join(",");

function auditSets(pages, bundle, issues) {
  const ordinary = pages.filter((page) => page.operation === "ForecastSets");
  const sharded = pages.filter((page) => page.operation === "ForecastSetsByPhaseGroups");
  const pagination = bundle.provenance?.setPagination;
  if (pagination == null) {
    if (sharded.length) issues.push("unexpected_set_shard_receipts");
    auditPageSeries(ordinary, {
      issue: "invalid_sets_pagination_receipts",
      issues,
      expectedParentId: bundle.event.id,
      expectedRows: bundle.sets,
      expectedTotal: bundle.sets.length,
    });
    return;
  }
  const limit = pagination.connectionRowLimit;
  if (!SET_PAGINATION_STRATEGIES.has(pagination.strategy)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000
      || !Number.isSafeInteger(pagination.initialShardGroupLimit) || pagination.initialShardGroupLimit < 1
      || !Array.isArray(pagination.shards) || pagination.shards.length === 0) {
    issues.push("invalid_set_pagination_provenance");
    return;
  }
  const ordinaryValid = auditPageSeries(ordinary, {
    issue: "invalid_sets_fallback_receipts",
    issues,
    expectedParentId: bundle.event.id,
    expectedTotal: pagination.eventTotal,
    complete: false,
  });
  if (ordinaryValid) {
    const total = ordinary[0].total;
    const oversized = pagination.strategy === "phase-group-shards-v1";
    if (oversized ? total <= limit : total > limit) issues.push("invalid_sets_fallback_receipts");
    if (oversized) {
      if (ordinary.length !== 1 || ordinary[0].page !== 1) issues.push("invalid_sets_fallback_receipts");
    } else {
      const seen = new Set();
      let firstRepeated = null;
      for (const page of [...ordinary].sort((a, b) => a.page - b.page)) {
        for (const row of page.nodes) {
          const id = String(row.id);
          if (seen.has(id) && firstRepeated == null) firstRepeated = { id, page: page.page };
          seen.add(id);
        }
      }
      const validTrigger = pagination.strategy === "phase-group-shards-preview-order-v1"
        ? firstRepeated?.id.startsWith("preview_")
        : firstRepeated != null && !firstRepeated.id.startsWith("preview_");
      const lastPage = Math.max(...ordinary.map((page) => page.page));
      if (!validTrigger || firstRepeated.page <= 1 || firstRepeated.page !== lastPage) {
        issues.push("invalid_sets_fallback_receipts");
      }
    }
  }

  const leaves = [];
  const coveredGroupIds = new Set();
  const leafKeys = new Set();
  for (const shard of pagination.shards) {
    const ids = normalizedGroupIds(shard?.phaseGroupIds);
    const key = ids && groupKey(ids);
    if (!ids || leafKeys.has(key) || !Number.isSafeInteger(shard?.total) || shard.total < 0
        || ids.some((id) => coveredGroupIds.has(id))) {
      issues.push("invalid_set_pagination_provenance");
      continue;
    }
    ids.forEach((id) => coveredGroupIds.add(id));
    leafKeys.add(key);
    leaves.push({ ids, key, total: shard.total });
  }
  const officialGroupIds = bundle.phaseGroups.map((group) => String(group?.id ?? "")).sort(compare);
  if (!sameJson([...coveredGroupIds].sort(compare), officialGroupIds)) issues.push("invalid_set_pagination_provenance");

  const pagesByGroup = new Map();
  for (const page of sharded) {
    const ids = normalizedGroupIds(page.phaseGroupIds);
    if (!ids) {
      issues.push("invalid_set_shard_receipts");
      continue;
    }
    const key = groupKey(ids);
    if (!pagesByGroup.has(key)) pagesByGroup.set(key, { ids, pages: [] });
    pagesByGroup.get(key).pages.push(page);
  }
  for (const leaf of leaves) {
    const expectedRows = bundle.sets.filter((set) => leaf.ids.includes(String(set?.phaseGroup?.id ?? "")));
    if (expectedRows.length !== leaf.total) issues.push("invalid_set_pagination_provenance");
    auditPageSeries(pagesByGroup.get(leaf.key)?.pages ?? [], {
      issue: "invalid_set_shard_receipts",
      issues,
      expectedParentId: bundle.event.id,
      expectedRows,
      expectedTotal: leaf.total,
    });
  }
  for (const [key, parent] of pagesByGroup) {
    if (leafKeys.has(key)) continue;
    const descendantIds = leaves.filter((leaf) => leaf.ids.every((id) => parent.ids.includes(id)))
      .flatMap((leaf) => leaf.ids).sort(compare);
    const validParent = sameJson(descendantIds, parent.ids) && descendantIds.length > 0
      && auditPageSeries(parent.pages, {
        issue: "invalid_set_shard_receipts",
        issues,
        expectedParentId: bundle.event.id,
        complete: false,
      });
    if (!validParent || parent.pages.length !== 1 || parent.pages[0]?.page !== 1
        || parent.pages[0]?.total <= limit) issues.push("invalid_set_shard_receipts");
  }
}

async function verifyRequestReceipts(context, bundle, issues) {
  const requests = bundle.provenance?.requests;
  if (!Array.isArray(requests) || requests.length === 0) return;
  if (new Set(requests.map((request) => request?.requestHash)).size !== requests.length) {
    issues.push("duplicate_request_provenance");
  }
  const receipts = [];
  for (const request of requests) {
    if (!validSha256(request?.requestHash)) continue;
    const receipt = await cachedReceipt(context, request.requestHash);
    if (receipt.issues.length) {
      issues.push(...receipt.issues);
      continue;
    }
    if (request.source !== "start.gg" || request.operation !== receipt.operation
        || request.responseHash !== receipt.envelope.responseHash
        || request.fetchedAt !== receipt.envelope.fetchedAt) {
      issues.push("request_provenance_receipt_mismatch");
      continue;
    }
    if (PAGINATION_OPERATIONS[receipt.operation]) {
      const page = paginationReceipt(receipt);
      if (!page) issues.push("invalid_pagination_receipt");
      else receipts.push(page);
    } else if (receipt.operation === "ForecastEvent") {
      if (receipt.variables?.slug !== bundle.event.slug || !sameJson(receipt.data?.event, bundle.event)) {
        issues.push("event_metadata_receipt_mismatch");
      }
      receipts.push({ operation: receipt.operation });
    } else if (receipt.operation === "ForecastSchema") {
      if (typeof receipt.variables?.name !== "string" || receipt.data?.type?.name !== receipt.variables.name) {
        issues.push("schema_receipt_mismatch");
      }
    } else issues.push("unexpected_request_operation");
  }
  if (receipts.filter((receipt) => receipt.operation === "ForecastEvent").length !== 1) {
    issues.push("invalid_event_metadata_receipts");
  }
  const pages = receipts.filter((receipt) => PAGINATION_OPERATIONS[receipt.operation]);
  auditOrdinaryCollection(pages, bundle, "ForecastEntrants", bundle.entrants, issues);
  auditSets(pages, bundle, issues);
  auditOrdinaryCollection(pages, bundle, "ForecastStandings", bundle.standings, issues);
  auditPhaseCollections(pages, bundle, "ForecastPhaseSeeds", issues);
  auditPhaseCollections(pages, bundle, "ForecastPhaseGroups", issues);
}

function verifyCollectionIds(bundle, issues) {
  for (const name of COLLECTIONS) {
    if (!Array.isArray(bundle?.[name])) {
      issues.push(`missing_${name}_array`);
      continue;
    }
    const ids = bundle[name].map((row) => String(row?.id ?? ""));
    if (ids.some((id) => !positiveId(id))) issues.push(`invalid_${name}_id`);
    if (new Set(ids).size !== ids.length) issues.push(`duplicate_${name}_id`);
  }
}

function verifyHistoricalEnvelope(bundle, issues) {
  const standingCoverage = {
    entrants: Array.isArray(bundle?.entrants) ? bundle.entrants.length : null,
    standings: Array.isArray(bundle?.standings) ? bundle.standings.length : null,
    knownEntrantsReferenced: null,
    entrantsWithoutStanding: null,
    standingRowsWithoutEntrant: 0,
    duplicateEntrantReferences: [],
    foreignEntrantIds: [],
  };
  if (bundle?.schemaVersion !== 1) issues.push("unsupported_bundle_schema");
  verifyCollectionIds(bundle, issues);
  if (!Array.isArray(bundle?.entrants) || bundle.entrants.length === 0) issues.push("empty_entrants");
  if (!Array.isArray(bundle?.sets) || bundle.sets.length === 0) issues.push("empty_sets");
  if (!Array.isArray(bundle?.seeds) || bundle.seeds.length === 0) issues.push("empty_seeds");
  if (!Array.isArray(bundle?.standings) || bundle.standings.length === 0) issues.push("empty_standings");
  if (!Array.isArray(bundle?.phaseGroups) || bundle.phaseGroups.length === 0) issues.push("empty_phase_groups");
  if (bundle?.event?.state !== "COMPLETED") issues.push("event_not_completed");
  if (!Number.isSafeInteger(bundle?.event?.numEntrants) || bundle.event.numEntrants < 1) issues.push("invalid_event_entrant_total");
  else if (Array.isArray(bundle?.entrants) && bundle.event.numEntrants !== bundle.entrants.length) issues.push("entrant_total_mismatch");
  if (!Array.isArray(bundle?.event?.phases) || bundle.event.phases.length === 0) issues.push("missing_event_phases");
  if (Array.isArray(bundle?.entrants) && Array.isArray(bundle?.standings)) {
    if (bundle.standings.length > bundle.entrants.length) issues.push("standing_count_exceeds_entrants");
    const entrantIds = new Set(bundle.entrants.map((entrant) => String(entrant?.id ?? "")).filter(positiveId));
    const referenced = new Set();
    const duplicates = new Set();
    const foreign = new Set();
    for (const standing of bundle.standings) {
      const entrantId = String(standing?.entrant?.id ?? "");
      if (!positiveId(entrantId)) {
        standingCoverage.standingRowsWithoutEntrant++;
        continue;
      }
      if (!entrantIds.has(entrantId)) foreign.add(entrantId);
      else if (referenced.has(entrantId)) duplicates.add(entrantId);
      else referenced.add(entrantId);
    }
    standingCoverage.knownEntrantsReferenced = referenced.size;
    standingCoverage.entrantsWithoutStanding = entrantIds.size - referenced.size;
    standingCoverage.duplicateEntrantReferences = [...duplicates].sort(compare);
    standingCoverage.foreignEntrantIds = [...foreign].sort(compare);
    if (standingCoverage.standingRowsWithoutEntrant) issues.push("standing_missing_entrant");
    if (standingCoverage.duplicateEntrantReferences.length) issues.push("duplicate_standing_entrant");
    if (standingCoverage.foreignEntrantIds.length) issues.push("foreign_standing_entrant");
  }

  const provenance = bundle?.provenance;
  if (provenance?.source !== "start.gg" || !Array.isArray(provenance?.requests) || provenance.requests.length === 0) {
    issues.push("missing_download_provenance");
  } else {
    const requestTimes = [];
    for (const request of provenance.requests) {
      if (request?.source !== "start.gg" || !validSha256(request?.requestHash)
          || !validSha256(request?.responseHash) || !Number.isFinite(Date.parse(request?.fetchedAt))) {
        issues.push("invalid_request_provenance");
        break;
      }
      requestTimes.push(request.fetchedAt);
    }
    if (!Number.isFinite(Date.parse(provenance.fetchedAt))) issues.push("invalid_bundle_fetched_at");
    else if (requestTimes.length && [...requestTimes].sort(compare).at(-1) !== provenance.fetchedAt) {
      issues.push("bundle_fetched_at_mismatch");
    }
  }
  const pagination = provenance?.setPagination;
  if (pagination != null) {
    if (!Number.isSafeInteger(pagination.eventTotal) || pagination.eventTotal < 0
        || !Array.isArray(bundle?.sets) || pagination.eventTotal !== bundle.sets.length
        || !Array.isArray(pagination.shards) || pagination.shards.length === 0
        || pagination.shards.some((shard) => !Number.isSafeInteger(shard?.total) || shard.total < 0)
        || pagination.shards.reduce((sum, shard) => sum + shard.total, 0) !== pagination.eventTotal) {
      issues.push("invalid_set_pagination_provenance");
    }
  }
  return { standingCoverage };
}

async function inspectDownload(context, source, registry, duplicates) {
  const issues = [];
  let slug = null;
  try { slug = normalizeEventSlug(source?.slug); }
  catch { issues.push("invalid_event_slug"); }
  if ((duplicates.slug.get(String(source?.slug ?? "")) ?? 0) > 1) issues.push("duplicate_download_slug");
  if ((duplicates.eventId.get(String(source?.eventId ?? "")) ?? 0) > 1) issues.push("duplicate_download_event_id");
  if ((duplicates.file.get(String(source?.file ?? "")) ?? 0) > 1) issues.push("duplicate_download_file");
  if (!positiveId(source?.eventId)) issues.push("invalid_index_event_id");
  if (!validSha256(source?.sha256)) issues.push("invalid_index_sha256");
  if (!/^raw\/[a-f0-9]{64}\.json$/.test(source?.file ?? "")
      || validSha256(source?.sha256) && source.file !== `raw/${source.sha256}.json`) {
    issues.push("invalid_bundle_path");
  }

  let body = null;
  let bundle = null;
  let observations = null;
  if (!issues.includes("invalid_bundle_path")) {
    const raw = await readContainedRegularFile(context, context.raw, path.basename(source.file));
    const issueNames = {
      raw_parent_symlink: "bundle_parent_symlink",
      raw_parent_not_directory: "bundle_parent_not_directory",
      raw_parent_outside_root: "bundle_parent_outside_root",
      raw_parent_missing: "bundle_parent_missing",
      raw_parent_unreadable: "bundle_parent_unreadable",
      raw_file_not_regular: "bundle_not_regular_file",
      raw_file_outside_root: "bundle_path_outside_root",
      raw_file_missing: "bundle_file_missing",
      raw_file_unreadable: "bundle_file_unreadable",
    };
    issues.push(...raw.issues.map((issue) => issueNames[issue] ?? issue));
    body = raw.body ?? null;
  }
  const actualSha256 = body == null ? null : digest(body);
  if (body != null && actualSha256 !== source.sha256) issues.push("bundle_hash_mismatch");
  if (body != null && actualSha256 === source.sha256) {
    try { bundle = JSON.parse(body); }
    catch { issues.push("invalid_bundle_json"); }
  }

  const registryEntry = slug == null ? null : registry.events.find((event) => event.startgg?.eventSlug === slug) ?? null;
  if (bundle) {
    if (slug !== bundle.event?.slug || String(bundle.event?.id ?? "") !== String(source.eventId ?? "")) {
      issues.push("bundle_index_identity_mismatch");
    }
    observations = verifyHistoricalEnvelope(bundle, issues);
    if (Array.isArray(bundle.entrants) && Array.isArray(bundle.sets) && Array.isArray(bundle.seeds)
        && Array.isArray(bundle.standings) && Array.isArray(bundle.phaseGroups)
        && Array.isArray(bundle.event?.phases)) {
      await verifyRequestReceipts(context, bundle, issues);
    }
    if (registryEntry?.mappingStatus === "verified") {
      try { attachMajor(bundle, registry); }
      catch { issues.push("verified_mapping_metadata_mismatch"); }
    }
  }
  const sourceCounts = bundle && COLLECTIONS.every((name) => Array.isArray(bundle[name]))
    ? Object.fromEntries(COLLECTIONS.map((name) => [name, bundle[name].length]))
    : null;
  return {
    slug: slug ?? String(source?.slug ?? ""),
    indexEventId: positiveId(source?.eventId) ? String(source.eventId) : null,
    file: typeof source?.file === "string" ? source.file : null,
    expectedSha256: validSha256(source?.sha256) ? source.sha256 : null,
    actualSha256,
    registryMajorId: registryEntry?.id ?? null,
    registryMappingStatus: registryEntry?.mappingStatus ?? "unmapped",
    sourceCounts,
    observations,
    issues: unique(issues),
    verification: issues.length === 0 && registryEntry?.mappingStatus === "verified" ? "verified" : "invalid",
  };
}

/**
 * Verify the immutable raw files selected by downloads.json, then join them to
 * the closed-world contract. This never changes a disposition: it emits a
 * review queue whose entries are safe to attempt through corpus normalization.
 */
export async function inspectHistoricalCorpusSources({ root, registry, contract, downloadIndex }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Source readiness needs an absolute research root");
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.events)) throw new Error("Source readiness needs registry schemaVersion 1");
  if (contract?.kind !== "forecast-historical-corpus-contract-v1" || !Array.isArray(contract.events)) {
    throw new Error("Source readiness needs a built historical corpus contract");
  }
  if (downloadIndex?.schemaVersion !== 1 || !Array.isArray(downloadIndex.events)) {
    throw new Error("Source readiness needs downloads schemaVersion 1");
  }
  const selected = [...downloadIndex.events].sort((a, b) => compare(a?.slug ?? "", b?.slug ?? "")
    || compare(a?.eventId ?? "", b?.eventId ?? "") || compare(a?.file ?? "", b?.file ?? ""));
  const duplicates = {
    slug: countDuplicates(selected, "slug"),
    eventId: countDuplicates(selected, "eventId"),
    file: countDuplicates(selected, "file"),
  };
  const context = await sourceContext(root);
  const downloads = [];
  for (const source of selected) downloads.push(await inspectDownload(context, source, registry, duplicates));
  const downloadsByMajor = new Map();
  for (const source of downloads) {
    if (!source.registryMajorId) continue;
    if (!downloadsByMajor.has(source.registryMajorId)) downloadsByMajor.set(source.registryMajorId, []);
    downloadsByMajor.get(source.registryMajorId).push(source);
  }

  const events = contract.events.map((event) => {
    const matches = downloadsByMajor.get(event.id) ?? [];
    const source = matches.length === 1 ? matches[0] : null;
    const mappingVerified = event.sourceMapping?.confidence === "verified";
    const downloadStatus = matches.length === 0 ? "missing"
      : matches.length > 1 ? "invalid"
      : source.verification;
    const readyForPromotionReview = event.disposition === "unresolved" && mappingVerified && downloadStatus === "verified";
    return {
      id: event.id,
      name: event.name,
      year: event.year,
      disposition: event.disposition,
      mappingStatus: event.sourceMapping?.confidence ?? "unmapped",
      eventSlug: event.sourceMapping?.eventSlug ?? null,
      downloadStatus,
      sourceSha256: source?.expectedSha256 ?? null,
      sourceFile: source?.file ?? null,
      sourceCounts: source?.sourceCounts ?? null,
      observations: source?.observations ?? null,
      issues: matches.length > 1 ? ["multiple_downloads_for_major"] : source?.issues ?? [],
      readyForPromotionReview,
    };
  }).sort(byEvent);

  const promotionCandidates = events.filter((event) => event.readyForPromotionReview);
  const mappedAwaitingDownload = events.filter((event) => event.disposition === "unresolved"
    && event.mappingStatus === "verified" && event.downloadStatus === "missing");
  const invalidInScopeDownloads = events.filter((event) => event.downloadStatus === "invalid");
  const includedSourceFailures = events.filter((event) => event.disposition === "included" && event.downloadStatus !== "verified");
  const missingStandingObservations = events
    .filter((event) => event.downloadStatus === "verified"
      && (event.observations?.standingCoverage?.entrantsWithoutStanding ?? 0) > 0)
    .map((event) => ({
      id: event.id,
      name: event.name,
      year: event.year,
      entrantsWithoutStanding: event.observations.standingCoverage.entrantsWithoutStanding,
    }));
  const outsideScopeDownloads = downloads
    .filter((source) => !contract.events.some((event) => event.id === source.registryMajorId))
    .sort((a, b) => compare(a.slug, b.slug));
  const years = [];
  for (let year = contract.scope.startYear; year <= contract.scope.endYear; year++) {
    const rows = events.filter((event) => event.year === year);
    years.push({
      year,
      expected: rows.length,
      verifiedMappings: rows.filter((event) => event.mappingStatus === "verified").length,
      verifiedDownloads: rows.filter((event) => event.downloadStatus === "verified").length,
      includedVerified: rows.filter((event) => event.disposition === "included" && event.downloadStatus === "verified").length,
      promotionCandidates: rows.filter((event) => event.readyForPromotionReview).length,
      mappedAwaitingDownload: rows.filter((event) => event.disposition === "unresolved"
        && event.mappingStatus === "verified" && event.downloadStatus === "missing").length,
      invalidDownloads: rows.filter((event) => event.downloadStatus === "invalid").length,
    });
  }

  return {
    schemaVersion: 1,
    kind: "forecast-historical-corpus-source-readiness-v1",
    contractId: contract.id,
    downloadIndexSha256: digest(JSON.stringify({
      schemaVersion: 1,
      events: selected.map((source) => ({
        slug: source?.slug ?? null,
        eventId: source?.eventId ?? null,
        file: source?.file ?? null,
        sha256: source?.sha256 ?? null,
      })),
    }) + "\n"),
    counts: {
      expected: events.length,
      verifiedMappings: events.filter((event) => event.mappingStatus === "verified").length,
      verifiedDownloads: events.filter((event) => event.downloadStatus === "verified").length,
      includedVerified: events.filter((event) => event.disposition === "included" && event.downloadStatus === "verified").length,
      promotionCandidates: promotionCandidates.length,
      mappedAwaitingDownload: mappedAwaitingDownload.length,
      invalidInScopeDownloads: invalidInScopeDownloads.length,
      includedSourceFailures: includedSourceFailures.length,
      eventsWithMissingStandings: missingStandingObservations.length,
      entrantsWithoutStandings: missingStandingObservations
        .reduce((sum, event) => sum + event.entrantsWithoutStanding, 0),
      outsideScopeDownloads: outsideScopeDownloads.length,
    },
    allIncludedSourcesReady: includedSourceFailures.length === 0,
    events,
    years,
    promotionCandidates,
    mappedAwaitingDownload,
    invalidInScopeDownloads,
    includedSourceFailures,
    missingStandingObservations,
    outsideScopeDownloads,
  };
}
