import test from "node:test";
import assert from "node:assert/strict";
import {
  projectRiptideTop16Top8,
  projectSeededBracket,
  PLATFIGHT_2026_TOP16_TOP8_ROUTING,
  RIPTIDE_TOP16_TOP8_ROUTING,
} from "../lib/forecast/bracket-projection.mjs";

const players = () => Array.from({ length: 16 }, (_, index) => ({
  id: `player-${index + 1}`,
  name: `Seed ${index + 1}`,
  seed: index + 1,
}));

const seeds = (match) => match.entrants.map((player) => player.seed);
const matchIndex = (projection) => new Map(projection.matches.map((match) => [match.id, match]));

test("follows the published Riptide Top 16 and Top 8 routing", () => {
  const projection = projectRiptideTop16Top8({ players: players(), predict: () => 1 });
  const matches = matchIndex(projection);

  assert.deepEqual(["A", "B", "C", "D"].map((id) => seeds(matches.get(id))),
    [[1, 8], [4, 5], [2, 7], [3, 6]]);
  assert.deepEqual(["J", "K", "L", "M"].map((id) => seeds(matches.get(id))),
    [[12, 15], [9, 14], [11, 16], [10, 13]]);
  assert.deepEqual(["N", "O", "P", "Q"].map((id) => seeds(matches.get(id))),
    [[6, 12], [7, 9], [5, 11], [8, 10]]);
  assert.deepEqual(projection.top8Qualifiers.map(({ top8Seed, player }) => [top8Seed, player.seed]),
    [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8]]);
  assert.deepEqual(seeds(matches.get("WSF-A")), [1, 4]);
  assert.deepEqual(seeds(matches.get("WSF-B")), [2, 3]);
  assert.deepEqual(seeds(matches.get("LR1-A")), [8, 5]);
  assert.deepEqual(seeds(matches.get("LR1-B")), [7, 6]);
  assert.deepEqual(seeds(matches.get("LQF-A")), [3, 8]);
  assert.deepEqual(seeds(matches.get("LQF-B")), [4, 7]);
  assert.deepEqual(seeds(matches.get("LSF")), [3, 4]);
  assert.deepEqual(seeds(matches.get("WF")), [1, 2]);
  assert.deepEqual(seeds(matches.get("LF")), [2, 3]);
  assert.deepEqual(seeds(matches.get("GF")), [1, 2]);
  assert.equal(projection.routing.id, RIPTIDE_TOP16_TOP8_ROUTING.id);
  assert.equal(projection.champion.seed, 1);
  assert.equal(projection.matches.length, 22);
  assert.equal(matches.has("GF-RESET"), false);
});

test("propagates projected upsets through every feeder and placement", () => {
  const projection = projectRiptideTop16Top8({ players: players(), predict: () => 0 });
  const matches = matchIndex(projection);

  assert.deepEqual(["N", "O", "P", "Q"].map((id) => seeds(matches.get(id))),
    [[3, 15], [2, 14], [4, 16], [1, 13]]);
  assert.deepEqual(projection.top8Qualifiers.map(({ top8Seed, player }) => [top8Seed, player.seed]),
    [[1, 8], [2, 7], [3, 6], [4, 5], [5, 16], [6, 15], [7, 14], [8, 13]]);
  assert.deepEqual(seeds(matches.get("WSF-A")), [8, 5]);
  assert.deepEqual(seeds(matches.get("LR1-A")), [13, 16]);
  assert.deepEqual(seeds(matches.get("LQF-A")), [7, 16]);
  assert.deepEqual(seeds(matches.get("LF")), [5, 15]);
  assert.deepEqual(seeds(matches.get("GF")), [6, 15]);
  assert.deepEqual(seeds(matches.get("GF-RESET")), [6, 15]);
  assert.equal(projection.champion.seed, 15);
  assert.deepEqual(projection.predictedPlacements.map(({ placement, player }) => [placement, player.seed]), [
    [1, 15], [2, 6], [3, 5], [4, 16], [5, 7], [5, 8], [7, 13], [7, 14],
    [9, 1], [9, 2], [9, 3], [9, 4], [13, 9], [13, 10], [13, 11], [13, 12],
  ]);
});

