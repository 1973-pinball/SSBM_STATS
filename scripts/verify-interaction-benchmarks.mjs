/** Exact matchup/stage selection, sampled coverage and comparable denominators. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { validateShippedInteractionSample, assertNoInteractionIdentityValues } from "./lib/interaction-benchmark-validation.mjs";
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
  const recovery = { attempts: 10, reachedLedge: 6, hitDuringRecovery: 4, returned: 5, died: 3, incomplete: 2 };
  const edgeguard = { opportunities: 10, contested: 7, completedContests: 5, stocksTaken: 3, opponentReturned: 4, uncontestedDeaths: 1, incomplete: 2 };
  const opening = { openings: 10, damage: 160, kills: 2, incomplete: 2 };
  const row = (cohort, characterId, opponentCharacterId, stageId, games = 10) => ({
    cohort, characterId, opponentCharacterId, stageId, games, defenseGames: games, recoveryGames: games, punishGames: games,
    ledge: { roll: structuredClone(choice) },
    oos: { grab: structuredClone(choice), jump: { ...choice, cStickInputs: 3, cStickSamples: 7 } },
    shieldExits: { jump: { ...choice, cStickInputs: 0, cStickSamples: 1 } },
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
  assert.equal(allOpponents.venue.oos.jump.cStickInputs, 6);
  assert.equal(allOpponents.venue.oos.jump.cStickSamples, 14, "observed input samples remain a subset of attempts when pooled");
  assert.equal(allOpponents.venue.shieldExits.jump.cStickInputs, 0, "observed neutral input stays a measured zero");
  assert.equal(allOpponents.venue.shieldExits.jump.cStickSamples, 2);
  assert.equal(allOpponents.venue.oos.grab.cStickInputs, undefined, "unobserved input counters stay unavailable");
  const mixedCoverage = structuredClone(raw);
  delete mixedCoverage.rows[1].oos.jump.cStickInputs;
  delete mixedCoverage.rows[1].oos.jump.cStickSamples;
  const mixedInputs = selectInteractionBenchmarks(parseInteractionBenchmarkData(mixedCoverage),
    { ...exact, opponentCharacterId: null }).venue.oos.jump;
  assert.equal(mixedInputs.attempts, 20);
  assert.equal(mixedInputs.cStickInputs, 3);
  assert.equal(mixedInputs.cStickSamples, 7, "unobserved attempts do not become neutral input samples");
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
  assert.deepEqual(value("recoveries", "low", "hitDuringRecoveryRate"), {
    value: 4 / 10, numerator: 4, denominator: 10, measuredGames: 10,
  }, "observed recovery hits use all attempts, including unresolved attempts");
  for (const hitDuringRecovery of [undefined, Number.NaN, -1, 11]) {
    const legacyOrInvalid = { ...selected.venue, recoveries: { low: { ...recovery, hitDuringRecovery } } };
    assert.deepEqual(interactionBenchmarkValue(legacyOrInvalid, "recoveries", "low", "hitDuringRecoveryRate"),
      { value: null, numerator: 0, denominator: 0, measuredGames: 10 },
      "missing or invalid recovery hits cannot become zero or NaN rates");
  }
  const noRecoveryHits = { ...selected.venue, recoveries: { low: { ...recovery, hitDuringRecovery: 0 } } };
  assert.equal(interactionBenchmarkValue(noRecoveryHits, "recoveries", "low", "hitDuringRecoveryRate").value, 0,
    "an explicit measured zero remains distinguishable from an old missing field");
  assert.equal(value("recoveries", "high", "hitDuringRecoveryRate").value, null,
    "an unused route cannot yield a measured hit rate");
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
  assert.equal(parseInteractionBenchmarkData({ ...raw, statsVersion: 8 }), null,
    "v8 references cannot supply recovery-hit coverage");
  assert.equal(parseInteractionBenchmarkData({ ...raw, schemaVersion: 2 }), null);
  assert.equal(parseInteractionBenchmarkData({ ...raw, sourceUrl: "javascript:fixture" }), null);
  assert.equal(parseInteractionBenchmarkData({ ...raw, rows: [...raw.rows, raw.rows[0]] }), null, "duplicate exact cells are rejected");
  const corrupt = structuredClone(raw);
  corrupt.rows[0].ledge.roll.incomplete = 3;
  assert.equal(parseInteractionBenchmarkData(corrupt), null, "inconsistent outcome totals are rejected");
  const badCoverage = structuredClone(raw);
  badCoverage.rows[0].defenseGames = 11;
  assert.equal(parseInteractionBenchmarkData(badCoverage), null);
  for (const hitDuringRecovery of [undefined, Number.NaN, -1, 11]) {
    const badRecovery = structuredClone(raw);
    badRecovery.rows[0].recoveries.low.hitDuringRecovery = hitDuringRecovery;
    assert.equal(parseInteractionBenchmarkData(badRecovery), null,
      "v9 references require a nonnegative integer hit count no greater than attempts");
  }
  for (const family of ["oos", "shieldExits"]) {
    for (const [cStickInputs, cStickSamples] of [[undefined, 1], [0, undefined], [-1, 1], [0, Number.NaN], [2, 1], [0, 11]]) {
      const badInputs = structuredClone(raw);
      badInputs.rows[0][family].jump = { ...choice, cStickInputs, cStickSamples };
      assert.equal(parseInteractionBenchmarkData(badInputs), null, "input observations require a complete pair within sample and attempt bounds");
    }
  }

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
  assert.equal(packed.encodingVersion, 2, "the extra recovery counter changes the compact wire format");
  const packedText = JSON.stringify(packed);
  const unpacked = decodeInteractionBenchmarks(JSON.parse(packedText));
  assert.deepEqual(unpacked, bundled, "compact transport preserves every exact cell, counter and provenance field");
  assert.deepEqual(decodeInteractionBenchmarks(bundled), bundled, "the current raw schema remains readable alongside compact encoding");
  validateShippedInteractionSample(unpacked, publicationRules);
  assertNoInteractionIdentityValues(unpacked, ["grab"], "public grab counters are not a player identity leak");
  assert.throws(() => assertNoInteractionIdentityValues({ ...unpacked, method: "grab" }, ["grab"]), /identity/,
    "the same identifier in a free-text value is rejected");
  assert.deepEqual(selectInteractionBenchmarks(parseInteractionBenchmarkData(unpacked), exact), selectInteractionBenchmarks(bundled, exact));
  const zeroAndMissing = structuredClone(bundled);
  zeroAndMissing.rows[0].ledge.unknown = { attempts: 0, punished: 0, hit: 0, traded: 0, noHit: 0, incomplete: 0 };
  zeroAndMissing.rows[0].shieldExits = {};
  const zeroRoundtrip = decodeInteractionBenchmarks(encodeInteractionBenchmarks(zeroAndMissing));
  assert.deepEqual(zeroRoundtrip, zeroAndMissing, "explicit zero counters and absent measurements are never conflated");
  assert.ok(Object.hasOwn(zeroRoundtrip.rows[0].ledge, "unknown"));
  assert.deepEqual(zeroRoundtrip.rows[0].shieldExits, {});
  const inputSamples = structuredClone(bundled);
  const inputRowIndex = inputSamples.rows.findIndex(row => row.defenseGames > 0);
  inputSamples.rows[inputRowIndex].oos = {
    grab: structuredClone(choice), jump: { ...choice, cStickInputs: 3, cStickSamples: 7 },
  };
  inputSamples.rows[inputRowIndex].shieldExits = { jump: { ...choice, cStickInputs: 0, cStickSamples: 1 } };
  const packedInputs = encodeInteractionBenchmarks(inputSamples);
  const compactChoice = (input, familyIndex, option) => input.rows[inputRowIndex][familyIndex]
    .find(entry => input.options[familyIndex === 9 ? "oos" : "shieldExits"][entry[0]] === option);
  assert.deepEqual(compactChoice(packedInputs, 9, "grab").slice(7), [null, null], "missing samples use explicit null slots");
  assert.deepEqual(compactChoice(packedInputs, 10, "jump").slice(7), [0, 1], "neutral observations keep a numeric zero");
  assert.deepEqual(decodeInteractionBenchmarks(JSON.parse(JSON.stringify(packedInputs))), inputSamples,
    "optional input counters roundtrip without conflating unobserved and neutral inputs");
  validateShippedInteractionSample(inputSamples, publicationRules);
  for (const family of ["oos", "shieldExits"]) {
    for (const [cStickInputs, cStickSamples] of [[undefined, 1], [0, undefined], [-1, 1], [0, Number.NaN], [2, 1], [0, 11]]) {
      const invalid = structuredClone(inputSamples);
      invalid.rows[inputRowIndex][family].jump = { ...choice, cStickInputs, cStickSamples };
      assert.throws(() => encodeInteractionBenchmarks(invalid), /Invalid interaction reference/);
      assert.throws(() => validateShippedInteractionSample(invalid, publicationRules));
    }
    const partial = structuredClone(inputSamples);
    delete partial.rows[inputRowIndex][family].jump.cStickSamples;
    assert.throws(() => encodeInteractionBenchmarks(partial), /privacy allowlist/);
    assert.throws(() => validateShippedInteractionSample(partial, publicationRules), /privacy allowlist/);
  }
  for (const familyIndex of [9, 10]) {
    for (const [inputs, samples] of [[null, 1], [0, null], [2, 1], [0, 11], [-1, 1]]) {
      const invalid = structuredClone(packedInputs);
      compactChoice(invalid, familyIndex, "jump").splice(7, 2, inputs, samples);
      assert.throws(() => decodeInteractionBenchmarks(invalid), /Invalid interaction reference/);
    }
  }
  const damaged = mutate => { const input = structuredClone(packed); mutate(input); assert.throws(() => decodeInteractionBenchmarks(input), /Invalid interaction reference/); };
  damaged(input => { input.encodingVersion = 1; });
  damaged(input => { input.encodingVersion = 3; });
  damaged(input => { input.metadata.statsVersion = 8; });
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
  const recoveryCounter = input => input.rows.find(row => row[11].length > 0)[11][0];
  damaged(input => { recoveryCounter(input)[3] = recoveryCounter(input)[1] + 1; });
  damaged(input => { recoveryCounter(input)[3] = -1; });
  damaged(input => { recoveryCounter(input)[3] = Number.NaN; });
  damaged(input => { recoveryCounter(input).splice(3, 1); });
  const missingRecoveryCounter = structuredClone(bundled);
  const recoveryRow = missingRecoveryCounter.rows.find(row => Object.keys(row.recoveries).length > 0);
  delete Object.values(recoveryRow.recoveries)[0].hitDuringRecovery;
  assert.equal(parseInteractionBenchmarkData(missingRecoveryCounter), null);
  assert.throws(() => encodeInteractionBenchmarks(missingRecoveryCounter), /privacy allowlist/);
  assert.throws(() => validateShippedInteractionSample(missingRecoveryCounter, publicationRules), /privacy allowlist/);
  assert.throws(() => decodeInteractionBenchmarks({ ...bundled, statsVersion: 8 }), /analysis schema/);
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
