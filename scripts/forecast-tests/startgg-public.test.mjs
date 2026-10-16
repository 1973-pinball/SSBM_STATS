import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPublicStartggClient, downloadPublicEvent, downloadPublicLadder } from "../lib/forecast/startgg-public.mjs";
import { normalizeEvents } from "../lib/forecast/dataset.mjs";
import { digest } from "../lib/forecast/local.mjs";

const eventResource = "/event/1?expand[]=phase&expand[]=groups&expand[]=entrants&expand[]=seeds";
const groupResource = "/phase_group/3?expand[]=sets&expand[]=seeds";
function fixture() {
  const entrants = [10, 20].map((id, index) => ({ id, eventId: 1, name: ["Alpha", "Beta"][index],
    participantIds: [id + 1], finalPlacement: index + 1, playerIds: { [id + 1]: id + 2 },
    mutations: { participants: { [id + 1]: { id: id + 1, playerId: id + 2, gamerTag: ["Alpha", "Beta"][index] } } } }));
  const seeds = entrants.map((entrant, index) => ({ id: index + 30, phaseId: 2, phaseGroupId: 3, entrantId: entrant.id, seedNum: index + 1, isBye: false,
    mutations: { participants: entrant.mutations.participants, entrants: { [entrant.id]: entrant } } }));
  const group = { id: 3, phaseId: 2, groupTypeId: 2, state: 3, hasSets: true };
  return {
    [eventResource]: { event: { id: 1, tournamentId: 4, state: 3, slug: "tournament/sample/event/melee", name: "Melee", videogameId: 1,
      entrantSizeMin: 1, isOnline: false, startAt: 1700000000, endAt: 1700010000 },
    phase: [{ id: 2, eventId: 1, phaseOrder: 1, groupCount: 1, bracketType: 2, state: 3 }], groups: [group], entrants, seeds },
    "/tournament/sample": { tournament: { id: 4, name: "Sample", startAt: 1700000000, endAt: 1700010000 } },
    [groupResource]: { groups: structuredClone(group), entrants: structuredClone(entrants), seeds: structuredClone(seeds), sets: [{ id: 100, eventId: 1, phaseGroupId: 3, state: 3,
      entrant1Id: 10, entrant2Id: 20, entrant1Score: 3, entrant2Score: 1, winnerId: 10,
      slots: [{ id: "100-0", slotIndex: 0, entrantId: 10, seedId: 30 }, { id: "100-1", slotIndex: 1, entrantId: 20, seedId: 31 }] }] },
  };
}
function fakeClient(data) {
  return { request: async (resource) => structuredClone(data[resource]), receipt: (resource) => ({ source: "start.gg",
    transport: "startgg-public-legacy-v1", requestHash: "a".repeat(64), responseHash: "b".repeat(64),
    fetchedAt: "2026-10-16T00:00:00.000Z", url: "https://api.start.gg" + resource }) };
}

test("public translation preserves stable identities and eligible outcomes without claiming GraphQL validation", async () => {
  const bundle = await downloadPublicEvent(fakeClient(fixture()), 1);
  const dataset = normalizeEvents([bundle]);
  assert.equal(dataset.sets[0].eligible, true);
  assert.deepEqual(dataset.sets[0].playerIds, ["startgg:player:12", "startgg:player:22"]);
  assert.equal(dataset.sets[0].winnerPlayerId, "startgg:player:12");
  assert.equal(dataset.standings[0].placement, 1);
  assert.equal(dataset.seeds[0].observedBeforeEvent, false);
  assert.equal(bundle.provenance.publicSourceAudit.collectionsReconciled, true);
  assert.equal(bundle.provenance.publicSourceAudit.graphqlPaginationValidated, false);
  assert.equal(bundle.event.phases[0].state, "COMPLETED");
  assert.equal(bundle.sets[0].phaseGroup.phase.state, "COMPLETED");
});

test("public translation retains DQs for bracket structure and excludes them from training", async () => {
  const data = fixture();
  data[groupResource].sets[0].entrant2Score = -1;
  const dataset = normalizeEvents([await downloadPublicEvent(fakeClient(data), 1)]);
  assert.equal(dataset.sets.length, 1);
  assert.equal(dataset.sets[0].eligible, false);
  assert.ok(dataset.sets[0].exclusionReasons.includes("dq"));
  const explicit = fixture();
  explicit[groupResource].sets[0].isDQ = true;
  const flagged = normalizeEvents([await downloadPublicEvent(fakeClient(explicit), 1)]);
  assert.equal(flagged.sets[0].eligible, false);
  assert.ok(flagged.sets[0].exclusionReasons.includes("dq"));
});

