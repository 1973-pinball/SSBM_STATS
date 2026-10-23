#!/usr/bin/env node
/**
 * Local-only forensic check of measured attempts with unavailable outcomes.
 * No parser writes, archive publishing, network calls, or raw replay uploads.
 *
 * node --experimental-strip-types scripts/diagnose-special-outcome-gaps.mjs
 *   [--cache <archive-cache>] [--manifest <gap-manifest>] [--output <local-json>]
 *
 * Uses audited original bundles and byte-validated local replay copies. It
 * extracts only manifest members, one bundle at a time, and never deletes files.
 * This diagnostic is deliberately outside the backfill parser fingerprint.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SlippiGame } from "@slippi/slippi-js/node";
import { createSpecialMovesAccumulator, addSpecialMovesFrame, finishSpecialMovesAccumulator } from "../src/lib/specialMoves.ts";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--cache", "--manifest", "--output"].includes(args[i]) || !args[i + 1]) throw new Error(`Unknown or incomplete option: ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
const cache = path.resolve(options.cache ?? path.join(os.homedir(), ".cache", "SSBM_DASHBOARD_nikki_archive"));
const manifestPath = path.resolve(options.manifest ?? path.join(cache, "specials-v5-outcome-gaps.local.json"));
const outputPath = path.resolve(options.output ?? path.join(cache, "specials-v5-outcome-diagnoses.local.json"));
const extractionRoot = path.join(cache, "special-outcome-diagnostics-v5", "extracted");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const audit = JSON.parse(readFileSync(path.join(cache, "source-audit-2026-10-22.json"), "utf8"));
assert.ok(Array.isArray(manifest), "Gap manifest must be an array");
const auditedBundles = new Map(audit.sources.filter(row => row.sourceFilename).map(row => [row.sourceFilename, row]));
const groups = new Map();
const safeMember = member => {
  assert.equal(typeof member, "string");
  const normalized = member.replaceAll("\\", "/");
  assert.ok(!path.posix.isAbsolute(normalized) && !normalized.includes(":") && !normalized.split("/").some(part => !part || part === "." || part === ".."), `Unsafe member: ${member}`);
  assert.ok(/\.slp$/i.test(normalized), `Expected a replay member: ${member}`);
  return normalized;
};
for (const entry of manifest) {
  assert.ok(auditedBundles.has(entry.bundle), `Bundle is absent from the immutable source audit: ${entry.bundle}`);
  assert.ok([18, 19, 20, 21].includes(entry.moveId), "Invalid move ID");
  assert.ok(Number.isInteger(entry.playerIndex) && Number.isInteger(entry.durationFrames), "Missing player/frame metadata");
  const member = safeMember(entry.file);
  let bundle = groups.get(entry.bundle);
  if (!bundle) groups.set(entry.bundle, bundle = new Map());
  let replay = bundle.get(member);
  if (!replay) bundle.set(member, replay = { member, entries: [] });
  replay.entries.push(entry);
}

function checkedPath(root, member) {
  const full = path.resolve(root, ...safeMember(member).split("/"));
  const relative = path.relative(path.resolve(root), full);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `Replay escaped its cache directory: ${member}`);
  return full;
}
function validatedFile(file, expectedBytes) {
  if (!existsSync(file)) return false;
  const stat = statSync(file);
  assert.ok(stat.isFile() && stat.size === expectedBytes, `Existing extracted replay has unexpected size: ${file}`);
  return true;
}
function extract(bundle, root, members) {
  return new Promise((resolve, reject) => {
    // Audited members are unique. bsdtar -q stops after the selected members,
    // avoiding a scan of the rest of a large solid archive for duplicate names.
    const child = spawn("tar", ["-xqf", bundle, "-C", root, ...members], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let errorText = "";
    child.stderr.on("data", chunk => { errorText = (errorText + chunk.toString()).slice(-8192); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${errorText}`)));
  });
}
const finite = value => typeof value === "number" && Number.isFinite(value);
const showNumber = value => finite(value) ? value : String(value);
const snapshot = post => post ? {
  internalCharacterId: post.internalCharacterId, actionStateId: post.actionStateId,
  actionStateCounter: showNumber(post.actionStateCounter), percent: showNumber(post.percent),
  lastAttackLanded: showNumber(post.lastAttackLanded), lastHitBy: showNumber(post.lastHitBy),
  stocksRemaining: post.stocksRemaining, isFollower: post.isFollower,
} : null;
function invalidEvidence(frame, playerIndex, opponentIndex, previousFrame) {
  const reasons = [];
  if (previousFrame === null ? frame.frame !== -123 : frame.frame !== previousFrame + 1) reasons.push("missing_prefix_or_noncontiguous_frame");
  const own = frame.players?.[playerIndex]?.post;
  const opponent = frame.players?.[opponentIndex]?.post;
  if (!own) reasons.push("missing_own_post");
  else {
    for (const field of ["internalCharacterId", "actionStateId", "lastAttackLanded"]) if (!finite(own[field])) reasons.push(`invalid_own_${field}`);
    if (own.isFollower === true) reasons.push("own_post_is_follower");
  }
  if (!opponent) reasons.push("missing_opponent_post");
  else for (const field of ["percent", "lastHitBy"]) if (!finite(opponent[field])) reasons.push(`invalid_opponent_${field}`);
  return reasons;
}
const outcomeTrack = (acc, playerIndex, moveId) => moveId === 21
  ? acc.downB.players.find(player => player.playerIndex === playerIndex)
  : acc.players.find(player => player.playerIndex === playerIndex)?.moves[moveId];
const reports = [];
let replayCount = 0;
for (const [bundleName, replayMap] of groups) {
  const source = auditedBundles.get(bundleName);
  const archive = path.join(cache, "downloads", bundleName);
  assert.equal(statSync(archive).size, source.compressed_bytes, `Source archive size differs from audit: ${bundleName}`);
  const stem = path.basename(bundleName, path.extname(bundleName));
  const result = JSON.parse(readFileSync(path.join(cache, "results-v5", `${stem}.json`), "utf8"));
  const records = new Map(result.records.filter(record => record.ok).map(record => [safeMember(record.file), record]));
  const root = path.join(extractionRoot, stem);
  const missing = [];
  for (const replay of replayMap.values()) {
    const record = records.get(replay.member);
    assert.ok(record && Number.isInteger(record.bytes), `No successful staged record for ${bundleName}/${replay.member}`);
    replay.record = record;
    // Prior one-off forensic extracts are useful immutable local copies too.
    const candidates = [root,
      path.join(cache, "specials-yoshi-outcomes-audit-v5"),
      path.join(cache, "specials-nma-outcomes-audit-v5"),
      path.join(cache, "extracted", stem),
    ].map(dir => checkedPath(dir, replay.member));
    replay.file = candidates.find(file => validatedFile(file, record.bytes));
    if (!replay.file) missing.push(replay.member);
  }
  if (missing.length) {
    mkdirSync(root, { recursive: true });
    console.log(`Extracting ${missing.length} selected replay(s) from ${bundleName}`);
    await extract(archive, root, missing);
    for (const replay of replayMap.values()) if (!replay.file) {
      replay.file = checkedPath(root, replay.member);
      assert.ok(validatedFile(replay.file, replay.record.bytes), `Extraction did not produce ${replay.member}`);
    }
  }
  for (const replay of replayMap.values()) {
    const game = new SlippiGame(readFileSync(replay.file));
    const settings = game.getSettings();
    assert.ok(settings && !settings.isTeams && settings.players.length === 2, "Expected singles settings");
    const acc = createSpecialMovesAccumulator(settings.players);
    assert.ok(acc);
    const frames = game.getFrames();
    const firstFailures = new Map();
    const firstAttemptFailures = new Map();
    let previous = null;
    for (const n of Object.keys(frames).map(Number).filter(frame => frame <= replay.record.durationFrames).sort((a, b) => a - b)) {
      const frame = frames[n];
      assert.ok(frame.players, `Frame ${n} has no player container; cannot reproduce the finalized parser input`);
      const previousFrame = acc.previousFrame;
      const before = replay.entries.map(entry => {
        const track = outcomeTrack(acc, entry.playerIndex, entry.moveId);
        return { outcomesKnown: track?.outcomesKnown, attemptsKnown: track?.attemptsKnown };
      });
      addSpecialMovesFrame(acc, frame);
      replay.entries.forEach((entry, i) => {
        const key = `${entry.playerIndex}/${entry.moveId}`;
        const track = outcomeTrack(acc, entry.playerIndex, entry.moveId);
        const outcomeChanged = before[i].outcomesKnown && !track?.outcomesKnown && !firstFailures.has(key);
        const attemptChanged = before[i].attemptsKnown && !track?.attemptsKnown && !firstAttemptFailures.has(key);
        if (!outcomeChanged && !attemptChanged) return;
        const opponentIndex = settings.players.find(player => player.playerIndex !== entry.playerIndex).playerIndex;
        const reasons = invalidEvidence(frame, entry.playerIndex, opponentIndex, previousFrame);
        const failure = {
          firstInvalidFrame: n, reasons: reasons.length ? reasons : ["unsupported_or_ambiguous_action_evidence"],
          own: snapshot(frame.players[entry.playerIndex]?.post), opponent: snapshot(frame.players[opponentIndex]?.post),
          previousOwn: snapshot(previous?.players?.[entry.playerIndex]?.post), previousOpponent: snapshot(previous?.players?.[opponentIndex]?.post),
        };
        if (outcomeChanged) firstFailures.set(key, failure);
        if (attemptChanged) firstAttemptFailures.set(key, failure);
      });
      previous = frame;
    }
    const measured = finishSpecialMovesAccumulator(acc);
    for (const entry of replay.entries) {
      const computed = measured.get(entry.playerIndex)?.[entry.moveId];
      const failure = firstFailures.get(`${entry.playerIndex}/${entry.moveId}`) ?? {
        firstInvalidFrame: null, reasons: ["outcomes_unavailable_at_initialization"],
      };
      const reasons = [...failure.reasons];
      const attemptsMatch = computed?.attempts === entry.move.attempts;
      const outcomesMatch = computed?.hitAttempts === undefined;
      if (!attemptsMatch) reasons.push("retained_attempts_differ_from_staged");
      if (!outcomesMatch) reasons.push("retained_outcomes_differ_from_staged");
      reports.push({ bundle: bundleName, file: replay.member, playerIndex: entry.playerIndex, characterId: entry.characterId,
        moveId: entry.moveId, statsVersion: replay.record.statsVersion, slpVersion: settings.slpVersion,
        stagedAttempts: entry.move.attempts, computed, reproductionMatches: attemptsMatch && outcomesMatch,
        ...failure, reasons, attemptFailure: firstAttemptFailures.get(`${entry.playerIndex}/${entry.moveId}`) ?? null,
      });
    }
    replayCount++;
  }
}
const classifications = {};
for (const report of reports) for (const reason of report.reasons) classifications[reason] = (classifications[reason] ?? 0) + 1;
const reproductionMismatches = reports.filter(report => !report.reproductionMatches).length;
const report = { generatedAt: new Date().toISOString(), localOnly: true, replayCount, moveSideCount: reports.length, reproductionMismatches, classifications, cases: reports };
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ replayCount, moveSideCount: reports.length, reproductionMismatches, classifications, output: outputPath }));
