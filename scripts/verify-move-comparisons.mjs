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
        return `${source}\nexport { ArchiveFrame as TestArchiveFrame };\n`;
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
  "attemptsPerGame", "landedPerGame", "dmgPerGame", "dmgShare", "avgDmgPerHit",
  "killsPerGame", "killShare", "avgKillPct", "lCancelPct",
];
const tableValue = (row, metric, covered) => ({
  attemptsPerGame: row.attemptsPerGame,
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
  const { moveGroup, moveGroupTracksAttempts } = await server.ssrLoadModule("/src/lib/melee.ts");
  const { archiveMoveBenchmark, communityMoveBenchmark, localMoveMetric } =
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
    const special = stats.resolveGames([record(10 + id, {
      [id]: move({ landed: 3, damage: 18, attempts: 0 }),
    })], new Set(["LOCAL#1"]));
    assert.equal(stats.moveTable(special).rows[0].attempts, null,
      `${key}: historical placeholder zeros cannot become supported attempt counts`);
    assert.equal(stats.moveMetricSeries(special, key, "attemptsPerGame").at(-1).value, null);
  }

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
    game_count: 3,
    metrics: {
      damageTotal: 132,
      moves: {
        21: archiveMove({ landed: 6, damage: 32, kills: 1, killPctSum: 90, openings: 2, openingDmg: 55 }),
        13: archiveMove({ attempts: 8, landed: 10, damage: 100, kills: 1, killPctSum: 100, lCancelSuccess: 9, lCancelFail: 3 }),
      },
    },
  };
  const archiveExpected = [null, 2, 32 / 3, 100 * 32 / 132, 32 / 6, 1 / 3, 50, 90, null];
  metricKeys.forEach((metric, index) => close(archiveMoveBenchmark(archive, "down-b", metric),
    archiveExpected[index], `archive Down B/${metric}`));
  close(archiveMoveBenchmark(archive, "nair", "lCancelPct"), 75, "archive aerial L-cancel retains its own denominator");
  assert.equal(archiveMoveBenchmark(null, "down-b", "landedPerGame"), null);
  assert.equal(archiveMoveBenchmark({ ...archive, metrics: { ...archive.metrics, moves: null } }, "down-b", "landedPerGame"), null,
    "an old archive with no move payload stays unavailable");
  const zeroSpecial = { game_count: 10, metrics: { damageTotal: 0, moves: { 21: archiveMove() } } };
  assert.equal(archiveMoveBenchmark(zeroSpecial, "down-b", "attemptsPerGame"), null,
    "archive placeholders stay unavailable even when the special never landed");

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
  const communityExpected = [null, 10 / 15, 52 / 15, 100 * 52 / 242, 52 / 10, 3 / 15, 100 * 3 / 11, 280 / 3, null];
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

  const { ArchiveMoveAtlasComparison, TestArchiveFrame } =
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
  assert.ok(demoTable.rows.some((row) => row.key === "down-b"), "demo exercises Down B");
  for (const row of demoTable.rows) for (const metric of metricKeys) {
    close(stats.moveMetricSeries(demoGames, row.key, metric).at(-1).value,
      tableValue(row, metric, demoTable.covered), `demo ${row.key}/${metric}: table/trend parity`);
  }
  console.log("Move comparisons passed: all specials, Down B effectiveness, legacy/preview coverage, archive/community denominators, unsupported attempts, table/trend parity, and Atlas loading/error visibility.");
} finally {
  await server.close();
}
