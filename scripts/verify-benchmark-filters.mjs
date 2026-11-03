/** Exercise archive queries with distinct matchup, stage, and player fixtures. */
import assert from "node:assert/strict";
import { createServer } from "vite";

const MARTH = 9, FOX = 2, PUFF = 15;
const metrics = (attempts) => ({
  durationFrames: 100, damageTotal: 100, neutralWins: 10,
  openingsPerKillSum: 2, openingsPerKillSamples: 1, damagePerOpeningSum: 10,
  damagePerOpeningSamples: 1, inputsPerMinuteSum: 100, inputsPerMinuteSamples: 1,
  lCancelSuccess: 10, lCancelFail: 1, techInPlace: 1, techToward: 1, techAway: 1,
  techMissed: 1, wallTechSuccess: 1, wallTechMissed: 1, actions: {}, playerBalanced: null,
  moves: { 13: { attempts, landed: 5, damage: 100, kills: 1, killPctSum: 100,
    openings: 1, openingDmg: 100, lCancelSuccess: 5, lCancelFail: 1 } },
});
const rows = [];
function row(population, character, opponent, count, attempts, extra = {}) {
  rows.push({
    rollup_key: `row-${rows.length}`, dataset_id: "test", scope: "community", population,
    character_id: character, opponent_character_id: opponent, stage_id: null,
    series_id: null, tournament_id: null, set_id: null, player_id: null,
    game_count: count, win_rate_game_count: count, wins: 1, format: "singles", published: true,
    metrics: metrics(attempts), ...extra,
  });
}
for (const population of ["broad", "conservative"]) {
  row(population, MARTH, null, 100, 1000);
  row(population, MARTH, PUFF, 10, 60);
  row(population, MARTH, FOX, 20, 140);
  row(population, FOX, PUFF, 5, 40);
  row(population, MARTH, PUFF, 3, 999, { stage_id: 31 });
  row(population, MARTH, PUFF, 3, 999, { published: false });
  row(population, MARTH, PUFF, 3, 999, { format: "doubles" });
  row(population, null, null, 999, 999);
}
for (const [player, count, attempts] of [["pro-a", 3, 12], ["pro-b", 7, 42]]) {
  const extra = { scope: "player", player_id: player };
  row("conservative", MARTH, PUFF, count, attempts, extra);
  row("conservative", MARTH, null, 50, 200, extra);
  row("conservative", MARTH, PUFF, 1, 999, { ...extra, stage_id: 31 });
  row("conservative", MARTH, PUFF, 1, 999, { ...extra, tournament_id: "event" });
}
row("conservative", FOX, PUFF, 5, 30, { scope: "player", player_id: "pro-a" });
row("conservative", FOX, null, 20, 60, { scope: "player", player_id: "pro-a" });

