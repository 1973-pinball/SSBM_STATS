import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  prependTournament, readGeneratedCatalog, selectTrainingCorpus, siteRoutingForEvent, validatePublishedSeedMapping, validateEvaluationRun,
} from "../build-site-predictions.mjs";

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

const catalog = readGeneratedCatalog(readFileSync(GENERATED_PATH, "utf8"));
const tournament = catalog.tournaments.find((item) => item.id === "startgg:event:1503439");

test("site generation rejects modified evaluation scores or predictions", () => {
  const datasetSha256 = "d".repeat(64);
  const comparison = { sourceDatasetSha256: datasetSha256, scores: { brier: 0.2 } };
  const predictions = [{ id: "set", p: 0.6 }];
  const runHash = createHash("sha256").update(JSON.stringify({ report: comparison, predictions })).digest("hex");
  const manifest = { runHash, sourceDatasetSha256: datasetSha256,
    report: `reports/${runHash}/comparison.json`, predictions: `reports/${runHash}/predictions.json` };
  const artifacts = { manifest, comparison, predictions, datasetSha256 };
  assert.doesNotThrow(() => validateEvaluationRun(artifacts));
  assert.throws(() => validateEvaluationRun({ ...artifacts, comparison: { ...comparison, scores: { brier: 0.1 } } }), /run-hash verification/);
  assert.throws(() => validateEvaluationRun({ ...artifacts, predictions: [{ id: "set", p: 0.9 }] }), /run-hash verification/);
  assert.throws(() => validateEvaluationRun({ ...artifacts, datasetSha256: "a".repeat(64) }), /run-hash verification/);
});

test("new forecasts become the dropdown default while preserving previous tournaments", () => {
  const requested = { id: "startgg:event:1661592", snapshot: { fetchedAt: "2026-10-16T00:00:00.000Z" } };
  const appended = prependTournament(catalog, requested);
  assert.equal(appended.tournaments[0], requested);
  assert.equal(appended.generatedAt, requested.snapshot.fetchedAt);
  assert.equal(appended.tournaments.find((item) => item.id === tournament.id), tournament);
  const replacement = { ...requested, name: "Refreshed event" };
  const refreshed = prependTournament(appended, replacement);
  assert.equal(refreshed.tournaments[0], replacement);
  assert.equal(refreshed.tournaments.filter((item) => item.id === requested.id).length, 1);
  assert.equal(refreshed.tournaments.length, appended.tournaments.length);
});

test("catalog reader handles quoted braces and rejects malformed existing artifacts", () => {
  const expected = { schemaVersion: 1, tournaments: [{ id: "event", name: 'Name with } and "quotes"' }] };
  assert.deepEqual(readGeneratedCatalog(`export const TOURNAMENT_PREDICTIONS = ${JSON.stringify(expected)} satisfies Catalog;`), expected);
  assert.throws(() => readGeneratedCatalog("export const OTHER = {};"), /missing/);
  assert.throws(() => readGeneratedCatalog("export const TOURNAMENT_PREDICTIONS = {"), /unterminated/);
  assert.throws(() => readGeneratedCatalog("export const TOURNAMENT_PREDICTIONS = {\"schemaVersion\":2,\"tournaments\":[]};"), /Unsupported/);
});

test("training stops at the earlier snapshot or event start and excludes the target", () => {
  const makeEvent = (id, end) => ({ id, eligible: true, chronology: { reportedTournamentEndAt: end } });
  const events = [makeEvent("past", 1000), makeEvent("after-start", 2100),
    makeEvent("at-start", 2000), makeEvent("startgg:event:1661592", 900)];
  const dataset = { events, sets: events.map((event) => ({ id: event.id, eventId: event.id, eligible: true })) };
  const bundle = { event: { id: 1661592, startAt: 2000 }, provenance: { fetchedAt: new Date(3000 * 1000).toISOString() } };
  const training = selectTrainingCorpus(dataset, bundle);
  assert.equal(training.cutoff, 2000);
  assert.deepEqual(training.events.map((event) => event.id), ["past"]);
  assert.deepEqual(training.sets.map((set) => set.id), ["past"]);
  const earlierSnapshot = { ...bundle, provenance: { fetchedAt: new Date(1500 * 1000).toISOString() } };
  assert.equal(selectTrainingCorpus(dataset, earlierSnapshot).cutoff, 1500);
  assert.throws(() => selectTrainingCorpus({ events: [], sets: [] }, bundle), /No historical training corpus/);
});

