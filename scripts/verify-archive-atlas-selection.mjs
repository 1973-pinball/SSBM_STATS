/**
 * Exercise the real Atlas hook with deferred requests and React's test renderer.
 * The optional --renderer path can point to an isolated installation using the
 * workspace's React package; no browser, Supabase, or parser inputs are needed.
 * --baseline reads the committed component to prove this catches the old race.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createServer } from "vite";

const args = process.argv.slice(2);
const rendererIndex = args.indexOf("--renderer");
const rendererModule = rendererIndex < 0 ? "react-test-renderer"
  : pathToFileURL(resolve(args[rendererIndex + 1])).href;
const { default: TestRenderer } = await import(rendererModule);
const baseline = args.includes("--baseline")
  ? execFileSync("git", ["show", "HEAD:src/components/CommunityArchiveAtlas.tsx"], { encoding: "utf8" }) : null;
const pending = [];
const request = (kind, datasetId, characterId, playerId = null) => new Promise((fulfill, reject) => {
  pending.push({ kind, datasetId, characterId, playerId, fulfill, reject, done: false });
});
const fixtureKey = "__archiveAtlasSelectionFixture";
globalThis[fixtureKey] = {
  dataset: { id: "test-v9" },
  pros: ["alpha", "beta"].map((id) => ({ id, display_name: id, observed_character_ids: [2, 8, 9, 10, 20] })),
  request,
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const server = await createServer({
  configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "isolated-atlas-selection",
    enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return "export const supabase = null;";
      if (id.endsWith("/src/lib/publicArchive.ts")) return `
        const fixture = globalThis.${fixtureKey};
        export const archiveRankingLabel = () => "";
        export const fetchLatestArchiveDataset = async () => fixture.dataset;
        export const fetchArchiveCommunityProOptions = async () => fixture.pros;
        export const fetchArchiveCommunityAtlasRows = (dataset, character) => fixture.request("field", dataset, character);
        export const fetchArchiveProAggregateAtlasRows = (dataset, character) => fixture.request("aggregate", dataset, character);
        export const fetchArchivePlayerAtlasRows = (dataset, player, character) => fixture.request("player", dataset, character, player);
      `;
    },
    transform(source, id) {
      if (id.endsWith("/src/components/CommunityArchiveAtlas.tsx")) {
        return `${baseline ?? source}\nexport { useArchiveAtlas as testUseArchiveAtlas };`;
      }
    },
  }],
});

let root;
let current;
let characterId = 2;
const renders = [];
const rowsFor = (entry) => [{
  dataset_id: entry.datasetId, character_id: entry.characterId,
  player_id: entry.playerId, id: `${entry.kind}:${entry.characterId}:${entry.playerId ?? "all"}`,
}];
const take = (kind, character, player = null) => {
  const entry = pending.find((value) => !value.done && value.kind === kind
    && value.characterId === character && value.playerId === player);
  assert.ok(entry, `expected pending ${kind}:${character}:${player}`);
  entry.done = true;
  return entry;
};
const fulfill = async (kind, character, player = null) => act(async () => {
  const entry = take(kind, character, player);
  entry.fulfill(rowsFor(entry));
});
const reject = async (kind, character, player = null) => act(async () => {
  take(kind, character, player).reject(new Error("Controlled archive failure"));
});
const assertAligned = () => {
  for (const snapshot of renders) {
    for (const field of ["fieldRows", "proAggregateRows", "proRows"]) {
      for (const row of snapshot[field]) {
        assert.equal(row.dataset_id, snapshot.datasetId, `${field}: stale dataset`);
        assert.equal(row.character_id, snapshot.characterId, `${field}: stale character on a committed render`);
        if (field === "proRows") assert.equal(row.player_id, snapshot.playerId, "stale named player on a committed render");
      }
    }
  }
};

try {
  const { testUseArchiveAtlas } = await server.ssrLoadModule("/src/components/CommunityArchiveAtlas.tsx");
  function Probe({ character }) {
    current = testUseArchiveAtlas(character);
    renders.push({
      characterId: character, datasetId: current.dataset?.id, playerId: current.playerId,
      fieldRows: current.fieldRows, proAggregateRows: current.proAggregateRows, proRows: current.proRows,
      error: current.error, loading: current.loading,
    });
    return createElement("output", null, JSON.stringify(renders.at(-1)));
  }
  const chooseCharacter = async (next) => {
    characterId = next;
    await act(async () => root.update(createElement(Probe, { character: next })));
    assertAligned();
  };
  const choosePlayer = async (next) => {
    await act(async () => current.setPlayerId(next));
    assertAligned();
  };
  await act(async () => { root = TestRenderer.create(createElement(Probe, { character: characterId })); });
  assert.equal(current.loading, true);
  await fulfill("field", 2);
  assert.deepEqual(current.fieldRows, [], "a partially resolved cohort must stay pending");
  await fulfill("aggregate", 2);
  assert.equal(current.loading, false);
  assert.equal(current.fieldRows[0].character_id, 2);

  await choosePlayer("alpha");
  await fulfill("player", 2, "alpha");
  assert.equal(current.proRows[0].player_id, "alpha");
  await choosePlayer("beta");
  assert.deepEqual(current.proRows, [], "new player must not reuse the old player's values");
  assert.equal(current.fieldRows[0].character_id, 2, "player changes preserve the current field cohort");
  await fulfill("player", 2, "beta");

  await chooseCharacter(20);
  assert.deepEqual(current.fieldRows, []);
  assert.deepEqual(current.proAggregateRows, []);
  assert.deepEqual(current.proRows, []);
  assert.equal(current.loading, true);
  await chooseCharacter(8);
  await fulfill("field", 8);
  await fulfill("aggregate", 8);
  await fulfill("player", 8, "beta");
  // Requests for the previous character finish last, after current values exist.
  await fulfill("field", 20);
  await fulfill("aggregate", 20);
  await fulfill("player", 20, "beta");
  assert.equal(current.fieldRows[0].character_id, 8);
  assert.equal(current.proRows[0].character_id, 8);

  await choosePlayer("alpha");
  await choosePlayer(null);
  await fulfill("player", 8, "alpha");
  assert.deepEqual(current.proRows, [], "deselected player's late response must be ignored");
  await choosePlayer("beta");
  await reject("player", 8, "beta");
  assert.deepEqual(current.proRows, []);
  assert.equal(current.fieldRows[0].character_id, 8, "failed named-player request preserves field comparisons");
  await choosePlayer(null);

  await chooseCharacter(9);
  await reject("field", 9);
  await fulfill("aggregate", 9);
  assert.equal(current.loading, false);
  assert.ok(current.error);
  const beforeRetry = renders.length;
  await chooseCharacter(10);
  assert.ok(renders.slice(beforeRetry).every((snapshot) => snapshot.error === null), "previous character's error must not appear under new filters");
  assert.equal(current.loading, true);
  await fulfill("field", 10);
  await fulfill("aggregate", 10);
  assert.equal(current.error, null);
  assert.equal(current.loading, false);
  await chooseCharacter(-1);
  assert.deepEqual(current.fieldRows, []);
  assert.deepEqual(current.proAggregateRows, []);
  assert.deepEqual(current.proRows, []);
  assert.equal(current.loading, false);
  assertAligned();
  console.log(`Atlas selection regression passed (${renders.length} renders): character/player changes, late responses, failures, and cleared selection.`);
} finally {
  if (root) await act(async () => root.unmount());
  await server.close();
  delete globalThis[fixtureKey];
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
}