globalThis.__ssbmArchiveTestClient = {
  from(table) {
    assert.equal(table, "archive_rollups");
    let selected = [...rows];
    const query = {
      select() { return query; },
      eq(key, value) { selected = selected.filter((r) => r[key] === value); return query; },
      is(key, value) { return query.eq(key, value); },
      in(key, values) { selected = selected.filter((r) => values.includes(r[key])); return query; },
      not(key, op, value) { assert.equal(op, "is"); selected = selected.filter((r) => r[key] !== value); return query; },
      order() { return query; },
      async range(start, end) { return { data: selected.slice(start, end + 1), error: null }; },
    };
    return query;
  },
};
const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "isolated-archive-client",
    enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return "export const supabase = globalThis.__ssbmArchiveTestClient;";
    },
  }],
});
try {
  const { fetchArchiveCommunityBenchmarks: field, fetchArchiveProAggregateAtlasRows: pros } =
    await server.ssrLoadModule("/src/lib/publicArchive.ts");
  const matchup = await field("test", MARTH, "singles", PUFF);
  for (const sample of [matchup.broad, matchup.conservative]) {
    assert.equal(sample.game_count, 10);
    assert.equal(sample.metrics.moves[13].attempts / sample.game_count, 6);
  }
  assert.equal((await field("test", MARTH)).broad.game_count, 100, "clearing Vs restores all opponents");
  assert.equal((await field("test", MARTH, "singles", FOX)).broad.game_count, 20, "changing Vs selects a different matchup");
  const allMe = (await field("test", null, "singles", PUFF)).broad;
  assert.equal(allMe.game_count, 15);
  assert.equal(allMe.metrics.moves[13].attempts, 100, "all Me combines disjoint character samples only");
  assert.equal((await field("test", MARTH, "singles", 99)).broad, null, "missing matchup cannot fall back to all opponents");
  const [pro] = await pros("test", MARTH, "singles", PUFF);
  assert.equal(pro.game_count, 10);
  assert.equal(pro.metrics.moves[13].attempts, 54, "pro average is weighted by player-games");
  assert.equal(pro.identified_player_count, 2);
  const [allPros] = await pros("test", null, "singles", PUFF);
  assert.equal(allPros.game_count, 15);
  assert.equal(allPros.metrics.moves[13].attempts, 84);
  assert.equal(allPros.identified_player_count, 2, "an alt character does not count as another pro");
  assert.equal((await pros("test", MARTH, "singles", null))[0].game_count, 100);
  assert.equal((await pros("test", null))[0].game_count, 120, "existing all-character atlas remains compatible");
  assert.ok((await pros("test", MARTH)).some((r) => r.stage_id === 31), "existing atlas retains its stage rows");
  assert.deepEqual(await pros("test", MARTH, "singles", 99), []);
  for (const item of rows) if (item.opponent_character_id === PUFF) item.metrics.moves = null;
  assert.equal((await field("test", null, "singles", PUFF)).broad.metrics.moves, null);
  assert.equal((await pros("test", null, "singles", PUFF))[0].metrics.moves, null, "old archive rows cannot invent move data");
  // Pooled rows retain small individual-player contributions and exact distinct
  // counts. A missing pooled slice must never fall back to a different cohort.
  const pooled = { scope: "pro", dataset_id: "pooled", identified_player_count: 2 };
  row("conservative", null, null, 140, 400, pooled);
  row("conservative", null, PUFF, 19, 104, pooled);
  row("conservative", MARTH, null, 120, 340, pooled);
  row("conservative", MARTH, PUFF, 14, 74, pooled);
  row("conservative", MARTH, PUFF, 5, 15, { ...pooled, stage_id: 31 });
  row("conservative", MARTH, 99, 99, 999, { dataset_id: "pooled", scope: "player", player_id: "legacy" });
  row("conservative", MARTH, PUFF, 999, 999, { ...pooled, published: false });
  row("conservative", MARTH, PUFF, 999, 999, { ...pooled, format: "doubles" });
  assert.equal((await pros("pooled", MARTH, "singles", PUFF))[0].game_count, 14);
  assert.equal((await pros("pooled", MARTH, "singles", PUFF))[0].metrics.moves[13].attempts, 74);
  const [pooledAll] = await pros("pooled", null);
  assert.equal(pooledAll.game_count, 140);
  assert.equal(pooledAll.metrics.moves[13].attempts, 400, "whole Pro row retains move metrics");
  assert.equal(pooledAll.identified_player_count, 2, "distinct players are not added across characters");
  assert.equal((await pros("pooled", null, "singles", PUFF))[0].game_count, 19);
  assert.equal((await pros("pooled", MARTH)).find(r => r.stage_id === 31).game_count, 5);
  assert.deepEqual(await pros("pooled", MARTH, "singles", 99), [], "missing pooled cells cannot revive legacy rows");
  assert.deepEqual(await pros("pooled", 99), [], "missing character cannot fall back to overall Pro");
  const demo = await server.ssrLoadModule("/src/lib/demo.ts");
  const stats = await server.ssrLoadModule("/src/lib/stats.ts");
  const { demoCommunitySnapshot } = await server.ssrLoadModule("/src/lib/community.ts");
  const games = stats.resolveGames(demo.generateDemoRecords(200), new Set(demo.DEMO_ACCOUNTS.map((a) => a.code)));
  const community = demoCommunitySnapshot([...games, ...games]);
  assert.equal(community.playerGameCount, games.length * 2, "demo includes both sides and deduplicates uploads");
  assert.equal(community.characters.reduce((total, r) => total + r.playerGames, 0), games.length * 2);
  assert.ok(community.characters.some((r) => !games.some((g) => g.me.characterId === r.characterId)), "opponent-only characters appear in demo benchmarks");
  for (const stage of community.characterStages.filter((r) => r.lookbackDays === null && r.gameType === "all")) {
    const expected = games.filter((g) => g.rec.stageId === stage.stageId && g.isWin !== null)
      .reduce((count, g) => count + Number(g.me.characterId === stage.characterId) + Number(g.opp.characterId === stage.characterId), 0);
    assert.equal(stage.games, expected, "demo stage totals include both sides and every opponent before suppression");
  }
  console.log("Archive filters passed: exact slices, pooled Pro contributions/counts, missing data, legacy compatibility, and community sides.");
} finally {
  await server.close();
  delete globalThis.__ssbmArchiveTestClient;
}
