import test from "node:test";
import assert from "node:assert/strict";
import {
  compileReviewedDoubleElimination,
  simulateDoubleElimination,
} from "../lib/forecast/historical-bracket.mjs";

const EVENT_ID = "startgg:event:pilot";
const PHASE_ID = "phase-1";
const GROUP_ID = "group-1";

function canonical(kind, id) {
  return `startgg:${kind}:${id}`;
}

function entrant(number) {
  return {
    id: canonical("entrant", number), source: { id: String(number) }, eventId: EVENT_ID,
    playerId: canonical("player", number),
  };
}

function seed(number) {
  return {
    id: canonical("seed", `s${number}`), source: { id: `s${number}` }, eventId: EVENT_ID,
    entrantId: canonical("entrant", number), seedNum: number, isBye: false, exclusionReasons: [],
    phase: { id: PHASE_ID }, phaseGroupId: GROUP_ID,
  };
}

const seedSource = (number) => ({ prereqType: "seed", prereqId: `s${number}` });
const setSource = (id, placement) => ({ prereqType: "set", prereqId: id, prereqPlacement: placement });
const byeSource = () => ({ prereqType: "bye", prereqId: null, prereqPlacement: null });

function bracketSet(id, round, fullRoundText, sources, lPlacement, wPlacement = null) {
  return {
    id: canonical("set", id), source: { id }, eventId: EVENT_ID,
    // Everything below except bracket structure is deliberately realized outcome noise.
    eligible: true, state: 3, winnerEntrantId: canonical("entrant", 999),
    winnerPlayerId: canonical("player", 999), scores: [3, 0], timestamps: { completedAt: 999999 },
    bracket: {
      round, fullRoundText, lPlacement, wPlacement,
      phaseGroup: { id: GROUP_ID, bracketType: "DOUBLE_ELIMINATION" },
      slots: sources.map((source, index) => ({
        ...source, slotIndex: index, entrantId: `realized-${id}-${index}`,
        seed: { id: `realized-seed-${id}-${index}`, seedNum: index + 1 },
        standingId: `standing-${id}-${index}`, placement: index + 1, scoreLabel: String(3 - index),
      })),
    },
  };
}

function fourPlayerDataset() {
  const sets = [
    bracketSet("10", 1, "Winners Round 1", [seedSource(1), seedSource(4)], 3, 2),
    bracketSet("20", 1, "Winners Round 1", [seedSource(2), seedSource(3)], 3, 2),
    bracketSet("30", 2, "Winners Final", [setSource("10", 1), setSource("20", 1)], 3, 2),
    bracketSet("40", -1, "Losers Round 1", [byeSource(), byeSource()], 4, null),
    bracketSet("50", -1, "Losers Round 1", [setSource("10", 2), byeSource()], 5, 4),
    bracketSet("60", -1, "Losers Round 1", [setSource("20", 2), byeSource()], 5, 4),
    bracketSet("70", -2, "Losers Round 1", [setSource("50", 1), setSource("60", 1)], 4, 3),
    bracketSet("80", -3, "Losers Final", [setSource("30", 2), setSource("70", 1)], 3, 2),
    bracketSet("90", 3, "Grand Final", [setSource("30", 1), setSource("80", 1)], 2, 1),
    bracketSet("91", 3, "Grand Final Reset", [setSource("90", 1), setSource("90", 2)], 2, 1),
  ];
  return {
    schemaVersion: 1,
    events: [{
      id: EVENT_ID, source: { id: "pilot" }, numEntrants: 4,
      phases: [{ id: PHASE_ID, bracketType: "DOUBLE_ELIMINATION", numSeeds: 4 }],
      phaseGroups: [{ id: GROUP_ID, bracketType: "DOUBLE_ELIMINATION", phase: { id: PHASE_ID } }],
    }],
    entrants: [1, 2, 3, 4].map(entrant),
    seeds: [1, 2, 3, 4].map(seed),
    sets,
    standings: [1, 2, 3, 4].map((number) => ({ eventId: EVENT_ID,
      entrantId: canonical("entrant", number), placement: number })),
  };
}

function twoPlayerDataset() {
  const dataset = fourPlayerDataset();
  dataset.events[0].numEntrants = 2;
  dataset.events[0].phases[0].numSeeds = 2;
  dataset.entrants = dataset.entrants.slice(0, 2);
  dataset.seeds = dataset.seeds.slice(0, 2);
  dataset.standings = dataset.standings.slice(0, 2);
  dataset.sets = [
    bracketSet("10", 1, "Winners Final", [seedSource(1), seedSource(2)], 2, 1),
    bracketSet("20", -1, "Losers Round 1", [setSource("10", 2), byeSource()], 3, 2),
    bracketSet("30", -2, "Losers Final", [setSource("20", 1), byeSource()], 2, 1),
    bracketSet("40", 2, "Grand Final", [setSource("10", 1), setSource("30", 1)], 2, 1),
    bracketSet("41", 2, "Grand Final Reset", [setSource("40", 1), setSource("40", 2)], 2, 1),
  ];
  return dataset;
}

