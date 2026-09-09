import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFixedRootMatchups,
  buildUpcomingMatchupReport,
  empiricalReliability,
  selectRootFullFieldSeedPhase,
  upcomingMatchupDetailedMarkdown,
  upcomingMatchupMarkdown,
} from "../lib/forecast/upcoming-report.mjs";

const entrant = (id, name) => ({ id, name, participants: [{ id: id + 100, gamerTag: name, player: { id: id + 1000 } }] });
const seed = (id, entrantId, seedNum, phase, progressionSeedId = null) => ({
  id, entrant: { id: entrantId }, seedNum, isBye: false, progressionSeedId, phase,
});
const slot = (seedId, entrantId) => ({ prereqType: "seed", prereqId: seedId, entrant: { id: entrantId } });

function fixture() {
  const root = { id: 10, name: "Pools", phaseOrder: 1 };
  const later = { id: 20, name: "Top 2", phaseOrder: 2 };
  return {
    schemaVersion: 1,
    event: {
      id: 1, slug: "tournament/riptide-2026-4/event/melee-singles", name: "Melee Singles",
      state: "CREATED",
      phases: [root, later], tournament: { name: "Riptide 2026" },
    },
    entrants: [entrant(1, "Alpha"), entrant(2, "Bravo"), entrant(3, "Charlie"), entrant(4, "Delta")],
    seeds: [
      seed(101, 1, 1, root, 201), seed(102, 2, 2, root), seed(103, 3, 3, root), seed(104, 4, 4, root, 202),
      seed(201, 1, 1, later), seed(202, 4, 2, later),
    ],
    phaseGroups: [
      { id: 1001, displayIdentifier: "A", phase: root },
      { id: 2001, displayIdentifier: "Finals", phase: later },
    ],
    sets: [
      { id: 501, state: 1, round: 1, fullRoundText: "Winners Round 1", identifier: "B",
        phaseGroup: { id: 1001, displayIdentifier: "A" }, slots: [slot(101, 1), slot(104, 4)] },
      { id: 500, state: 1, round: 1, fullRoundText: "Winners Round 1", identifier: "A",
        phaseGroup: { id: 1001, displayIdentifier: "A" }, slots: [slot(102, 2), slot(103, 3)] },
      // Populated entrant projections do not make winner/loser feeders fixed.
      { id: 502, state: 1, round: 2, fullRoundText: "Winners Final",
        phaseGroup: { id: 1001, displayIdentifier: "A" }, slots: [
          { prereqType: "set", prereqId: 500, prereqPlacement: 1, entrant: { id: 2 } },
          { prereqType: "set", prereqId: 501, prereqPlacement: 1, entrant: { id: 1 } },
        ] },
      // A later phase is conditional even when it has two populated seed slots.
      { id: 503, state: 1, round: 1, fullRoundText: "Grand Final",
        phaseGroup: { id: 2001, displayIdentifier: "Finals" }, slots: [slot(201, 1), slot(202, 4)] },
      { id: 504, state: 3, winnerId: 1, round: 1, fullRoundText: "Completed",
        phaseGroup: { id: 1001, displayIdentifier: "A" }, slots: [slot(101, 1), slot(104, 4)] },
    ],
    standings: [],
    provenance: { source: "start.gg", fetchedAt: "2026-09-07T12:34:56Z", requests: [] },
  };
}

test("selects the unique no-incoming full-field root phase", () => {
  const root = selectRootFullFieldSeedPhase(fixture());
  assert.equal(root.phaseId, "10");
  assert.equal(root.entrantCount, 4);
  assert.deepEqual(root.seeds.map((row) => [row.entrantId, row.seedNum]), [["1", 1], ["2", 2], ["3", 3], ["4", 4]]);
});

