import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyDerivedRecoveryExport, reconcileRecoveryAddition } from "../lib/archive-recovery-export.mjs";
import { createRecoveryExportFixture, readRows, putRows, resealExport } from "./fixtures/recovery-export-fixture.mjs";

test("actual builder and independent recovery verifier agree on a 67 to 68-source synthetic recovery", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "ssbm-recovery-export-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ssbm-recovery-export-"));
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await createRecoveryExportFixture(directory);
  const before = await verifyDerivedRecoveryExport(fixture.before);
  const after = await verifyDerivedRecoveryExport(fixture.after);

  await t.test("full table reconstruction includes changed representatives, all metrics, and pooled Pro", () => {
    assert.equal(before.dataset.archive_count, 67); assert.equal(after.dataset.archive_count, 68);
    assert.equal(before.dataset.unique_game_count, 30); assert.equal(after.dataset.unique_game_count, 31);
    assert.equal(after.summary.duplicateFiles, 3);
    assert.deepEqual(after.summary.mappedPlayerIds, ["codyschwab", "moky", "zain"]);
    const reconciliation = reconcileRecoveryAddition(before, after);
    assert.equal(reconciliation.newUniqueGames, 1); assert.equal(reconciliation.addedDuplicateCopies, 3);
    assert.ok(reconciliation.ledger.some(entry => entry.before?.eventId === "zzz" && entry.after?.eventId === "ootb5"));
    assert.ok(reconciliation.rollupChanges.changed > 0); assert.ok(reconciliation.rollupChanges.added > 0);
    const stageCell = row => row.scope === "community" && row.population === "broad" && row.character_id === 1
      && row.opponent_character_id === null && row.stage_id === 31;
    assert.equal(before.tables.archive_rollups.find(stageCell), undefined);
    assert.equal(after.tables.archive_rollups.find(stageCell)?.game_count, 25, "specific community cell crosses 24 to 25");
    const pooled = after.tables.archive_rollups.find(row => row.scope === "pro" && row.character_id === null
      && row.opponent_character_id === null && row.stage_id === null);
    assert.equal(pooled.identified_player_count, 3); assert.equal(pooled.game_count, 60);
    assert.ok(pooled.metrics.moves, "all-character pooled Pro retains moves");
    assert.equal(after.publicByRaw.has("synthetic-game-29"), false, "unreviewed venue replay remains aggregate-only");
    assert.ok(after.tables.archive_game_players.some(row => row.character_id === 1 && row.move_stats[19].attempts === undefined));
    for (const moveId of [18, 19, 20, 21]) assert.ok(after.tables.archive_game_players.some(row => row.move_stats[moveId].attempts === 0),
      "explicit measured zeros survive each special direction");
  });

  const tamper = async (table, mutation, pattern) => {
    const files = [...new Set([`${table}.ndjson`, "archive_datasets.ndjson", "manifest.json", "qa.json"])];
    const saved = await Promise.all(files.map(async name => [name, await readFile(path.join(fixture.after.dir, name))]));
    try {
      const rows = await readRows(fixture.after.dir, table);
      mutation(rows);
      await putRows(fixture.after.dir, table, rows);
      await resealExport(fixture.after.dir);
      await assert.rejects(verifyDerivedRecoveryExport(fixture.after), pattern);
    } finally {
      for (const [name, bytes] of saved) await writeFile(path.join(fixture.after.dir, name), bytes);
    }
  };

  await t.test("recomputed content hash cannot hide changed non-special rollup metrics", () => tamper("archive_rollups", rows => {
    rows.find(row => row.scope === "community").metrics.damageTotal += 1;
  }, /value mismatch/));

  await t.test("recomputed content hash cannot hide a pooled Pro distinct-player error", () => tamper("archive_rollups", rows => {
    rows.find(row => row.scope === "pro").identified_player_count += 1;
  }, /value mismatch/));

  await t.test("recomputed counts cannot hide a duplicate named side", () => tamper("archive_game_players", rows => {
    rows.push(structuredClone(rows[0]));
  }, /independently reconstructed row count/));

  await t.test("recomputed content hash cannot change a preserved game measurement", () => tamper("archive_game_players", rows => {
    rows[0].damage_total += 1;
  }, /independent public rows differ/));

  await t.test("recomputed content hash cannot turn an unknown special into a measured zero", () => tamper("archive_game_players", rows => {
    const row = rows.find(side => side.character_id === 1 && side.move_stats[19].attempts === undefined);
    assert.ok(row); row.move_stats[19].attempts = 0;
  }, /independent public rows differ/));

  await t.test("recomputed content hash cannot promote an unapproved identity", () => tamper("archive_game_players", rows => {
    rows.find(row => row.player_id === "moky").player_id = "magi";
  }, /independent public rows differ/));

  await t.test("a private field is rejected even in a correctly hashed public export", () => tamper("archive_game_players", rows => {
    rows[0].connectCode = "SYNTHETIC#000";
  }, /Private source field/));

  await t.test("dataset metadata cannot hide extra fields behind a recomputed hash", () => tamper("archive_datasets", rows => {
    rows[0].secret_label = "Synthetic unauthorized metadata";
  }, /archive_datasets: independent public rows differ/));
});
