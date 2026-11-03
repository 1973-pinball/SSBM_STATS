import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({ configFile: false, envDir: false,
  server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { automaticInteractionTargets, interactionAnalysisAttemptKey, matchInteractionAnalysisFiles } =
    await server.ssrLoadModule("/src/lib/automaticInteractionAnalysis.ts");
  const record = (n, statsVersion = 6, id = `replays/${n}.slp|100|200`) => ({
    id, path: id.split("|")[0], statsVersion,
    playedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    stageId: 31, isTeams: false,
    players: [0, 1].map(port => ({ port, connectCode: `PLAYER#${port}`, characterId: 2 })),
  });
  const file = rec => ({ id: rec.id, path: rec.path, format: "slp", file: {} });
  const records = Array.from({ length: 200 }, (_, i) => record(i, i >= 195 ? 8 : 6));
  const attempted = new Set();
  const targets = automaticInteractionTargets(records, attempted);
  assert.equal(targets.length, 145, "5 current games in the latest 150 leave exactly 145 upgrades");
  assert.deepEqual(targets.map(rec => rec.id), records.slice(50, 195).map(rec => rec.id));
  assert.equal(attempted.size, 0, "target derivation is pure; scheduling owns attempt state");

  targets.forEach(rec => attempted.add(interactionAnalysisAttemptKey(rec)));
  assert.deepEqual(automaticInteractionTargets(records, attempted), [], "attempted games must not pull in 50 older games");
  const upgraded = records.map(rec => ({ ...rec, statsVersion: 8 }));
  assert.deepEqual(automaticInteractionTargets(upgraded, new Set()), [], "upgrades do not expand the rolling scope");
  assert.deepEqual(automaticInteractionTargets(records, new Set(), 0), []);
  assert.deepEqual(automaticInteractionTargets([], new Set()), []);

  const original = record(500);
  const local = { ...original, id: "local/moved.slp|100|999", path: "local/moved.slp" };
  const otherCopy = { ...original, id: "z-copy/moved.slp|100|777", path: "z-copy/moved.slp" };
  const unrelated = record(501);
  assert.equal(interactionAnalysisAttemptKey(local), interactionAnalysisAttemptKey(original), "moved aliases share attempt state");
  assert.notEqual(interactionAnalysisAttemptKey({ ...original, statsVersion: 7 }), interactionAnalysisAttemptKey(original),
    "a changed saved detector version has a distinct attempt key");
  assert.deepEqual(automaticInteractionTargets([local], new Set([interactionAnalysisAttemptKey(original)])), []);

  const exact = matchInteractionAnalysisFiles([original], [file(local), file(unrelated), file(original)], [local, unrelated]);
  assert.deepEqual(exact.files.map(f => f.id), [original.id], "exact target ID wins over a cached alias");
  assert.deepEqual([...exact.matchedRequestedIds], [original.id]);
  const aliases = matchInteractionAnalysisFiles([original], [file(otherCopy), file(unrelated), file(local)], [otherCopy, local, unrelated]);
  assert.deepEqual(aliases.files.map(f => f.id), [local.id], "one deterministic cached alias per game; unrelated files excluded");
  assert.deepEqual([...aliases.matchedRequestedIds], [original.id], "alias counts as finding the saved target");
  const duplicates = matchInteractionAnalysisFiles([original, local], [file(local), file(original), file(original)], [local]);
  assert.equal(duplicates.files.length, 1, "duplicate target/copy entries never parse a game twice");
  assert.deepEqual([...duplicates.matchedRequestedIds], [original.id, local.id]);

  assert.deepEqual(matchInteractionAnalysisFiles([original], [file(local)], []).files, [],
    "an uncached moved/cloud alias needs the manual file fallback, never an expanded scan");
  assert.deepEqual(matchInteractionAnalysisFiles([original], [], [local]).files, []);
  assert.deepEqual([...matchInteractionAnalysisFiles([original], [], [local]).matchedRequestedIds], []);
  assert.deepEqual(matchInteractionAnalysisFiles([], [file(unrelated)], [unrelated]).files, []);
  const conflict = { ...unrelated, id: local.id };
  assert.deepEqual(matchInteractionAnalysisFiles([original], [file(local)], [local, conflict]).files, [],
    "conflicting content identities are not enough to identify a moved replay");
  assert.deepEqual(matchInteractionAnalysisFiles([original], [file(local)], [{ ...local, parseError: "unreadable" }]).files, []);

  const unsupported = record(600, 8);
  assert.deepEqual(automaticInteractionTargets([unsupported], new Set()), [],
    "current v8 without supported interaction fields must not retry endlessly");
  assert.deepEqual(automaticInteractionTargets([
    { ...original, statsLevel: "header" }, { ...original, parseError: "bad" },
    { ...original, isTeams: true }, { ...original, players: [] },
  ], new Set()), [], "preview, failed, teams, and malformed records stay out");
  const datelessA = { ...original, playedAt: null }, datelessB = { ...local, playedAt: null };
  assert.notEqual(interactionAnalysisAttemptKey(datelessA), interactionAnalysisAttemptKey(datelessB));
  assert.deepEqual(matchInteractionAnalysisFiles([datelessA], [file(datelessB)], [datelessB]).files, [],
    "replays without content timestamps cannot be inferred to be aliases");

  console.log("Automatic interactions: bounded latest-150 upgrades, attempt deduplication, cached aliases, exact-match preference and no unrelated reparses passed.");
} finally { await server.close(); }