test("accepts only uncompleted direct-seed matches in the selected root phase", () => {
  const source = fixture();
  const fixed = buildFixedRootMatchups(source);
  assert.deepEqual(fixed.counts, {
    sourceSets: 5, fixedUncompletedMatches: 2, directSeedMatches: 2, resolvedFeederMatches: 0,
    completedSets: 1, unresolvedSets: 2,
    statuses: { fixed_matchup: 2, unresolved_feeder: 2, bye: 0, completed: 1, invalid: 0 },
  });
  assert.deepEqual(fixed.matches.map((row) => row.setId), ["500", "501"]);
  assert.deepEqual(fixed.matches[0].entrants.map((row) => row.canonicalPlayerId), ["startgg:player:1002", "startgg:player:1003"]);
  source.sets[0].winnerId = 1;
  assert.equal(buildFixedRootMatchups(source).counts.fixedUncompletedMatches, 1);
});

test("completed prerequisites resolve winner and loser feeders, but never incomplete projections", () => {
  const source = fixture();
  source.sets.find((row) => row.id === 500).state = 3;
  source.sets.find((row) => row.id === 500).winnerId = 2;
  source.sets.find((row) => row.id === 501).state = 3;
  source.sets.find((row) => row.id === 501).winnerId = 1;
  let fixed = buildFixedRootMatchups(source);
  assert.deepEqual(fixed.counts, {
    sourceSets: 5, fixedUncompletedMatches: 1, directSeedMatches: 0, resolvedFeederMatches: 1,
    completedSets: 3, unresolvedSets: 1,
    statuses: { fixed_matchup: 1, unresolved_feeder: 1, bye: 0, completed: 3, invalid: 0 },
  });
  assert.deepEqual(fixed.matches[0].entrants.map((row) => row.name), ["Bravo", "Alpha"]);
  assert.equal(fixed.sourceRows.length, source.sets.length);
  assert.equal(fixed.sourceRows.find((row) => row.setId === "502").slotOrigins[0].originLabel, "Winner of 500");

  const feeder = source.sets.find((row) => row.id === 502);
  feeder.slots[0].prereqPlacement = 2; feeder.slots[0].entrant.id = 3;
  feeder.slots[1].prereqPlacement = 2; feeder.slots[1].entrant.id = 4;
  fixed = buildFixedRootMatchups(source);
  assert.deepEqual(fixed.matches[0].entrants.map((row) => row.name), ["Charlie", "Delta"]);

  source.sets.find((row) => row.id === 500).winnerId = 999;
  fixed = buildFixedRootMatchups(source);
  assert.equal(fixed.sourceRows.find((row) => row.setId === "502").status, "invalid");
});

test("completed byes resolve their winner into a downstream matchup", () => {
  const source = fixture();
  const first = source.sets.find((row) => row.id === 500);
  first.state = 3; first.winnerId = 2; first.displayScore = "Bye";
  first.slots[1] = { prereqType: "bye", prereqId: null, entrant: null };
  const feeder = source.sets.find((row) => row.id === 502);
  feeder.slots[0].entrant.id = 2;
  feeder.slots[1] = slot(101, 1);
  const fixed = buildFixedRootMatchups(source);
  const downstream = fixed.sourceRows.find((row) => row.setId === "502");
  assert.equal(fixed.sourceRows.find((row) => row.setId === "500").status, "bye");
  assert.equal(downstream.status, "fixed_matchup");
  assert.deepEqual(downstream.entrants.map((row) => row.name), ["Bravo", "Alpha"]);
});

test("report prediction input cannot expose winner, scores, or raw bracket state", () => {
  const inputs = [];
  const report = buildUpcomingMatchupReport({
    bundle: fixture(),
    sourceSha256: "source-hash",
    historicalDatasetSha256: "dataset-hash",
    model: { id: "regularized-bt-recent-form", name: "Regularized BT + seed + form" },
    predict(input) {
      inputs.push(input);
      return { p: input.id.endsWith("500") ? 0.82 : 0.5, knownPlayers: 2, formKnownPlayers: 1,
        seedCovered: true, historySetCounts: [12, 7] };
    },
  });
  assert.equal(inputs.length, 2);
  assert.deepEqual(Object.keys(inputs[0]), ["id", "eventId", "entrantIds", "playerIds"]);
  assert.equal("winnerPlayerId" in inputs[0], false);
  assert.equal(report.matches[0].prediction.favoriteName, "Bravo");
  assert.equal(report.matches[0].prediction.estimatedWinChance, 0.82);
  assert.equal(report.matches[0].prediction.reliability.favoriteWinRate, 0.737);
  assert.equal(report.matches[1].prediction.favoriteName, null);
  assert.equal(report.generatedAt, "2026-09-07T12:34:56.000Z");
  assert.equal(report.productize, false);
  assert.match(upcomingMatchupMarkdown(report), /conditional matchup picks/i);
});

