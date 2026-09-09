import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GENERATED_PATH = new URL("../../src/lib/tournamentPredictionData.ts", import.meta.url);
const EXPECTED_MODELS = [
  "dynamic-bradley-terry",
  "glicko2",
  "higher-seed",
  "neutral",
  "recency-elo",
  "regularized-bt-recent-form",
];
const BASE_MATCH_IDS = [
  "A", "B", "C", "D", "J", "K", "L", "M", "N", "O", "P", "Q",
  "WSF-A", "WSF-B", "LR1-A", "LR1-B", "LQF-A", "LQF-B", "LSF", "WF", "LF", "GF",
];

function generatedJsonLiteral(source) {
  const marker = "export const TOURNAMENT_PREDICTIONS =";
  const declaration = source.indexOf(marker);
  assert.notEqual(declaration, -1, "generated catalog export is missing");
  const start = source.indexOf("{", declaration + marker.length);
  assert.notEqual(start, -1, "generated catalog JSON object is missing");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail("generated catalog JSON object is unterminated");
}

const catalog = JSON.parse(generatedJsonLiteral(readFileSync(GENERATED_PATH, "utf8")));
const tournament = catalog.tournaments[0];

test("generated site catalog contains one current tournament and all six models", () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(catalog.generatedAt)));
  assert.equal(catalog.tournaments.length, 1);
  assert.equal(tournament.id, "startgg:event:1503439");
  assert.equal(tournament.name, "Riptide 2026");

  const modelIds = tournament.models.map((model) => model.id);
  assert.equal(new Set(modelIds).size, 6);
  assert.deepEqual([...modelIds].sort(), EXPECTED_MODELS);
  const recommended = tournament.models.filter((model) => model.recommended);
  assert.equal(recommended.length, 1);
  assert.equal(recommended[0].id, tournament.defaultModelId);
  assert.equal(tournament.models.filter((model) => model.id === tournament.defaultModelId).length, 1);

  assert.deepEqual(tournament.scenario.missingPoolNames, ["J205", "L204", "M203", "M205", "M206"]);
  assert.equal(tournament.scenario.missingEntrantCount, 88);
});

test("players are the unique seed 1 through 16 field", () => {
  assert.equal(tournament.players.length, 16);
  assert.equal(new Set(tournament.players.map((player) => player.id)).size, 16);
  assert.deepEqual(tournament.players.map((player) => player.seed).sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, index) => index + 1));
});

test("every model scenario has valid deterministic matches, reset state, and champion", () => {
  const playersById = new Map(tournament.players.map((player) => [player.id, player]));
  const placementCounts = new Map([[1, 1], [2, 1], [3, 1], [4, 1], [5, 2], [7, 2], [9, 4], [13, 4]]);

  for (const model of tournament.models) {
    const resetMatches = model.matches.filter((match) => match.isReset);
    assert.ok(resetMatches.length <= 1, `${model.id} has more than one reset`);
    assert.equal(model.matches.length, BASE_MATCH_IDS.length + resetMatches.length);
    assert.deepEqual(model.matches.slice(0, BASE_MATCH_IDS.length).map((match) => match.id), BASE_MATCH_IDS);
    assert.equal(new Set(model.matches.map((match) => match.id)).size, model.matches.length);

    for (const match of model.matches) {
      assert.equal(match.playerIds.length, 2, `${model.id}/${match.id} participant count`);
      assert.notEqual(match.playerIds[0], match.playerIds[1], `${model.id}/${match.id} duplicate participant`);
      assert.ok(match.playerIds.every((id) => playersById.has(id)), `${model.id}/${match.id} unknown participant`);
      assert.equal(match.probabilities.length, 2, `${model.id}/${match.id} probability count`);
      assert.ok(match.probabilities.every((p) => Number.isFinite(p) && p >= 0 && p <= 1),
        `${model.id}/${match.id} invalid probability`);
      assert.ok(Math.abs(match.probabilities[0] + match.probabilities[1] - 1) < 1e-9,
        `${model.id}/${match.id} probabilities do not sum to one`);
      assert.ok(match.playerIds.includes(match.predictedWinnerId), `${model.id}/${match.id} winner is not a participant`);

      const expectedWinner = match.probabilities[0] > match.probabilities[1] ? match.playerIds[0]
        : match.probabilities[1] > match.probabilities[0] ? match.playerIds[1]
          : [...match.playerIds].sort((a, b) => playersById.get(a).seed - playersById.get(b).seed)[0];
      assert.equal(match.predictedWinnerId, expectedWinner, `${model.id}/${match.id} winner contradicts probability`);
    }

    const grandFinal = model.matches.find((match) => match.id === "GF");
    const reset = resetMatches[0];
    const lowerSideWon = grandFinal.predictedWinnerId === grandFinal.playerIds[1];
    assert.equal(Boolean(reset), lowerSideWon, `${model.id} reset does not match grand-final result`);
    if (reset) {
      assert.equal(reset.id, "GF-RESET");
      assert.deepEqual(reset.playerIds, grandFinal.playerIds);
    }
    const decidingFinal = reset ?? grandFinal;
    assert.equal(model.championId, decidingFinal.predictedWinnerId);
    assert.ok(playersById.has(model.championId));

    assert.equal(model.top8PlayerIds.length, 8);
    assert.equal(new Set(model.top8PlayerIds).size, 8);
    assert.ok(model.top8PlayerIds.every((id) => playersById.has(id)));
    assert.equal(model.placements.length, 16);
    assert.equal(new Set(model.placements.map((row) => row.playerId)).size, 16);
    for (const [placement, count] of placementCounts) {
      assert.equal(model.placements.filter((row) => row.placement === placement).length, count,
        `${model.id} placement ${placement} count`);
    }
    assert.equal(model.placements.find((row) => row.placement === 1).playerId, model.championId);
  }
});

test("neutral model is 50/50 and advances the lower numerical seed", () => {
  const neutral = tournament.models.find((model) => model.id === "neutral");
  const seedByPlayer = new Map(tournament.players.map((player) => [player.id, player.seed]));
  assert.ok(neutral);
  for (const match of neutral.matches) {
    assert.deepEqual(match.probabilities, [0.5, 0.5]);
    assert.equal(match.decision, "lower-seed-number");
    const expected = [...match.playerIds].sort((a, b) => seedByPlayer.get(a) - seedByPlayer.get(b))[0];
    assert.equal(match.predictedWinnerId, expected);
  }
});

test("recommended regularized model projects Hungrybox over lloD in grand final", () => {
  const primary = tournament.models.find((model) => model.id === "regularized-bt-recent-form");
  const hungrybox = tournament.players.find((player) => player.name === "Hungrybox");
  const llod = tournament.players.find((player) => player.name === "lloD");
  const grandFinal = primary.matches.find((match) => match.id === "GF");

  assert.deepEqual(grandFinal.playerIds, [hungrybox.id, llod.id]);
  assert.ok(Math.abs(grandFinal.probabilities[0] - 0.721769) < 1e-6);
  assert.equal(grandFinal.predictedWinnerId, hungrybox.id);
  assert.equal(primary.championId, hungrybox.id);
});
