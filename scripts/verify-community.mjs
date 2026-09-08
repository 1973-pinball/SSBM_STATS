/**
 * Run Community SQL against an isolated in-memory PostgreSQL database.
 * Requires @electric-sql/pglite (or PGLITE_MODULE pointing to its entry point).
 * No connection to Supabase and no real replay/user data are used.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CURRENT_STATS_VERSION = 3;
const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0].value;
const refresh = () => db.exec("select public.refresh_community_snapshot()");
const sampleCount = () => scalar("select coalesce(sum(game_count),0)::int as value from public.community_user_rollups");
const snapshot = () => scalar("select payload as value from public.community_snapshot");
const rollup = (n) => scalar("select payload as value from public.community_user_rollups where user_id=$1", [uuid(n)]);
const player = (code, characterId, attempts) => ({
  connectCode: code, characterId, lCancelSuccess: attempts, lCancelFail: 0,
  techs: { inPlace: 1, toward: 1, away: 1, missed: 1 },
  inputsPerMinute: 100 + attempts, openingsPerKill: 2, damagePerOpening: 20,
  actions: { rolls: attempts, crouchCancels: attempts },
  moveStats: { "13": { attempts, landed: attempts, damage: 100, openings: 1, openingDmg: 100 } },
});
const game = (first, second, winnerIndex = 0) => ({
  statsVersion: CURRENT_STATS_VERSION,
  playedAt: new Date().toISOString(), durationFrames: 7200, stageId: 31,
  gameType: "ranked", isTeams: false, players: [first, second], winnerIndex,
});
async function addUser(n, code, enabled = true, version = "2026-08-24") {
  await db.query("insert into auth.users values ($1)", [uuid(n)]);
  await db.query("insert into public.user_codes values ($1,$2)", [uuid(n), code]);
  await db.query("insert into public.community_consent(user_id,enabled,consent_version) values ($1,$2,$3)", [uuid(n), enabled, version]);
}
async function putGames(n, records) {
  const versions = Object.fromEntries(Object.entries(records).map(([key, record]) => [key, record.statsVersion ?? 0]));
  await db.query(`insert into public.game_record_packs(user_id,records,versions) values ($1,$2,$3)
    on conflict (user_id,bucket) do update set records=excluded.records, versions=excluded.versions`, [uuid(n), JSON.stringify(records), JSON.stringify(versions)]);
}
const consent = (n, enabled) => db.query("update public.community_consent set enabled=$2 where user_id=$1", [uuid(n), enabled]);

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.game_records (user_id uuid);
    create table public.game_record_packs (
      user_id uuid references auth.users(id) on delete cascade,
      bucket smallint default 0, records jsonb, versions jsonb default '{}'::jsonb, primary key(user_id,bucket)
    );
    create table public.user_codes (
      user_id uuid references auth.users(id) on delete cascade,
      code text, primary key(user_id,code)
    );
  `);
  const schema = await readFile(new URL("../supabase/community.sql", import.meta.url), "utf8");
  await db.exec(schema);
  await addUser(1, "MARTH#1");
  await addUser(2, "FOX#2", false);
  const replay = game(player("MARTH#1", 9, 10), player("FOX#2", 2, 30));
  await putGames(1, { shared: replay });
  await putGames(2, { shared: replay });
  await refresh();
  assert.equal(await sampleCount(), 2, "one replay contributes two player samples");
  let data = await rollup(1);
  const fox = data.moves.find((r) => r.characterId === 2 && r.lookbackDays === null);
  assert.equal(fox.attempts, 30, "opponent move usage belongs to Fox");
  assert.equal(fox.characterGames, 1);
  assert.equal(data.characters.find((r) => r.characterId === 2 && r.lookbackDays === null).wins, 0);
  assert.equal(data.characters.find((r) => r.characterId === 9 && r.lookbackDays === null).wins, 1);

  await consent(2, true);
  await refresh();
  assert.equal(await sampleCount(), 2, "another upload cannot count either side twice");
  assert.equal(await scalar("select contributor_count as value from public.community_snapshot"), 2);
  assert.equal(await scalar("select count(*)::int as value from public.community_dirty_users"), 0);

  // Ownership transfers on opt-out, record deletion, and account edits.
  await consent(1, false);
  await refresh();
  assert.equal(await sampleCount(), 2);
  assert.equal((await rollup(2)).moves.find((r) => r.characterId === 9 && r.lookbackDays === null).attempts, 10);
  await consent(1, true);
  await refresh();
  await putGames(1, {});
  await refresh();
  assert.equal(await sampleCount(), 2);
  await putGames(1, { shared: replay });
  await refresh();
  await db.query("update public.user_codes set code='OTHER#1' where user_id=$1", [uuid(1)]);
  await refresh();
  assert.equal(await sampleCount(), 2);
  assert.equal(await scalar("select user_id::text as value from public.community_user_rollups"), uuid(2));
  await consent(2, false);
  await refresh();
  assert.equal(await sampleCount(), 0, "no consenting eligible uploader means no samples");

  await addUser(3, "MIRROR#3");
  await putGames(3, { mirror: game(player("MIRROR#3", 9, 10), player("MIRROR#4", 9, 30), null) });
  await refresh();
  data = await rollup(3);
  const mirror = data.moves.find((r) => r.lookbackDays === null);
  assert.equal(mirror.attempts, 40);
  assert.equal(mirror.moveGames, 2, "a mirror has two separate move denominators");
  assert.equal(mirror.attemptGames, 2);
  assert.equal(mirror.characterGames, 2);
  assert.equal(data.characters.find((r) => r.lookbackDays === null).decided, 0, "unknown results stay unknown on both sides");
  await db.query("insert into public.user_codes values ($1,'MIRROR#4')", [uuid(3)]);
  await refresh();
  assert.equal(await sampleCount(), 0, "self-matches remain excluded");

  await addUser(4, "OLD#4", true, "outdated");
  await putGames(4, { stale: game(player("OLD#4", 9, 10), player("FOX#5", 2, 30)) });
  await refresh();
  assert.equal(await sampleCount(), 0, "stale consent remains excluded");

  await addUser(5, "DELETE#5");
  await addUser(6, "KEEP#6");
  const shared = game(player("DELETE#5", 9, 10), player("KEEP#6", 2, 30));
  await putGames(5, { deleteShared: shared });
  await putGames(6, { deleteShared: shared });
  await refresh();
  await db.query("delete from auth.users where id=$1", [uuid(5)]);
  await refresh();
  assert.equal(await sampleCount(), 2, "account deletion transfers shared games to a surviving contributor");
  assert.equal(await scalar("select user_id::text as value from public.community_user_rollups"), uuid(6));
  await consent(6, false);
  await refresh();

  // One uploader can supply a qualifying cohort through their opponents.
  // Participants are unioned across both player sides and duplicate uploads.
  await addUser(7, "OWNER#7");
  await addUser(8, "OPP#0", false);
  const cohort = (count, opponents, mirror = false) => Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`cohort-${i}`, game(
      player("OWNER#7", 9, 10), player(`OPP#${i % opponents}`, mirror ? 9 : 2, 30),
    )]),
  );
  const assertSuppressed = async (message) => {
    for (const rows of Object.values(await snapshot()).filter(Array.isArray)) {
      assert.equal(rows.length, 0, message);
    }
  };
  await putGames(7, cohort(100, 23));
  await refresh();
  await assertSuppressed("100 games with only 24 distinct players stay private");
  const normalizedCohort = cohort(100, 23);
  normalizedCohort["cohort-0"].players[1].connectCode = " opp#0 ";
  normalizedCohort["cohort-1"].players[1].connectCode = "";
  normalizedCohort["cohort-1"].players[1].displayName = "A new tag is not a new player";
  await putGames(7, normalizedCohort);
  await refresh();
  await assertSuppressed("case, whitespace, missing codes, and display names cannot inflate unique players");
  await putGames(7, cohort(99, 24));
  await refresh();
  await assertSuppressed("25 distinct players with only 99 games stay private");
  await putGames(8, cohort(99, 24));
  await consent(8, true);
  await refresh();
  await assertSuppressed("a duplicate uploader adds neither players nor unique games");
  await consent(8, false);
  await putGames(7, cohort(100, 24));
  await refresh();
  data = await snapshot();
  assert.equal(await scalar("select min_players as value from public.community_snapshot"), 25);
  const opponentMatchup = data.matchups.find((r) => r.characterId === 2 && r.stageId === 0 && r.gameType === "all" && r.lookbackDays === null);
  assert.equal(opponentMatchup.players, 25, "both players identify the cohort, including opponents");
  assert.equal(opponentMatchup.uniqueGames, 100);
  assert.equal(opponentMatchup.contributors, 1, "a one-source sample cannot display zero contributors");
  assert.equal(data.benchmarks.find((r) => r.characterId === 2).inputsPerMinute.p50, 130);
  assert.ok(data.moves.some((r) => r.characterId === 2), "opponent moves qualify from one uploader");
  for (const forbidden of ["playerKeys", "OWNER#", "OPP#", "connectCode", "user_id"]) {
    assert.ok(!JSON.stringify(data).includes(forbidden), `public snapshot must omit ${forbidden}`);
  }
  assert.equal(await scalar(`select public.community_count_players('[ ["A#1","B#1"], ["B#1","C#1"], [null,""] ]') as value`), 3,
    "participant sets union across sources without counting missing identities");
  await putGames(7, cohort(50, 24, true));
  await refresh();
  await assertSuppressed("50 mirror games cannot pass as 100 distinct games");

  // All-opponent stages must include opponents whose individual cells are
  // suppressed, and union shared participants rather than summing cell counts.
  const mixedOpponents = (opponents) => Object.fromEntries(
    Object.entries(cohort(100, opponents)).map(([key, record], i) => [key, {
      ...record,
      players: [record.players[0], { ...record.players[1], characterId: i % 2 ? 20 : 2 }],
      winnerIndex: i < 37 ? 0 : 1,
    }]),
  );
  await putGames(7, mixedOpponents(23));
  await refresh();
  await assertSuppressed("the same participants in multiple opponent cells still count only once");
  await putGames(7, mixedOpponents(24));
  await refresh();
  data = await snapshot();
  assert.equal(data.matchups.length, 0, "each exact matchup has only 50 games");
  const marthStage = data.characterStages.find((r) => r.characterId === 9 && r.stageId === 31 && r.gameType === "all" && r.lookbackDays === null);
  assert.equal(marthStage.games, 100, "all opponents qualify together before matchup suppression");
  assert.equal(marthStage.uniqueGames, 100);
  assert.equal(marthStage.players, 25);
  assert.equal(marthStage.contributors, 1, "one contributor across multiple opponent cells is counted once");
  assert.equal(marthStage.winRate, 0.37, "the rate uses all decided results before count rounding");
  assert.ok(data.characterStages.every((r) => r.characterId === 9 && r.stageId === 31), "no other character or stage borrows this sample");
  const splitStages = mixedOpponents(24);
  Object.values(splitStages).forEach((record, i) => { if (i % 2) record.stageId = 32; });
  await putGames(7, splitStages);
  await refresh();
  assert.equal((await snapshot()).characterStages.length, 0, "each stage must independently reach 100 games");
  const unknownResults = mixedOpponents(24);
  unknownResults["cohort-0"].winnerIndex = null;
  await putGames(7, unknownResults);
  await refresh();
  assert.equal((await snapshot()).characterStages.length, 0, "unknown outcomes cannot meet the decided-game threshold");
  await putGames(7, cohort(100, 24, true));
  await refresh();
  const mirrorStage = (await snapshot()).characterStages.find((r) => r.gameType === "all" && r.lookbackDays === null);
  assert.equal(mirrorStage.games, 200);
  assert.equal(mirrorStage.uniqueGames, 100);
  assert.equal(mirrorStage.winRate, 0.5);
  await consent(7, false);
  await refresh();

  // Each contributor plays Marth only; all Fox performance comes from opponents.
  for (let n = 10; n < 35; n++) {
    await addUser(n, `MAIN#${n}`);
    await putGames(n, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
      `game-${n}-${i}`, game(player(`MAIN#${n}`, 9, 10), player(`OPP#${n}`, 2, 30)),
    ])));
    if (n === 33) {
      await refresh();
      assert.equal(await scalar("select contributor_count as value from public.community_snapshot"), 24);
      const published = await snapshot();
      assert.ok(published.matchups.length > 0, "24 contributors with 48 unique players and 120 games can publish");
    }
  }
  await refresh();
  assert.equal(await sampleCount(), 250, "125 unique games produce 250 player samples");
  assert.equal(await scalar("select contributor_count as value from public.community_snapshot"), 25);
  data = await snapshot();
  const foxMove = data.moves.find((r) => r.characterId === 2 && r.lookbackDays === null);
  assert.equal(foxMove.contributors, 25, "opponents do not become contributors");
  assert.equal(foxMove.characterGames, 125);
  assert.equal(foxMove.attempts / foxMove.attemptGames, 30);
  const foxExecution = data.execution.find((r) => r.characterId === 2 && r.lookbackDays === null);
  assert.equal(foxExecution.actionCounts.rolls, 3750);
  assert.equal(foxExecution.actionCounts.crouchCancels, 3750);
  assert.equal(data.matchups.find((r) => r.characterId === 2 && r.stageId === 0 && r.gameType === "all" && r.lookbackDays === null).winRate, 0);
  assert.equal(data.benchmarks.find((r) => r.characterId === 2).inputsPerMinute.p50, 130);
  for (const forbidden of ["connectCode", "user_id", "own_side", "game_key", "MAIN#", "OPP#"]) {
    assert.ok(!JSON.stringify(data).includes(forbidden), `public payload must omit ${forbidden}`);
  }
  assert.equal(await scalar("select has_table_privilege('anon','public.community_game_sources','select') as value"), false);
  assert.equal(await scalar("select has_function_privilege('authenticated','public.refresh_community_game_sources(uuid)','execute') as value"), false);
  assert.equal(await scalar("select has_table_privilege('anon','public.community_snapshot','select') as value"), true);
  const before = JSON.stringify(data);
  await refresh();
  assert.equal(JSON.stringify(await snapshot()), before, "unchanged refresh is stable");
  const privateBefore = await scalar("select jsonb_agg(to_jsonb(r) order by user_id) as value from public.community_user_rollups r");
  await db.exec(`update public.community_snapshot set payload = jsonb_set(payload - 'characterStages', '{thresholdVersion}', '"unique-players-v1"')`);
  await refresh();
  assert.equal(JSON.stringify(await snapshot()), before, "old snapshots republish the new stage totals without queued users");
  assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(r) order by user_id) as value from public.community_user_rollups r"), privateBefore,
    "adding character stages reuses the existing private cache without rebuilding it");
  await db.exec(schema);
  await refresh();
  assert.equal(await sampleCount(), 250, "migration and backfill are repeatable");
  console.log("Community SQL passed: both sides, mirrors, duplicate uploads, ownership transfers, consent, thresholds, and private/public permissions.");
} finally {
  await db.close();
}