function review(fieldSize = 4) {
  return {
    eventId: "pilot", fieldSize, initialPhaseId: PHASE_ID, phaseGroupId: GROUP_ID,
    grandFinalSetId: fieldSize === 4 ? "90" : "40",
    resetRule: "if-lower-side-wins-grand-final",
  };
}

const neutralModel = (id = "neutral") => ({
  id, name: `Neutral ${id}`, methodology: { kind: "constant", p: 0.5 },
  predict: () => ({ p: 0.5, covered: true }),
});

test("compiles a reviewed DE graph while redacting every realized outcome field", () => {
  const dataset = fourPlayerDataset();
  const original = compileReviewedDoubleElimination(dataset, review());
  const mutated = structuredClone(dataset);
  mutated.standings.reverse();
  for (const set of mutated.sets) {
    set.eligible = false;
    set.state = 1;
    set.winnerEntrantId = "leaked-winner";
    set.winnerPlayerId = "leaked-player";
    set.scores = [0, 99];
    set.timestamps = { completedAt: -1 };
    set.bracket.slots.reverse();
    for (const slot of set.bracket.slots) {
      slot.entrantId = "leaked-entrant";
      slot.seed = { id: "leaked-seed", seedNum: 999 };
      slot.standingId = "leaked-standing";
      slot.placement = 999;
      slot.scoreLabel = "leaked-score";
    }
  }
  mutated.events.reverse(); mutated.entrants.reverse(); mutated.seeds.reverse(); mutated.sets.reverse();
  const redacted = compileReviewedDoubleElimination(mutated, review());
  const withoutObservedReset = structuredClone(dataset);
  withoutObservedReset.sets = withoutObservedReset.sets
    .filter((set) => set.source.id !== "91");

  assert.deepEqual(redacted, original);
  assert.deepEqual(compileReviewedDoubleElimination(withoutObservedReset, review()), original,
    "whether a reset happened cannot decide route eligibility or its hash");
  assert.equal(original.schemaVersion, 1);
  assert.equal(original.kind, "reviewed-double-elimination");
  assert.deepEqual(original.field.map(({ seed, entrantId, playerId }) => [seed, entrantId, playerId]), [
    [1, canonical("entrant", 1), canonical("player", 1)],
    [2, canonical("entrant", 2), canonical("player", 2)],
    [3, canonical("entrant", 3), canonical("player", 3)],
    [4, canonical("entrant", 4), canonical("player", 4)],
  ]);
  assert.equal(original.matches.some((match) => match.id === canonical("set", "40")), false,
    "fully empty Start.gg rows are not simulated");
  assert.ok(original.matches.find((match) => match.id === canonical("set", "50"))
    .sources.some((source) => source.kind === "bye"), "pass-through byes remain structural");
  assert.equal(original.matches.at(-1).id, original.grandFinalId);
  assert.match(original.structuralSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(original.reset, { rule: "if-lower-side-wins-grand-final", lowerSide: 1 });

  const reassigned = structuredClone(dataset);
  [reassigned.seeds[0].entrantId, reassigned.seeds[1].entrantId]
    = [reassigned.seeds[1].entrantId, reassigned.seeds[0].entrantId];
  assert.notEqual(compileReviewedDoubleElimination(reassigned, review()).structuralSha256,
    original.structuralSha256, "the reviewed hash covers seed-to-entrant/player identity mapping");
});

test("simulates pass-through byes deterministically and conserves title and Top 8 probability", () => {
  const graph = compileReviewedDoubleElimination(fourPlayerDataset(), review());
  const first = simulateDoubleElimination({ graph, models: [neutralModel("z"), neutralModel("a")],
    simulations: 12_000, randomSeed: "pilot-seed" });
  const second = simulateDoubleElimination({ graph: structuredClone(graph),
    models: [neutralModel("a"), neutralModel("z")], simulations: 12_000, randomSeed: "pilot-seed" });
  assert.deepEqual(second, first);
  assert.deepEqual(first.models.map((model) => model.id), ["a", "z"]);
  assert.equal(first.randomPolicy.outcomeIndependent, true);
  assert.equal(first.randomPolicy.commonRandomNumbersAcrossModels, true);
  assert.equal(first.randomPolicy.eventScoped, true);
  assert.deepEqual(first.models[0].entrants, first.models[1].entrants,
    "identical models receive exactly the same counter-based match draws");
  for (const model of first.models) {
    assert.equal(model.pairwiseCoverage.pairs, 6);
    assert.equal(model.pairwiseCoverage.covered, 6);
    assert.ok(Math.abs(model.conservation.titleProbabilitySum - 1) < 1e-12);
    assert.ok(Math.abs(model.conservation.top8ProbabilitySum - 4) < 1e-12);
    for (const entrant of model.entrants) {
      assert.ok(Math.abs(entrant.titleProbability - 0.25) < 0.025);
      assert.equal(entrant.top8Probability, 1);
      assert.equal(entrant.top8MonteCarloSe, 0);
      assert.ok(entrant.titleMonteCarloSe > 0);
    }
  }

  const otherEvent = fourPlayerDataset();
  otherEvent.events[0].id = "startgg:event:other-pilot";
  for (const kind of ["entrants", "seeds", "sets", "standings"]) {
    for (const row of otherEvent[kind]) row.eventId = "startgg:event:other-pilot";
  }
  const otherGraph = compileReviewedDoubleElimination(otherEvent, { ...review(), eventId: "other-pilot" });
  const other = simulateDoubleElimination({ graph: otherGraph, models: [neutralModel("a")],
    simulations: 12_000, randomSeed: "pilot-seed" });
  assert.notEqual(other.randomPolicy.resolvedSeed, first.randomPolicy.resolvedSeed,
    "each event receives a distinct deterministic Monte Carlo stream");
});

test("uses a virtual reset only after the lower-side finalist wins grand final", () => {
  const graph = compileReviewedDoubleElimination(twoPlayerDataset(), review(2));
  const p = 0.75;
  const pairModel = (id) => ({
    id, name: id, methodology: { kind: "fixed-pair", p },
    predict(set) {
      return { p: set.playerIds[0] === canonical("player", 1) ? p : 1 - p, covered: true };
    },
  });
  const result = simulateDoubleElimination({ graph, models: [pairModel("left"), pairModel("right")],
    simulations: 100_000, randomSeed: 8675309 });
  const expected = 3 * p ** 2 - 2 * p ** 3;
  for (const model of result.models) {
    const playerOne = model.entrants.find((entrant) => entrant.playerId === canonical("player", 1));
    assert.ok(Math.abs(playerOne.titleProbability - expected) < 0.01,
      `${playerOne.titleProbability} should approximate two-loss title probability ${expected}`);
  }
  assert.deepEqual(result.models[0].entrants, result.models[1].entrants);
});

test("fails closed on malformed, cross-group, cyclic, duplicate, non-DE, and GF routes", () => {
  const malformed = [
    [/dangling/, (dataset) => { dataset.sets[0].bracket.slots[0] = setSource("missing", 1); }],
    [/duplicate entrant sources/, (dataset) => { dataset.sets[0].bracket.slots[1] = seedSource(1); }],
    [/prerequisite cycle/, (dataset) => { dataset.sets[0].bracket.slots[0] = setSource("80", 1); }],
    [/wrong group/, (dataset) => { dataset.sets.find((set) => set.source.id === "90").bracket.phaseGroup.id = "elsewhere"; }],
    [/not double elimination/, (dataset) => { dataset.events[0].phaseGroups[0].bracketType = "ROUND_ROBIN"; }],
    [/valid championship structure/, (dataset) => { dataset.sets.find((set) => set.source.id === "90").bracket.wPlacement = 2; }],
  ];
  for (const [pattern, mutate] of malformed) {
    const dataset = fourPlayerDataset();
    mutate(dataset);
    assert.throws(() => compileReviewedDoubleElimination(dataset, review()), pattern);
  }
  assert.throws(() => compileReviewedDoubleElimination(fourPlayerDataset(), { ...review(), resetRule: "always" }),
    /Unsupported reset rule/);
});

test("rejects invalid simulation inputs and structural graph tampering", () => {
  const graph = compileReviewedDoubleElimination(fourPlayerDataset(), review());
  assert.throws(() => simulateDoubleElimination({ graph, models: [], simulations: 1 }), /At least one/);
  assert.throws(() => simulateDoubleElimination({ graph, models: [neutralModel()], simulations: 0 }), /simulations/);
  assert.throws(() => simulateDoubleElimination({ graph, models: [{ ...neutralModel(), predict: () => ({ p: 2 }) }] }),
    /invalid pairwise probability/);
  const tampered = structuredClone(graph);
  tampered.matches[0].round = -99;
  assert.throws(() => simulateDoubleElimination({ graph: tampered, models: [neutralModel()], simulations: 1 }),
    /structural hash/);
});
