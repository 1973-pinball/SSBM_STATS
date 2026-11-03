#!/usr/bin/env node
/** Independent reconciliation of a staged public export against source-member
 * receipts and immutable per-replay parse results. No parsing or DB/network writes. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) { assert.ok(process.argv[i].startsWith("--") && process.argv[i + 1]); args.set(process.argv[i].slice(2), process.argv[i + 1]); }
for (const key of ["cache", "export"]) assert.ok(args.has(key), `--${key} is required`);
const cache = path.resolve(args.get("cache")), directory = path.resolve(args.get("export"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const read = async file => JSON.parse(await readFile(file, "utf8"));
const manifest = await read(path.join(directory, "manifest.json")), id = manifest.datasetId;
assert.equal(manifest.schemaVersion, 1); assert.ok(manifest.statsVersion >= 10); assert.equal(manifest.interactionStatsVersion, 9);
assert.equal(manifest.rankTiming, "unknown"); assert.equal(manifest.rankSeason, null); assert.equal(manifest.rankDate, null); assert.equal(manifest.uniquePlayers, null);
const receipt = await read(path.join(cache, `${id}.build.local.json`));
assert.equal(receipt.manifestSha256, sha(await readFile(path.join(directory, "manifest.json"))));
const selectionBytes = await readFile(path.join(cache, `${id}.selection.local.json`)), selection = JSON.parse(selectionBytes);
assert.equal(sha(selectionBytes), receipt.selectionSha256); assert.equal(selection.parserFingerprint, manifest.parser.sourceSha256);
assert.equal(selection.sourceManifestSha256, manifest.source.sourceManifestSha256);
assert.equal(selection.archives.length, manifest.source.archives.length);
assert.equal(manifest.counts.sourceArchives, manifest.source.archives.length);
assert.equal(manifest.counts.sourceBytes, manifest.source.archives.reduce((sum, archive) => sum + archive.bytes, 0));
const rankPair = name => {
  const match = /(?:^|_)(diamond|master|platinum)-(diamond|master|platinum)(?:_|-)/i.exec(path.basename(name));
  return match ? [match[1].toLowerCase(), match[2].toLowerCase()].sort().join("/") : null;
};
const occurrences = new Map(); let occurrenceCount = 0;
for (const archive of selection.archives) {
  const pinned = manifest.source.archives.find(file => file.path === archive.archive);
  assert.ok(pinned && pinned.sha256 === archive.sha256);
  const memberBytes = await readFile(path.join(cache, "members", archive.sha256 + ".local.json"));
  assert.equal(sha(memberBytes), archive.memberReceiptSha256);
  const document = JSON.parse(memberBytes); assert.equal(document.bytes, pinned.bytes); assert.equal(document.sha256, pinned.sha256); assert.equal(document.archive, pinned.path);
  assert.equal(document.members.length, archive.members);
  for (const member of document.members) {
    occurrenceCount++;
    const item = occurrences.get(member.sha256) ?? { bytes: member.bytes, pairs: new Set() };
    assert.equal(item.bytes, member.bytes); item.pairs.add(rankPair(member.member)); item.pairs.add(rankPair(archive.archive)); occurrences.set(member.sha256, item);
  }
}
assert.equal(occurrenceCount, manifest.counts.replayOccurrences); assert.equal(occurrences.size, manifest.counts.uniqueReplays);
assert.equal(occurrenceCount - occurrences.size, manifest.counts.duplicateCopies);
assert.equal(selection.replays.length, occurrences.size); assert.equal(new Set(selection.replays.map(game => game.sha256)).size, occurrences.size);

const key = (tier, character, opponent, stage) => `${tier}/${character ?? "all"}/${opponent ?? "all"}/${stage ?? "all"}`;
const scalarFields = { damageTotal: "totalDamage", neutralWins: "neutralWins", lCancelSuccess: "lCancelSuccess", lCancelFail: "lCancelFail" };
const techFields = { techInPlace: "inPlace", techToward: "toward", techAway: "away", techMissed: "missed", wallTechSuccess: "wallSuccess", wallTechMissed: "wallMissed" };
const actions = ["rolls", "airDodges", "spotDodges", "wavedashes", "wavelands", "dashDances", "ledgeGrabs", "crouchCancels", "grabs"];
const normalIds = [2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const families = ["ledge", "oos", "shieldExits", "recoveries", "edgeguards", "beforeOpening"];
const moveFields = ["landed", "damage", "kills", "killPctSum", "openings", "openingDmg"];
const outcomeFields = ["hitAttempts", "noHitAttempts", "incompleteAttempts"];
const sample = (games = 0, frames = 0) => ({ playerGames: games, durationFrames: frames });
const bump = (row, field, value = 1) => { row[field] = (row[field] ?? 0) + value; };
const bumpSample = (row, frames) => { row.playerGames++; row.durationFrames += frames; };
const actual = new Map(), expected = new Map(); let bytes = 0;
for (const shard of manifest.shards) {
  assert.ok(["diamond", "master"].includes(shard.tier)); assert.equal(shard.encoding, "gzip");
  assert.equal(shard.path, `/ranked/${id}/${shard.tier}-${shard.characterId ?? "all"}.json.gz`);
  const payload = await readFile(path.join(directory, path.basename(shard.path))); bytes += payload.length;
  assert.equal(payload.length, shard.bytes); assert.equal(sha(payload), shard.sha256);
  const document = JSON.parse(gunzipSync(payload));
  assert.deepEqual(Object.keys(document).sort(), ["schemaVersion", "datasetId", "statsVersion", "interactionStatsVersion", "tier", "characterId", "rows"].sort());
  for (const field of ["schemaVersion", "datasetId", "statsVersion", "interactionStatsVersion"]) assert.equal(document[field], manifest[field]);
  assert.equal(document.tier, shard.tier); assert.equal(document.characterId, shard.characterId); assert.equal(document.rows.length, shard.rows);
  for (const row of document.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["tier", "characterId", "opponentCharacterId", "stageId", "playerGames", "distinctGames", "decidedPlayerGames", "wins", "uniquePlayers", "metrics", "coverage", "interactions"].sort());
    assert.equal(row.tier, shard.tier); assert.equal(row.characterId, shard.characterId); assert.equal(row.uniquePlayers, null); assert.equal(row.metrics.playerBalanced, null);
    const cell = key(row.tier, row.characterId, row.opponentCharacterId, row.stageId); assert.ok(!actual.has(cell)); actual.set(cell, row);
  }
}
const empty = () => ({ playerGames: 0, gameIds: new Set(), decidedPlayerGames: 0, wins: 0,
  metrics: { durationFrames: 0, ...Object.fromEntries([...Object.keys(scalarFields), ...Object.keys(techFields)].map(field => [field, 0])),
    openingsPerKillSum: 0, openingsPerKillSamples: 0, damagePerOpeningSum: 0, damagePerOpeningSamples: 0, inputsPerMinuteSum: 0, inputsPerMinuteSamples: 0,
    actions: Object.fromEntries(actions.map(action => [action, 0])), playerBalanced: null, moves: {} },
  coverage: { statsPlayerGames: 0, statsDurationFrames: 0, actionPlayerGames: 0, actionDurationFrames: 0, movePlayerGames: 0, moveDurationFrames: 0,
    metrics: Object.fromEntries(["damageTotal", "neutralWins", "openingsPerKill", "damagePerOpening", "inputsPerMinute", "lCancel", "tech", "wallTech"].map(field => [field, sample()])),
    actions: Object.fromEntries(actions.map(action => [action, sample()])), moves: {} },
  interactions: { games: 0, defenseGames: 0, recoveryGames: 0, punishGames: 0, ...Object.fromEntries(families.map(family => [family, {}])) } });
function contribute(target, game, side, slot, gameHash) {
  target.playerGames++; target.gameIds.add(gameHash);
  if (game.winnerIndex !== null) { target.decidedPlayerGames++; if (game.winnerIndex === slot) target.wins++; }
  const frames = game.durationFrames, m = target.metrics, c = target.coverage;
  m.durationFrames += frames;
  for (const group of ["stats", "action", "move"]) { c[`${group}PlayerGames`]++; c[`${group}DurationFrames`] += frames; }
  for (const [to, from] of Object.entries(scalarFields)) m[to] += side[from];
  for (const [to, from] of Object.entries(techFields)) m[to] += side.techs[from];
  for (const field of ["damageTotal", "neutralWins", "lCancel", "tech", "wallTech"]) bumpSample(c.metrics[field], frames);
  for (const field of ["openingsPerKill", "damagePerOpening", "inputsPerMinute"]) if (side[field] !== null) {
    m[`${field}Sum`] += side[field]; m[`${field}Samples`]++; bumpSample(c.metrics[field], frames);
  }
  for (const action of actions) { m.actions[action] += side.actions[action]; bumpSample(c.actions[action], frames); }
  for (const id of new Set([...normalIds.map(String), ...Object.keys(side.moveStats)])) {
    const move = side.moveStats[id], row = m.moves[id] ??= { ...Object.fromEntries(moveFields.map(field => [field, 0])), lCancelSuccess: 0, lCancelFail: 0 };
    const coverage = c.moves[id] ??= { landed: sample(), attempts: sample(), outcomes: sample(), lCancel: sample() };
    const attempts = move?.attempts ?? (normalIds.includes(Number(id)) ? 0 : undefined);
    if (attempts !== undefined) { bump(row, "attempts", attempts); bump(row, "attemptGames"); bumpSample(coverage.attempts, frames); }
    if (move) {
      for (const field of moveFields) row[field] += move[field]; row.lCancelSuccess += move.lcSuccess; row.lCancelFail += move.lcFail;
      if (outcomeFields.every(field => Object.hasOwn(move, field))) { bump(row, "outcomeGames"); for (const field of outcomeFields) bump(row, field, move[field]); bumpSample(coverage.outcomes, frames); }
    }
  }
  target.interactions.games++;
  for (const [group, counter, groupFamilies] of [["defense", "defenseGames", ["ledge", "oos", "shieldExits"]], ["recovery", "recoveryGames", ["recoveries", "edgeguards"]], ["punish", "punishGames", ["beforeOpening"]]]) {
    if (!side[group]) continue;
    target.interactions[counter]++;
    for (const family of groupFamilies) for (const [option, counters] of Object.entries(side[group][family])) {
      const row = target.interactions[family][option] ??= {}; for (const [field, value] of Object.entries(counters)) bump(row, field, value);
    }
  }
}
const rawStreams = new Map(), rejections = {}, observedTierPlayerGames = {};
let accepted = 0, rejected = 0, wrappers = 0;
for (const selected of [...selection.replays].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
  const parsed = await read(path.join(cache, "parsed", selection.parserFingerprint, selected.sha256 + ".json"));
  assert.equal(parsed.parserFingerprint, selection.parserFingerprint);
  const result = parsed.result, source = occurrences.get(selected.sha256); assert.ok(source); assert.equal(result.sha256, selected.sha256); assert.equal(result.bytes, source.bytes);
  const conflict = result.tiers.length !== 2 || result.tiers.some(tier => !["diamond", "master", "platinum"].includes(tier))
    || [...source.pairs].some(pair => pair !== [...result.tiers].sort().join("/"));
  assert.equal(selected.sourceRankPairConflict, conflict);
  const reasons = [...new Set([...result.reasons, ...(conflict ? ["source-rank-pair-conflict"] : [])])];
  if (result.rawCommandSha256) {
    const signature = JSON.stringify({ tiers: result.tiers, reasons: [...reasons].sort(), record: result.record });
    if (rawStreams.has(result.rawCommandSha256)) { assert.equal(rawStreams.get(result.rawCommandSha256), signature); wrappers++; continue; }
    rawStreams.set(result.rawCommandSha256, signature);
  }
  if (reasons.length) { rejected++; for (const reason of reasons) bump(rejections, reason); continue; }
  const game = result.record; assert.ok(game && game.statsVersion === manifest.statsVersion && game.players.length === 2); accepted++;
  game.players.forEach((side, slot) => {
    const tier = result.tiers[slot]; bump(observedTierPlayerGames, tier); if (!["diamond", "master"].includes(tier)) return;
    for (let mask = 0; mask < 8; mask++) {
      const cell = key(tier, mask & 1 ? side.characterId : null, mask & 2 ? game.players[1 - slot].characterId : null, mask & 4 ? game.stageId : null);
      assert.ok(actual.has(cell), `missing exact pooled cell ${cell}`);
      const row = expected.get(cell) ?? empty(); contribute(row, game, side, slot, selected.sha256); expected.set(cell, row);
    }
  });
}
assert.equal(accepted, manifest.counts.acceptedGames); assert.equal(rejected, manifest.counts.rejectedGames); assert.equal(wrappers, manifest.counts.wrapperDuplicateCopies);
assert.equal(accepted + rejected + wrappers, manifest.counts.uniqueReplays); assert.deepEqual(rejections, manifest.counts.rejections);
assert.equal(actual.size, expected.size);
for (const [cell, row] of actual) {
  const want = expected.get(cell); assert.ok(want);
  for (const field of ["playerGames", "decidedPlayerGames", "wins"]) assert.equal(row[field], want[field], `${cell}/${field}`);
  assert.equal(row.distinctGames, want.gameIds.size, `${cell}/distinctGames`);
  for (const [moveId, coverage] of Object.entries(want.coverage.moves)) {
    coverage.landed = sample(want.coverage.movePlayerGames, want.coverage.moveDurationFrames);
    if ([13, 14, 15, 16, 17].includes(Number(moveId))) coverage.lCancel = { ...coverage.landed };
  }
  assert.deepEqual(row.metrics, want.metrics, `${cell}/all headline, action, and move counters`);
  assert.deepEqual(row.coverage, want.coverage, `${cell}/all per-metric denominators`);
  assert.deepEqual(row.interactions, want.interactions, `${cell}/all interaction counters and coverage`);
  if (row.characterId === null && row.opponentCharacterId === null && row.stageId === null) {
    assert.deepEqual(manifest.tiers[row.tier], { playerGames: want.playerGames, distinctGames: want.gameIds.size, decidedPlayerGames: want.decidedPlayerGames, wins: want.wins });
  }
}
assert.deepEqual(observedTierPlayerGames, receipt.observedTierPlayerGames);
const report = { ok: true, datasetId: id, checkedAt: new Date().toISOString(), manifestSha256: receipt.manifestSha256,
  sourceArchives: selection.archives.length, sourceOccurrences: occurrenceCount, uniqueReplayBytes: occurrences.size, wrapperDuplicateCopies: wrappers,
  acceptedGames: accepted, rejectedGames: rejected, observedTierPlayerGames, publishedTiers: manifest.tiers,
  exactRowsVerified: actual.size, shardCount: manifest.shards.length, compressedBytesVerified: bytes,
  checks: ["source/member receipts", "byte and validated-wrapper deduplication", "actual-slot rank and archive/member pair agreement", "all eight exact filters",
    "distinct games and decided wins", "all headline/action/move/interaction counters", "every metric's measured-game/frame denominators", "strict public field allowlists"], publicationPerformed: false };
const reportFile = path.join(cache, `${id}.verification.local.json`); await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, reportFile }, null, 2));
