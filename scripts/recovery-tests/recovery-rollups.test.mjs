import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRecoveryRollups, dimensionKey, assertRecoveryRows, assertRecoveryCoverage,
  assertRecoveryRecordMeasurements } from "../lib/archive-recovery-rollups.mjs";

const dataset = "nikki-2026-09-08-v99";
const capability = () => ({ attempts: true, outcomes: true });
const special = (attempts = 1) => ({ attempts, hitAttempts: attempts, noHitAttempts: 0, incompleteAttempts: 0,
  landed: 2, damage: 3.1234, kills: 1, killPctSum: 109.1234, openings: 1, openingDmg: 9.1234, lcSuccess: 2, lcFail: 1 });
const moves = () => Object.fromEntries([18, 19, 20, 21].map((id) => [id, special()]));
function side(characterId, overrides = {}) {
  return { characterId, teamId: null, totalDamage: 20.1234, neutralWins: 2, openingsPerKill: 1.2345678,
    damagePerOpening: 4.2345678, inputsPerMinute: 250.2345678, lCancelSuccess: 2, lCancelFail: 1,
    techs: { inPlace: 1, toward: 2, away: 3, missed: 4, wallSuccess: 5, wallMissed: 6 },
    actions: { rolls: 1, airDodges: 2, spotDodges: 3, wavedashes: 4, wavelands: 5, dashDances: 6,
      ledgeGrabs: 7, crouchCancels: 8, grabs: 9 }, moveStats: moves(), ...overrides };
}
function game(index, overrides = {}) {
  const record = { statsVersion: 6, isTeams: false, durationFrames: 3600, stageId: 31,
    winnerIndex: 0, winnerTeamId: null, players: [side(0), side(1)], ...overrides.record };
  return { key: `game-${index}`, eventId: "event", seriesId: "series", tier: "probable", format: record.isTeams ? "doubles" : "singles",
    identities: record.players.map(() => null), ...overrides, record };
}
function reference(n, override = () => ({})) {
  const ref = createRecoveryRollups(dataset);
  for (let i = 0; i < n; i++) ref.add(game(i, override(i)));
  return ref.finish();
}
function find(result, pattern, all = false) {
  return [...(all ? result.allRows : result.rows).values()].find((row) => Object.entries(pattern).every(([key, value]) => row[key] === value));
}
const global = { series_id: null, tournament_id: null, opponent_character_id: null, stage_id: null };

test("all dimensions independently retain every scalar, action, move field and exact key", () => {
  const result = reference(1, () => ({ record: { players: [side(0, { moveStats: { ...moves(), 2: { attempts: 3, landed: 2, damage: 1.2345 } } }), side(1)] } }));
  const row = find(result, { ...global, scope: "community", population: "broad", character_id: 0 });
  const dims = { scope: "community", population: "broad", series_id: null, tournament_id: null, set_id: null,
    player_id: null, format: "singles", character_id: 0, opponent_character_id: null, stage_id: null };
  assert.equal(row.rollup_key, `r:${createHash("sha256").update(`${dataset}:${JSON.stringify(dims)}`).digest("hex")}`);
  assert.equal(dimensionKey(row), JSON.stringify(Object.values(dims)));
  assert.equal(row.game_count, 1); assert.equal(row.win_rate_game_count, 1); assert.equal(row.wins, 1);
  assert.equal(row.metrics.durationFrames, 3600); assert.equal(row.metrics.damageTotal, 20.123);
  assert.equal(row.metrics.openingsPerKillSum, 1.234568); assert.equal(row.metrics.openingsPerKillSamples, 1);
  assert.equal(row.metrics.inputsPerMinuteSum, 250.234568); assert.equal(row.metrics.damagePerOpeningSum, 4.234568);
  assert.equal(row.metrics.techAway, 3); assert.equal(row.metrics.wallTechMissed, 6);
  assert.deepEqual(row.metrics.actions, side(0).actions);
  assert.deepEqual(row.metrics.moves[2], { attempts: 3, landed: 2, damage: 1.234, kills: 0, killPctSum: 0,
    openings: 0, openingDmg: 0, lCancelSuccess: 0, lCancelFail: 0 });
  assert.deepEqual(row.metrics.moves[18], { attempts: 1, landed: 2, damage: 3.123, kills: 1, killPctSum: 109.123,
    openings: 1, openingDmg: 9.123, lCancelSuccess: 2, lCancelFail: 1, attemptGames: 1, outcomeGames: 1,
    hitAttempts: 1, noHitAttempts: 0, incompleteAttempts: 0 });
  assert.equal(find(result, { ...global, scope: "community", population: "broad", character_id: null }).metrics.moves, null);
  const stageRow = find(result, { scope: "tournament", population: "conservative", character_id: 0,
    opponent_character_id: null, stage_id: 31 }, true);
  assert.equal(stageRow.tournament_id, `${dataset}:event`); assert.equal(stageRow.series_id, "series");
  assert.equal(stageRow.metrics.moves, null);
  assert.equal(result.summary.selectedGames, 1);
});

