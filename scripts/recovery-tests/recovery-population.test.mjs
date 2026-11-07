import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildRecoveryPopulation, selectedRecoveryGames, recoveryGameKey } from "../lib/archive-recovery-population.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = "https://example.test/public-evidence";
const side = (label, characterId = 2) => ({ displayName: label, nametag: null, characterId, teamId: null,
  moveStats: { 18: { landed: 0, damage: 0, kills: 0 } } });
const replay = (key, file = `${key}.slp`, extra = {}) => ({ ok: true, file, identityKey: key, statsVersion: 6,
  legalStage: true, playableRoster: true, durationFrames: 7200, isTeams: false, stageId: 31,
  playedAt: "2026-09-01T12:00:00Z", winnerIndex: 0, winnerTeamId: null, consoleNick: "station",
  players: [side("Alice", 2), side("Bob", 9)], ...extra });
const payload = (bundle, records) => ({ name: `${bundle.replace(/\.(?:7z|zip)$/, "")}.json`, payload: {
  bundle, replayFiles: records.length, parsed: records.filter(row => row.ok).length,
  failed: records.filter(row => !row.ok).length, records,
} });
const factory = rows => async function* () { for (const row of [...rows].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) yield row; };
const eventFor = bundle => bundle.replace(/\.(?:7z|zip)$/, "").replace(/-(?:main-stream|streams?|top-8|r2-offstream)$/, "");
const rankingDataset = { players: { Alice: { country: "US" }, Bob: { country: "CA" } }, editions: [
  { title: "MPGR 2024", year: 2024, url: source, entries: [{ player: "Alice", rank: 1 }, { player: "Unranked", rank: 101 }] },
  { title: "SSBMRank 2026", year: 2026, url: source, entries: [{ player: "Bob", rank: 2 }] },
] };
const aliasGroup = (eventId, aliases, resolution = "probable") => ({ kind: "event_aliases", eventId, aliases,
  resolution, sourceUrl: source });
const aliceAlias = { observedAlias: "Alice", playerId: "alice" };
const regional = { id: "ampp", displayName: "Ampp", sourceUrl: source, countryCode: "CA", rankings: [
  { series: "Southern Ontario", editionLabel: "Southern Ontario 2025", year: 2025, rank: 8, sourceUrl: source },
] };
async function fixture(rows, { identities = { overrides: [] }, supplemental = null, additionalEvents = [] } = {}) {
  const eventIds = [...new Set([...rows.map(row => eventFor(row.payload.bundle)), ...additionalEvents])];
  const inputs = factory(rows);
  const model = await buildRecoveryPopulation({ payloads: inputs, datasetId: "nikki-2026-09-08-v12",
    eventDocument: { events: eventIds.map(id => ({ id, isTournament: id !== "personal-pre-slippi-online", sourceUrl: source })) },
    seriesDocument: { series: [{ id: "synthetic-series", eventIds }] }, identityDocument: identities,
    supplementalDocument: supplemental, rankingDataset });
  return { model, inputs, selected: async () => { const results = []; for await (const game of selectedRecoveryGames(inputs, model)) results.push(game); return results; } };
}

test("source addition recomputes first-copy selection and duplicate attribution", async () => {
  const oldRecord = replay("same", "bracket/original.slp");
  const oldSource = payload("z-event.7z", [oldRecord]);
  const before = await fixture([oldSource]);
  assert.equal(before.model.games.get("same").bundle, "z-event.7z");
  const recoveredRecord = replay("same", "recovered.slp");
  const after = await fixture([oldSource, payload("ootb5.7z", [recoveredRecord, { ok: false, file: "failed.slp" }])]);
  assert.deepEqual(after.model.counts, { replayFiles: 3, parsedFiles: 2, failedFiles: 1, duplicateFiles: 1, uniqueGames: 1 });
  assert.equal(after.model.games.get("same").bundle, "ootb5.7z");
  assert.equal(after.model.bundleCounts.get("z-event.7z").duplicateCopies, 1);
  assert.equal(after.model.bundleCounts.get("ootb5.7z").duplicateCopies, 0);
  assert.equal(after.model.games.get("same").copies.length, 2);
  const [selected] = await after.selected();
  assert.equal(selected.record, recoveredRecord);
  assert.equal(selected.game.broadcastEvidence, true);
  assert.equal(selected.tier, "probable");
  assert.equal(selected.publicGameKey, recoveryGameKey(after.model.datasetId, "same"));
  assert.equal(after.model.selectionCompleted, true);
});

