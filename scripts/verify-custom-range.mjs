import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({ configFile: false, envDir: false,
  server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
const previousTimezone = process.env.TZ;
try {
  const { applyFilters, applyTeamFilters, customRangeError, overview, statCardData } = await server.ssrLoadModule("/src/lib/stats.ts");
  const { DEFAULT_FILTERS } = await server.ssrLoadModule("/src/lib/types.ts");
  const makeGame = (id, date, characterId = 9) => ({
    rec: { id, stageId: 31, gameType: "direct", durationFrames: 3600 },
    me: { characterId, connectCode: "ME#1", displayName: "Player", kills: 1, totalDamage: 100 },
    opp: { characterId: 2, connectCode: "OPP#1", displayName: "Opponent", kills: 1 },
    isWin: true, date, selfMatch: false,
  });
  const asTeam = (g) => ({ ...g, teammate: { connectCode: "TEAM#1" }, opps: [g.opp, { characterId: 15, connectCode: "OPP#2" }] });
  const ids = (games) => games.map((g) => g.rec.id);

  // Local calendar boundaries must include the whole end day, even on 23/25-hour
  // DST days. Repeat outside the US so no UTC or fixed-offset assumption slips in.
  for (const timezone of ["America/New_York", "UTC", "Pacific/Auckland"]) {
    process.env.TZ = timezone;
    for (const [month, day] of [[3, 8], [11, 1]]) {
      const dayString = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const games = [
        makeGame("before", new Date(2026, month - 1, day, 0, 0, 0, -1)),
        makeGame("start", new Date(2026, month - 1, day, 0)),
        makeGame("end", new Date(2026, month - 1, day, 23, 59, 59, 999)),
        makeGame("after", new Date(2026, month - 1, day + 1, 0)),
        makeGame("undated", null),
      ];
      const filters = { ...DEFAULT_FILTERS, range: "custom", rangeStart: dayString, rangeEnd: dayString };
      assert.deepEqual(ids(applyFilters(games, filters)), ["start", "end"], `${timezone}: inclusive singles date range`);
      assert.deepEqual(ids(applyTeamFilters(games.map(asTeam), filters)), ["start", "end"], `${timezone}: same teams date range`);
      assert.equal(overview(applyFilters(games, filters), games, filters).prevWinRate, null, "custom range has no implied prior window");
      assert.equal(applyFilters(games, { ...filters, rangeEnd: null }).length, 0, "incomplete custom dates never show all games");
      assert.equal(applyFilters(games, { ...filters, rangeStart: "2026-12-31" }).length, 0, "reversed dates never show all games");
      assert.equal(applyFilters(games, { ...filters, myCharacter: 2 }).length, 0, "custom dates compose with character filters");
      assert.deepEqual(ids(applyFilters(games, { ...filters, day: dayString, rangeStart: "2026-12-31" })), ["start", "end"], "picked day retains precedence");
    }
  }
  process.env.TZ = "America/New_York";
  const midnight = { ...DEFAULT_FILTERS, range: "custom", rangeStart: "2026-03-08", rangeEnd: "2026-03-08" };
  assert.deepEqual(ids(applyFilters([
    makeGame("previous-local-day", new Date("2026-03-08T04:59:59Z")),
    makeGame("start-local-day", new Date("2026-03-08T05:00:00Z")),
    makeGame("end-local-day", new Date("2026-03-09T03:59:59Z")),
    makeGame("next-local-day", new Date("2026-03-09T04:00:00Z")),
  ], midnight)), ["start-local-day", "end-local-day"], "UTC timestamps are filtered by local calendar day");
  assert.equal(customRangeError("2024-02-29", "2024-02-29"), null);
  assert.ok(customRangeError("2026-02-29", "2026-03-01"), "reject impossible calendar dates");
  assert.ok(customRangeError("2026-02-30", "2026-03-01"));
  assert.ok(customRangeError("2026-11-02", "2026-11-01"));
  assert.ok(customRangeError(null, null));

  const cardGames = [9, 9, 9, 2, 2, 15].map((character, i) => makeGame(String(i), new Date(2026, 10, 1, 12, i * 5), character));
  const card = statCardData(cardGames);
  assert.deepEqual(card.mainChar, { id: 9, games: 3 });
  assert.deepEqual(card.secondaryChar, { id: 2, games: 2 });
  assert.equal(statCardData(applyFilters(cardGames, { ...DEFAULT_FILTERS, myCharacter: 9 })).secondaryChar, null, "one-character view has no invented secondary");
  assert.equal(statCardData([]).secondaryChar, null);
  console.log("Custom date ranges and player-card secondary verified.");
} finally {
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
  await server.close();
}