test("markdown is deterministic, source-timestamped, grouped, probability-sorted and candid", () => {
  const source = fixture();
  const args = {
    bundle: source, model: { id: "m", name: "Model" },
    predict: ({ id }) => ({ p: id.endsWith("500") ? 0.75 : 0.9, knownPlayers: 0, formKnownPlayers: 0, seedCovered: true }),
  };
  const first = upcomingMatchupMarkdown(buildUpcomingMatchupReport(args));
  source.entrants.reverse(); source.seeds.reverse(); source.sets.reverse(); source.phaseGroups.reverse();
  const second = upcomingMatchupMarkdown(buildUpcomingMatchupReport(args));
  assert.equal(second, first);
  assert.match(first, /\[Start.gg bracket\].*2026-09-07T12:34:56.000Z/);
  assert.match(first, /state \*\*CREATED\*\*.*preview rows/);
  assert.ok(first.indexOf("Alpha 90.0%") < first.indexOf("Bravo 75.0%"));
  assert.match(first, /sorted highest to lowest within each pool/);
  assert.doesNotMatch(first, /Grand Final/);
  assert.match(first, /2 unresolved\/bye/);
  assert.match(first, /not a title or top-eight simulation/i);
  assert.match(first, /complete matchup table/);
  assert.match(first, /download --refresh --event tournament\/riptide-2026-4\/event\/melee-singles/);

  const detailed = upcomingMatchupDetailedMarkdown(buildUpcomingMatchupReport(args));
  assert.match(detailed, /Bravo \[2\] > Charlie \[3\]/);
  assert.match(detailed, /Alpha \[1\] > Delta \[4\]/);
  assert.match(detailed, /\| 75.0% \| S · 0\/0 \|/);

  const equalStrength = upcomingMatchupMarkdown(buildUpcomingMatchupReport({
    ...args,
    predict: () => ({ p: 0.75, knownPlayers: 0, formKnownPlayers: 0, seedCovered: true }),
  }));
  assert.ok(equalStrength.indexOf("Bravo 75.0%") < equalStrength.indexOf("Alpha 75.0%"));
});

test("root selection and structural identity mismatches fail closed", () => {
  const noRoot = fixture(); noRoot.seeds[0].seedNum = 2;
  assert.throws(() => selectRootFullFieldSeedPhase(noRoot), /no unique root/);

  const ambiguous = fixture();
  ambiguous.seeds.push(...ambiguous.seeds.slice(0, 4).map((row, index) => ({
    ...structuredClone(row), id: 300 + index, progressionSeedId: null,
    phase: { id: 30, name: "Duplicate roots" },
  })));
  assert.throws(() => selectRootFullFieldSeedPhase(ambiguous), /multiple root/);

  const mismatch = fixture(); mismatch.sets[0].slots[0].entrant.id = 2;
  assert.equal(buildFixedRootMatchups(mismatch).counts.fixedUncompletedMatches, 1);
  const duplicate = fixture(); duplicate.sets.push(structuredClone(duplicate.sets[0]));
  assert.throws(() => buildFixedRootMatchups(duplicate), /Duplicate bracket set/);
});

test("empirical reliability buckets use favorite-side strength at boundaries", () => {
  assert.deepEqual(empiricalReliability(0.5), { favoriteProbability: 0.5, lower: 0.5, upper: 0.6, favoriteWinRate: 0.539, n: 724 });
  assert.equal(empiricalReliability(0.19).favoriteWinRate, 0.737);
  assert.equal(empiricalReliability(0.9).favoriteWinRate, 0.873);
  assert.equal(empiricalReliability(1).n, 2520);
  assert.throws(() => empiricalReliability(1.1), /between zero and one/);
});
