/** Render competing source fixtures to verify the consolidated benchmark columns. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "isolated-consolidated-baseline-components", enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return "export const supabase = null;";
    },
    transform(source, id) {
      if (id.endsWith("/src/components/CommunityArchiveAtlas.tsx")) {
        const call = "const archive = useArchiveAtlas(characterId);";
        assert.equal(source.split(call).length - 1, 3, "inject the same source into all three Atlas views");
        return source.replaceAll(call, "const archive = globalThis.__ssbmBenchmarkUiFixture;");
      }
      if (id.endsWith("/src/components/Views.tsx")) {
        return source + "\nexport { executionBenchmarkValue as testExecutionBenchmarkValue, EXECUTION_BENCHMARK_STYLES as testBenchmarkStyles, MovesSection as TestMovesSection };\n";
      }
    },
  }],
});

const metrics = {
  durationFrames: 3_600, damageTotal: 300, neutralWins: 20,
  lCancelSuccess: 30, lCancelFail: 10,
  techInPlace: 10, techToward: 10, techAway: 10, techMissed: 10,
  wallTechSuccess: 0, wallTechMissed: 0,
  openingsPerKillSum: 6, openingsPerKillSamples: 2,
  damagePerOpeningSum: 60, damagePerOpeningSamples: 2,
  inputsPerMinuteSum: 300, inputsPerMinuteSamples: 2,
  actions: { wavedashes: 80 },
  // Deliberately disagree: Tournament must pool measured opportunities.
  playerBalanced: { lCancel: { equalWeightMean: 0.99, qualifiedPlayers: 8 } },
  moves: { 13: {
    attempts: 400, landed: 200, damage: 300, kills: 10, killPctSum: 900,
    openings: 80, openingDmg: 400, lCancelSuccess: 30, lCancelFail: 10,
  } },
};
const row = (population, opponent, stage, overrides = {}) => ({
  rollup_key: `${population}:${opponent}:${stage}`, dataset_id: "test", scope: "community",
  population, format: "singles", player_id: null, character_id: 20,
  opponent_character_id: opponent, stage_id: stage, game_count: 40,
  wins: 30, win_rate_game_count: 40, metrics, ...overrides,
});
const broad = row("broad", null, null);
const conservative = row("conservative", null, null, {
  game_count: 7, wins: 0, win_rate_game_count: 7,
  metrics: { ...metrics, moves: { 13: { ...metrics.moves[13], landed: 700 } } },
});
const pro = row("conservative", null, null, { scope: "pro", game_count: 10, wins: 5, win_rate_game_count: 10, identified_player_count: 2 });
const plain = text => {
  // Removing one tag can expose another; reach a fixed point before comparing
  // trusted SSR fixture text. This helper is not used to render untrusted HTML.
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== previous);
  return text.replace(/&amp;/g, "&");
};
assert.equal(plain("<scr<script>ipt>fixture</scr<script>ipt>"), "fixture", "nested tags cannot be reconstructed by text extraction");
const tableRows = markup => [...markup.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
  .map(match => [...match[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(cell => plain(cell[1])));

try {
  const demo = await server.ssrLoadModule("/src/lib/demo.ts");
  const stats = await server.ssrLoadModule("/src/lib/stats.ts");
  const { CURRENT_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const record = structuredClone(demo.generateDemoRecords(20).find(game => !game.isTeams));
  assert.ok(record);
  record.statsVersion = CURRENT_STATS_VERSION;
  record.stageId = 31;
  record.players[0].connectCode = "TEST#1";
  record.players[0].characterId = 20;
  record.players[0].moveStats = { 13: { attempts: 4, landed: 2, damage: 30, kills: 1, killPctSum: 90, openings: 2, openingDmg: 40, lcSuccess: 3, lcFail: 1 } };
  record.players[1].connectCode = "OTHER#2";
  record.players[1].characterId = 2;
  const games = stats.resolveGames([record], new Set(["TEST#1"]));
  assert.equal(games.length, 1);
  globalThis.__ssbmBenchmarkUiFixture = {
    dataset: null, pros: [], characterPros: [], selectedPro: null,
    playerId: null, setPlayerId() {}, loading: false, error: null,
    fieldRows: [broad, conservative,
      { ...broad, opponent_character_id: 2 }, { ...conservative, opponent_character_id: 2 },
      { ...broad, stage_id: 31 }, { ...conservative, stage_id: 31 }],
    proAggregateRows: [pro, { ...pro, opponent_character_id: 2 }, { ...pro, stage_id: 31 }], proRows: [],
  };
  const atlas = await server.ssrLoadModule("/src/components/CommunityArchiveAtlas.tsx");
  const render = (component, extra = {}) => renderToStaticMarkup(createElement(component, {
    games, characterId: 20, lookbackGames: 150, communityRows: [], ...extra,
  }));
  const matchup = render(atlas.ArchiveMatchupAtlasComparison, { stageId: 0, gameType: "all" });
  const matchupRows = tableRows(matchup);
  assert.equal(matchupRows[0].length, 6, "one Tournament and one Pro Tournament column");
  assert.match(matchupRows[0][4], /^Tournament/);
  assert.match(matchupRows[1][4], /^75.*40 games$/, "Tournament uses broad wins/count, not conservative or added samples");
  assert.match(matchupRows[1][5], /^50.*10 games$/, "Pro remains independently scoped");
  const stage = render(atlas.ArchiveStageAtlasComparison, { opponentId: null, communityCharacterStages: [] });
  const stageRows = tableRows(stage);
  assert.equal(stageRows[0].length, 5);
  assert.match(stageRows[1][3], /^75.*40 games$/);
  const move = render(atlas.ArchiveMoveAtlasComparison);
  const moveRows = tableRows(move);
  assert.equal(moveRows[0].length, 5);
  assert.match(moveRows[0][3], /^Tournament.*40 player-games$/);
  assert.equal(moveRows[1][3], "5.00", "landed/game uses broad 200/40, never conservative 700/7");
  const lCancel = moveRows.find(cells => cells[0] === "L-cancel success");
  assert.ok(lCancel);
  assert.match(lCancel[3], /^75/, "Atlas pooled L-cancel ignores the unequal source estimator");
  for (const markup of [matchup, stage, move]) {
    assert.doesNotMatch(markup, /Venue archive|Tournament archive/);
    assert.match(markup, /SSBMStats Community/);
    assert.match(markup, /Pro Tournament/);
  }

  const views = await server.ssrLoadModule("/src/components/Views.tsx");
  assert.deepEqual(views.testBenchmarkStyles.map(source => source.label), ["SSBMStats Community", "Tournament", "Pro Tournament"]);
  const benchmarks = { characterId: 20, opponentCharacterId: null, tournament: broad, pro, communityMoves: [], communityBenchmark: { lCancel: { p50: 61 } }, communityExecution: null };
  assert.equal(views.testExecutionBenchmarkValue(benchmarks, "tournament", "lCancel"), 75);
  assert.equal(views.testExecutionBenchmarkValue(benchmarks, "community", "lCancel"), 61, "Community median is preserved");
  assert.equal(views.testExecutionBenchmarkValue({ ...benchmarks, tournament: null }, "tournament", "lCancel"), null);
  const moves = stats.moveTable(games);
  const execution = renderToStaticMarkup(createElement(views.TestMovesSection, {
    games, career: moves, recent: moves, benchmarks, metric: "landedPerGame", setMetric() {}, interactionPanel: null,
  }));
  assert.doesNotMatch(execution, /Venue/);
  assert.match(execution, /Pro Tournament/);
  assert.match(execution, /SSBMStats Community/);
  const effectiveness = tableRows(execution).find(cells => cells[0] === "Neutral air" && cells.length === 8);
  assert.ok(effectiveness, "Execution effectiveness has eight columns after consolidation");
  assert.equal(effectiveness[3], "5.0");
  console.log("Consolidated baseline UI passed: broad-only Tournament, independent Pro, pooled rates, Community medians, and consistent tables/reference labels.");
} finally {
  delete globalThis.__ssbmBenchmarkUiFixture;
  await server.close();
}