test("Platfight uses its reviewed routing and unknown events disclose the template assumption", () => {
  const platfight = siteRoutingForEvent("startgg:event:1661592");
  assert.equal(platfight.routing.sourceEventId, "1661592");
  assert.equal(platfight.routingEvidence, "published");
  assert.match(platfight.explanation, /9–16 are assumed to win the first lower round/);
  assert.deepEqual(platfight.routing.matches.find((match) => match.id === "J").sides.map((side) => side.seed), [12, 13]);
  const unknown = siteRoutingForEvent("startgg:event:999999");
  assert.equal(unknown.routingEvidence, "assumed-template");
  assert.match(unknown.explanation, /has not been verified/);
});

test("Platfight requires the reviewed root-to-Top-24 seed mapping", () => {
  const root = { seeds: Array.from({ length: 16 }, (_, index) => ({ seedNum: index + 1, entrantId: String(index + 100) })) };
  const bundle = { event: { id: 1661592 }, seeds: root.seeds.map((seed) => ({
    phase: { id: 2402255 }, seedNum: seed.seedNum, projectedEntrantId: Number(seed.entrantId),
  })) };
  assert.doesNotThrow(() => validatePublishedSeedMapping(bundle, root));
  assert.throws(() => validatePublishedSeedMapping({ ...bundle, seeds: [] }, root), /mapping changed or is unavailable/);
  const changed = structuredClone(bundle);
  changed.seeds[0].projectedEntrantId = 999;
  assert.throws(() => validatePublishedSeedMapping(changed, root), /review the published routing/);
});

test("generated site catalog retains Riptide and gives every tournament all six models", () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(catalog.generatedAt)));
  assert.ok(catalog.tournaments.length >= 1);
  assert.equal(new Set(catalog.tournaments.map((item) => item.id)).size, catalog.tournaments.length);
  assert.ok(tournament, "the saved Riptide forecast must remain available");
  assert.equal(tournament.id, "startgg:event:1503439");
  assert.equal(tournament.name, "Riptide 2026");

  for (const item of catalog.tournaments) {
    const modelIds = item.models.map((model) => model.id);
    assert.equal(new Set(modelIds).size, 6, item.name);
    assert.deepEqual([...modelIds].sort(), EXPECTED_MODELS, item.name);
    const recommended = item.models.filter((model) => model.recommended);
    assert.equal(recommended.length, 1, item.name);
    assert.equal(recommended[0].id, item.defaultModelId, item.name);
    assert.equal(item.models.filter((model) => model.id === item.defaultModelId).length, 1, item.name);
    if (item.scenario.routingEvidence === "assumed-template") {
      assert.match(item.scenario.label, /assumed/i);
      assert.match(item.scenario.explanation, /has not been verified/);
    }
  }

  assert.deepEqual(tournament.scenario.missingPoolNames, ["J205", "L204", "M203", "M205", "M206"]);
  assert.equal(tournament.scenario.missingEntrantCount, 88);
});

test("players are the unique seed 1 through 16 field", () => {
  for (const item of catalog.tournaments) {
    assert.equal(item.players.length, 16, item.name);
    assert.equal(new Set(item.players.map((player) => player.id)).size, 16, item.name);
    assert.deepEqual(item.players.map((player) => player.seed).sort((a, b) => a - b),
      Array.from({ length: 16 }, (_, index) => index + 1), item.name);
  }
});

for (const currentTournament of catalog.tournaments) {
test(`${currentTournament.name}: every model scenario has valid deterministic matches, reset state, and champion`, () => {
  const tournament = currentTournament;
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

test(`${currentTournament.name}: neutral model is 50/50 and advances the lower numerical seed`, () => {
  const tournament = currentTournament;
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
}

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