test("public source rejects incomplete group and seed coverage, foreign sets, and conflicting identity evidence", async () => {
  for (const [mutate, expected] of [
    [(data) => { data[eventResource].phase[0].groupCount = 2; }, /group count mismatch/],
    [(data) => { data[groupResource].seeds.pop(); }, /seed coverage mismatch/],
    [(data) => { data[groupResource].seeds[0].seedNum = 99; }, /seed values conflict/],
    [(data) => { data[groupResource].sets = []; }, /reports sets but returned an empty/],
    [(data) => { data[groupResource].sets[0].eventId = 99; }, /set event\/group mismatch/],
    [(data) => { data[groupResource].seeds[0].mutations.entrants[10].playerIds[11] = 99; }, /Conflicting public participant identity/],
    [(data) => { data[eventResource].event.state = 2; }, /not completed/],
  ]) {
    const data = fixture();
    mutate(data);
    await assert.rejects(downloadPublicEvent(fakeClient(data), 1), expected);
  }
});

test("upcoming previews retain placeholders as source hints and cannot become historical outcomes", async () => {
  const data = fixture();
  const set = data[groupResource].sets[0];
  set.id = "preview_3_-1_0";
  set.state = 1;
  set.winnerId = null;
  set.entrant1Id = "placeholder30";
  set.entrant1IsPlaceholder = true;
  set.slots[0].entrantId = null;
  for (const entity of [data[eventResource], data[groupResource]]) {
    entity.seeds[0].entrantId = "placeholder30";
    entity.seeds[0].projectedEntrantId = 10;
  }
  await assert.rejects(downloadPublicEvent(fakeClient(data), 1), /invalid or duplicate sets IDs/);
  const bundle = await downloadPublicEvent(fakeClient(data), 1, { requireCompleted: false });
  assert.equal(bundle.sets[0].id, "preview_3_-1_0");
  assert.equal(bundle.sets[0].slots[0].entrant, null);
  assert.equal(bundle.sets[0].slots[0].sourcePlaceholderEntrantId, "placeholder30");
  assert.equal(bundle.seeds[0].entrant.id, "placeholder30");
  assert.equal(bundle.seeds[0].projectedEntrantId, 10);
  assert.equal(normalizeEvents([bundle]).sets[0].eligible, false);
});