test("plays a reset only when the lower-side entrant wins grand final", () => {
  const contexts = [];
  const withReset = projectRiptideTop16Top8({
    players: players(),
    predict(a, b, context) {
      contexts.push(context);
      if (context.matchId === "GF") return 0;
      return 1;
    },
  });
  const matches = matchIndex(withReset);
  assert.equal(withReset.matches.length, 23);
  assert.deepEqual(seeds(matches.get("GF")), [1, 2]);
  assert.deepEqual(seeds(matches.get("GF-RESET")), [1, 2]);
  assert.equal(matches.get("GF").winner.seed, 2);
  assert.equal(matches.get("GF-RESET").winner.seed, 1);
  assert.equal(withReset.champion.seed, 1);
  assert.equal(contexts.at(-1).isReset, true);

  const noReset = projectRiptideTop16Top8({
    players: players(),
    predict: (_a, _b, context) => context.matchId === "GF" ? 1 : 0.5,
  });
  assert.equal(noReset.matches.length, 22);
  assert.equal(noReset.matches.some((match) => match.id === "GF-RESET"), false);
});

test("validates the field, routing, and every model probability", () => {
  assert.throws(() => projectRiptideTop16Top8({ players: players().slice(1), predict: () => 0.5 }),
    /exactly 16 players/);
  const duplicate = players(); duplicate[15] = { ...duplicate[15], seed: 1 };
  assert.throws(() => projectRiptideTop16Top8({ players: duplicate, predict: () => 0.5 }),
    /Duplicate player seed 1/);
  assert.throws(() => projectRiptideTop16Top8({ players: players() }), /predict callback/);
  for (const probability of [NaN, Infinity, -0.01, 1.01, "0.5"]) {
    assert.throws(() => projectRiptideTop16Top8({ players: players(), predict: () => probability }),
      /finite probability from 0 through 1/);
  }
  assert.throws(() => projectSeededBracket({
    players: players(), predict: () => 0.5, routing: { id: "x", label: "X", fieldSize: 8, matches: [{}] },
  }), /16-player routing/);
});