test("pooled Pro includes sparse individual contributors before suppression and counts distinct identities", () => {
  const result = reference(3, (i) => ({ identities: [{ playerId: `player${i}` }, null] }));
  const pooled = find(result, { scope: "pro", character_id: 0, opponent_character_id: 1, stage_id: null });
  assert.equal(pooled.game_count, 3); assert.equal(pooled.identified_player_count, 3);
  assert.equal(pooled.metrics.moves[18].attempts, 3);
  assert.equal(find(result, { scope: "player", character_id: 0, opponent_character_id: 1, stage_id: null }), undefined);
  const allCharacters = find(result, { ...global, scope: "pro", character_id: null });
  assert.equal(allCharacters.metrics.moves[18].attemptGames, 3);
  assert.equal(allCharacters.identified_player_count, 3);
  const versus = find(result, { scope: "pro", character_id: null, opponent_character_id: 1, stage_id: null });
  assert.equal(versus.game_count, 3);
  assert.deepEqual(result.summary.mappedPlayerIds, ["player0", "player1", "player2"]);
  assert.equal(result.summary.mappedPlayerSides, 3); assert.equal(result.summary.mappedGames, 3);
});

test("only explicitly measured zeros enter attempt/outcome denominators", () => {
  const result = reference(3, (i) => ({ identities: [{ playerId: "known" }, null], record: { players: [side(0,
    { moveStats: { 18: i === 0 ? {} : i === 1 ? { attempts: 0 } : special(0) } }), side(1)] } }));
  for (const pattern of [{ ...global, scope: "community", population: "broad", character_id: 0 },
    { scope: "pro", character_id: 0, opponent_character_id: 1, stage_id: null }]) {
    const move = find(result, pattern).metrics.moves[18];
    assert.equal(move.attempts, 0); assert.equal(move.attemptGames, 2); assert.equal(move.outcomeGames, 1);
    assert.equal(move.hitAttempts, 0); assert.equal(move.noHitAttempts, 0); assert.equal(move.incompleteAttempts, 0);
  }
  const unknown = reference(1, () => ({ record: { players: [side(0, { moveStats: { 18: {} } }), side(1)] } }));
  const missing = find(unknown, { ...global, scope: "community", population: "broad", character_id: 0 }).metrics.moves[18];
  assert.equal(missing.attempts, 0); assert.equal(missing.attemptGames, undefined); assert.equal(missing.outcomeGames, undefined);
});

test("minimum samples are applied to complete cell totals at every scope", () => {
  for (const n of [2, 3, 4, 5, 9, 10, 24, 25]) {
    const result = reference(n, () => ({ identities: [{ playerId: "known" }, null] }));
    const present = (scope, stage) => Boolean(find(result, { scope, character_id: 0, opponent_character_id: 1, stage_id: stage }));
    assert.equal(present("community", null), n >= 25); assert.equal(present("community", 31), n >= 25);
    for (const scope of ["player", "pro"]) {
      assert.equal(present(scope, null), n >= 3); assert.equal(present(scope, 31), n >= 5);
    }
    for (const scope of ["series", "tournament"]) {
      assert.equal(present(scope, null), n >= 5); assert.equal(present(scope, 31), n >= 10);
    }
  }
});

test("balanced rates enforce identity-game and opportunity thresholds and equal-weight quantiles", () => {
  const ref = createRecoveryRollups(dataset);
  for (const [id, success, fail, techSuccess, techMissed, n] of [["A", 1, 4, 1, 1, 10], ["B", 4, 1, 2, 0, 10],
    ["C", 100, 0, 100, 0, 9], ["D", 1, 0, 1, 0, 10]]) {
    for (let i = 0; i < n; i++) ref.add(game(`${id}-${i}`, { record: { players: [side(0, { connectCode: id,
      lCancelSuccess: success, lCancelFail: fail, techs: { inPlace: techSuccess, missed: techMissed } }), side(1)] } }));
  }
  const result = ref.finish(), row = find(result, { ...global, scope: "community", population: "conservative", character_id: 0 });
  assert.equal(result.summary.privateIdentityGroupsConsidered, 4); assert.equal(result.summary.balancedCohorts, 1);
  assert.equal(row.player_balanced_sample_count, 2);
  const lc = row.metrics.playerBalanced.lCancel;
  assert.equal(lc.qualifiedPlayers, 2); assert.equal(lc.equalWeightMean, 0.5); assert.equal(lc.median, 0.5);
  assert.ok(Math.abs(lc.p25 - 0.35) < 1e-12); assert.ok(Math.abs(lc.p75 - 0.65) < 1e-12);
  assert.deepEqual(row.metrics.playerBalanced.techSuccess, { qualifiedPlayers: 2, equalWeightMean: 0.75, p25: 0.625, median: 0.75, p75: 0.875 });
  assert.equal(find(result, { ...global, scope: "community", population: "broad", character_id: 0 }).metrics.playerBalanced, null);
});