test("public client reuses verified receipts and rejects changed cached payloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "startgg-public-"));
  try {
    let requests = 0;
    const fetchImpl = async () => { requests++; return { ok: true, status: 200, json: async () => ({ entities: { event: { id: 1 } } }) }; };
    const client = createPublicStartggClient({ cacheDir: directory, minIntervalMs: 0, fetchImpl });
    await client.request("/event/1");
    await client.request("/event/1");
    assert.equal(requests, 1);
    assert.equal(client.receipt("/event/1").transport, "startgg-public-legacy-v1");
    await assert.rejects(client.request("/event/1?token=secret"), /Unsupported/);
    const file = path.join(directory, (await readdir(directory))[0]);
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.response.entities.event.id = 2;
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(client.request("/event/1"), /Invalid public Start.gg cache receipt/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function ladderClient(change = () => {}) {
  const calls = [];
  return { calls, queryReceipt: () => ({ transport: "startgg-public-web-graphql-v1", fetchedAt: "2026-10-16T00:00:00Z" }),
    async webQuery(query, variables) {
      const field = query.includes("PublicStartggLadderSeeds") ? "seeds" : "sets";
      calls.push({ field, page: variables.page });
      const all = Array.from({ length: field === "seeds" ? 26 : 27 }, (_, index) => field === "seeds"
        ? { id: 100 + index, seedNum: index + 1, groupSeedNum: index + 1, isBye: false, progressionSeedId: null,
          phase: { id: 2 }, phaseGroup: { id: 3 }, entrant: { id: 1000 + index, name: `Player ${index}`,
            participants: [{ id: 2000 + index, gamerTag: `Player ${index}`, player: { id: 3000 + index } }] } }
        : { id: 500 + index, state: 3, winnerId: 1000, phaseGroup: { id: 3 },
          slots: [0, 1].map((side) => ({ id: `${500 + index}-${side}`, slotIndex: side, entrant: { id: 1000 + side },
            standing: { stats: { score: { value: index === 0 ? null : side === 0 ? 3 : 1 } } } })) });
      const pageInfo = { page: variables.page, perPage: 25, total: all.length, totalPages: 2 };
      const parent = { id: 3, phase: { id: 2, event: { id: 1 } },
        [field]: { pageInfo, nodes: all.slice((variables.page - 1) * 25, variables.page * 25) } };
      change(parent, field, variables.page);
      return { phaseGroup: parent };
    } };
}

test("public website ladder pages reconcile totals and preserve source identities and missing scores", async () => {
  const client = ladderClient();
  const result = await downloadPublicLadder(client, { id: 3, phaseId: 2 }, 1);
  assert.equal(result.seeds.length, 26);
  assert.equal(result.sets.length, 27);
  assert.equal(result.seeds[0].mutations.participants[2000].playerId, 3000);
  assert.equal(result.sets[0].entrant1Score, null);
  assert.equal(result.sets[1].entrant1Score, 3);
  assert.equal(result.proof.transport, "startgg-public-web-graphql-v1");
  assert.equal(result.proof.authentication, "none");
  assert.deepEqual(client.calls, [{ field: "seeds", page: 1 }, { field: "seeds", page: 2 }, { field: "sets", page: 1 }, { field: "sets", page: 2 }]);
});

test("public website ladder rejects truncated pages, foreign IDs, duplicate rows, and shifting totals", async () => {
  for (const [change, expected] of [
    [(parent, field) => { parent[field].nodes.pop(); }, /truncated/],
    [(parent) => { parent.phase.event.id = 99; }, /identity mismatch/],
    [(parent, field) => { parent[field].nodes[0].phaseGroup.id = 99; }, /Foreign public ladder row/],
    [(parent, field, page) => { if (page === 2) parent[field].nodes[0].id = field === "seeds" ? 100 : 500; }, /Duplicate/],
    [(parent, field, page) => { if (page === 2) parent[field].pageInfo.total++; }, /totals disagree/],
    [(parent, field, page) => { if (page === 2) parent[field].pageInfo.page = 1; }, /totals disagree/],
  ]) await assert.rejects(downloadPublicLadder(ladderClient(change), { id: 3, phaseId: 2 }, 1), expected);
});

test("metadata-only legacy ladders reconcile website seed values and retain their source proof", async () => {
  const data = fixture();
  data[eventResource].groups[0].groupTypeId = 7;
  data[groupResource] = { groups: structuredClone(data[eventResource].groups[0]) };
  const client = fakeClient(data);
  client.queryReceipt = () => ({ transport: "startgg-public-web-graphql-v1", fetchedAt: "2026-10-16T00:00:00Z" });
  let conflict = false;
  client.webQuery = async (query) => {
    const field = query.includes("PublicStartggLadderSeeds") ? "seeds" : "sets";
    const nodes = field === "seeds" ? data[eventResource].seeds.map((seed) => ({
      ...seed, seedNum: conflict ? 999 : seed.seedNum, phase: { id: 2 }, phaseGroup: { id: 3 },
      entrant: { id: seed.entrantId, name: seed.mutations.entrants[seed.entrantId].name,
        participants: [{ id: seed.entrantId + 1, gamerTag: "Source tag", player: { id: seed.entrantId + 2 } }] },
    })) : [{ id: 100, state: 3, winnerId: 10, phaseGroup: { id: 3 },
      slots: [0, 1].map((index) => ({ id: `100-${index}`, slotIndex: index, entrant: { id: index ? 20 : 10 },
        seed: { id: index + 30, seedNum: index + 1 }, standing: { stats: { score: { value: index ? 1 : 3 } } } })) }];
    return { phaseGroup: { id: 3, phase: { id: 2, event: { id: 1 } },
      [field]: { nodes, pageInfo: { page: 1, perPage: 25, total: nodes.length, totalPages: 1 } } } };
  };
  const bundle = await downloadPublicEvent(client, 1);
  assert.equal(normalizeEvents([bundle]).sets[0].eligible, true);
  assert.deepEqual(bundle.entrants.map((entry) => entry.participants[0].player.id), [12, 22]);
  assert.equal(bundle.provenance.publicSourceAudit.publicWebGraphqlGroups[0].collections.sets.total, 1);
  assert.equal(bundle.provenance.requests.filter((receipt) => receipt.transport === "startgg-public-web-graphql-v1").length, 2);
  assert.equal(bundle.provenance.publicSourceAudit.graphqlPaginationValidated, false);
  conflict = true;
  await assert.rejects(downloadPublicEvent(client, 1), /seed values conflict/);
});

test("public website client uses anonymous read-only POSTs and verifies cached results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "startgg-public-web-"));
  try {
    let requests = 0;
    const fetchImpl = async (url, options) => {
      requests++;
      assert.equal(url, "https://www.start.gg/api/-/gql");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.headers, { "Content-Type": "application/json", "client-version": "20" });
      assert.equal(JSON.parse(options.body).operationName, "PublicStartggLadderSeeds");
      return { ok: true, status: 200, json: async () => ({ data: { phaseGroup: { id: 3 } } }) };
    };
    const client = createPublicStartggClient({ cacheDir: directory, minIntervalMs: 0, fetchImpl });
    const query = "query PublicStartggLadderSeeds($groupId: ID!) { phaseGroup(id: $groupId) { id } }";
    const variables = { groupId: 3 };
    await client.webQuery(query, variables);
    await client.webQuery(query, variables);
    assert.equal(requests, 1);
    assert.equal(client.queryReceipt(query, variables).transport, "startgg-public-web-graphql-v1");
    await assert.rejects(client.webQuery("mutation Test { update }", {}), /Unsupported/);
    const file = path.join(directory, (await readdir(directory))[0]);
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.response.success = false;
    envelope.responseHash = digest(JSON.stringify(envelope.response));
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(client.webQuery(query, variables), /Incomplete cached/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
