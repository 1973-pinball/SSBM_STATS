import test from "node:test";
import assert from "node:assert/strict";
import {
  projectRiptideTop16Top8,
  projectSeededBracket,
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
