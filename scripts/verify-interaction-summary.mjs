/** Coverage and outcome denominators must survive old caches, partial coverage and unresolved events. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "interaction-presentation-fixtures",
    transform(source, id) {
      if (id.endsWith("/src/components/Interactions.tsx")) {
        return `${source}\nexport { ChoiceTable as TestChoiceTable, RecoveryTable as TestRecoveryTable, EdgeguardTable as TestEdgeguardTable, PunishTable as TestPunishTable };\n`;
      }
    },
  }],
});

try {
  const { interactionSummary, interactionRate } = await server.ssrLoadModule("/src/lib/interactionSummary.ts");
  const { CURRENT_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const { generateDemoRecords } = await server.ssrLoadModule("/src/lib/demo.ts");
  const { Interactions, TestChoiceTable, TestRecoveryTable, TestEdgeguardTable, TestPunishTable } = await server.ssrLoadModule("/src/components/Interactions.tsx");
  const base = generateDemoRecords(1).find((rec) => !rec.isTeams);
  assert.ok(base);
  const choice = { attempts: 5, punished: 2, hit: 1, traded: 0, noHit: 1, incomplete: 1 };
  const recovery = { attempts: 4, reachedLedge: 3, returned: 2, died: 1, incomplete: 1 };
  const edgeguard = { opportunities: 4, contested: 3, completedContests: 2, stocksTaken: 1, opponentReturned: 2, uncontestedDeaths: 0, incomplete: 1 };
  const punish = { openings: 4, damage: 45, kills: 1, incomplete: 1 };
  const measured = structuredClone(base);
  measured.players[0].defense = { ledge: { roll: choice }, oos: {}, shieldExits: {} };
  measured.players[0].recovery = { recoveries: { low: recovery }, edgeguards: { holdLedge: edgeguard } };
  measured.players[0].punish = { beforeOpening: { grab: punish } };
  const asGame = (rec) => ({ rec, me: rec.players[0], opp: rec.players[1], isWin: true, date: null, selfMatch: false });
  const legacy = structuredClone(base);
  legacy.statsVersion = 6;
  delete legacy.players[0].defense;
  delete legacy.players[0].recovery;
  delete legacy.players[0].punish;
  const preview = { ...measured, statsLevel: "header" };
  const teams = { ...measured, isTeams: true };
  const failed = { ...measured, parseError: "fixture" };
  const partial = structuredClone(legacy);
  partial.statsVersion = CURRENT_STATS_VERSION;
  partial.players[0].defense = { ledge: {}, oos: {}, shieldExits: {} };
  const games = [measured, legacy, preview, teams, failed, partial].map(asGame);
  const summary = interactionSummary(games);
  assert.equal(summary.games, 3, "previews, teams and failed records are excluded");
  assert.equal(summary.defenseGames, 2, "measured zero-use game counts; missing field does not");
  assert.equal(summary.recoveryGames, 1, "coverage is independent by metric family");
  assert.equal(summary.punishGames, 1);
  assert.deepEqual(summary.ledge.roll, choice);
  assert.deepEqual(summary.recoveries.low, recovery);
  assert.deepEqual(summary.edgeguards.holdLedge, edgeguard);
  assert.deepEqual(summary.beforeOpening.grab, punish);
  assert.deepEqual(interactionSummary([asGame(legacy)]).ledge, {}, "old caches do not invent zero events");
  const outdated = { ...measured, statsVersion: 7 };
  const outdatedSummary = interactionSummary([asGame(outdated)]);
  assert.equal(outdatedSummary.games, 1, "outdated interactions do not remove baseline games");
  assert.equal(outdatedSummary.defenseGames, 0, "version 7 detector results need re-analysis");
  assert.equal(outdatedSummary.recoveryGames, 0);
  assert.equal(outdatedSummary.punishGames, 0);
  const doubled = interactionSummary([asGame(measured), asGame(measured)]);
  assert.equal(doubled.ledge.roll.attempts, 10);
  assert.equal(doubled.beforeOpening.grab.damage, 90);
  assert.equal(choice.attempts, 5, "aggregation does not mutate stored counts");
  assert.equal(interactionRate(0, 0), null);
  assert.equal(interactionRate(0, 5), 0);
  assert.equal(interactionRate(2, choice.attempts - choice.incomplete), 0.5);

  const render = (component, props) => renderToStaticMarkup(createElement(component, props));
  const ledgeHtml = render(TestChoiceTable, { rows: { roll: choice }, labels: [{ key: "roll", label: "Ledge roll" }], covered: 1, kind: "ledge options" });
  assert.match(ledgeHtml, /50\.0%/, "incoming hit rate excludes unresolved uses");
  assert.match(ledgeHtml, /2 \/ 4/);
  assert.match(ledgeHtml, /Small sample/);
  const recoveryHtml = render(TestRecoveryTable, { rows: { low: recovery }, covered: 1 });
  assert.match(recoveryHtml, /66\.7%/, "stable return rate uses completed recoveries");
  const edgeguardHtml = render(TestEdgeguardTable, { rows: { holdLedge: edgeguard }, covered: 1 });
  assert.match(edgeguardHtml, /50\.0%/, "edgeguard rate uses completed contests, not all contests");
  const punishHtml = render(TestPunishTable, { rows: { grab: punish }, covered: 1 });
  assert.match(punishHtml, /15\.0/, "damage per opening excludes unfinished episodes");
  assert.match(punishHtml, /33\.3%/);
  const pending = render(TestChoiceTable, {
    rows: { roll: { attempts: 1, punished: 0, hit: 0, traded: 0, noHit: 0, incomplete: 1 } },
    labels: [{ key: "roll", label: "Ledge roll" }], covered: 1, kind: "ledge options",
  });
  assert.match(pending, /No resolved observations/);
  assert.doesNotMatch(pending, />0\.0%</, "an unresolved-only sample does not report a zero outcome rate");
  const oldHtml = render(Interactions, { games: [asGame(legacy)], onAnalyze() {}, onSelectReplayFiles() {} });
  assert.match(oldHtml, /Analyze these games/);
  assert.match(oldHtml, /Select replay files/);
  assert.match(oldHtml, /0 \/ 1 game measured/);
  const unsupportedHtml = render(Interactions, { games: [asGame({ ...legacy, statsVersion: CURRENT_STATS_VERSION })], onAnalyze() {} });
  assert.doesNotMatch(unsupportedHtml, /Analyze these games/, "unsupported current recordings do not repeatedly request analysis");
  const demoHtml = render(Interactions, { games: [asGame(measured)], isDemo: true, onAnalyze() {} });
  assert.match(demoHtml, /Demo figures are synthetic/);
  assert.doesNotMatch(demoHtml, /Analyze these games/);

  const demoGames = generateDemoRecords(30).filter((rec) => !rec.isTeams).map(asGame);
  const demoSummary = interactionSummary(demoGames.slice(-10));
  assert.equal(demoSummary.games, 10, "summary respects the supplied current-form window");
  assert.equal(demoSummary.defenseGames, 10);
  assert.equal(demoSummary.recoveryGames, 10);
  assert.equal(demoSummary.punishGames, 10);
  for (const game of demoGames) {
    for (const player of game.rec.players) {
      for (const section of Object.values(player.defense)) for (const row of Object.values(section)) {
        assert.equal(row.attempts, row.punished + row.hit + row.traded + row.noHit + row.incomplete);
      }
      for (const row of Object.values(player.recovery.recoveries)) assert.equal(row.attempts, row.returned + row.died + row.incomplete);
      for (const row of Object.values(player.recovery.edgeguards)) {
        assert.equal(row.opportunities, row.stocksTaken + row.opponentReturned + row.uncontestedDeaths + row.incomplete);
        assert.ok(row.completedContests <= row.contested);
      }
    }
  }
  console.log("Interaction summary, coverage, demo and presentation checks passed.");
} finally {
  await server.close();
}
