/** Isolated PostgreSQL check; requires PGLITE_MODULE or @electric-sql/pglite. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { PGlite } = await import(process.env.PGLITE_MODULE ?? "@electric-sql/pglite");
const db = new PGlite();
try {
  await db.exec("create role anon; create role authenticated; create role service_role; create schema auth;");
  const schema = await readFile(new URL("../supabase/public-archive.sql", import.meta.url), "utf8");
  const upgrade = await readFile(new URL("../supabase/archive-pro-rollups-upgrade.sql", import.meta.url), "utf8");
  assert.equal((await db.query("select to_regprocedure('public.archive_supports_pooled_pro_rollups()') capability")).rows[0].capability,
    null, "an unmigrated database does not advertise support");
  await db.exec(schema);
  await db.exec(`insert into archive_datasets
    (id,label,source_url,source_label,compressed_bytes,archive_count,replay_file_count,parsed_replay_count,
    unique_game_count,broad_game_count,conservative_game_count,parser_version,curation_version,data_as_of,content_sha256)
    values ('test','test','https://example.com','test',0,0,0,0,0,0,0,'6','test','2026-11-03',repeat('a',64));`);
  await db.exec(`insert into archive_rollups
    (rollup_key,dataset_id,scope,population,format,game_count,identified_player_count,metrics,stats_version)
    values ('pro','test','pro','conservative','singles',3,2,'{}',6),
      ('community','test','community','broad','singles',10,null,'{}',6);`);
  await db.exec("drop function public.archive_supports_pooled_pro_rollups()");
  await db.exec(upgrade);
  assert.equal((await db.query("select public.archive_supports_pooled_pro_rollups() supported")).rows[0].supported, true,
    "the standalone upgrade installs the capability");
  await db.exec(upgrade);
  await db.exec(schema);
  assert.equal((await db.query("select count(*)::int n from archive_rollups")).rows[0].n, 2, "migration and schema rerun preserve rows");
  await db.exec("set role service_role");
  assert.equal((await db.query("select public.archive_supports_pooled_pro_rollups() supported")).rows[0].supported, true,
    "the loader can confirm committed schema support with service-role REST");
  await db.exec("reset role; set role authenticated");
  await assert.rejects(db.exec("select public.archive_supports_pooled_pro_rollups()"), /permission denied/);
  await db.exec("reset role");
  for (const update of ["population='broad'", "identified_player_count=null", "identified_player_count=0", "scope='unrecognized'"]) {
    await assert.rejects(db.exec(`update archive_rollups set ${update} where rollup_key='pro'`), /check constraint/);
  }
  await db.exec("set role anon");
  await assert.rejects(db.exec("select public.archive_supports_pooled_pro_rollups()"), /permission denied/);
  assert.equal((await db.query("select count(*)::int n from archive_rollups")).rows[0].n, 0, "unpublished pooled rows remain private");
  await assert.rejects(db.exec("update archive_rollups set published=true"), /permission denied/);
  await db.exec("reset role; update archive_rollups set published=true where rollup_key='pro'; set role anon");
  assert.equal((await db.query("select count(*)::int n from archive_rollups")).rows[0].n, 1, "published pooled rows are readable");
  console.log("Pooled Pro schema passed: shape validation, repeatable migration, preserved rows, service-only capability and read-only published access.");
} finally { await db.close(); }
