/** Verify special-move measurements and the denominators used in comparisons. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "isolated-move-comparison-components",
    enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return "export const supabase = null;";
    },
    transform(source, id) {
      // Expose the presentation shell only in this verification server, so its
      // loading/error behavior can be checked without production test exports.
      if (id.endsWith("/src/components/CommunityArchiveAtlas.tsx")) {
        return `${source}\nexport { ArchiveFrame as TestArchiveFrame, localMoveMetric as testLocalMoveMetric, archiveMoveMetric as testArchiveMoveMetric };\n`;
      }
      if (id.endsWith("/src/components/ArchiveCommunityBenchmark.tsx")) {
        return `${source}\nexport { archiveMoveMetric as testLegacyArchiveMoveMetric, formatCommunityMove as testLegacyCommunityMove };\n`;
      }
      if (id.endsWith("/src/components/Views.tsx")) {
        return `${source}\nexport { MoveMetricChart as TestMoveMetricChart, hasOpponentMoveMetric as testHasOpponentMoveMetric };\n`;
      }
    },
  }],
});

const close = (actual, expected, message) => {
  if (expected === null) assert.equal(actual, null, message);
  else assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, received ${actual}`);
};
const move = (fields = {}) => ({
  landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0,
  lcSuccess: 0, lcFail: 0, ...fields,
});
const metricKeys = [
  "attemptsPerGame", "noHitPerGame", "noHitRate", "landedPerGame", "dmgPerGame", "dmgShare", "avgDmgPerHit",
  "killsPerGame", "killShare", "avgKillPct", "lCancelPct",
];
const tableValue = (row, metric, covered) => ({
  attemptsPerGame: row.attemptsPerGame,
  noHitPerGame: row.noHitPerGame,
  noHitRate: row.noHitRate === null ? null : row.noHitRate * 100,
  landedPerGame: row.landedPerGame,
  dmgPerGame: row.dmgPerGame,
  dmgShare: row.dmgShare === null ? null : row.dmgShare * 100,
  avgDmgPerHit: row.avgDmgPerHit,
  killsPerGame: covered ? row.kills / covered : null,
  killShare: row.killShare === null ? null : row.killShare * 100,
  avgKillPct: row.avgKillPct,
  lCancelPct: row.lCancelPct === null ? null : row.lCancelPct * 100,
})[metric];

try {
  const stats = await server.ssrLoadModule("/src/lib/stats.ts");
  const demo = await server.ssrLoadModule("/src/lib/demo.ts");
  const { CURRENT_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const { moveGroup, moveGroupTracksAttempts, specialMoveId } = await server.ssrLoadModule("/src/lib/melee.ts");
  const { archiveMoveBenchmark, archiveMoveComparisonGames, archiveMoveSample, communityMoveBenchmark, localMoveMetric, localMoveComparisonGames, localMoveSample } =
    await server.ssrLoadModule("/src/lib/executionMoveBenchmarks.ts");

  const base = demo.generateDemoRecords(1).find((record) => !record.isTeams);
  assert.ok(base, "fixture needs a complete singles record");
  const record = (index, moves, mode = "current") => {
    const result = structuredClone(base);
    result.id = `move-comparison-${index}`;
    result.playedAt = new Date(Date.UTC(2026, 9, 1 + index)).toISOString();
    result.statsVersion = CURRENT_STATS_VERSION;
    result.players[0].connectCode = "LOCAL#1";
    result.players[0].characterId = 20;
    result.players[0].moveStats = moves;
    result.players[1].connectCode = "OPPONENT#2";
    if (mode === "legacy") delete result.statsVersion;
    if (mode === "preview") {
      result.statsLevel = "header";
      delete result.players[0].moveStats;
    }
    return result;
  };
  const records = [
    record(0, {
      21: move({ landed: 4, damage: 20, kills: 1, killPctSum: 90, openings: 2, openingDmg: 55 }),
      13: move({ attempts: 5, landed: 2, damage: 30, kills: 1, killPctSum: 100, lcSuccess: 4, lcFail: 1 }),
    }),
    record(1, { 13: move({ attempts: 3, landed: 1, damage: 10, lcSuccess: 2, lcFail: 1 }) }),
    record(2, {
      21: move({ landed: 2, damage: 12 }),
      13: move({ landed: 7, damage: 60, lcSuccess: 3, lcFail: 1 }),
    }, "legacy"),
    record(3, {}, "preview"),
  ];
  const games = stats.resolveGames(records, new Set(["LOCAL#1"]));
  assert.equal(games.length, 4);
  const table = stats.moveTable(games);
  assert.equal(table.covered, 3, "header previews cannot dilute per-game rates");
  const downB = table.rows.find((row) => row.key === "down-b");
  assert.ok(downB, "Down B must survive move aggregation");
  assert.equal(downB.label, "Down B");
  assert.equal(downB.landed, 6);
  assert.equal(downB.damage, 32);
  assert.equal(downB.kills, 1);
  assert.equal(downB.openings, 2);
  assert.equal(downB.dmgPerOpening, 27.5);
  assert.equal(downB.landedPerGame, 2, "a measured game without Down B contributes zero uses");
  close(downB.dmgShare, 32 / 132, "damage share covers the whole measured arsenal");
  assert.equal(downB.attempts, null, "landed Down B hits cannot stand in for initiations");
  assert.equal(downB.attemptsPerGame, null);
  const nair = table.rows.find((row) => row.key === "nair");
  assert.equal(nair.attemptsPerGame, 4, "legacy rows without attempts cannot dilute tracked attempts");

  for (const [id, key] of [[18, "neutral-b"], [19, "side-b"], [20, "up-b"], [21, "down-b"]]) {
    assert.equal(moveGroup(id).key, key);
    assert.equal(moveGroupTracksAttempts(key), false);
    const placeholder = record(10 + id, {
      [id]: move({ landed: 3, damage: 18, attempts: 0 }),
    });
    placeholder.statsVersion = 3;
    const special = stats.resolveGames([placeholder], new Set(["LOCAL#1"]));
    assert.equal(stats.moveTable(special).rows[0].attempts, null,
      `${key}: historical placeholder zeros cannot become supported attempt counts`);
    assert.equal(stats.moveMetricSeries(special, key, "attemptsPerGame").at(-1).value, null);
  }

  const tracked = (fields = {}) => move({ attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0, ...fields });
  const specialKeys = ["neutral-b", "side-b", "up-b", "down-b"];
  specialKeys.forEach((key, index) => assert.equal(specialMoveId(key), 18 + index));
  assert.equal(specialMoveId("nair"), null);
  const v4 = record(20, {
    18: move({ attempts: 0, landed: 9 }),
    19: tracked({ attempts: 500, hitAttempts: 99, noHitAttempts: 400, incompleteAttempts: 1, landed: 9 }),
    20: move({ attempts: 0, landed: 9 }),
    21: tracked({ attempts: 3, hitAttempts: 1, noHitAttempts: 2, landed: 9 }),
  });
  v4.statsVersion = 4;
  const v5 = structuredClone(v4);
  v5.id = "unsafe-v5-special-counts";
  v5.statsVersion = 5;
  const v6first = record(21, {
    18: move({ attempts: 8 }), // projectile: no per-use damage outcomes
    19: tracked({ attempts: 6, hitAttempts: 2, noHitAttempts: 3, incompleteAttempts: 1, landed: 20 }),
    20: tracked(),
    21: tracked({ attempts: 3, hitAttempts: 1, noHitAttempts: 2 }),
  });
  v6first.statsVersion = 6;
  const v6second = record(22, {
    // Missing Neutral B coverage is not a measured zero, even in a v6 game.
    19: tracked(),
    20: tracked({ attempts: 5, hitAttempts: 1, noHitAttempts: 2, incompleteAttempts: 2 }),
    21: move({ attempts: 4 }),
  });
  v6second.statsVersion = 6;
  const specialPreview = record(23, { 18: tracked({ attempts: 90, noHitAttempts: 90 }) }, "preview");
  const specialGames = stats.resolveGames([v4, v5, v6first, v6second, specialPreview], new Set(["LOCAL#1"]));
  const specialTable = stats.moveTable(specialGames);
  assert.equal(specialTable.covered, 4);
  const specialExpected = {
    "neutral-b": { attempts: 8, attemptGames: 1, outcomes: 0, perGame: 8, noHitPerGame: null, rate: null },
    "side-b": { attempts: 6, attemptGames: 2, outcomes: 2, perGame: 3, noHitPerGame: 1.5, rate: 3 / 5 },
    "up-b": { attempts: 5, attemptGames: 2, outcomes: 2, perGame: 2.5, noHitPerGame: 1, rate: 2 / 3 },
    "down-b": { attempts: 7, attemptGames: 2, outcomes: 1, perGame: 7 / 2, noHitPerGame: 2, rate: 2 / 3 },
  };
  for (const key of specialKeys) {
    const row = specialTable.rows.find((value) => value.key === key);
    const expected = specialExpected[key];
    assert.ok(row, `${key}: attempts-only and legacy-landed rows are retained`);
    assert.equal(row.attempts, expected.attempts, `${key}: version-specific attempts`);
    assert.equal(row.attemptGames, expected.attemptGames, `${key}: only explicit capable games count`);
    assert.equal(row.outcomeGames, expected.outcomes);
    close(row.attemptsPerGame, expected.perGame, `${key}: attempts denominator`);
    close(row.noHitPerGame, expected.noHitPerGame, `${key}: completed-use game sample`);
    close(row.noHitRate, expected.rate, `${key}: matched completed uses`);
    for (const metric of metricKeys) close(stats.moveMetricSeries(specialGames, key, metric).at(-1).value,
      tableValue(row, metric, specialTable.covered), `${key}/${metric}: mixed v4/v5/v6 table/trend parity`);
    const zeroGame = record(30, { [specialMoveId(key)]: tracked() });
    zeroGame.statsVersion = 6;
    const zeroRow = stats.moveTable(stats.resolveGames([zeroGame], new Set(["LOCAL#1"]))).rows[0];
    assert.equal(zeroRow.attemptsPerGame, 0, `${key}: measured zero survives without landed hits`);
    assert.equal(zeroRow.noHitPerGame, 0);
    assert.equal(zeroRow.noHitRate, null);
    assert.equal(localMoveSample(zeroRow, "attemptsPerGame"), "1 tracked games");
  }
  for (const old of [v4, v5]) {
    const oldGames = stats.resolveGames([old], new Set(["LOCAL#1"]));
    const oldSpecialRows = stats.moveTable(oldGames).rows;
    for (const key of specialKeys) {
      const row = oldSpecialRows.find((value) => value.key === key);
      assert.equal(row.landed, 9, `${key}: legacy landed measurements remain available`);
      assert.equal(row.attemptsPerGame, null, `${key}: v${old.statsVersion} cannot prove complete replay coverage`);
      assert.equal(row.noHitRate, null);
      assert.equal(localMoveSample(row, "attemptsPerGame"), "No tracked games");
      assert.equal(localMoveSample(row, "noHitRate"), "No tracked games");
      assert.equal(stats.moveMetricSeries(oldGames, key, "attemptsPerGame").at(-1).value, null);
      assert.equal(stats.moveMetricSeries(oldGames, key, "noHitRate").at(-1).value, null);
    }
  }
  const attemptRecords = [
    record(1, { 21: tracked({ attempts: 10, hitAttempts: 3, noHitAttempts: 5, incompleteAttempts: 2, landed: 20, damage: 40 }) }),
    record(2, { 21: tracked() }),
    record(3, { 21: move({ attempts: 4 }) }), // utility/delayed Down B: attempts only
    record(4, { 21: move({ landed: 7, damage: 14 }) }, "legacy"),
    record(5, {}, "preview"),
  ];
  const attemptGames = stats.resolveGames(attemptRecords, new Set(["LOCAL#1"]));
  const attemptTable = stats.moveTable(attemptGames);
  const attemptedDownB = attemptTable.rows.find((row) => row.key === "down-b");
  assert.equal(attemptedDownB.attemptGames, 3, "only explicit Down B capability contributes attempt games");
  close(attemptedDownB.attemptsPerGame, 14 / 3, "legacy games cannot dilute Down B initiations");
  assert.equal(attemptedDownB.outcomeGames, 2, "attempts-only characters cannot dilute outcome games");
  assert.equal(attemptedDownB.noHitPerGame, 2.5);
  assert.equal(attemptedDownB.outcomeAttempts, 8);
  assert.equal(attemptedDownB.noHitRate, 5 / 8, "incomplete uses and conversion hit counts do not determine no-hit rate");
  for (const metric of metricKeys) {
    close(stats.moveMetricSeries(attemptGames, "down-b", metric).at(-1).value,
      tableValue(attemptedDownB, metric, attemptTable.covered), `tracked Down B ${metric}: table/trend parity`);
  }
  const onlyAttempts = stats.resolveGames([record(1, { 21: tracked({ attempts: 6, noHitAttempts: 6 }) })], new Set(["LOCAL#1"]));
  assert.equal(stats.moveTable(onlyAttempts).rows[0].noHitRate, 1, "zero-landed attempted moves stay visible");
  const noUses = stats.resolveGames([record(1, { 21: tracked() })], new Set(["LOCAL#1"]));
  assert.equal(stats.moveTable(noUses).rows[0].attemptsPerGame, 0, "tracked Down B remains visible in a zero-use library");
  assert.equal(stats.moveTable(noUses).rows[0].noHitPerGame, 0);
  assert.equal(stats.moveTable(noUses).rows[0].noHitRate, null);
  const utility = stats.resolveGames([record(1, { 21: move({ attempts: 6 }) })], new Set(["LOCAL#1"]));
  assert.equal(stats.moveTable(utility).rows[0].noHitRate, null, "utility Down B never invents a 100% no-hit rate");
  assert.equal(stats.moveTable(utility).rows[0].noHitPerGame, null);
  const incomplete = stats.resolveGames([record(1, { 21: tracked({ attempts: 6, incompleteAttempts: 6 }) })], new Set(["LOCAL#1"]));
  assert.equal(stats.moveTable(incomplete).rows[0].noHitRate, null, "no completed uses means unavailable rate");
  const oldNormalZero = record(1, {});
  oldNormalZero.statsVersion = 3;
  const normalCoverage = stats.resolveGames([oldNormalZero, record(2, { 13: move({ attempts: 4 }) })], new Set(["LOCAL#1"]));
  assert.equal(stats.moveTable(normalCoverage).rows[0].attemptsPerGame, 2, "schema bump preserves prior normal zero-use games");
  assert.equal(stats.moveMetricSeries(normalCoverage, "nair", "attemptsPerGame").at(-1).value, 2);

  // This is the UI's explicit contract: the trend's final point is the table's
  // current window, including legacy rows, games without this move, and previews.
  for (const window of [2, 3, 4]) {
    const current = stats.moveTable(games.slice(-window));
    for (const row of current.rows) {
      for (const metric of metricKeys) {
        const expected = tableValue(row, metric, current.covered);
        close(stats.moveMetricSeries(games, row.key, metric, window, 2).at(-1).value,
          expected, `${row.key}/${metric}: final trend point matches the ${window}-game table`);
        close(localMoveMetric(row, metric, current.covered), expected,
          `${row.key}/${metric}: comparison matches the local table`);
      }
    }
  }

  const archiveMove = (fields = {}) => ({
    attempts: 0, landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0,
    openingDmg: 0, lCancelSuccess: 0, lCancelFail: 0, ...fields,
  });
  const archive = {
    stats_version: 4,
    game_count: 3,
    metrics: {
      damageTotal: 132,
      moves: {
        21: archiveMove({ landed: 6, damage: 32, kills: 1, killPctSum: 90, openings: 2, openingDmg: 55 }),
        13: archiveMove({ attempts: 8, landed: 10, damage: 100, kills: 1, killPctSum: 100, lCancelSuccess: 9, lCancelFail: 3 }),
      },
    },
  };
  const archiveExpected = [null, null, null, 2, 32 / 3, 100 * 32 / 132, 32 / 6, 1 / 3, 50, 90, null];
  metricKeys.forEach((metric, index) => close(archiveMoveBenchmark(archive, "down-b", metric),
    archiveExpected[index], `archive Down B/${metric}`));
  close(archiveMoveBenchmark(archive, "nair", "lCancelPct"), 75, "archive aerial L-cancel retains its own denominator");
  assert.equal(archiveMoveBenchmark(null, "down-b", "landedPerGame"), null);
  assert.equal(archiveMoveBenchmark({ ...archive, metrics: { ...archive.metrics, moves: null } }, "down-b", "landedPerGame"), null,
    "an old archive with no move payload stays unavailable");
  const zeroSpecial = { game_count: 10, metrics: { damageTotal: 0, moves: { 21: archiveMove() } } };
  assert.equal(archiveMoveBenchmark(zeroSpecial, "down-b", "attemptsPerGame"), null,
    "archive placeholders stay unavailable even when the special never landed");
  const trackedArchive = { ...archive, game_count: 100, metrics: { ...archive.metrics, moves: {
    21: archiveMove({ attempts: 14, attemptGames: 3, hitAttempts: 3, noHitAttempts: 5, incompleteAttempts: 2, outcomeGames: 2, landed: 90 }),
  } } };
  close(archiveMoveBenchmark(trackedArchive, "down-b", "attemptsPerGame"), 14 / 3, "archive attempts use explicit capable games, never all legacy games");
  close(archiveMoveBenchmark(trackedArchive, "down-b", "noHitPerGame"), 2.5, "archive no-hit game denominator excludes untracked characters/versions");
  close(archiveMoveBenchmark(trackedArchive, "down-b", "noHitRate"), 62.5, "archive no-hit outcomes are matched per-use, not conversion totals");
  assert.equal(archiveMoveComparisonGames(trackedArchive, "down-b", "attemptsPerGame"), 3, "difference highlighting cannot use legacy archive games as attempt evidence");
  assert.equal(archiveMoveComparisonGames(trackedArchive, "down-b", "noHitRate"), 2);
  assert.equal(localMoveComparisonGames(attemptedDownB, "attemptsPerGame", 100), 3);
  assert.equal(localMoveComparisonGames(attemptedDownB, "noHitRate", 100), 2);
  assert.equal(archiveMoveSample({ ...archive, metrics: { ...archive.metrics, moves: {} } }, "down-b", "attemptsPerGame"), "Archive reparse needed", "missing archive Down B row explains why attempts are unavailable");
  for (const key of specialKeys) for (const metric of ["attemptsPerGame", "noHitPerGame", "noHitRate"]) {
    const noSample = { ...archive, stats_version: CURRENT_STATS_VERSION, metrics: { ...archive.metrics, moves: {} } };
    assert.equal(archiveMoveSample(noSample, key, metric), "No tracked games", `${key}: current missing coverage must not promise a reparse will repair the source`);
    assert.equal(archiveMoveBenchmark(noSample, key, metric), null);
    assert.equal(archiveMoveSample({ ...noSample, stats_version: 5 }, key, metric), "Archive reparse needed", `${key}: old statistics need reprocessing`);
  }
  assert.equal(archiveMoveSample({ ...trackedArchive, stats_version: 4 }, "down-b", "attemptsPerGame"), "3 tracked games", "published v9 measurements remain available while its archive revision is live");
  const zeroTrackedArchive = { ...trackedArchive, metrics: { ...trackedArchive.metrics, moves: { 21: archiveMove({ attemptGames: 5, outcomeGames: 5, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 }) } } };
  close(archiveMoveBenchmark(zeroTrackedArchive, "down-b", "attemptsPerGame"), 0, "explicit tracked zero is valid");
  close(archiveMoveBenchmark(zeroTrackedArchive, "down-b", "noHitPerGame"), 0, "known zero no-hit uses is valid");
  close(archiveMoveBenchmark(zeroTrackedArchive, "down-b", "noHitRate"), null, "zero completed archive uses cannot invent a rate");
  for (const key of specialKeys.slice(0, 3)) {
    const moveId = specialMoveId(key);
    const measured = { ...trackedArchive, metrics: { ...trackedArchive.metrics, moves: { [moveId]: trackedArchive.metrics.moves[21] } } };
    close(archiveMoveBenchmark(measured, key, "attemptsPerGame"), 14 / 3, `${key}: Venue/Pro explicit attempt denominator`);
    close(archiveMoveBenchmark(measured, key, "noHitPerGame"), 2.5, `${key}: Venue/Pro outcome denominator`);
    close(archiveMoveBenchmark(measured, key, "noHitRate"), 62.5, `${key}: no conversion-hit subtraction`);
    assert.equal(archiveMoveComparisonGames(measured, key, "attemptsPerGame"), 3);
    assert.equal(archiveMoveComparisonGames(measured, key, "noHitRate"), 2);
    assert.equal(archiveMoveSample(measured, key, "noHitRate"), "8 completed uses");
    const untracked = { ...measured, metrics: { ...measured.metrics, moves: { [moveId]: archiveMove({ attempts: 0, landed: 0 }) } } };
    assert.equal(archiveMoveBenchmark(untracked, key, "attemptsPerGame"), null, `${key}: v9 zero placeholders stay unavailable`);
    assert.equal(archiveMoveSample(untracked, key, "attemptsPerGame"), "Archive reparse needed");
    const utilityArchive = { ...measured, metrics: { ...measured.metrics, moves: { [moveId]: archiveMove({ attempts: 6, attemptGames: 2 }) } } };
    assert.equal(archiveMoveBenchmark(utilityArchive, key, "noHitRate"), null);
    assert.equal(archiveMoveSample(utilityArchive, key, "noHitRate"), "Outcome tracking unavailable");
  }

  const communityMove = (characterId, characterGames, moveKey, fields = {}) => ({
    characterId, characterGames, moveKey, attempts: null, attemptGames: 0,
    landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDamage: 0,
    lCancelSuccess: 0, lCancelFail: 0, ...fields,
  });
  const community = [
    communityMove(20, 10, "down-b", { landed: 8, damage: 40, kills: 2, killPctSum: 180 }),
    communityMove(20, 10, "nair", { attempts: 60, attemptGames: 7, landed: 40, damage: 160, kills: 8 }),
    communityMove(2, 5, "down-b", { landed: 2, damage: 12, kills: 1, killPctSum: 100 }),
    communityMove(2, 5, "jab", { attempts: 15, attemptGames: 3, landed: 10, damage: 30 }),
  ];
  const communityExpected = [null, null, null, 10 / 15, 52 / 15, 100 * 52 / 242, 52 / 10, 3 / 15, 100 * 3 / 11, 280 / 3, null];
  metricKeys.forEach((metric, index) => close(communityMoveBenchmark(community, "down-b", metric),
    communityExpected[index], `community Down B/${metric}: each character denominator counts once`));
  assert.equal(communityMoveBenchmark([], "down-b", "landedPerGame"), null,
    "a suppressed community sample is unavailable rather than zero");
  assert.equal(communityMoveBenchmark([communityMove(20, 100, "down-b", { attempts: 0 })], "down-b", "attemptsPerGame"), null,
    "unsupported community attempt placeholders remain unavailable");
  const suppressedSpecial = community.filter((row) => !(row.characterId === 2 && row.moveKey === "down-b"));
  for (const metric of ["attemptsPerGame", "landedPerGame", "dmgPerGame", "killsPerGame"]) {
    assert.equal(communityMoveBenchmark(suppressedSpecial, "down-b", metric), null,
      `${metric}: a character with other published moves cannot imply zero suppressed Down B usage`);
  }
  close(communityMoveBenchmark(suppressedSpecial, "down-b", "dmgShare"), 100 * 40 / 230,
    "damage share retains its documented published-row denominator");
  close(communityMoveBenchmark(suppressedSpecial, "down-b", "killShare"), 20,
    "kill share retains its documented published-row denominator");
  // Use a tracked normal too: specials would return null attempts regardless
  // of the privacy guard, so they cannot verify this denominator on their own.
  assert.equal(communityMoveBenchmark(community, "nair", "attemptsPerGame"), null,
    "one character's suppressed normal attempts cannot be filled with zero");
  const completeNair = [...community, communityMove(2, 5, "nair", {
    attempts: 15, attemptGames: 3, landed: 5, damage: 20, kills: 1,
  })];
  close(communityMoveBenchmark(completeNair, "nair", "attemptsPerGame"), 75 / 15,
    "complete character coverage weights attempts by the combined character-game sample");
  close(communityMoveBenchmark(completeNair, "nair", "landedPerGame"), 45 / 15,
    "complete character coverage weights landings by the combined character-game sample");

  const { ArchiveMoveAtlasComparison, TestArchiveFrame, testLocalMoveMetric, testArchiveMoveMetric } =
    await server.ssrLoadModule("/src/components/CommunityArchiveAtlas.tsx");
  const atlasMarkup = renderToStaticMarkup(createElement(ArchiveMoveAtlasComparison, {
    games, characterId: 20, lookbackGames: 150,
    communityRows: community.filter((row) => row.characterId === 20),
  }));
  assert.match(atlasMarkup, /Loading historical tournament comparisons/);
  assert.match(atlasMarkup, />Down B<\/td>/,
    "Down B is visible by default even while archive benchmarks are loading");
  assert.match(atlasMarkup, /SSBM Stats/);
  assert.match(atlasMarkup, /Venue archive/);
  assert.match(atlasMarkup, /No-hit uses \/ game/);
  assert.match(atlasMarkup, /No-hit rate/);
  const allSpecialMarkup = renderToStaticMarkup(createElement(ArchiveMoveAtlasComparison, {
    games: specialGames, characterId: 20, lookbackGames: 150, communityRows: [],
  }));
  for (const key of specialKeys) assert.match(allSpecialMarkup, new RegExp(`>${moveGroup(specialMoveId(key)).label}</td>`), `${key}: Atlas keeps attempted specials visible`);
  const { TestMoveMetricChart, testHasOpponentMoveMetric } = await server.ssrLoadModule("/src/components/Views.tsx");
  const opponentSpecialGames = specialGames.map((game) => ({ ...game, opp: game.me }));
  for (const key of specialKeys) {
    assert.equal(testHasOpponentMoveMetric(opponentSpecialGames, new Set([key]), "attemptsPerGame"), true, `${key}: opponent attempt trend is available`);
    assert.equal(testHasOpponentMoveMetric(opponentSpecialGames, new Set([key]), "noHitRate"), key !== "neutral-b", `${key}: opponent outcome availability follows capability`);
  }
  const onlyOldOpponent = opponentSpecialGames.slice(0, 1);
  assert.equal(testHasOpponentMoveMetric(onlyOldOpponent, new Set(["side-b"]), "attemptsPerGame"), false, "opponent v4 placeholders cannot enable Side B attempt charts");
  assert.equal(testHasOpponentMoveMetric(onlyOldOpponent, new Set(["down-b"]), "noHitRate"), false, "opponent v4 Down B cannot establish complete coverage");
  const noHitChart = renderToStaticMarkup(createElement(TestMoveMetricChart, {
    games: specialGames,
    moves: [table.rows.find((row) => row.key === "nair"), ...specialTable.rows],
    benchmarks: { characterId: 20, opponentCharacterId: null, communityMoves: [], venue: null, tournament: null, pro: null },
    metric: "noHitRate", setMetric: () => {},
  }));
  assert.match(noHitChart, /aria-label="Moves: Side B"/, "no-hit chart replaces a default normal with an outcome-tracked special");
  assert.doesNotMatch(noHitChart, /Nothing to plot/, "measured special outcomes are immediately chartable");
  for (const label of ["Neutral B", "Side B", "Up B", "Down B"]) assert.match(noHitChart, new RegExp(`<span>${label}</span>`), `${label}: available in the no-hit move picker`);
  const zeroBeforeUsedGames = stats.resolveGames([record(31, {
    13: move({ attempts: 5, landed: 5 }),
    19: tracked(),
    20: tracked({ attempts: 3, hitAttempts: 1, noHitAttempts: 2 }),
  })], new Set(["LOCAL#1"]));
  const zeroBeforeUsedRows = stats.moveTable(zeroBeforeUsedGames).rows;
  const zeroBeforeUsedChart = (metric) => renderToStaticMarkup(createElement(TestMoveMetricChart, {
    games: zeroBeforeUsedGames,
    moves: ["nair", "side-b", "up-b"].map((key) => zeroBeforeUsedRows.find((row) => row.key === key)),
    benchmarks: { characterId: 20, opponentCharacterId: null, communityMoves: [], venue: null, tournament: null, pro: null },
    metric, setMetric: () => {},
  }));
  assert.match(zeroBeforeUsedChart("noHitRate"), /aria-label="Moves: Up B"/, "a measured zero-use special cannot hide a different special's completed-use rate");
  assert.doesNotMatch(zeroBeforeUsedChart("noHitRate"), /Nothing to plot/);
  assert.match(zeroBeforeUsedChart("noHitPerGame"), /aria-label="Moves: Side B"/, "zero no-hit uses per measured game remains chartable");
  assert.doesNotMatch(zeroBeforeUsedChart("noHitRate"), /Refresh replays/, "current statistics do not trigger a stale-cache instruction");
  assert.match(noHitChart, /Some cached replays use older statistics\. Refresh replays/, "stale local versions receive a separate refresh instruction");
  const currentUnavailableGames = stats.resolveGames([record(32, { 21: move({ landed: 1 }) })], new Set(["LOCAL#1"]));
  const currentUnavailableRow = stats.moveTable(currentUnavailableGames).rows[0];
  assert.equal(localMoveSample(currentUnavailableRow, "noHitRate"), "No tracked games");
  const currentUnavailableAtlas = renderToStaticMarkup(createElement(ArchiveMoveAtlasComparison, {
    games: currentUnavailableGames, characterId: 20, lookbackGames: 150, communityRows: [],
  }));
  assert.doesNotMatch(currentUnavailableAtlas, /Refresh replays/, "a current archive/local sample without coverage is unavailable, not stale");
  assert.match(allSpecialMarkup, /Some cached replays use older statistics\. Refresh replays/);
  close(testLocalMoveMetric(attemptedDownB, "noHitRate", attemptTable.covered), 5 / 8, "Atlas local rate uses matched outcome sample");
  close(testArchiveMoveMetric({ key: "down-b", ...trackedArchive.metrics.moves[21] }, "noHitRate", trackedArchive), 5 / 8, "Atlas archive rate agrees with execution benchmark");
  const { testLegacyArchiveMoveMetric, testLegacyCommunityMove } = await server.ssrLoadModule("/src/components/ArchiveCommunityBenchmark.tsx");
  close(testLegacyArchiveMoveMetric({ key: "down-b", ...trackedArchive.metrics.moves[21] }, "attempts", trackedArchive), 14 / 3, "Community overview uses the same explicit archive attempt sample");
  assert.equal(testLegacyCommunityMove(communityMove(20, 100, "down-b", { attempts: 0 }), "attempts", 0), "—", "Community overview does not invent special attempt coverage from placeholders");
  const unavailableArchive = {
    loading: false, error: "Archive unavailable", fieldRows: [], proAggregateRows: [], proRows: [],
    pros: [], characterPros: [], selectedPro: null, playerId: null, setPlayerId: () => {}, dataset: null,
  };
  const frame = (showContentWithoutArchive) => renderToStaticMarkup(createElement(TestArchiveFrame, {
    archive: unavailableArchive, eyebrow: "Move Atlas", title: "Move profile", showContentWithoutArchive,
  }, createElement("span", null, "Local Down B measurements")));
  assert.match(frame(true), /Archive unavailable/);
  assert.match(frame(true), /Local Down B measurements/,
    "a failed archive request cannot hide local move measurements");
  assert.doesNotMatch(frame(false), /Local Down B measurements/,
    "archive-only panels retain their existing unavailable state");

  const originalNow = Date.now;
  let demoRecords;
  try {
    Date.now = () => Date.UTC(2026, 9, 22);
    demoRecords = demo.generateDemoRecords(240);
    assert.equal(JSON.stringify(demoRecords), JSON.stringify(demo.generateDemoRecords(240)),
      "the same clock and seed produce the same demo");
  } finally {
    Date.now = originalNow;
  }
  const demoGames = stats.resolveGames(demoRecords, new Set(demo.DEMO_ACCOUNTS.map((account) => account.code)));
  const demoTable = stats.moveTable(demoGames.slice(-stats.ROLLING_WINDOW));
  for (const key of specialKeys) assert.ok(demoTable.rows.some((row) => row.key === key && row.attemptGames > 0), `demo exercises measured ${key}`);
  for (const row of demoTable.rows) for (const metric of metricKeys) {
    close(stats.moveMetricSeries(demoGames, row.key, metric).at(-1).value,
      tableValue(row, metric, demoTable.covered), `demo ${row.key}/${metric}: table/trend parity`);
  }
  console.log("Move comparisons passed: all four special directions, v6 completeness coverage, v4/v5 local exclusion, measured zeros, utility/incomplete outcomes, explicit archive denominators, stale/current availability messages, opponent/table/trend parity, demo determinism, and Atlas/chart visibility.");
} finally {
  await server.close();
}