test("unclassified games never enter conservative, private-balance or Pro cohorts", () => {
  const result = reference(1, () => ({ tier: "unclassified", identities: [{ playerId: "known" }, null],
    record: { players: [side(0, { connectCode: "known" }), side(1)] } }));
  assert.ok([...result.rows.values()].every((row) => row.population === "broad" && !["player", "pro"].includes(row.scope)));
  assert.equal(result.summary.privateIdentityGroupsConsidered, 0); assert.equal(result.summary.mappedGames, 0);
});

test("doubles use team winners without singles matchups or measured special usage", () => {
  const players = [0, 1, 2, 3].map((id) => side(id, { teamId: id % 2, moveStats: { 18: { landed: 1 } } }));
  const result = reference(1, () => ({ record: { isTeams: true, winnerIndex: null, winnerTeamId: 1, players } }));
  const row = find(result, { ...global, scope: "community", population: "broad", character_id: null });
  assert.equal(row.game_count, 4); assert.equal(row.wins, 2); assert.equal(row.win_rate_game_count, 4);
  assert.ok([...result.allRows.values()].every((cell) => cell.opponent_character_id === null));
  assert.equal(find(result, { ...global, scope: "community", population: "broad", character_id: 1 }).metrics.moves[18].attemptGames, undefined);
});

test("independent record guard rejects malformed, unsupported, outdated and doubles coverage", () => {
  const record = game(0).record;
  assertRecoveryRecordMeasurements(record, capability);
  for (const bad of [
    { ...record, statsVersion: 5 },
    { ...record, players: [side(0, { actions: {} }), side(1)] },
    { ...record, players: [side(0, { moveStats: { 18: { attempts: -1 } } }), side(1)] },
    { ...record, players: [side(0, { moveStats: { 18: { attempts: 1, hitAttempts: 1 } } }), side(1)] },
    { ...record, players: [side(0, { moveStats: { 18: { attempts: 2, hitAttempts: 1, noHitAttempts: 0, incompleteAttempts: 0 } } }), side(1)] },
    { ...record, players: [side(0, { moveStats: { 2: special() } }), side(1)] },
    { ...record, isTeams: true },
  ]) assert.throws(() => assertRecoveryRecordMeasurements(bad, capability));
  assert.throws(() => assertRecoveryRecordMeasurements(record, () => ({ attempts: true, outcomes: false })), /unsupported special outcome/);
  assert.throws(() => assertRecoveryRecordMeasurements(record, () => ({ attempts: false, outcomes: false })), /unsupported special initiation/);
});

test("complete rollup comparison detects extra cells, privacy fields and non-special metric tampering", () => {
  const expected = reference(5).rows;
  assert.equal(assertRecoveryRows(expected, expected).comparedRows, expected.size);
  for (const mutate of [
    (rows) => { rows[0].metrics.actions.rolls++; },
    (rows) => { rows[0].metrics.damageTotal += 0.001; },
    (rows) => { rows[0].metrics.connectCode = "private"; },
    (rows) => { rows[0].wins++; },
    (rows) => { rows.push(rows[0]); },
    (rows) => { rows.pop(); },
  ]) {
    const actual = structuredClone([...expected.values()]); mutate(actual);
    assert.throws(() => assertRecoveryRows(actual, expected));
  }
});

