/** Render competing source fixtures to verify the consolidated benchmark columns. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "isolated-consolidated-baseline-components", enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return "export const supabase = null;";
    },
    transform(source, id) {
      if (id.endsWith("/src/lib/rankedBenchmarks.ts")) return source.replace("export function useRankedBenchmarkRows(characterId: number | null): RankedBenchmarkState {", "export function useRankedBenchmarkRows(characterId: number | null): RankedBenchmarkState { return globalThis.__ssbmRankedUiFixture;");
      if (id.endsWith("/src/components/CommunityArchiveAtlas.tsx")) {
        const call = "const archive = useArchiveAtlas(characterId);";
        assert.equal(source.split(call).length - 1, 3, "inject the same source into all three Atlas views");
        return source.replaceAll(call, "const archive = globalThis.__ssbmBenchmarkUiFixture;");
      }
      if (id.endsWith("/src/components/Community.tsx")) return source + "\nexport { MatchupAtlas as TestMatchupAtlas, MoveAtlas as TestMoveAtlas, StageLab as TestStageLab, CommunityBenchmarks as TestCommunityBenchmarks };\n";
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
const rankedRow = (tier, count, wins, landed) => ({
  tier, characterId: 20, opponentCharacterId: null, stageId: null,
  playerGames: count, distinctGames: count, decidedPlayerGames: count, wins, uniquePlayers: null,
  metrics: { ...metrics, playerBalanced: null, lCancelSuccess: wins, lCancelFail: count - wins,
    moves: { 13: { ...metrics.moves[13], landed } } },
  coverage: { statsPlayerGames: count, statsDurationFrames: 3600, actionPlayerGames: count, actionDurationFrames: 3600, movePlayerGames: count, moveDurationFrames: 3600,
    metrics: {}, actions: {}, moves: { 13: { attempts: { playerGames: count, durationFrames: 3600 } } } },
  interactions: { games: count, defenseGames: 0, recoveryGames: 0, punishGames: 0, ledge: {}, oos: {}, shieldExits: {}, recoveries: {}, edgeguards: {}, beforeOpening: {} },
});
const diamond = rankedRow("diamond", 10, 2, 30), master = rankedRow("master", 20, 16, 160);
const rankedRows = row => [row, { ...row, opponentCharacterId: 24 }, { ...row, opponentCharacterId: 2 }, { ...row, stageId: 31 }, { ...row, opponentCharacterId: 2, stageId: 31 }];
globalThis.__ssbmRankedUiFixture = { characterId: 20, manifest: null, loading: false, error: null, rows: { diamond: rankedRows(diamond), master: rankedRows(master) } };
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
  assert.equal(matchupRows[0].length, 8, "five benchmark columns remain distinct");
  assert.match(matchupRows[1][3], /^20.*10 player-games$/);
  assert.match(matchupRows[1][4], /^80.*20 player-games$/);
  assert.match(matchupRows[0][6], /^Tournament/);
  assert.match(matchupRows[1][6], /^75.*40 player-games$/, "Tournament uses broad wins/count, not conservative or added samples");
  assert.match(matchupRows[1][7], /^50.*10 player-games$/, "Pro remains independently scoped");
  const rankedOnlyOpponent = matchupRows.find(cells => cells[0] === "Pichu");
  assert.ok(rankedOnlyOpponent, "ranked-only opponents are visible even when local games exist");
  assert.equal(rankedOnlyOpponent[2], "—"); assert.match(rankedOnlyOpponent[3], /^20/);
  const stage = render(atlas.ArchiveStageAtlasComparison, { opponentId: null, communityCharacterStages: [] });
  const stageRows = tableRows(stage);
  assert.equal(stageRows[0].length, 7);
  assert.match(stageRows[1][2], /^20.*10 player-games$/);
  assert.match(stageRows[1][5], /^75.*40 player-games$/);
  const move = render(atlas.ArchiveMoveAtlasComparison);
  const moveRows = tableRows(move);
  assert.equal(moveRows[0].length, 7);
  assert.equal(moveRows[1][2], "3.00", "Diamond uses its own pooled counters");
  assert.equal(moveRows[1][3], "8.00", "Master uses its own pooled counters");
  assert.match(moveRows[0][5], /^Tournament.*40 player-games$/);
  assert.equal(moveRows[1][5], "5.00", "landed/game uses broad 200/40, never conservative 700/7");
  const noLocalMoveRows = tableRows(render(atlas.ArchiveMoveAtlasComparison, { games: [] }));
  const noLocalNair = noLocalMoveRows.find(cells => cells[0] === "Neutral air");
  assert.ok(noLocalNair, "ranked move rows remain browsable for characters without local games");
  assert.equal(noLocalNair[1], "—"); assert.equal(noLocalNair[2], "3.00");
  const lCancel = moveRows.find(cells => cells[0] === "L-cancel success");
  assert.ok(lCancel);
  assert.match(lCancel[5], /^75/, "Atlas pooled L-cancel ignores the unequal source estimator");
  for (const markup of [matchup, stage, move]) {
    assert.doesNotMatch(markup, /Venue archive|Tournament archive/);
    assert.match(markup, /Diamond Slippi/);
    assert.match(markup, /Master Slippi/);
    assert.match(markup, /SSBMStats Community/);
    assert.match(markup, /Pro Tournament/);
  }

  const views = await server.ssrLoadModule("/src/components/Views.tsx");
  assert.deepEqual(views.testBenchmarkStyles.map(source => source.label), ["Diamond Slippi", "Master Slippi", "SSBMStats Community", "Tournament", "Pro Tournament"]);
  const { rankedMetricRow } = await server.ssrLoadModule("/src/lib/rankedBenchmarks.ts");
  const benchmarks = { diamond: rankedMetricRow(diamond), master: rankedMetricRow(master), stageId: null, characterId: 20, opponentCharacterId: null, tournament: broad, pro, communityMoves: [], communityBenchmark: { lCancel: { p50: 61 } }, communityExecution: null };
  assert.equal(views.testExecutionBenchmarkValue(benchmarks, "diamond", "lCancel"), 20);
  assert.equal(views.testExecutionBenchmarkValue(benchmarks, "master", "lCancel"), 80);
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
  const effectiveness = tableRows(execution).find(cells => cells[0] === "Neutral air" && cells.length === 10);
  assert.ok(effectiveness, "Execution effectiveness includes both ranked tiers");
  assert.equal(effectiveness[2], "3.0");
  assert.equal(effectiveness[3], "8.0");
  assert.equal(effectiveness[5], "5.0");
  const healthyArchive = globalThis.__ssbmBenchmarkUiFixture;
  globalThis.__ssbmBenchmarkUiFixture = { ...healthyArchive, fieldRows: [], proAggregateRows: [], error: "Tournament unavailable", loading: false };
  const independent = tableRows(render(atlas.ArchiveMatchupAtlasComparison, { stageId: 0, gameType: "all" }));
  assert.match(independent[1][3], /^20.*10 player-games$/, "ranked comparisons survive a tournament outage");
  assert.equal(independent[1][6], "—");
  globalThis.__ssbmBenchmarkUiFixture = healthyArchive;
  const headline = await server.ssrLoadModule("/src/components/ArchiveCommunityBenchmark.tsx");
  const headlineMarkup = render(headline.ArchiveCommunityBenchmark, { communityMoves: [] });
  assert.match(headlineMarkup, /Diamond Slippi/); assert.match(headlineMarkup, /Master Slippi/);
  const communityViews = await server.ssrLoadModule("/src/components/Community.tsx");
  const emptySnapshot = { characters: [], matchups: [], characterStages: [], moves: [], execution: [], benchmarks: [] };
  for (const component of [communityViews.TestMatchupAtlas, communityViews.TestMoveAtlas, communityViews.TestStageLab, communityViews.TestCommunityBenchmarks]) {
    const markup = render(component, { snapshot: emptySnapshot, lookbackGames: 150, lookbackInput: "150", setLookbackInput() {} });
    const characterPicker = /<label>Character<select[^>]*>(.*?)<\/select>/s.exec(markup)?.[1];
    assert.ok(characterPicker); assert.equal([...characterPicker.matchAll(/<option\b/g)].length, 26, "all ranked character shards are browsable without community samples");
    assert.match(characterPicker, /Pichu/); assert.match(characterPicker, /Bowser/); assert.match(characterPicker, /Kirby/);
  }
  const { recommendations } = await server.ssrLoadModule("/src/lib/coach.ts");
  const coachRecords = Array.from({ length: 120 }, (_, i) => {
    const game = structuredClone(record);
    game.id = "coach-" + i; game.playedAt = new Date(Date.UTC(2026, 0, 1, 0, i * 2)).toISOString();
    game.winnerIndex = i < 60 ? 1 : 0;
    game.players[0].moveStats = {
      13: { ...record.players[0].moveStats[13], landed: i < 60 ? 90 : 10, damage: i < 60 ? 180 : 20 },
      15: { ...record.players[0].moveStats[13], landed: i < 60 ? 10 : 90, damage: i < 60 ? 20 : 180 },
    };
    return game;
  });
  const coachGames = stats.resolveGames(coachRecords, new Set(["TEST#1"]));
  const coachReference = { characterId: 20, gameCount: 200, landedByMove: { nair: 10, bair: 90 }, sourceLabel: "Diamond Slippi" };
  const rankedAdvice = recommendations(coachGames, Infinity, { tournamentMoveBenchmarks: [coachReference] }).find(row => row.kind === "move");
  assert.ok(rankedAdvice, "biased move fixture reaches the existing evidence gate");
  assert.match(rankedAdvice.detail, /Diamond Slippi Falco player-games/);
  assert.doesNotMatch(rankedAdvice.detail, /Tournament Falco player-games/);
  const localAdvice = recommendations(coachGames, Infinity, { tournamentMoveBenchmarks: [] }).find(row => row.kind === "move");
  assert.ok(localAdvice); assert.doesNotMatch(localAdvice.detail, /Diamond Slippi|Master Slippi|Tournament/);
  console.log("Consolidated baseline UI passed: broad-only Tournament, independent Pro, pooled rates, Community medians, and consistent tables/reference labels.");
} finally {
  delete globalThis.__ssbmBenchmarkUiFixture;
  delete globalThis.__ssbmRankedUiFixture;
  await server.close();
}
