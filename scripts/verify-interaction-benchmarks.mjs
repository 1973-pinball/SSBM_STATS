/** Exact matchup/stage selection, sampled coverage and comparable denominators. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { validateShippedInteractionSample } from "./lib/interaction-benchmark-validation.mjs";
import { encodeInteractionBenchmarks, decodeInteractionBenchmarks, INTERACTION_CODEC_OPTIONS } from "../src/lib/interactionBenchmarkCodec.mjs";

const server = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: "interaction-benchmark-presentation-fixtures",
    transform(source, id) {
      if (id.endsWith("/src/components/Interactions.tsx")) return `${source}\nexport { InteractionBenchmarkComparison as TestBenchmarkComparison };\n`;
    },
  }],
});

try {
  const { INTERACTION_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const { parseInteractionBenchmarkData, selectInteractionBenchmarks, interactionBenchmarkValue,
    interactionComparisonKeys, loadInteractionBenchmarks } = await server.ssrLoadModule("/src/lib/interactionBenchmarks.ts");
  const { TestBenchmarkComparison } = await server.ssrLoadModule("/src/components/Interactions.tsx");
  const choice = { attempts: 10, punished: 2, hit: 3, traded: 1, noHit: 2, incomplete: 2 };
  const recovery = { attempts: 10, reachedLedge: 6, returned: 5, died: 3, incomplete: 2 };
  const edgeguard = { opportunities: 10, contested: 7, completedContests: 5, stocksTaken: 3, opponentReturned: 4, uncontestedDeaths: 1, incomplete: 2 };
  const opening = { openings: 10, damage: 160, kills: 2, incomplete: 2 };
  const row = (cohort, characterId, opponentCharacterId, stageId, games = 10) => ({
    cohort, characterId, opponentCharacterId, stageId, games, defenseGames: games, recoveryGames: games, punishGames: games,
    ledge: { roll: structuredClone(choice) }, oos: { grab: structuredClone(choice) }, shieldExits: {},
    recoveries: { low: structuredClone(recovery) }, edgeguards: { holdLedge: structuredClone(edgeguard) }, beforeOpening: { grab: structuredClone(opening) },
  });
  const raw = {
    schemaVersion: 1, statsVersion: INTERACTION_STATS_VERSION, generatedAt: "2026-11-02T12:00:00.000Z",
    sourceDataset: "fixture replay sample", sourceUrl: "https://replays.nikki.sh/", method: "Explicit test sample.",
    sample: { bundles: 3, games: 40, availableGames: 100, proPlayers: 1 },
    rows: [row("venue", 9, 2, 31), row("venue", 9, 15, 31, 20), row("venue", 9, 2, 32, 30),
      row("venue", 2, 9, 31, 40), row("tournament", 9, 2, 31, 4), row("pro", 2, 9, 31, 2)],
  };
  const data = parseInteractionBenchmarkData(raw);
  assert.ok(data);
  const exact = { characterId: 9, opponentCharacterId: 2, stageId: 31 };
  const selected = selectInteractionBenchmarks(data, exact);
  assert.equal(selected.venue.games, 10, "other matchups, stages and characters cannot leak into exact selection");
  assert.equal(selected.tournament.games, 4);
  assert.equal(selected.pro, null, "missing pro matchup cannot fall back to all pros");
  const allOpponents = selectInteractionBenchmarks(data, { ...exact, opponentCharacterId: null });
  assert.equal(allOpponents.venue.games, 30);
  assert.equal(allOpponents.venue.ledge.roll.attempts, 20);
  const allStages = selectInteractionBenchmarks(data, { ...exact, stageId: null });
  assert.equal(allStages.venue.games, 40);
  const missing = selectInteractionBenchmarks(data, { ...exact, characterId: 26 });
  assert.deepEqual(missing, { venue: null, tournament: null, pro: null });
  assert.equal(raw.rows[0].ledge.roll.attempts, 10, "rollups cannot mutate source rows");

  const value = (family, key, measure) => interactionBenchmarkValue(selected.venue, family, key, measure);
  assert.equal(value("ledge", "roll", "caughtRate").value, 3 / 8, "trades included, unresolved excluded");
  assert.equal(value("oos", "grab", "landedRate").value, 4 / 8);
  assert.equal(value("ledge", "roll", "noHitRate").value, 2 / 8);
  assert.equal(value("recoveries", "low", "returnRate").value, 5 / 8);
  assert.equal(value("recoveries", "low", "deathRate").value, 3 / 8);
  assert.equal(value("edgeguards", "holdLedge", "stockLossRate").value, 3 / 5, "only completed contests supply denominator");
  assert.equal(value("beforeOpening", "grab", "damagePerOpening").value, 20);
  assert.equal(value("beforeOpening", "grab", "deathRate").value, 2 / 8);
  assert.equal(value("ledge", "getup", "usageShare").value, 0, "known zero share within measured game family");
  assert.equal(value("ledge", "getup", "caughtRate").value, null, "no uses cannot give a measured zero outcome rate");
  assert.equal(value("ledge", "roll", "damagePerOpening").value, null, "incompatible measures stay unavailable");
  assert.equal(interactionBenchmarkValue(null, "ledge", "roll", "usageShare").value, null);
  const unavailable = { ...selected.venue, defenseGames: 0, ledge: {} };
  assert.equal(interactionBenchmarkValue(unavailable, "ledge", "roll", "usageShare").value, null);
  const noResolved = { ...selected.venue, ledge: { roll: { attempts: 1, punished: 0, hit: 0, traded: 0, noHit: 0, incomplete: 1 } } };
  assert.equal(interactionBenchmarkValue(noResolved, "ledge", "roll", "caughtRate").value, null);
  const local = { ...selected.venue, ledge: { getup: choice } };
  assert.deepEqual(interactionComparisonKeys(local, selected, "ledge"), ["getup", "roll"], "reference-only options stay visible");

  assert.equal(parseInteractionBenchmarkData({ ...raw, statsVersion: 7 }), null);
  assert.equal(parseInteractionBenchmarkData({ ...raw, schemaVersion: 2 }), null);
  assert.equal(parseInteractionBenchmarkData({ ...raw, sourceUrl: "javascript:fixture" }), null);
  assert.equal(parseInteractionBenchmarkData({ ...raw, rows: [...raw.rows, raw.rows[0]] }), null, "duplicate exact cells are rejected");
  const corrupt = structuredClone(raw);
  corrupt.rows[0].ledge.roll.incomplete = 3;
  assert.equal(parseInteractionBenchmarkData(corrupt), null, "inconsistent outcome totals are rejected");
  const badCoverage = structuredClone(raw);
  badCoverage.rows[0].defenseGames = 11;
  assert.equal(parseInteractionBenchmarkData(badCoverage), null);

  const html = renderToStaticMarkup(createElement(TestBenchmarkComparison, { local, family: "ledge", scope: exact, data }));
  assert.match(html, /Sampled · experimental/);
  assert.match(html, /No matching sample/);
  assert.match(html, /10 \/ 10 measured player-games/);
  assert.match(html, /Ledge roll/);
  assert.match(html, /Get up/);
  assert.match(html, /Small sample/);
  assert.match(html, /not population statistics/);
  assert.match(html, /ignoring date, mode, account, and named-opponent filters/);
  assert.match(html, /without a broader fallback/);
  const empty = renderToStaticMarkup(createElement(TestBenchmarkComparison, { local: { ...local, ledge: {} }, family: "ledge", scope: { ...exact, characterId: 26 }, data }));
  assert.match(empty, /No qualifying observations/);

  const bundled = await loadInteractionBenchmarks();
  assert.equal(bundled.statsVersion, INTERACTION_STATS_VERSION, "bundled sample matches detector version");
  const { LEDGE_OPTION_LABELS, OOS_OPTION_LABELS } = await server.ssrLoadModule("/src/lib/defensiveInteractions.ts");
  const { RECOVERY_ROUTE_LABELS, EDGEGUARD_TACTIC_LABELS } = await server.ssrLoadModule("/src/lib/recoveryInteractions.ts");
  const { PUNISH_ACTION_LABELS } = await server.ssrLoadModule("/src/lib/punishContext.ts");
  const publicationRules = { statsVersion: INTERACTION_STATS_VERSION, optionKeys: {
    ledge: LEDGE_OPTION_LABELS.map(row => row.key), oos: OOS_OPTION_LABELS.map(row => row.key), shieldExits: OOS_OPTION_LABELS.map(row => row.key),
    recoveries: Object.keys(RECOVERY_ROUTE_LABELS), edgeguards: Object.keys(EDGEGUARD_TACTIC_LABELS), beforeOpening: Object.keys(PUNISH_ACTION_LABELS),
  } };
  validateShippedInteractionSample(bundled, publicationRules);
  for (const [family, options] of Object.entries(publicationRules.optionKeys)) {
    assert.deepEqual([...INTERACTION_CODEC_OPTIONS[family]].sort(), [...options].sort(), `${family}: codec allowlist follows detector labels`);
  }
  const packed = encodeInteractionBenchmarks(bundled);
  const packedText = JSON.stringify(packed);
  const unpacked = decodeInteractionBenchmarks(JSON.parse(packedText));
  assert.deepEqual(unpacked, bundled, "compact transport preserves every exact cell, counter and provenance field");
  assert.deepEqual(decodeInteractionBenchmarks(bundled), bundled, "legacy raw format remains readable during migration");
  validateShippedInteractionSample(unpacked, publicationRules);
  assert.deepEqual(selectInteractionBenchmarks(parseInteractionBenchmarkData(unpacked), exact), selectInteractionBenchmarks(bundled, exact));
  const zeroAndMissing = structuredClone(bundled);
  zeroAndMissing.rows[0].ledge.unknown = { attempts: 0, punished: 0, hit: 0, traded: 0, noHit: 0, incomplete: 0 };
  zeroAndMissing.rows[0].shieldExits = {};
  const zeroRoundtrip = decodeInteractionBenchmarks(encodeInteractionBenchmarks(zeroAndMissing));
  assert.deepEqual(zeroRoundtrip, zeroAndMissing, "explicit zero counters and absent measurements are never conflated");
  assert.ok(Object.hasOwn(zeroRoundtrip.rows[0].ledge, "unknown"));
  assert.deepEqual(zeroRoundtrip.rows[0].shieldExits, {});
  const damaged = mutate => { const input = structuredClone(packed); mutate(input); assert.throws(() => decodeInteractionBenchmarks(input), /Invalid interaction reference/); };
  damaged(input => { input.encodingVersion = 2; });
  damaged(input => { input.filePath = "private"; });
  damaged(input => { input.metadata.connectCode = "PRIVATE#123"; });
  damaged(input => { input.metadata.provenance.filePath = "C:/private/replay.slp"; });
  damaged(input => { input.options.ledge.push("connectCode"); });
  damaged(input => { input.options.ledge.push(input.options.ledge[0]); });
  damaged(input => { input.rows.push(input.rows[0]); });
  damaged(input => { input.rows[0].push("private"); });
  damaged(input => { input.rows[0][0] = 3; });
  damaged(input => { input.rows[0][3] = 999; });
  damaged(input => { input.rows[0][8][0][0] = input.options.ledge.length; });
  damaged(input => { input.rows[0][8].push(input.rows[0][8][0]); });
  damaged(input => { input.rows[0][8][0][1] = -1; });
  damaged(input => { input.rows[0][8][0][1] = Number.NaN; });
  damaged(input => { input.rows[0][8][0].pop(); });
  damaged(input => { input.rows[0][8].filePath = "private"; });
  damaged(input => { input.rows[0][5] = 0; });
  const privateRaw = structuredClone(bundled);
  privateRaw.rows[0].ledge["PRIVATE#123"] = structuredClone(choice);
  assert.throws(() => encodeInteractionBenchmarks(privateRaw), /privacy allowlist/);
  assert.ok(Buffer.byteLength(packedText) < Buffer.byteLength(JSON.stringify(bundled)) * 0.4, "compact artifact meaningfully reduces download and offline-cache size");
  const privateField = structuredClone(bundled);
  privateField.rows[0].connectCode = "PRIVATE#123";
  assert.throws(() => validateShippedInteractionSample(privateField, publicationRules), /privacy allowlist/);
  const privateNested = structuredClone(bundled);
  privateNested.provenance.filePath = "C:/private/replays.slp";
  assert.throws(() => validateShippedInteractionSample(privateNested, publicationRules), /privacy allowlist/);
  console.log(`Interaction benchmark selection, denominators, coverage, presentation and codec passed (${bundled.rows.length} bundled cells; ${Buffer.byteLength(packedText)} compact bytes / ${Buffer.byteLength(JSON.stringify(bundled))} raw bytes).`);
} finally {
  await server.close();
}