test("merged duplicate source flags do not replace original measurements", async () => {
  const record = replay("same", "friendlies/game.slp");
  const beforeBytes = JSON.stringify(record);
  const other = replay("same", "bracket/game.slp", { players: [side("Alice", 20), side("Bob", 9)] });
  const { model, selected } = await fixture([payload("a-event.7z", [record]), payload("z-event.7z", [other])]);
  assert.equal(model.games.get("same").explicitFriendly, false);
  assert.equal(model.games.get("same").broadcastEvidence, true);
  const [game] = await selected();
  assert.equal(game.record.players[0].characterId, 2);
  assert.equal(game.record.players[0].moveStats[18].attempts, undefined);
  assert.equal(game.record.players[0].moveStats[18].hitAttempts, undefined);
  assert.equal(JSON.stringify(record), beforeBytes);
  assert.equal(model.curationBuckets.probableBracket, 1);
});

test("station roster sequences require 2..10 games and bounded gaps", async () => {
  const first = replay("first", "station/a.slp");
  const second = replay("second", "station/b.slp", { playedAt: "2026-09-01T12:20:00Z" });
  const third = replay("third", "station/c.slp", { playedAt: "2026-09-01T12:51:00Z" });
  const { model } = await fixture([payload("event.7z", [first, second, third])]);
  assert.equal(model.games.get("first").tier, "probable");
  assert.equal(model.games.get("first").setId, model.games.get("second").setId);
  assert.equal(model.games.get("third").tier, "unclassified");
  assert.equal(model.sets.size, 1);
  const long = Array.from({ length: 11 }, (_, index) => replay(`g${index}`, `station/game-${String(index).padStart(2, "0")}.slp`));
  const excessive = await fixture([payload("event.7z", long)]);
  assert.equal(excessive.model.sets.size, 0);
  assert.equal(excessive.model.buckets.unclassifiedVenue, 11);
});

test("manual exhibition and technical, friendly, non-tournament exclusions remain distinct", async () => {
  const { model, selected } = await fixture([
    payload("the-match-zain-vs-cody.7z", [replay("match")]),
    payload("event.7z", [replay("friendly", "friendlies/a.slp"), replay("short", "short.slp", { durationFrames: 1799 }),
      replay("illegal", "illegal.slp", { legalStage: false })]),
    payload("personal-pre-slippi-online.7z", [replay("personal", "bracket/a.slp")]),
  ]);
  assert.equal(model.games.get("match").tier, "verified");
  assert.equal(model.games.get("match").setId, `${model.datasetId}:the-match-zain-vs-cody:main`);
  assert.equal(model.buckets.excludedOrIncomplete, 4);
  assert.equal((await selected()).length, 1);
});

test("rankings never auto-publish tag matches and regional Ampp retains sourced eligibility", async () => {
  const { model, selected } = await fixture([payload("event.7z", [replay("bracket", "bracket/g.slp")])], {
    identities: { players: [regional], overrides: [] },
  });
  assert.equal(model.rankedPlayers.size, 3);
  assert.equal(model.rankedPlayers.has("unranked"), false);
  assert.equal(model.rankedPlayers.get("alice").active, false);
  assert.equal(model.rankedPlayers.get("bob").active, true);
  assert.equal(model.rankedPlayers.get("ampp").liquipedia_url, source);
  assert.equal(model.rankings.find(row => row.player_id === "ampp").ranking_series, "Southern Ontario");
  assert.equal(model.aliases.size, 3);
  assert.deepEqual((await selected())[0].identities, [null, null]);
});

test("exact public evidence promotes an otherwise unclassified game and verifies slot and character", async () => {
  const exact = { kind: "event_game_players", eventId: "event", playerId: "ampp", resolution: "probable", sourceUrl: source,
    games: [{ identitySha256: hash("exact"), slot: 1, characterId: 9 }] };
  const options = { identities: { players: [regional], overrides: [exact] } };
  const accepted = await fixture([payload("event.7z", [replay("exact")])], options);
  assert.equal(accepted.model.baseBuckets.unclassifiedVenue, 1);
  assert.equal(accepted.model.buckets.probableBracket, 1);
  assert.equal(accepted.model.identityPromotedGames, 1);
  assert.equal((await accepted.selected())[0].identities[1].playerId, "ampp");
  assert.equal(accepted.model.matchedExactOverrides, 1);
  const drift = await fixture([payload("event.7z", [replay("exact", "g.slp", { players: [side("Alice", 2), side("Bob", 20)] })])], options);
  await assert.rejects(drift.selected(), /Character drift/);
  const unmatched = await fixture([payload("event.7z", [replay("other")])], options);
  await assert.rejects(unmatched.selected(), /did not match selected/);
});