test("is deterministic and resolves exact ties by lower numerical seed", () => {
  const input = players().reverse();
  const first = projectRiptideTop16Top8({ players: input, predict: () => 0.5 });
  const second = projectRiptideTop16Top8({ players: structuredClone(input), predict: () => 0.5 });

  assert.deepEqual(second, first);
  assert.equal(first.champion.seed, 1);
  assert.ok(first.matches.every((match) => match.decision === "lower-seed-number"));
  assert.deepEqual(first.predictedPlacements.map(({ placement, player }) => [placement, player.seed]), [
    [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [5, 6], [7, 7], [7, 8],
    [9, 9], [9, 10], [9, 11], [9, 12], [13, 13], [13, 14], [13, 15], [13, 16],
  ]);
});

// Sanitized routing-only fixture from the public event/1661592 and
// phase_group/3462537,3462538 endpoints listed on the routing definition.
// These are source identifiers and root-seed positions, not forecast results.
const platfightSourceFixture = {
  firstLowerRound: {
    J: [11, 20], K: [14, 24], L: [10, 17], M: [15, 22],
    N: [12, 18], O: [13, 23], P: [9, 19], Q: [16, 21],
  },
  lowerOpenings: [
    { source: "R", id: "preview_3462537_-5_0", feeders: ["J", "K"], ui: "L" },
    { source: "S", id: "preview_3462537_-5_1", feeders: ["L", "M"], ui: "M" },
    { source: "T", id: "preview_3462537_-5_2", feeders: ["N", "O"], ui: "J" },
    { source: "U", id: "preview_3462537_-5_3", feeders: ["P", "Q"], ui: "K" },
  ],
  qualifiers: [
    { id: "preview_3462537_3_0", source: "A", seedId: "42098602", seedNum: 1 },
    { id: "preview_3462537_3_2", source: "C", seedId: "42098603", seedNum: 2 },
    { id: "preview_3462537_3_3", source: "D", seedId: "42098604", seedNum: 3 },
    { id: "preview_3462537_3_1", source: "B", seedId: "42098605", seedNum: 4 },
    { id: "preview_3462537_-6_0", source: "V", seedId: "42098606", seedNum: 5, losersOf: "B", winnersOf: "R" },
    { id: "preview_3462537_-6_2", source: "X", seedId: "42098607", seedNum: 6, losersOf: "D", winnersOf: "T" },
    { id: "preview_3462537_-6_3", source: "Y", seedId: "42098608", seedNum: 7, losersOf: "C", winnersOf: "U" },
    { id: "preview_3462537_-6_1", source: "W", seedId: "42098609", seedNum: 8, losersOf: "A", winnersOf: "S" },
  ],
};

test("Platfight contracts only the assumed first lower Top 24 round using the source fixture", () => {
  const route = PLATFIGHT_2026_TOP16_TOP8_ROUTING;
  const definitions = new Map(route.matches.map((match) => [match.id, match]));
  const projection = projectSeededBracket({ players: players(), predict: () => 1, routing: route });
  const matches = matchIndex(projection);

  for (const opening of platfightSourceFixture.lowerOpenings) {
    const expectedSeeds = opening.feeders.map((id) => platfightSourceFixture.firstLowerRound[id][0]);
    assert.deepEqual(seeds(matches.get(opening.ui)), expectedSeeds);
    assert.equal(definitions.get(opening.ui).sourceSetId, opening.id);
    assert.equal(definitions.get(opening.ui).sourceIdentifier, opening.source);
  }
  assert.deepEqual(["J", "K", "L", "M"].map((id) => seeds(matches.get(id))),
    [[12, 13], [9, 16], [11, 14], [10, 15]]);
  assert.deepEqual(["N", "O", "P", "Q"].map((id) => seeds(matches.get(id))),
    [[6, 12], [7, 9], [5, 11], [8, 10]]);
  assert.equal(projection.matches.length, 22);
  assert.equal(new Set(projection.predictedPlacements.map(({ player }) => player.seed)).size, 16);
  assert.ok(Object.isFrozen(route.matches[0].sides));
});

test("Platfight follows published loser links and cross-phase progression seeds", () => {
  const route = PLATFIGHT_2026_TOP16_TOP8_ROUTING;
  const definitions = new Map(route.matches.map((match) => [match.id, match]));
  for (const source of platfightSourceFixture.qualifiers) {
    const qualifier = route.top8Qualifiers.find((row) => row.top8Seed === source.seedNum);
    const match = definitions.get(qualifier.source.matchId);
    assert.equal(qualifier.sourceSeedId, source.seedId);
    assert.equal(qualifier.source.result, "winner");
    assert.equal(match.sourceSetId, source.id);
    assert.equal(match.sourceIdentifier, source.source);
    if (source.losersOf) {
      assert.deepEqual(match.sides.map((side) => [definitions.get(side.matchId).sourceIdentifier, side.result]),
        [[source.losersOf, "loser"], [source.winnersOf, "winner"]]);
    }
  }
  const top8Seeds = new Map(route.top8Qualifiers.map(({ top8Seed, source }) => [source.matchId, top8Seed]));
  // Top 8 A/B use phase seeds 1/4 and 2/3. F/G contract only the four
  // source auto-advance byes and use phase seeds 8/5 and 7/6.
  assert.deepEqual(["WSF-A", "WSF-B", "LR1-A", "LR1-B"].map((id) =>
    definitions.get(id).sides.map((side) => top8Seeds.get(side.matchId))),
  [[1, 4], [2, 3], [8, 5], [7, 6]]);
  assert.deepEqual(["WSF-A", "WSF-B", "LR1-A", "LR1-B"].map((id) => definitions.get(id).sourceSetId), [
    "preview_3462538_2_0", "preview_3462538_2_1", "preview_3462538_-3_0", "preview_3462538_-3_1",
  ]);
});

test("Platfight preserves upset propagation, all placements, and the conditional grand-final reset", () => {
  const projection = projectSeededBracket({
    players: players(), predict: () => 0, routing: PLATFIGHT_2026_TOP16_TOP8_ROUTING,
  });
  const matches = matchIndex(projection);
  assert.deepEqual(projection.top8Qualifiers.map(({ player }) => player.seed), [8, 7, 6, 5, 14, 13, 16, 15]);
  assert.deepEqual(seeds(matches.get("LR1-A")), [15, 14]);
  assert.deepEqual(seeds(matches.get("LR1-B")), [16, 13]);
  assert.deepEqual(seeds(matches.get("GF-RESET")), [6, 13]);
  assert.equal(projection.matches.length, 23);
  assert.deepEqual(projection.predictedPlacements.map(({ placement, player }) => [placement, player.seed]), [
    [1, 13], [2, 6], [3, 5], [4, 14], [5, 7], [5, 8], [7, 15], [7, 16],
    [9, 1], [9, 2], [9, 3], [9, 4], [13, 9], [13, 10], [13, 11], [13, 12],
  ]);
});
