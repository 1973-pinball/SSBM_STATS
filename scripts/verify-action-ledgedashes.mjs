/** Ledgedash actions use measured defensive-analysis coverage, never placeholder zeros. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, envDir: false, appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "isolated-action-ledgedash-fixtures", enforce: "pre",
    load(id) {
      if (id.endsWith("/src/lib/supabase.ts")) return "export const supabase = null;";
    },
    transform(source, id) {
      if (id.endsWith("/src/components/Views.tsx")) {
        return `${source}\nexport { ACTION_SERIES as testActionSeries, archiveActionBenchmark as testArchiveActionBenchmark };\n`;
      }
    },
  }],
});

const near = (actual, expected, label) => {
  if (expected === null) assert.equal(actual, null, label);
  else assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-10, `${label}: expected ${expected}, got ${actual}`);
};
const choice = (attempts, incomplete = 0) => ({ attempts, punished: 0, hit: 0, traded: 0, noHit: attempts - incomplete, incomplete });
const defense = attempts => ({ ledge: attempts === 0 ? {} : { ledgedash: choice(attempts) }, oos: {}, shieldExits: {} });

try {
  const stats = await server.ssrLoadModule("/src/lib/stats.ts");
  const { generateDemoRecords } = await server.ssrLoadModule("/src/lib/demo.ts");
  const { ACTION_LABELS, CURRENT_STATS_VERSION, INTERACTION_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const base = generateDemoRecords(1).find(record => !record.isTeams);
  assert.ok(base, "Synthetic demo supplies a complete singles record");
  assert.equal(typeof stats.ledgedashCount, "function", "Shared ledgedash accessor is exported");
  assert.equal(stats.ROLLING_WINDOW, 150, "Action trend and current-form table share the 150-game window");
  assert.ok(!ACTION_LABELS.some(row => row.key === "ledgedashes"), "Derived ledgedashes do not change stored action or ranked-coverage schemas");
  let nextId = 0;
  function game(mine = null, opponent = null, { version = CURRENT_STATS_VERSION, minutes = 1, ...extra } = {}) {
    const rec = structuredClone(base), id = nextId++;
    rec.id = `ledgedash-action-${id}`;
    rec.path = `synthetic/ledgedash-action-${id}.slp`;
    rec.playedAt = new Date(Date.UTC(2026, 10, 1, 12, id)).toISOString();
    rec.durationFrames = minutes * 3600;
    rec.statsVersion = version;
    Object.assign(rec, extra);
    if (mine === null) delete rec.players[0].defense;
    else rec.players[0].defense = defense(mine);
    if (opponent === null) delete rec.players[1].defense;
    else rec.players[1].defense = defense(opponent);
    return { rec, me: rec.players[0], opp: rec.players[1], date: new Date(rec.playedAt), isWin: rec.winnerIndex === 0 };
  }
  const rowFor = games => {
    const row = stats.actionAverages(games).rows.find(row => row.key === "ledgedashes");
    assert.ok(row, "The Actions table always includes a Ledgedashes row for full-game inputs");
    assert.equal(row.label, "Ledgedashes");
    return row;
  };

  for (const version of [INTERACTION_STATS_VERSION, CURRENT_STATS_VERSION]) {
    assert.equal(stats.ledgedashCount(game(4, 1, { version })), 4, `Compatible v${version} measurements remain visible`);
    assert.equal(stats.ledgedashCount(game(0, 0, { version })), 0, `v${version} empty measured ledge map is a genuine zero`);
  }
  for (const invalid of [
    game(99, 99, { version: 8 }),
    game(99, 99, { statsLevel: "header" }), game(99, 99, { parseError: "synthetic failure" }),
    game(99, 99, { isTeams: true }), game(null, 4),
  ]) {
    assert.equal(stats.ledgedashCount(invalid), null, "Unavailable defensive measurement stays unknown");
  }
  const legacy = game(99, 99); delete legacy.rec.statsVersion;
  assert.equal(stats.ledgedashCount(legacy), null, "Unversioned fields cannot become current analysis");
  for (const attempts of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    const malformed = game(1, 0);
    malformed.me.defense.ledge.ledgedash.attempts = attempts;
    assert.equal(stats.ledgedashCount(malformed), null, "A malformed existing attempt count is unavailable, not zero");
  }
  const unresolved = game(4, 0);
  unresolved.me.defense.ledge.ledgedash = choice(4, 3);
  assert.equal(stats.ledgedashCount(unresolved), 4, "Count recognized ledgedashes even when subsequent outcomes are incomplete");
  const independent = game(null, 3);
  assert.equal(stats.ledgedashCount(independent), null);
  assert.equal(stats.ledgedashCount(independent, independent.opp), 3, "Opponent coverage is independent of mine");

  const mixed = [game(6, null, { minutes: 2 }), game(0, 4, { minutes: 1 }), game(null, 2, { minutes: 3 }),
    game(500, 500, { version: 8, minutes: 100 }), game(500, 500, { statsLevel: "header", minutes: 100 })];
  const snapshot = JSON.stringify(mixed);
  const average = rowFor(mixed);
  assert.equal(average.covered, 2); assert.equal(average.oppCovered, 2);
  near(average.perGame, 3, "My per-game denominator contains only measured sides");
  near(average.perMinute, 2, "My rate uses only the measured games' three minutes");
  near(average.oppPerGame, 3, "Opponent per-game denominator is independently measured");
  near(average.oppPerMinute, 1.5, "Opponent rate uses its own four measured minutes");
  assert.equal(JSON.stringify(mixed), snapshot, "Aggregation does not rewrite stored records");
  const unavailable = rowFor([game(null, null), game(100, 100, { version: 8 })]);
  for (const key of ["perGame", "perMinute", "oppPerGame", "oppPerMinute"]) assert.equal(unavailable[key], null, "No coverage yields a dash, never zero");
  assert.equal(unavailable.covered, 0); assert.equal(unavailable.oppCovered, 0);

  const picks = [{ key: "ledgedashes", value: game => stats.ledgedashCount(game) },
    { key: "opp:ledgedashes", value: game => stats.ledgedashCount(game, game.opp) }];
  const sliding = stats.perGameSeries([game(null, 3), game(4, null), game(0, null), game(null, 2), game(null, null)], picks, 2);
  assert.deepEqual(sliding.map(point => point.ledgedashes), [null, 4, 2, 0, null], "Unknown samples age out without being converted to zero");
  assert.deepEqual(sliding.map(point => point["opp:ledgedashes"]), [3, 3, null, 2, 2], "Each line has its own rolling coverage");
  const previewSeries = stats.perGameSeries([game(0, 0, { statsLevel: "header" }), game(0, 0)], [{ key: "constant", value: () => 6 }], 2);
  assert.deepEqual(previewSeries.map(point => point.constant), [null, 6], "Chart excludes header placeholders even for an ordinary numeric picker");

  const history = Array.from({ length: 310 }, (_, index) => game(index < 160 ? 100 : index === 160 ? 4 : null,
    index < 160 ? 100 : index === 309 ? 6 : null, { minutes: 1 }));
  const recent = history.slice(-150), recentRow = rowFor(recent);
  assert.equal(recentRow.covered, 1); assert.equal(recentRow.oppCovered, 1);
  assert.equal(recentRow.perGame, 4, "The past-150 table never fills coverage with older measured games");
  assert.equal(recentRow.oppPerGame, 6);
  const thinned = stats.perGameSeries(history, picks, 150, 7);
  assert.equal(thinned.at(-1).index, history.length, "Thinning retains the final game");
  near(thinned.at(-1).ledgedashes, recentRow.perGame, "Final chart point equals the past-150 table");
  near(thinned.at(-1)["opp:ledgedashes"], recentRow.oppPerGame, "Opponent final point equals its table row");
  const agedOut = [...history, game(null, null)];
  assert.equal(stats.perGameSeries(agedOut, picks, 150, 7).at(-1).ledgedashes, null, "The last tracked game falling outside the window leaves no measurement");

  const standard = [game(null, null, { minutes: 1 }), game(null, null, { minutes: 2 })];
  standard[0].me.actions.wavedashes = 2; standard[1].me.actions.wavedashes = 4;
  standard[0].opp.actions.wavedashes = 5; standard[1].opp.actions.wavedashes = 1;
  const wavedashes = stats.actionAverages(standard).rows.find(row => row.key === "wavedashes");
  assert.equal(wavedashes.perGame, 3); assert.equal(wavedashes.perMinute, 2);
  assert.equal(wavedashes.oppPerGame, 3); assert.equal(wavedashes.oppPerMinute, 2);
  assert.deepEqual(stats.perGameSeries(standard, [{ key: "wavedashes", value: game => game.me.actions.wavedashes }], 150)
    .map(point => point.wavedashes), [2, 3], "Existing complete action series retain their arithmetic");
  const demoGames = generateDemoRecords(30).filter(record => !record.isTeams).map(rec => ({ rec, me: rec.players[0], opp: rec.players[1], date: rec.playedAt ? new Date(rec.playedAt) : null, isWin: rec.winnerIndex === 0 }));
  const demoRow = rowFor(demoGames.slice(-150));
  assert.ok(demoRow.covered > 0 && demoRow.perGame !== null && Number.isFinite(demoRow.perGame), "Existing demo analysis supplies the new metric without new parser fields");

  const { Execution, testActionSeries, testArchiveActionBenchmark } = await server.ssrLoadModule("/src/components/Views.tsx");
  const series = testActionSeries.find(row => row.key === "ledgedashes");
  assert.ok(series, "Actions chart has a Ledgedashes picker");
  assert.equal(series.label, "Ledgedashes");
  assert.equal(series.value(independent), null); assert.equal(series.oppValue(independent), 3);
  assert.equal(testArchiveActionBenchmark({ game_count: 100, metrics: { actions: {} } }, "ledgedashes"), null,
    "Archives without ledgedash counters do not provide a fabricated zero reference");
  const markup = renderToStaticMarkup(createElement(Execution, { games: recent, isDemo: false,
    selectedCharacterId: null, selectedOpponentCharacterId: null }));
  assert.ok((markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).some(button => button.includes("Ledgedashes")),
    "Rendered Actions chart exposes the metric chip");
  const tableRow = (markup.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? []).find(row => row.includes("Ledgedashes"));
  assert.ok(tableRow, "Rendered current-form Actions table contains Ledgedashes");
  assert.match(tableRow, />4\.0(?:<|\s)/, "The table renders the same measured local rate as the final chart point");
  assert.match(tableRow, />6\.0(?:<|\s)/, "The table renders the independent opponent rate");
  console.log("Ledgedash actions passed: versions and unknowns, side-specific coverage/duration, past-150 window, chart/table parity, preserved action arithmetic, demo and rendered UI.");
} finally {
  await server.close();
}
