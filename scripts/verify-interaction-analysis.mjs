import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({ configFile: false, envDir: false,
  server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { createInteractionAccumulator, addInteractionFrame, finishInteractionAccumulator } = await server.ssrLoadModule("/src/lib/interactionAnalysis.ts");
  const types = await server.ssrLoadModule("/src/lib/types.ts");
  const { dedupeRecords, mergeGameRecords } = await server.ssrLoadModule("/src/lib/dedupe.ts");
  const { interactionSummary } = await server.ssrLoadModule("/src/lib/interactionSummary.ts");
  const { interactionAnalysisFeedback } = await server.ssrLoadModule("/src/lib/interactionAnalysisReport.ts");
  const { db } = await server.ssrLoadModule("/src/lib/db.ts");
  const settings = { isTeams: false, stageId: 31, players: [{ playerIndex: 0 }, { playerIndex: 1 }] };
  const post = { actionStateId: 14, positionX: 0, positionY: 0, isAirborne: false, internalCharacterId: 1,
    stocksRemaining: 4, percent: 0, lastHitBy: 255, isFollower: false, hitlagRemaining: 0 };
  const frames = Array.from({ length: 124 }, (_, i) => ({ frame: i - 123, players: { 0: { post }, 1: { post } } }));
  const acc = createInteractionAccumulator(settings);
  for (const f of frames) addInteractionFrame(acc, f);
  const bounds = { expectedLastFrame: 0, finalizedLastFrame: 0 };
  const full = finishInteractionAccumulator(acc, bounds);
  assert.equal(full.size, 2);
  assert.ok(full.get(0).defense && full.get(0).recovery && full.get(0).punish, "complete observed zero is measured, not absent");
  assert.equal(finishInteractionAccumulator(acc, { ...bounds, expectedLastFrame: 1 }).size, 0, "malformed declared tail invalidates full-game coverage");
  assert.equal(finishInteractionAccumulator(acc, { ...bounds, finalizedLastFrame: null }).size, 0, "unknown finalization fails closed");
  const prefix = createInteractionAccumulator(settings);
  for (const f of frames.slice(1)) addInteractionFrame(prefix, f);
  assert.equal(finishInteractionAccumulator(prefix, bounds).size, 0, "missing first frame invalidates counts");
  const gap = createInteractionAccumulator(settings);
  for (const f of [frames[0], ...frames.slice(2)]) addInteractionFrame(gap, f);
  assert.equal(finishInteractionAccumulator(gap, bounds).size, 0);
  assert.equal(createInteractionAccumulator({ ...settings, isTeams: true }), null);

  const rec = (id, statsVersion) => ({ id, statsVersion, path: "fixture", playedAt: "2026-01-01T00:00:00Z", stageId: 31,
    isTeams: false, players: [0, 1].map(port => ({ port, connectCode: null, characterId: 2, techs: {}, actions: { crouchCancels: 0 } })) });
  assert.equal(types.CURRENT_STATS_VERSION, 9);
  assert.equal(types.INTERACTION_STATS_VERSION, 9);
  assert.equal(types.MIN_COMPATIBLE_STATS_VERSION, 6);
  const baseline = rec("a-old", 6), previousAnalysis = rec("b-previous", 7), previousRevision = rec("c-v8", 8), analyzed = rec("z-new", 9), stale = rec("stale", 5);
  assert.ok(types.hasCurrentStats(baseline), "baseline stays usable while recent-game analysis runs");
  assert.equal(types.needsStatsRepair(baseline), false, "no whole-library schema repair for interaction upgrades");
  assert.ok(types.needsInteractionAnalysis(baseline));
  assert.ok(types.hasCurrentStats(previousAnalysis), "v7 baseline remains usable after audit corrections");
  assert.equal(types.needsStatsRepair(previousAnalysis), false, "v7 correction uses the scoped analysis queue");
  assert.ok(types.needsInteractionAnalysis(previousAnalysis), "older interaction detector needs reanalysis");
  assert.ok(types.hasCurrentStats(previousRevision), "v8 baseline stays usable while recovery and defensive metrics upgrade");
  assert.equal(types.needsStatsRepair(previousRevision), false, "v8 never triggers whole-library schema repair");
  assert.ok(types.needsInteractionAnalysis(previousRevision), "v8 interaction metrics need the scoped v9 upgrade");
  assert.equal(types.needsInteractionAnalysis(analyzed), false, "unsupported v9 fields don't force endless reparsing");
  assert.equal(types.hasCurrentStats(rec("invalid", 6.5)), false);
  assert.equal(dedupeRecords([baseline, analyzed])[0], analyzed);
  assert.equal(mergeGameRecords(baseline, analyzed), analyzed, "late old response can't downgrade analysis");
  assert.equal(mergeGameRecords(previousAnalysis, analyzed), analyzed, "v7 response cannot overwrite current v9");
  assert.equal(mergeGameRecords(previousRevision, analyzed), analyzed, "v8 response cannot overwrite current v9");
  assert.equal(mergeGameRecords({ ...analyzed, statsLevel: "header" }, baseline), baseline);

  const measurements = { ledge: { getup: { attempts: 1, punished: 0, hit: 0, traded: 0, noHit: 1, incomplete: 0 } }, oos: {}, shieldExits: {} };
  const rows = [baseline, previousAnalysis, previousRevision, analyzed].map(record => ({ rec: record, me: { ...record.players[0], defense: measurements } }));
  const summary = interactionSummary(rows);
  assert.equal(summary.games, 4, "baseline games remain in overall coverage denominator");
  assert.equal(summary.defenseGames, 1, "v6/v7/v8 interaction fields are ignored until current reanalysis");
  assert.equal(summary.ledge.getup.attempts, 1);

  // A cloud-path survivor and an already-seen local alias share game content
  // but not file identity. A zero-work reanalysis must explain the file picker.
  const missingAlias = interactionAnalysisFeedback(["cloud/game|1|2"], ["local/game|1|2"], []);
  assert.match(missingAlias, /1 replay could not be matched/);
  assert.match(missingAlias, /Select replay files/);
  assert.match(missingAlias, /saved stats are still available/);
  assert.equal(interactionAnalysisFeedback(["cloud/game|1|2"], ["local/game|1|2"], ["cloud/game|1|2"]), null,
    "a newly parsed alias with confirmed matching content suppresses a false missing-path warning");
  assert.equal(interactionAnalysisFeedback(["one"], ["one", "unrelated"], ["one"]), null);
  const partial = interactionAnalysisFeedback(["one", "one", "two", "missing"], ["one", "two", "unrelated"], ["one", "unrelated"]);
  assert.match(partial, /1 replay could not be matched/);
  assert.match(partial, /could not finish for 1 matched replay/);
  assert.match(partial, /Retry after any recording has finished/);
  assert.equal(interactionAnalysisFeedback([], ["unrelated"], ["unrelated"]), null);

  const packs = new Map([[1, { id: 1, records: [baseline, previousAnalysis, previousRevision, analyzed, stale] }]]);
  const seen = new Set([baseline.id, previousAnalysis.id, previousRevision.id, analyzed.id, stale.id]);
  const stores = {
    packs: { toArray: async () => structuredClone([...packs.values()]), put: async pack => packs.set(pack.id, pack), delete: async id => packs.delete(id) },
    seen: { bulkDelete: async ids => ids.forEach(id => seen.delete(id)) },
  };
  const upgrade = db._versions.find(v => v._cfg.version === 20)._cfg.contentUpgrade;
  await upgrade({ table: name => { assert.ok(name in stores); return stores[name]; } });
  assert.deepEqual(packs.get(1).records, [baseline, previousAnalysis, previousRevision, analyzed]);
  assert.deepEqual([...seen], [baseline.id, previousAnalysis.id, previousRevision.id, analyzed.id], "v20 preserves v6/v7/v8 baseline seen markers");
  console.log("Interaction integration: full-stream coverage, scoped upgrade, newer-copy preference and v20 preservation passed.");
} finally { await server.close(); }
