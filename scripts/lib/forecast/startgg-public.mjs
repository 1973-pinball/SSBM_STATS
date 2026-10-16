/** Public legacy Start.gg observations. Deliberately separate from the vetted
 * GraphQL receipt contract: collection reconciliation does not prove pagination
 * totals which this API does not supply. Raw responses remain local. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { digest, writeJson } from "./local.mjs";

const SOURCE = "startgg-public-legacy-v1";
const WEB_GRAPHQL = "startgg-public-web-graphql-v1";
const WEB_ENDPOINT = "https://www.start.gg/api/-/gql";
export const PUBLIC_ADAPTER_VERSION = 3;
const origin = "https://api.start.gg";
const positive = (value) => /^[1-9]\d*$/.test(String(value ?? ""));
const state = (value) => ({ 1: "CREATED", 2: "ACTIVE", 3: "COMPLETED", 4: "READY" })[value] ?? null;
const bracket = (value) => ({ 1: "SINGLE_ELIMINATION", 2: "DOUBLE_ELIMINATION", 3: "ROUND_ROBIN", 4: "SWISS", 6: "CUSTOM_SCHEDULE" })[value] ?? null;
const requireRows = (entities, name, { allowPreview = false } = {}) => {
  if (!Array.isArray(entities?.[name])) throw new Error(`Public source missing ${name} collection`);
  const result = entities[name];
  if (result.some((row) => !positive(row?.id) && !(allowPreview && /^preview_[1-9]\d*_-?\d+_\d+$/.test(row?.id))) || new Set(result.map((row) => String(row.id))).size !== result.length) {
    throw new Error(`Public source has invalid or duplicate ${name} IDs`);
  }
  return result;
};
const selected = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));

export function createPublicStartggClient({ cacheDir, minIntervalMs = 1100, fetchImpl = fetch, sleepImpl = sleep, now = Date.now } = {}) {
  if (!cacheDir || !Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error("Invalid public source client configuration");
  let lastStarted = -Infinity;
  const receipts = new Map();
  async function request(resource) {
    if (!/^\/(event|phase_group|entrant)\/[1-9]\d*(?:\?expand\[\]=[a-z]+(?:&expand\[\]=[a-z]+)*)?$/.test(resource)
      && !/^\/tournament\/[a-zA-Z0-9_-]+$/.test(resource)) throw new Error("Unsupported public read-only source URL");
    const url = origin + resource;
    const description = { method: "GET", url };
    const requestHash = digest(JSON.stringify(description));
    const file = path.join(cacheDir, requestHash + ".json");
    let envelope;
    try { envelope = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (envelope) {
      if (envelope.schemaVersion !== 1 || envelope.transport !== SOURCE || envelope.requestHash !== requestHash
        || JSON.stringify(envelope.request) !== JSON.stringify(description)
        || envelope.responseHash !== digest(JSON.stringify(envelope.response))
        || !Number.isFinite(Date.parse(envelope.fetchedAt))) throw new Error("Invalid public Start.gg cache receipt");
    } else {
      for (let attempt = 0; attempt < 4; attempt++) {
        const delay = Math.max(0, lastStarted + minIntervalMs - now());
        if (delay) await sleepImpl(delay);
        lastStarted = now();
        const reply = await fetchImpl(url, { signal: AbortSignal.timeout(60000), headers: { Accept: "application/json" } });
        if ([429, 500, 502, 503, 504].includes(reply.status) && attempt < 3) {
          const retrySeconds = Number(reply.headers.get("retry-after"));
          const retryMs = Math.max(2000 * 2 ** attempt, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0);
          if (retryMs > 60000) throw new Error("Public Start.gg requested a long retry pause; rerun to resume cached progress");
          await sleepImpl(retryMs);
          continue;
        }
        if (!reply.ok) throw new Error(`Public Start.gg HTTP ${reply.status} for ${resource.split("?")[0]}`);
        const response = await reply.json();
        if (!response?.entities || typeof response.entities !== "object" || response.errors?.length) throw new Error("Incomplete public Start.gg response");
        envelope = { schemaVersion: 1, source: "start.gg", transport: SOURCE, request: description, requestHash,
          fetchedAt: new Date(now()).toISOString(), responseHash: digest(JSON.stringify(response)), response };
        await writeJson(file, envelope);
        break;
      }
    }
    const receipt = { source: "start.gg", transport: SOURCE, requestHash, responseHash: envelope.responseHash,
      fetchedAt: envelope.fetchedAt, url, operation: "public-get" };
    receipts.set(resource, receipt);
    return envelope.response.entities;
  }
  const queryDescription = (query, variables) => ({ method: "POST", url: WEB_ENDPOINT, clientVersion: 20, query, variables });
  async function webQuery(query, variables) {
    if (!/^query PublicStartggLadder(?:Seeds|Sets)\(/.test(query) || /\b(?:mutation|subscription)\b/.test(query)) throw new Error("Unsupported public website query");
    const description = queryDescription(query, variables);
    const requestHash = digest(JSON.stringify(description));
    const file = path.join(cacheDir, requestHash + ".json");
    let envelope;
    try { envelope = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (envelope) {
      if (envelope.schemaVersion !== 1 || envelope.transport !== WEB_GRAPHQL || envelope.requestHash !== requestHash
        || JSON.stringify(envelope.request) !== JSON.stringify(description)
        || envelope.responseHash !== digest(JSON.stringify(envelope.response))
        || !Number.isFinite(Date.parse(envelope.fetchedAt))) throw new Error("Invalid public website GraphQL cache receipt");
    } else {
      for (let attempt = 0; attempt < 4; attempt++) {
        const delay = Math.max(0, lastStarted + minIntervalMs - now());
        if (delay) await sleepImpl(delay);
        lastStarted = now();
        const reply = await fetchImpl(WEB_ENDPOINT, { method: "POST", signal: AbortSignal.timeout(60000),
          headers: { "Content-Type": "application/json", "client-version": "20" },
          body: JSON.stringify({ query, variables, operationName: query.match(/^query (\w+)/)[1] }) });
        if ([429, 500, 502, 503, 504].includes(reply.status) && attempt < 3) {
          const seconds = Number(reply.headers.get("retry-after"));
          const delay = Math.max(2000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0);
          if (delay > 60000) throw new Error("Public Start.gg requested a long retry pause; rerun to resume cached progress");
          await sleepImpl(delay);
          continue;
        }
        if (!reply.ok) throw new Error(`Public website GraphQL HTTP ${reply.status}`);
        const response = await reply.json();
        if (!response?.data || response.errors?.length || response.success === false) throw new Error("Incomplete public website GraphQL response");
        envelope = { schemaVersion: 1, source: "start.gg", transport: WEB_GRAPHQL, request: description, requestHash,
          fetchedAt: new Date(now()).toISOString(), responseHash: digest(JSON.stringify(response)), response };
        await writeJson(file, envelope);
        break;
      }
    }
    if (!envelope.response?.data || envelope.response.errors?.length || envelope.response.success === false) throw new Error("Incomplete cached public website GraphQL response");
    receipts.set(requestHash, { source: "start.gg", transport: WEB_GRAPHQL, requestHash, responseHash: envelope.responseHash,
      fetchedAt: envelope.fetchedAt, url: WEB_ENDPOINT, operation: query.match(/^query (\w+)/)[1] });
    return envelope.response.data;
  }
  return { request, receipt: (resource) => receipts.get(resource), webQuery,
    queryReceipt: (query, variables) => receipts.get(digest(JSON.stringify(queryDescription(query, variables)))) };
}

const LADDER_SEEDS = `query PublicStartggLadderSeeds($groupId: ID!, $page: Int!, $perPage: Int!) {
  phaseGroup(id: $groupId) { id phase { id event { id } }
    seeds(query: { page: $page perPage: $perPage }) { pageInfo { page perPage total totalPages }
      nodes { id seedNum groupSeedNum isBye progressionSeedId updatedAt phase { id } phaseGroup { id }
        entrant { id name participants { id gamerTag player { id } } } }
    }
  }
}`;
const LADDER_SETS = `query PublicStartggLadderSets($groupId: ID!, $page: Int!, $perPage: Int!) {
  phaseGroup(id: $groupId) { id phase { id event { id } }
    sets(page: $page perPage: $perPage sortType: STANDARD filters: { showByes: true hideEmpty: false }) {
      pageInfo { page perPage total totalPages }
      nodes { id state round fullRoundText winnerId startAt startedAt completedAt createdAt updatedAt displayScore identifier lPlacement wPlacement
        phaseGroup { id } winnerProgressionSeed { id } loserProgressionSeed { id }
        slots(includeByes: true) { id slotIndex prereqId prereqType prereqPlacement
          seed { id seedNum } entrant { id } standing { stats { score { value } } } }
      }
    }
  }
}`;

export async function downloadPublicLadder(client, group, eventId) {
  const requests = [];
  const proof = { groupId: String(group.id), transport: WEB_GRAPHQL, authentication: "none", collections: {} };
  async function collection(query, field) {
    const rows = [];
    const ids = new Set();
    let total;
    let pages;
    for (let page = 1; page <= (pages ?? 1); page++) {
      const variables = { groupId: group.id, page, perPage: 25 };
      const result = await client.webQuery(query, variables);
      requests.push(client.queryReceipt(query, variables));
      const parent = result.phaseGroup;
      if (String(parent?.id) !== String(group.id) || String(parent.phase?.id) !== String(group.phaseId)
        || String(parent.phase?.event?.id) !== String(eventId)) throw new Error("Public ladder query identity mismatch");
      const connection = parent[field];
      const currentTotal = connection?.pageInfo?.total;
      const currentPages = connection?.pageInfo?.totalPages;
      if (connection?.pageInfo?.page !== page || connection?.pageInfo?.perPage !== 25
        || !Number.isSafeInteger(currentTotal) || currentTotal < 0 || !Number.isSafeInteger(currentPages)
        || currentPages < 0 || currentPages > 10000 || currentPages !== Math.ceil(currentTotal / 25)
        || total !== undefined && (total !== currentTotal || pages !== currentPages)) throw new Error("Public ladder pagination totals disagree");
      total = currentTotal;
      pages = currentPages;
      const nodes = requireRows({ [field]: connection.nodes }, field);
      if (nodes.length !== Math.min(25, Math.max(0, total - (page - 1) * 25))) throw new Error("Public ladder page is truncated");
      for (const node of nodes) {
        if (ids.has(String(node.id))) throw new Error("Duplicate public ladder row across pages");
        if (String(node.phaseGroup?.id) !== String(group.id) || field === "seeds" && String(node.phase?.id) !== String(group.phaseId)) throw new Error("Foreign public ladder row");
        ids.add(String(node.id));
        rows.push(node);
      }
    }
    if (rows.length !== total) throw new Error("Public ladder collection total mismatch");
    proof.collections[field] = { total, totalPages: pages, fetchedPages: Math.max(1, pages), uniqueIds: ids.size };
    return rows;
  }
  const sourceSeeds = await collection(LADDER_SEEDS, "seeds");
  const sourceSets = await collection(LADDER_SETS, "sets");
  const seeds = sourceSeeds.map((seed) => {
    const entrant = seed.entrant;
    const participants = entrant?.participants ?? [];
    return { ...selected(seed, ["id", "seedNum", "groupSeedNum", "isBye", "progressionSeedId", "updatedAt"]),
      phaseId: group.phaseId, phaseGroupId: group.id, entrantId: entrant?.id ?? null, projectedEntrantId: null,
      mutations: { participants: Object.fromEntries(participants.map((participant) => [participant.id, {
        id: participant.id, gamerTag: participant.gamerTag, playerId: participant.player?.id ?? null,
      }])), entrants: entrant ? { [entrant.id]: { id: entrant.id, name: entrant.name,
        participantIds: participants.map((participant) => participant.id),
        playerIds: Object.fromEntries(participants.map((participant) => [participant.id, participant.player?.id ?? null])) } } : {} } };
  });
  const sets = sourceSets.map((set) => {
    const slots = [...set.slots].sort((a, b) => a.slotIndex - b.slotIndex);
    if (slots.length !== 2 || slots.some((slot, index) => slot.slotIndex !== index)) throw new Error("Invalid public ladder set slots");
    return { ...selected(set, ["id", "state", "round", "fullRoundText", "winnerId", "startAt", "startedAt", "completedAt", "createdAt", "updatedAt", "displayScore", "identifier", "lPlacement", "wPlacement"]),
      eventId, phaseGroupId: group.id, entrant1Id: slots[0].entrant?.id ?? null, entrant2Id: slots[1].entrant?.id ?? null,
      entrant1Score: slots[0].standing?.stats?.score?.value ?? null, entrant2Score: slots[1].standing?.stats?.score?.value ?? null,
      wProgressionSeedId: set.winnerProgressionSeed?.id ?? null, lProgressionSeedId: set.loserProgressionSeed?.id ?? null,
      slots: slots.map((slot) => ({ ...slot, entrantId: slot.entrant?.id ?? null, seedId: slot.seed?.id ?? null })) };
  });
  return { seeds, sets, requests, proof };
}

export async function inspectPublicEvent(client, eventId) {
  if (!positive(eventId)) throw new Error("A positive event ID is required");
  const resource = `/event/${eventId}?expand[]=phase&expand[]=groups&expand[]=entrants&expand[]=seeds`;
  const entities = await client.request(resource);
  if (String(entities.event?.id) !== String(eventId)) throw new Error("Public event ID mismatch");
  return { resource, entities };
}

function participantRows(raw) {
  const ids = raw.participantIds ?? [];
  if (!Array.isArray(ids) || ids.some((id) => !positive(id))) throw new Error("Invalid public participant IDs");
  return ids.map((id) => {
    const participant = raw.mutations?.participants?.[id];
    const playerId = raw.playerIds?.[id] ?? participant?.playerId ?? null;
    if (raw.playerIds?.[id] && participant?.playerId && String(raw.playerIds[id]) !== String(participant.playerId)) {
      throw new Error("Conflicting public participant identity");
    }
    return { id, gamerTag: participant?.gamerTag ?? null, player: positive(playerId) ? { id: playerId } : null };
  });
}

export async function downloadPublicEvent(client, eventId, { onProgress = () => {}, requireCompleted = true } = {}) {
  const inspected = await inspectPublicEvent(client, eventId);
  const { entities } = inspected;
  const rawEvent = entities.event;
  if (requireCompleted && rawEvent.state !== 3) throw new Error(`Public historical event ${eventId} is not completed`);
  const phases = requireRows(entities, "phase");
  const groups = requireRows(entities, "groups");
  const rawEntrants = requireRows(entities, "entrants");
  const rawSeeds = requireRows(entities, "seeds");
  const eventSeedById = new Map(rawSeeds.map((seed) => [String(seed.id), seed]));
  if (!phases.length || !rawEntrants.length || !groups.length) throw new Error("Public event lacks phases, groups, or entrants");
  const requests = [client.receipt(inspected.resource)];
  const tournamentSlug = rawEvent.slug?.match(/^tournament\/([a-zA-Z0-9_-]+)\/event\/[a-zA-Z0-9_-]+$/)?.[1];
  if (!tournamentSlug) throw new Error("Invalid public event slug");
  const tournamentResource = `/tournament/${tournamentSlug}`;
  const rawTournament = (await client.request(tournamentResource)).tournament;
  requests.push(client.receipt(tournamentResource));
  if (String(rawTournament?.id) !== String(rawEvent.tournamentId)) throw new Error("Public tournament identity mismatch");
  const phaseById = new Map(phases.map((phase) => [String(phase.id), {
    ...selected(phase, ["id", "name", "phaseOrder", "isExhibition"]), state: state(phase.state), bracketType: bracket(phase.bracketType),
  }]));
  for (const phase of phases) {
    if (String(phase.eventId) !== String(eventId)) throw new Error("Public phase belongs to another event");
    const listed = groups.filter((group) => String(group.phaseId) === String(phase.id)).length;
    if (!Number.isSafeInteger(phase.groupCount) || listed !== phase.groupCount) throw new Error(`Public phase ${phase.id} group count mismatch`);
  }
  const phaseGroups = groups.map((group) => {
    const phase = phaseById.get(String(group.phaseId));
    if (!phase) throw new Error("Public group references unknown phase");
    return { ...selected(group, ["id", "displayIdentifier", "startAt", "numRounds", "firstRoundTime", "groupTypeId"]),
      state: state(group.state), bracketType: bracket(group.groupTypeId), phase };
  });
  const groupById = new Map(phaseGroups.map((group) => [String(group.id), group]));
  const eventEntrantIds = new Set(rawEntrants.map((entrant) => String(entrant.id)));
  const eventEntrantsById = new Map(rawEntrants.map((entrant) => [String(entrant.id), entrant]));
  const observedEntrants = new Map();
  const groupSeedIds = new Set();
  const rawSets = [];
  const publicWebGraphqlGroups = [];
  const remember = (raw) => {
    if (!eventEntrantIds.has(String(raw.id)) || String(raw.eventId) !== String(eventId)) throw new Error("Public group contains foreign entrant");
    const participants = participantRows(raw);
    const previous = observedEntrants.get(String(raw.id));
    const signature = (list) => JSON.stringify(list.map((p) => [String(p.id), p.player?.id == null ? null : String(p.player.id)]).sort());
    if (previous && signature(previous.participants) !== signature(participants)) throw new Error("Conflicting public entrant identities across groups");
    observedEntrants.set(String(raw.id), { id: raw.id, name: raw.name, participants });
  };
  for (const [index, group] of groups.entries()) {
    // Seed mutations already include participant/player identities. Avoid the
    // entrants expansion, which adds full public player profiles and portraits.
    const resource = `/phase_group/${group.id}?expand[]=sets&expand[]=seeds`;
    let response = await client.request(resource);
    requests.push(client.receipt(resource));
    if (String(response.groups?.id) !== String(group.id) || String(response.groups?.phaseId) !== String(group.phaseId)) throw new Error("Public phase group identity mismatch");
    if (group.groupTypeId === 7 && (!Array.isArray(response.seeds) || !Array.isArray(response.sets))) {
      const ladder = await downloadPublicLadder(client, group, eventId);
      requests.push(...ladder.requests);
      publicWebGraphqlGroups.push(ladder.proof);
      response = { ...response, seeds: ladder.seeds, sets: ladder.sets };
    }
    for (const seed of requireRows(response, "seeds")) {
      if (String(seed.phaseGroupId) !== String(group.id)) throw new Error("Public seed group mismatch");
      const eventSeed = eventSeedById.get(String(seed.id));
      const identityFields = ["phaseId", "phaseGroupId", "entrantId", "seedNum", "groupSeedNum", "isBye", "progressionSeedId", "projectedEntrantId"];
      if (!eventSeed || identityFields.some((field) => String(eventSeed[field] ?? "") !== String(seed[field] ?? ""))) throw new Error("Public event/group seed values conflict");
      groupSeedIds.add(String(seed.id));
      for (const entrant of Object.values(seed.mutations?.entrants ?? {})) {
        if (!requireCompleted && entrant.isPlaceholder === true && /^placeholder[1-9]\d*$/.test(entrant.id)) continue;
        const eventEntrant = eventEntrantsById.get(String(entrant.id));
        if (!eventEntrant) throw new Error("Public seed contains foreign entrant identity");
        remember({ ...eventEntrant, ...entrant, mutations: { participants: seed.mutations.participants ?? {} } });
      }
    }
    const sourceSets = response.sets === undefined && response.groups.hasSets === false ? [] : requireRows(response, "sets", { allowPreview: !requireCompleted });
    if (response.groups.hasSets === true && !sourceSets.length) throw new Error("Public group reports sets but returned an empty collection");
    for (const set of sourceSets) {
      if (String(set.eventId) !== String(eventId) || String(set.phaseGroupId) !== String(group.id)) throw new Error("Public set event/group mismatch");
      rawSets.push(set);
    }
    onProgress({ eventId: String(eventId), group: index + 1, groups: groups.length, sets: rawSets.length });
  }
  const eventSeedIds = new Set(rawSeeds.filter((seed) => seed.phaseGroupId != null).map((seed) => String(seed.id)));
  if (groupSeedIds.size !== eventSeedIds.size || [...groupSeedIds].some((id) => !eventSeedIds.has(id))) throw new Error("Public event/group seed coverage mismatch");
  for (const raw of rawEntrants) {
    if (observedEntrants.has(String(raw.id))) continue;
    const resource = `/entrant/${raw.id}?expand[]=participants`;
    const response = await client.request(resource);
    requests.push(client.receipt(resource));
    const entry = response.entrants;
    if (String(entry?.id) !== String(raw.id)) throw new Error("Public entrant identity mismatch");
    const attendees = Array.isArray(response.attendee) ? response.attendee : [response.attendee].filter(Boolean);
    remember({ ...entry, mutations: { participants: Object.fromEntries(attendees.map((participant) => [participant.id, participant])) } });
  }
  if (new Set(rawSets.map((set) => String(set.id))).size !== rawSets.length) throw new Error("Duplicate public set ID across groups");
  const seeds = rawSeeds.map((seed) => {
    const phase = phaseById.get(String(seed.phaseId));
    const placeholder = !requireCompleted && /^placeholder[1-9]\d*$/.test(seed.entrantId);
    if (!phase || seed.entrantId != null && !placeholder && !eventEntrantIds.has(String(seed.entrantId))) throw new Error("Public seed references unknown phase or entrant");
    return { ...selected(seed, ["id", "seedNum", "groupSeedNum", "isBye", "progressionSeedId", "projectedEntrantId", "updatedAt"]),
      phase, phaseGroup: seed.phaseGroupId == null ? null : { id: seed.phaseGroupId },
      entrant: seed.entrantId == null ? null : { id: seed.entrantId } };
  });
  const seedById = new Map(seeds.map((seed) => [String(seed.id), seed]));
  const sets = rawSets.map((set) => {
    const slots = [0, 1].map((index) => {
      const raw = set.slots?.find((slot) => slot.slotIndex === index) ?? {};
      const sourceEntrantId = set[`entrant${index + 1}Id`] ?? raw.entrantId ?? null;
      const placeholder = !requireCompleted && set[`entrant${index + 1}IsPlaceholder`] === true && /^placeholder[1-9]\d*$/.test(sourceEntrantId);
      const entrantId = placeholder ? null : sourceEntrantId;
      if (entrantId != null && !eventEntrantIds.has(String(entrantId))) throw new Error("Public set references unknown entrant");
      if (raw.entrantId != null && entrantId != null && String(raw.entrantId) !== String(entrantId)) throw new Error("Public set slot entrant mismatch");
      const seed = seedById.get(String(raw.seedId ?? (raw.prereqType === "seed" ? raw.prereqId : null)));
      return { ...selected(raw, ["id", "prereqId", "prereqType", "prereqPlacement", "prereqCondition"]), slotIndex: index,
        ...(placeholder ? { sourcePlaceholderEntrantId: sourceEntrantId } : {}),
        entrant: entrantId == null ? null : { id: entrantId, isDisqualified: raw.entrant?.isDisqualified ?? null }, seed: seed ? { id: seed.id, seedNum: seed.seedNum } : null,
        standing: { stats: { score: { value: set[`entrant${index + 1}Score`] ?? null } } } };
    });
    return { ...selected(set, ["id", "state", "round", "fullRoundText", "winnerId", "isDQ", "startAt", "startedAt", "completedAt", "createdAt", "updatedAt", "displayScore", "identifier", "lPlacement", "wPlacement"]),
      winnerProgressionSeed: set.wProgressionSeedId == null ? null : { id: set.wProgressionSeedId },
      loserProgressionSeed: set.lProgressionSeedId == null ? null : { id: set.lProgressionSeedId },
      phaseGroup: groupById.get(String(set.phaseGroupId)), slots };
  });
  const standings = rawEntrants.filter((entry) => Number.isSafeInteger(entry.finalPlacement) && entry.finalPlacement > 0)
    .map((entry) => ({ placement: entry.finalPlacement, entrant: { id: entry.id }, sourceField: "entrant.finalPlacement" }));
  const audit = {
    transport: SOURCE, eventId: String(eventId), listedPhaseGroups: groups.length, fetchedPhaseGroups: groups.length,
    entrants: rawEntrants.length, observedEntrantIdentities: observedEntrants.size, seeds: seeds.length, sets: sets.length,
    standings: standings.length, entrantsWithoutFinalPlacement: rawEntrants.length - standings.length,
    missingPlayerIdentities: [...observedEntrants.values()].filter((entry) => entry.participants.some((participant) => !participant.player)).length,
    collectionsReconciled: true, graphqlPaginationValidated: false,
    ...(publicWebGraphqlGroups.length ? { publicWebGraphqlGroups } : {}),
    limitations: ["Legacy collections expose no independent pagination totals; completeness is checked by phase group counts and cross-collection ID reconciliation.",
      ...(publicWebGraphqlGroups.length ? ["Public website GraphQL pagination totals are validated only for the listed ladder groups; this is not authenticated developer GraphQL source validation."] : []),
      "Event standings are translated from entrant.finalPlacement; the legacy response does not provide GraphQL Standing IDs.",
      "Historical seeds are observed now and are not proven pre-event features.", "Public responses are not an atomic snapshot."],
  };
  return { schemaVersion: 1,
    event: { ...selected(rawEvent, ["id", "name", "slug", "startAt", "endAt", "type", "isOnline", "entrantSizeMin", "teamRosterSize"]),
      state: state(rawEvent.state), numEntrants: rawEntrants.length, videogame: { id: rawEvent.videogameId },
      phases: [...phaseById.values()], tournament: selected(rawTournament, ["id", "name", "slug", "startAt", "endAt", "isOnline"]) },
    entrants: [...observedEntrants.values()], seeds, sets, standings, phaseGroups,
    provenance: { source: "start.gg", transport: SOURCE, adapterVersion: PUBLIC_ADAPTER_VERSION, fetchedAt: requests.map((request) => request.fetchedAt).sort().at(-1), requests, publicSourceAudit: audit },
  };
}
