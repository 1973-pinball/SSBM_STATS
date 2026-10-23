/** Local import diagnostics against the real dashboard selectors and demo data. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createServer } from "vite";

const tempRoot = resolve(tmpdir());
const temp = await mkdtemp(join(tempRoot, "ssbm-import-report-"));
let server;
try {
  server = await createServer({
    configFile: false, envDir: temp, cacheDir: join(temp, "vite"),
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { createImportReport } = await server.ssrLoadModule("/src/lib/importReport.ts");
  const { generateDemoRecords, DEMO_ACCOUNTS } = await server.ssrLoadModule("/src/lib/demo.ts");
  const { DEFAULT_FILTERS } = await server.ssrLoadModule("/src/lib/types.ts");
  const { localDay, resolveGames, resolveTeamGames } = await server.ssrLoadModule("/src/lib/stats.ts");

  const codes = new Set(DEMO_ACCOUNTS.map((account) => account.code));
  const demo = generateDemoRecords(25);
  const single = resolveGames(demo, codes, true)[0]?.rec;
  const team = resolveTeamGames(demo, codes, true)[0]?.rec;
  assert.ok(single && team, "demo provides eligible singles and teams fixtures");
  const oct6 = "2026-10-06T18:00:00.000Z";
  const oct7 = "2026-10-07T18:00:00.000Z";
  let nextId = 0;
  const record = (playedAt = oct7, source = single) => {
    const rec = structuredClone(source);
    rec.id = `import-report-${++nextId}`;
    rec.path = `${rec.id}.slp`;
    rec.playedAt = playedAt;
    rec.players.forEach((player) => { player.isCpu = false; });
    return rec;
  };
  const progress = (patch = {}) => ({
    pass: "full", total: 1, done: 1, skippedCached: 0, failed: 0, unreadable: 0, deferred: 0, ...patch,
  });
  const assertPartition = (result) => {
    assert.equal(result.inspectedGames, result.parsedGames + result.cachedGames,
      "inspected games partition into fresh and cached observations");
    assert.equal(result.inspectedGames,
      result.includedGames + Object.values(result.exclusions).reduce((sum, count) => sum + count, 0),
      "every inspected distinct game has exactly one outcome");
  };
  const report = (records, filters = DEFAULT_FILTERS, format = "singles", accounts = DEMO_ACCOUNTS) => {
    const builder = createImportReport(accounts, filters, format);
    records.forEach((rec) => builder.observe(rec));
    const result = builder.finish(progress({ total: records.length, done: records.length }));
    assertPartition(result);
    return result;
  };

  const cached = createImportReport(DEMO_ACCOUNTS, DEFAULT_FILTERS, "singles")
    .finish(progress({ total: 0, done: 0, skippedCached: 500 }));
  assert.equal(cached.parsedGames, 0, "cached files are not newly observed parses");
  assert.equal(cached.inspectedGames, 0, "seen markers without corresponding rows cannot be diagnosed");
  assert.equal(cached.cachedGames, 0);
  assert.equal(cached.includedGames, 0, "already scanned does not claim current display eligibility");
  assert.equal(cached.progress.skippedCached, 500);
  assert.equal(cached.latestParsedAt, null);
  assert.equal(cached.latestMatchingAt, null);
  assertPartition(cached);

  // Old library games need not be re-observed to explain a newly selected file.
  const old = record(oct6);
  const recent = record(oct7);
  assert.equal(report([old]).latestMatchingAt, oct6);
  const newOnly = report([recent]);
  assert.equal(newOnly.parsedGames, 1);
  assert.equal(newOnly.matchingGames, 1);
  assert.equal(newOnly.includedGames, 1);
  assert.equal(newOnly.latestMatchingAt, oct7, "the new replay's embedded date reaches the report");
  assert.equal(report([recent, old]).latestParsedAt, oct7, "completion order does not change newest date");

  const foreign = record("2026-10-08T18:00:00.000Z");
  foreign.players.forEach((player, index) => { player.connectCode = `OTHER#${index + 1}`; });
  const mixed = report([old, recent, foreign]);
  assert.equal(mixed.parsedGames, 3);
  assert.equal(mixed.matchingGames, 2);
  assert.equal(mixed.exclusions.account, 1);
  assert.equal(mixed.latestParsedAt, foreign.playedAt);
  assert.equal(mixed.latestMatchingAt, oct7, "another player's newer game cannot advance your latest game");
  assert.equal(report([recent], DEFAULT_FILTERS, "singles", []).exclusions.account, 1);

  const cachedMismatch = createImportReport(DEMO_ACCOUNTS, DEFAULT_FILTERS, "singles");
  cachedMismatch.observeCached(foreign);
  cachedMismatch.observeCached(foreign);
  const foreignCopy = structuredClone(foreign);
  foreignCopy.id = "cached-copy-in-another-folder";
  cachedMismatch.observeCached(foreignCopy);
  const cachedDiagnosis = cachedMismatch.finish(progress({ total: 0, done: 0, skippedCached: 1 }));
  assert.equal(cachedDiagnosis.parsedGames, 0, "inspecting a stored row is not a fresh parse");
  assert.equal(cachedDiagnosis.inspectedGames, 1);
  assert.equal(cachedDiagnosis.cachedGames, 1, "repeated cached copies are inspected once by content key");
  assert.equal(cachedDiagnosis.exclusions.account, 1, "cached-only selections still diagnose identity mismatches");
  assert.equal(cachedDiagnosis.latestParsedAt, foreign.playedAt);
  assert.equal(cachedDiagnosis.latestMatchingAt, null);
  assertPartition(cachedDiagnosis);

  const freshThenCached = createImportReport(DEMO_ACCOUNTS, DEFAULT_FILTERS, "singles");
  freshThenCached.observe(recent);
  freshThenCached.observeCached(recent);
  freshThenCached.observeCached(record(oct7));
  freshThenCached.observeCached(old);
  const combined = freshThenCached.finish(progress({ skippedCached: 1 }));
  assert.equal(combined.parsedGames, 1);
  assert.equal(combined.cachedGames, 1, "the stored copy of a fresh parse cannot inflate cached-game totals");
  assert.equal(combined.inspectedGames, 2);
  assert.equal(combined.matchingGames, 2);
  assert.equal(combined.includedGames, 2);
  assert.equal(combined.latestMatchingAt, oct7);
  assertPartition(combined);

  const cachedDateFilter = createImportReport(DEMO_ACCOUNTS,
    { ...DEFAULT_FILTERS, day: localDay(new Date(oct6)) }, "singles");
  cachedDateFilter.observeCached(recent);
  const hiddenCached = cachedDateFilter.finish(progress({ total: 0, done: 0, skippedCached: 1 }));
  assert.equal(hiddenCached.parsedGames, 0);
  assert.equal(hiddenCached.cachedGames, 1);
  assert.equal(hiddenCached.matchingGames, 1);
  assert.equal(hiddenCached.exclusions.filters, 1, "cached-only imports diagnose an older selected date too");
  assert.equal(hiddenCached.latestMatchingAt, oct7);
  assertPartition(hiddenCached);

  const noCodes = record();
  noCodes.players.forEach((player) => { player.connectCode = null; });
  assert.equal(report([noCodes]).exclusions.noCode, 1);
  assert.equal(report([noCodes]).matchingGames, 0);
  const opponentCodeOnly = record();
  opponentCodeOnly.players.forEach((player) => {
    if (codes.has(player.connectCode)) player.connectCode = null;
  });
  assert.equal(report([opponentCodeOnly]).exclusions.account, 1,
    "an opponent code alone is a non-match, not proof that this is someone else's replay");

  const cpu = record();
  cpu.players[1].isCpu = true;
  assert.equal(report([cpu]).exclusions.cpu, 1);
  assert.equal(report([cpu]).matchingGames, 1);
  assert.equal(report([cpu], { ...DEFAULT_FILTERS, includeCpuGames: true }).includedGames, 1);
  for (const status of [undefined, null, false]) {
    cpu.players[1].isCpu = status;
    assert.equal(report([cpu]).includedGames, 1, "only explicit CPU evidence hides a game");
  }

  const wrongStage = record();
  wrongStage.stageId = 7;
  const wrongRoster = record();
  wrongRoster.players[1].characterId = 31;
  const wrongShape = record();
  wrongShape.players.pop();
  for (const unsupported of [wrongStage, wrongRoster, wrongShape]) {
    assert.equal(report([unsupported]).exclusions.unsupported, 1);
  }
  wrongStage.players[1].isCpu = true;
  assert.equal(report([wrongStage]).exclusions.unsupported, 1, "unsupported takes priority over CPU");

  const chosenDay = localDay(new Date(oct6));
  const filtered = report([old, recent], { ...DEFAULT_FILTERS, day: chosenDay });
  assert.equal(filtered.includedGames, 1);
  assert.equal(filtered.exclusions.filters, 1, "a date filter can hide a successfully imported newer replay");
  assert.equal(report([recent], { ...DEFAULT_FILTERS, gameTypes: [] }).exclusions.filters, 1);

  const doubles = record(oct7, team);
  assert.equal(report([doubles]).exclusions.format, 1);
  assert.equal(report([doubles], DEFAULT_FILTERS, "teams").includedGames, 1,
    "the actual displayed format overrides the format field in the filter snapshot");
  assert.equal(report([recent], { ...DEFAULT_FILTERS, format: "teams" }, "singles").includedGames, 1);
  doubles.players[1].isCpu = true;
  assert.equal(report([doubles]).exclusions.cpu, 1, "CPU takes priority over other format");

  const copied = record(oct7);
  const duplicate = report([recent, recent, copied]);
  assert.equal(duplicate.parsedGames, 1, "copied files and repeated delivery count as one content game");
  assert.equal(duplicate.includedGames, 1);
  assert.equal(duplicate.progress.done, 3, "file progress remains separate from distinct-game counts");

  const undecided = record();
  undecided.winnerIndex = null;
  undecided.durationFrames = 60;
  delete undecided.statsVersion;
  undecided.players.forEach((player) => { delete player.techs; delete player.moveStats; });
  assert.equal(report([undecided]).includedGames, 1,
    "short/undecided games and older stat payloads still belong in the game selection");
  const selfMatch = record();
  selfMatch.players[1].connectCode = selfMatch.players[0].connectCode;
  assert.equal(report([selfMatch]).includedGames, 1, "self-matches still count as games");

  const invalidDate = record("not-a-date");
  const missingDate = record(null);
  for (const undated of [invalidDate, missingDate]) {
    const result = report([undated]);
    assert.equal(result.includedGames, 1);
    assert.equal(result.latestParsedAt, null);
    assert.equal(result.latestMatchingAt, null);
  }
  const preview = record();
  preview.statsLevel = "header";
  const failure = record();
  failure.parseError = "synthetic parse failure";
  assert.equal(report([preview, failure]).parsedGames, 0, "provisional or failed rows are not successful imports");
  const failedCached = createImportReport(DEMO_ACCOUNTS, DEFAULT_FILTERS, "singles");
  failedCached.observeCached(preview);
  failedCached.observeCached(failure);
  assert.equal(failedCached.finish(progress()).inspectedGames, 0,
    "cached failures and previews cannot establish game eligibility");

  const mutableAccounts = structuredClone(DEMO_ACCOUNTS);
  const mutableFilters = { ...DEFAULT_FILTERS, gameTypes: [recent.gameType] };
  const snapshot = createImportReport(mutableAccounts, mutableFilters, "singles");
  mutableAccounts[0].code = "CHANGED#1";
  mutableAccounts.push({ code: "OTHER#1", label: null });
  mutableFilters.gameTypes.length = 0;
  mutableFilters.myCharacter = 999;
  snapshot.observe(recent);
  const mutableProgress = progress();
  const finished = snapshot.finish(mutableProgress);
  mutableProgress.done = 500;
  assert.equal(finished.includedGames, 1, "account and filter edits during parsing do not rewrite the snapshot");
  assert.deepEqual(finished.accountCodes, DEMO_ACCOUNTS.map((account) => account.code));
  assert.equal(finished.progress.done, 1, "finish copies mutable progress");
  finished.exclusions.account = 999;
  finished.accountCodes.length = 0;
  assert.equal(snapshot.finish(progress()).exclusions.account, 0, "returned snapshots do not expose accumulator state");
  assert.deepEqual(snapshot.finish(progress()).accountCodes, DEMO_ACCOUNTS.map((account) => account.code));

  console.log("Import report checks passed: dates, identity, display exclusions, distinct fresh/cached games, cached-only diagnoses, and immutable snapshots.");
} finally {
  try {
    await server?.close();
  } finally {
    const relativeTemp = relative(tempRoot, resolve(temp));
    assert.ok(relativeTemp && !relativeTemp.startsWith("..") && !isAbsolute(relativeTemp),
      "Refusing cleanup outside the task's temporary directory root");
    await rm(temp, { recursive: true, force: true });
  }
}
