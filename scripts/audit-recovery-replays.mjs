/** Local, sanitized state/trajectory audit; this does not render or watch Melee video.
 * node --experimental-strip-types scripts/audit-recovery-replays.mjs <replay-dir> [count=32] [--details]
 * Optional --probe=sample:player-slot:first-frame:last-frame prints a short local state trace.
 * Samples across the library, preferring distinct stage/character combinations.
 * Reports only sample indices, frame numbers, action states and aggregate counts.
 * Raw files, file names, account names and connect codes are never emitted.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { SlippiGame } from "@slippi/slippi-js/node";
import { createRecoveryAccumulator, addRecoveryFrame, finishRecoveryAccumulator } from "../src/lib/recoveryInteractions.ts";
import { createPunishAccumulator, addPunishFrame, finishPunishAccumulator } from "../src/lib/punishContext.ts";

const [directory, countArg = "32"] = process.argv.slice(2);
assert.ok(directory, "Provide a local replay directory");
const wanted = Math.min(100, Math.max(1, Number(countArg) || 32));
const details = process.argv.includes("--details");
const probe = process.argv.find((arg) => arg.startsWith("--probe="))?.slice(8).split(":").map(Number);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
  ? walk(path.join(dir, entry.name)) : /\.slp$/i.test(entry.name) ? [path.join(dir, entry.name)] : []);
const files = walk(directory).sort();
const candidates = [];
const stride = Math.max(1, Math.floor(files.length / (wanted * 4)));
for (let i = 0; i < files.length && candidates.length < wanted * 4; i += stride) {
  const game = new SlippiGame(files[i]);
  const settings = game.getSettings();
  if (settings?.players.length === 2 && !settings.isTeams) candidates.push({ file: files[i], settings });
}
const selected = [], combinations = new Set();
for (const candidate of candidates) {
  const key = `${candidate.settings.stageId}:${candidate.settings.players.map((p) => p.characterId).sort((a, b) => a - b)}`;
  if (combinations.has(key)) continue;
  combinations.add(key); selected.push(candidate);
  if (selected.length === wanted) break;
}
for (const candidate of candidates) {
  if (selected.length === wanted) break;
  if (!selected.includes(candidate)) selected.push(candidate);
}
assert.ok(selected.length, "No singles replays available");

// Independent geometry reference: libmelee EDGE_GROUND_POSITION, rounded to
// hundredths for the review. The production detector is not imported for this.
const edges = { 2: 63.35, 3: 87.75, 8: 56, 28: 77.27, 31: 68.40, 32: 85.57 };
const dead = (p) => p.actionStateId >= 0 && p.actionStateId <= 10;
const damage = (p) => p.actionStateId >= 75 && p.actionStateId <= 91;
const ledge = (p) => p.actionStateId === 252 || p.actionStateId === 253;
const outside = (p, edge) => Math.abs(p.positionX) > edge + 2 || p.positionY < -5;
const freeRecoveryState = (p) => (p.actionStateId >= 25 && p.actionStateId <= 34)
  || (p.actionStateId >= 44 && p.actionStateId <= 69) || p.actionStateId === 236 || p.actionStateId >= 341 || ledge(p);
const captured = (s) => (s >= 223 && s <= 232) || (s >= 266 && s <= 304 && s !== 293) || (s >= 327 && s <= 338);
const compact = (post) => ({ s: post.actionStateId, x: +post.positionX.toFixed(1), y: +post.positionY.toFixed(1),
  pct: +post.percent.toFixed(1), stocks: post.stocksRemaining, air: post.isAirborne, misc: post.miscActionState,
  lastHitBy: post.lastHitBy, hitlag: post.hitlagRemaining });
const trace = (frames, index, start, end) => {
  const rows = []; let previous;
  for (let frame = Math.max(-123, start); frame <= end; frame++) {
    const post = frames[frame]?.players[index]?.post;
    if (!post) continue;
    if (!previous || post.actionStateId !== previous.actionStateId || post.percent !== previous.percent
      || post.stocksRemaining !== previous.stocksRemaining || frame === end) rows.push({ f: frame, ...compact(post) });
    previous = post;
  }
  return rows.length <= 18 ? rows : [...rows.slice(0, 10), { omittedTransitions: rows.length - 18 }, ...rows.slice(-8)];
};
const evidence = [], samples = [];
const probeFrames = [];
const totals = { games: selected.length, framesAudited: 0, gameplayFrames: 0, recoveryGames: 0, recoveryEpisodes: 0, launchOnlyExcluded: 0,
  candidateExcursions: 0, damageAssociatedCandidates: 0, unmatchedDamageCandidates: 0, noRecentDamageCandidates: 0,
  eligibleTumbleFramesWithPositiveMisc: 0, openings: 0, hitOrGrabEvents: 0, followupEvents: 0,
  unmatchedOpeningCandidates: 0, aggregateEqualities: 0, belowFloorStartsInside: 0, lowOnlyAfterLedge: 0, distantOnstageContests: 0 };
const addEvidence = (kind, value) => {
  const limit = ["unmatchedDamageExcursion", "unmatchedOpeningCandidate", "belowFloorStartInside", "lowOnlyAfterLedge"].includes(kind) ? 100 : 5;
  if (evidence.filter((e) => e.kind === kind).length < limit) evidence.push({ kind, ...value });
};

for (const [sample, selection] of selected.entries()) {
  const game = new SlippiGame(selection.file);
  const settings = game.getSettings(), frames = game.getFrames(), lastFrame = game.getLatestFrame().frame;
  const recovery = createRecoveryAccumulator(settings), punish = createPunishAccumulator(settings);
  const ids = settings.players.map((p) => p.playerIndex), episodeRows = [], punishStarts = [];
  const episodeRefs = new Map(), outsideSegments = new Map(), lastDamages = new Map();
  const edge = edges[settings.stageId];
  let localHits = 0, localOpenings = 0;
  for (let fn = -123; fn <= lastFrame; fn++) {
    const frame = frames[fn]; if (!frame) continue;
    totals.framesAudited++;
    if (fn >= 0) totals.gameplayFrames++;
    const beforeRecovery = recovery?.players.map((p) => p.episode);
    const beforeTactics = recovery?.players.map((p) => new Set(p.episode?.tactics ?? []));
    const beforePunish = punish.players.map((p) => p.active);
    if (recovery) addRecoveryFrame(recovery, frame);
    addPunishFrame(punish, frame);
    for (const [slot, index] of ids.entries()) {
      const post = frame.players[index]?.post, prev = frames[fn - 1]?.players[index]?.post;
      if (!post || !prev) continue;
      const opponent = ids[1 - slot];
      const event = (post.percent > prev.percent && post.stocksRemaining === prev.stocksRemaining && post.lastHitBy === opponent)
        || (captured(post.actionStateId) && !captured(prev.actionStateId));
      if (event) {
        localHits++; totals.hitOrGrabEvents++;
        if (beforePunish[slot]) totals.followupEvents++;
        else if (!punish.players[slot].active) {
          totals.unmatchedOpeningCandidates++;
          addEvidence("unmatchedOpeningCandidate", { sample, player: slot, frame: fn, trace: trace(frames, index, fn - 20, fn + 4) });
        }
      }
      if (!beforePunish[slot] && punish.players[slot].active) {
        localOpenings++; totals.openings++;
        const action = punish.players[slot].active.action;
        punishStarts.push({ slot, frame: fn, action });
        addEvidence(`opening:${action}`, { sample, player: slot, frame: fn, trace: trace(frames, index, fn - 35, fn + 6) });
      }
      const episode = recovery?.players[slot]?.episode;
      if (probe && sample === probe[0] && slot === probe[1] && fn >= probe[2] && fn <= probe[3]) {
        probeFrames.push({ frame: fn, ...compact(post), launchUntil: recovery.players[slot].launchUntil,
          episode: episode?.started ?? null, eligible: episode?.eligible ?? false });
      }
      if (episode && !episodeRefs.has(episode)) {
        episodeRefs.set(episode, { slot, start: fn, initiallyEligible: episode.eligible, firstHigh: null, firstLow: null, firstLedge: null });
        if (Math.abs(post.positionX) <= edge) {
          totals.belowFloorStartsInside++;
          addEvidence("belowFloorStartInside", { sample, player: slot, frame: fn, trace: trace(frames, index, fn - 8, fn + 12) });
        }
      }
      if (episode) {
        const evidence = episodeRefs.get(episode);
        if (episode.high && evidence.firstHigh === null) evidence.firstHigh = fn;
        if (episode.low && evidence.firstLow === null) evidence.firstLow = fn;
        if (ledge(post) && evidence.firstLedge === null) evidence.firstLedge = fn;
        for (const tactic of episode.tactics) if (!beforeTactics[slot].has(tactic)) {
          const guarding = frame.players[opponent].post;
          const distance = Math.hypot(guarding.positionX - post.positionX, guarding.positionY - post.positionY);
          const newDamage = post.percent > prev.percent;
          if (tactic === "onstage" && distance > 60 && !newDamage) {
            totals.distantOnstageContests++;
            addEvidence("distantOnstageContest", { sample, player: slot, frame: fn, distance: +distance.toFixed(1),
              recovering: compact(post), guarding: compact(guarding) });
          }
          addEvidence(`contest:${tactic}`, { sample, player: slot, frame: fn, recovering: compact(post), guarding: compact(guarding) });
        }
      }
      const ending = beforeRecovery?.[slot];
      if (ending && !episode) {
        const row = { ...episodeRefs.get(ending), end: fn, eligible: ending.eligible,
          outcome: dead(post) || post.stocksRemaining < prev.stocksRemaining ? "died" : "returned",
          route: ending.high ? ending.low ? "mixed" : "high" : ending.low ? "low" : "unknown",
          ledge: ending.reachedLedge, tactics: [...ending.tactics], opponentLostStock: ending.opponentLostStock };
        episodeRows.push(row);
        if (row.firstLedge !== null && row.firstLow > row.firstLedge && row.firstHigh < row.firstLedge) {
          totals.lowOnlyAfterLedge++;
          addEvidence("lowOnlyAfterLedge", { sample, player: slot, start: row.start, end: fn, firstLow: row.firstLow,
            firstLedge: row.firstLedge, trace: trace(frames, index, row.start - 8, fn) });
        }
        if (ending.eligible) {
          totals.recoveryEpisodes++;
          addEvidence(`recovery:${row.route}:${row.outcome}`, { sample, player: slot, start: row.start, end: fn, ledge: row.ledge,
            tactics: row.tactics, trace: trace(frames, index, row.start - 15, fn), opponentTrace: trace(frames, opponent, row.start - 5, fn) });
        } else totals.launchOnlyExcluded++;
      }
      if (episode?.eligible && post.actionStateId === 38 && post.miscActionState > 0) {
        totals.eligibleTumbleFramesWithPositiveMisc++;
        addEvidence("tumbleWithPositiveMisc", { sample, player: slot, frame: fn, post: compact(post) });
      }
      if (!edge || (settings.stageId === 3 && settings.isFrozenPS !== true)) continue;
      if (damage(post) || (post.percent > prev.percent && post.lastHitBy === opponent)) lastDamages.set(index, fn);
      const isOutside = outside(post, edge) && !dead(post);
      let segment = outsideSegments.get(index);
      if (isOutside && !segment) {
        segment = { slot, start: fn, lastDamage: lastDamages.get(index) ?? -Infinity, state: post.actionStateId,
          initial: compact(post), actionable: false, ledge: false, production: !!episode };
        outsideSegments.set(index, segment);
      }
      if (segment) {
        if (isOutside && freeRecoveryState(post)) segment.actionable = true;
        if (ledge(post)) segment.ledge = true;
        if (episode) segment.production = true;
        if (!isOutside || fn === lastFrame) {
          totals.candidateExcursions++;
          const associated = segment.start - segment.lastDamage <= 90 && segment.state !== 252 && segment.state !== 253;
          if (associated) {
            totals.damageAssociatedCandidates++;
            if (segment.actionable && !segment.production) {
              totals.unmatchedDamageCandidates++;
              addEvidence("unmatchedDamageExcursion", { sample, player: slot, start: segment.start, end: fn,
                lastDamage: segment.lastDamage, playerIndex: index, opponentIndex: opponent,
                trace: trace(frames, index, segment.lastDamage - 5, fn) });
            }
          } else {
            totals.noRecentDamageCandidates++;
            addEvidence("noRecentDamageExcursion", { sample, player: slot, start: segment.start, end: fn,
              production: segment.production, trace: trace(frames, index, segment.start - 15, fn) });
          }
          outsideSegments.delete(index);
        }
      }
    }
  }
  const recoveryStats = recovery && finishRecoveryAccumulator(recovery), punishStats = finishPunishAccumulator(punish);
  let recoveryCount = 0;
  for (const index of ids) {
    const rec = recoveryStats?.get(index);
    if (rec) for (const row of Object.values(rec.recoveries)) {
      assert.equal(row.attempts, row.returned + row.died + row.incomplete);
      recoveryCount += row.attempts; totals.aggregateEqualities++;
    }
    if (rec) for (const row of Object.values(rec.edgeguards)) {
      assert.equal(row.opportunities, row.stocksTaken + row.opponentReturned + row.uncontestedDeaths + row.incomplete);
      assert.ok(row.stocksTaken <= row.completedContests && row.completedContests <= row.contested);
      totals.aggregateEqualities++;
    }
    assert.ok(punishStats.get(index), "Complete modern sample must have opening coverage");
  }
  if (recoveryStats?.get(ids[0])) totals.recoveryGames++;
  samples.push({ sample, stage: settings.stageId, characters: settings.players.map((p) => p.characterId), frames: lastFrame,
    recoveryCount, completedEpisodes: episodeRows.filter((r) => r.eligible).length, openings: localOpenings, hitsOrGrabs: localHits });
}
console.log(JSON.stringify({ audit: "state/trajectory review, not rendered gameplay or a measured accuracy estimate", totals, samples, ...(probe ? { probeFrames } : {}),
  ...(details ? { evidence } : { evidenceKinds: Object.fromEntries([...new Set(evidence.map((e) => e.kind))].map((kind) => [kind, evidence.filter((e) => e.kind === kind).length])) }) }, null, 2));
