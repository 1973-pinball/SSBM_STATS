import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryRollups } from "../lib/archive-recovery-rollups.mjs";
import { verifyRecoverySelectors } from "../lib/archive-recovery-selectors.mjs";

const datasetId = "nikki-2026-09-08-v99";
const observedMove = (i) => i % 3 === 0 ? { attempts: 0, hitAttempts: 0, noHitAttempts: 0, incompleteAttempts: 0 }
  : i % 3 === 1 ? { attempts: 4, hitAttempts: 1, noHitAttempts: 2, incompleteAttempts: 1 } : { landed: 1 };
function fixture() {
  const ref = createRecoveryRollups(datasetId);
  for (let i = 0; i < 30; i++) {
    const players = [0, 1].map((characterId) => ({ characterId, teamId: null, actions: { crouchCancels: 0 },
      moveStats: Object.fromEntries([18, 19, 20, 21].map((id) => [id, observedMove(i + characterId)])) }));
    ref.add({ key: String(i), eventId: "fixture", seriesId: "fixture-series", format: "singles", tier: "probable",
      record: { statsVersion: 6, isTeams: false, stageId: i % 2 ? 31 : 32, durationFrames: 3600,
        winnerIndex: i % 2, winnerTeamId: null, players }, identities: i < 3 ? [{ playerId: `sparse${i}` }, null] : [null, null] });
  }
  ref.add({ key: "doubles", eventId: "fixture", seriesId: "fixture-series", format: "doubles", tier: "probable",
    record: { statsVersion: 6, isTeams: true, stageId: 31, durationFrames: 3600, winnerIndex: null, winnerTeamId: 0,
      players: [0, 1, 2, 3].map((characterId) => ({ characterId, teamId: characterId % 2,
        actions: { crouchCancels: 0 }, moveStats: { 18: { landed: 1 } } })) },
    identities: [null, null, null, null] });
  const expectedRollups = ref.finish().rows;
  return { datasetId, expectedRollups, tables: { archive_rollups: structuredClone([...expectedRollups.values()]) } };
}

test("production selectors and displays match independent all-character, matchup, named, doubles and missing rows", async () => {
  const inputs = fixture(), priorFetch = globalThis.fetch;
  inputs.tables.archive_rollups.push({ ...structuredClone(inputs.tables.archive_rollups[0]),
    dataset_id: "unrelated-immutable-revision", rollup_key: "foreign-dataset", game_count: 999999 });
  const pooled = inputs.tables.archive_rollups.find((row) => row.scope === "pro" && row.character_id === 0
    && row.opponent_character_id === 1 && row.stage_id === null);
  assert.equal(pooled.game_count, 3);
  assert.ok(!inputs.tables.archive_rollups.some((row) => row.scope === "player" && row.opponent_character_id === 1));
  const checked = await verifyRecoverySelectors(inputs);
  assert.ok(checked.communitySelections >= 200);
  assert.ok(checked.proSelections >= 100);
  assert.equal(checked.namedSelections, 3);
  assert.ok(checked.measuredRateChecks > 0 && checked.zeroValues > 0 && checked.unavailableValues > 0);
  assert.ok(checked.absentSelections > 0 && checked.atlasRows > 0);
  assert.equal(globalThis.fetch, priorFetch, "global network gate restored after the offline check");
});

test("selector validation rejects a pooled Pro denominator changed after reconstruction", async () => {
  const inputs = fixture();
  const pooled = inputs.tables.archive_rollups.find((row) => row.scope === "pro" && row.character_id === null
    && row.opponent_character_id === null && row.stage_id === null);
  pooled.metrics.moves[18].attemptGames++;
  await assert.rejects(verifyRecoverySelectors(inputs), /independently reconstructed selector row/);
});

test("selector validation rejects a dropped sparse contribution and a populated absent matchup", async () => {
  const missing = fixture();
  missing.tables.archive_rollups = missing.tables.archive_rollups.filter((row) => !(row.scope === "pro"
    && row.character_id === 0 && row.opponent_character_id === 1 && row.stage_id === null));
  await assert.rejects(verifyRecoverySelectors(missing), /exact matchup\/stage row set/);
  const injected = fixture();
  const row = injected.tables.archive_rollups.find((cell) => cell.scope === "community" && cell.population === "broad"
    && cell.character_id === 0 && cell.opponent_character_id === null && cell.stage_id === null);
  injected.tables.archive_rollups.push({ ...structuredClone(row), rollup_key: "unexpected-matchup", opponent_character_id: 0 });
  await assert.rejects(verifyRecoverySelectors(injected), /sample presence|exact matchup\/stage row set|independently reconstructed selector row/);
});