test("26-by-4 coverage is mandatory for both communities; ample Pro and sparse unknowns are distinct", () => {
  const ref = createRecoveryRollups(dataset);
  for (let character = 0; character < 26; character++) for (let i = 0; i < 25; i++) {
    ref.add(game(`${character}-${i}`, { record: { players: [side(character), side((character + 1) % 26)] } }));
  }
  // Each side below is a new named sample with an entirely unmeasured special.
  ref.add(game("sparse-pro", { identities: [{ playerId: "sparse" }, null],
    record: { players: [side(0, { moveStats: { 18: {} } }), side(1)] } }));
  const rows = ref.finish().rows, report = assertRecoveryCoverage(rows, capability);
  assert.equal(report.communityCharacterRows, 52);
  assert.ok(report.sparseUnavailable.some((row) => row.playerId === "sparse" && row.moveId === 18));
  const absent = structuredClone([...rows.values()]);
  absent.find((row) => row.scope === "community" && row.character_id === 25 && row.opponent_character_id === null && row.stage_id === null)
    .metrics.moves[18].attemptGames = 0;
  assert.throws(() => assertRecoveryCoverage(absent, capability), /positive attempts/);
  const ample = reference(25, () => ({ identities: [{ playerId: "unmeasured" }, null],
    record: { players: [side(0, { moveStats: {} }), side(1)] } }));
  assert.throws(() => assertRecoveryCoverage(ample.rows, capability, { requiredCharacters: [] }), /ample coverage/);
});

test("independent reference agrees with a complete production export of synthetic games", async (t) => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "ssbm-rollup-reference-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ssbm-rollup-reference-"));
    await rm(directory, { recursive: true, force: true });
  });
  const results = path.join(directory, "results"), downloads = path.join(directory, "downloads"), output = path.join(directory, "export");
  await Promise.all([mkdir(results), mkdir(downloads)]);
  const records = Array.from({ length: 30 }, (_, i) => ({ ...game(i).record, ok: true, identityKey: `synthetic-${i}`,
    file: `Pools/Game${i}.slp`, legalStage: true, playableRoster: true,
    playedAt: new Date(Date.UTC(2026, 0, 1, 0, i * 2)).toISOString(), stageId: i % 2 ? 31 : 32,
    players: [side(0, { displayName: "Zain", connectCode: "SYNTHETIC#1", lCancelSuccess: i % 4,
      moveStats: { ...moves(), 18: i % 3 === 0 ? { landed: 1 } : i % 3 === 1 ? { attempts: 0 } : special(2) } }),
    side(1, { connectCode: "SYNTHETIC#2" })] }));
  const json = async (name, value) => { const filename = path.join(directory, name); await writeFile(filename, JSON.stringify(value)); return filename; };
  await writeFile(path.join(results, "event.json"), JSON.stringify({ schemaVersion: 2, statsVersion: 6, bundle: "event.7z",
    replayFiles: records.length, parsed: records.length, failed: 0, records }));
  await writeFile(path.join(downloads, "event.7z"), "synthetic archive placeholder");
  const events = await json("events.json", { events: [{ id: "event", name: "Synthetic event", year: 2026,
    sourceUrl: "https://example.test/event", isTournament: true }] });
  const series = await json("series.json", { series: [{ id: "series", name: "Synthetic series", sourceUrl: "https://example.test/series", eventIds: ["event"] }] });
  const identities = await json("identities.json", { players: [], overrides: [{ kind: "event_alias", eventId: "event",
    playerId: "zain", observedAlias: "Zain", resolution: "probable", sourceUrl: "https://example.test/bracket" }] });
  const curation = path.join(directory, "curation.json");
  function run(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  run("scripts/curate-nikki-archive.mjs", [results, curation]);
  run("scripts/build-nikki-public-archive.mjs", ["--results", results, "--downloads", downloads, "--curation", curation,
    "--events", events, "--series", series, "--identities", identities, "--data-as-of", "2026-09-08", "--version", "v99", "--output", output]);
  const actual = (await readFile(path.join(output, "archive_rollups.ndjson"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const ref = createRecoveryRollups(dataset);
  for (const record of records) ref.add({ record, key: record.identityKey, eventId: "event", seriesId: "series", tier: "probable",
    format: "singles", identities: [{ playerId: "zain", resolution: "probable", sourceUrl: "https://example.test/bracket" }, null] });
  const expected = ref.finish();
  assert.equal(assertRecoveryRows(actual, expected.rows).comparedRows, actual.length);
  const qa = JSON.parse(await readFile(path.join(output, "qa.json"), "utf8"));
  assert.equal(expected.summary.computed, qa.rollups.computed);
  assert.equal(expected.summary.privateIdentityGroupsConsidered, qa.playerBalanced.privateIdentityGroupsConsidered);
  assert.equal(expected.summary.balancedCohorts, qa.playerBalanced.publishedCohorts);
  assert.equal(expected.summary.mappedPlayerSides, qa.identity.mappedPlayerSlots);
});