test("supplemental aliases cannot promote unclassified games or name doubles", async () => {
  const supplemental = { schemaVersion: 1, reviewedAt: "2026-11-07", overrides: [aliasGroup("event", [aliceAlias])] };
  const doubles = replay("doubles", "bracket/doubles.slp", { isTeams: true,
    players: [{ ...side("Alice"), teamId: 0 }, { ...side("B"), teamId: 0 }, { ...side("C"), teamId: 1 }, { ...side("D"), teamId: 1 }] });
  const { selected, model } = await fixture([payload("event.7z", [
    replay("single", "bracket/a.slp"), replay("unclassified", "isolated/a.slp"), doubles,
  ])], { supplemental });
  const games = await selected();
  assert.equal(games.find(game => game.key === "single").identities[0].playerId, "alice");
  assert.deepEqual(games.find(game => game.key === "unclassified").identities, [null, null]);
  assert.deepEqual(games.find(game => game.key === "doubles").identities, [null, null, null, null]);
  assert.equal(model.identityPromotedGames, 0);
  assert.equal(model.matchedSupplementalPlayers, 1);
  const unavailable = await fixture([payload("event.7z", [replay("unclassified")])], { supplemental });
  await assert.rejects(unavailable.selected(), /did not match conservative singles/);
  await assert.rejects(fixture([payload("event.7z", [replay("r", "bracket/r.slp")])], {
    identities: { players: [regional], overrides: [] }, supplemental: { ...supplemental,
      overrides: [aliasGroup("event", [{ observedAlias: "Ampp", playerId: "ampp" }])] },
  }), /global Top 100/);
});

test("alias conflicts and repeated singles identities fail independently", async () => {
  const identities = { overrides: [aliasGroup("event", [aliceAlias, { observedAlias: "Bob", playerId: "bob" }])] };
  const conflicted = await fixture([payload("event.7z", [replay("x", "bracket/x.slp", {
    players: [{ ...side("Alice"), nametag: "Bob" }, side("Unknown", 9)],
  })])], { identities });
  await assert.rejects(conflicted.selected(), /Conflicting reviewed display-name/);
  const same = await fixture([payload("event.7z", [replay("x", "bracket/x.slp", {
    players: [side("Alice", 2), side("Alice", 9)],
  })])], { identities });
  await assert.rejects(same.selected(), /both singles sides/);
  const supplemental = { schemaVersion: 1, reviewedAt: "2026-11-07", overrides: [aliasGroup("event", [{ observedAlias: "Alice", playerId: "bob" }])] };
  const disagreement = await fixture([payload("event.7z", [replay("x", "bracket/x.slp")])], { identities, supplemental });
  await assert.rejects(disagreement.selected(), /legacy and supplemental/);
});

test("strict public alias matching does not fold lookalike numbers or punctuation", async () => {
  const { selected } = await fixture([payload("event.7z", [replay("x", "bracket/x.slp", {
    players: [side("A.lice"), side("B0b", 9)],
  })])], { identities: { overrides: [aliasGroup("event", [aliceAlias, { observedAlias: "Bob", playerId: "bob" }])] } });
  assert.deepEqual((await selected())[0].identities, [null, null]);
});

test("counts and repeated paths are reconstructed and checked, not trusted", async () => {
  const bad = payload("event.7z", [replay("x")]); bad.payload.parsed = 2;
  await assert.rejects(fixture([bad]), /parsed count differs/);
  await assert.rejects(fixture([payload("event.7z", [replay("x", "same.slp"), replay("y", "same.slp")])]), /Duplicate replay path/);
});

test("approved rule counts exclude omitted source events without mutating the registry", async () => {
  const identities = { overrides: [aliasGroup("event", [aliceAlias]), aliasGroup("ootb5", [aliceAlias])] };
  const { model, selected } = await fixture([payload("event.7z", [replay("x", "bracket/x.slp")])], {
    identities, additionalEvents: ["ootb5"],
  });
  assert.equal(model.approvedOverrides, 1);
  assert.equal(model.identityEvidence.alias.size, 2);
  assert.equal((await selected())[0].identities[0].playerId, "alice");
  assert.equal(identities.overrides.length, 2);
});
