#!/usr/bin/env node
/** Local-only bounded/retained audit of named incomplete replay records. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, SlippiGame } from "@slippi/slippi-js/node";
import { createServer } from "vite";

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--cache", "--manifest", "--output"].includes(args[i]) && args[i + 1], `Invalid option ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
const cache = path.resolve(options.cache ?? path.join(os.homedir(), ".cache", "SSBM_DASHBOARD_nikki_archive"));
const manifestPath = path.resolve(options.manifest ?? path.join(cache, "specials-v5-missing-final-stocks.local.json"));
const outputPath = path.resolve(options.output ?? path.join(cache, "specials-v6-completeness-diagnoses.local.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const cases = (Array.isArray(manifest) ? manifest : manifest.cases).filter(row => !row.isTeams && row.legalStage && row.playableRoster && row.durationFrames >= 1800);
const auditText = readFileSync(path.join(cache, "source-audit-2026-10-22.json"));
const auditSha256 = createHash("sha256").update(auditText).digest("hex");
const audit = JSON.parse(auditText.toString("utf8"));
const parserInputs = ["src/lib/parse.ts", "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts", "src/lib/types.ts", "src/lib/replayMetadata.ts", "scripts/analyze-nikki-bundle.mjs", "scripts/lib/archive-move-coverage.mjs", "package-lock.json"];
function fingerprint() {
  const hash = createHash("sha256");
  for (const name of parserInputs) { hash.update(name); hash.update(readFileSync(name)); }
  return hash.digest("hex");
}
const parserSha256 = fingerprint();
const bundles = new Map(audit.sources.filter(row => row.sourceFilename).map(row => [row.sourceFilename, row]));
function memberName(member) {
  const value = member.replaceAll("\\", "/");
  assert.ok(!path.posix.isAbsolute(value) && !value.includes(":") && !value.split("/").some(part => !part || part === "." || part === "..") && /\.slp$/i.test(value));
  return value;
}
function inside(root, member) {
  const value = path.resolve(root, ...memberName(member).split("/"));
  const relative = path.relative(path.resolve(root), value);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  return value;
}
const groups = Map.groupBy(cases, row => row.bundle);
for (const [bundleName, entries] of groups) {
  const source = bundles.get(bundleName);
  assert.ok(source);
  const archive = path.join(cache, "downloads", bundleName);
  assert.equal(statSync(archive).size, source.compressed_bytes);
  const stem = path.basename(bundleName, ".7z");
  const resultPath = ["results-v5", "results-v4"].map(dir => path.join(cache, dir, `${stem}.json`)).find(existsSync);
  assert.ok(resultPath);
  const records = new Map(JSON.parse(readFileSync(resultPath, "utf8")).records.filter(row => row.ok).map(row => [memberName(row.file), row]));
  const extractionRoot = path.join(cache, "special-completeness-diagnostics-v5", "extracted", stem);
  const missing = [];
  for (const entry of entries) {
    entry.member = memberName(entry.file);
    const record = records.get(entry.member);
    assert.ok(record && Number.isInteger(record.bytes));
    entry.expectedBytes = record.bytes;
    entry.record = record;
    entry.auditedCompressedBytes = source.compressed_bytes;
    const roots = [extractionRoot, path.join(cache, "special-outcome-diagnostics-v5", "extracted", stem), path.join(cache, "specials-nma-outcomes-audit-v5"), path.join(cache, "extracted", stem)];
    entry.localFile = roots.map(root => inside(root, entry.member)).find(file => {
      if (!existsSync(file)) return false;
      assert.equal(statSync(file).size, record.bytes);
      return true;
    });
    if (!entry.localFile) missing.push(entry.member);
  }
  if (missing.length) {
    mkdirSync(extractionRoot, { recursive: true });
    console.log(`Extracting ${missing.length} selected replays from ${bundleName}`);
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xqf", archive, "-C", extractionRoot, ...missing], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let errors = "";
      child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-8192); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`tar ${code}: ${errors}`)));
    });
    for (const entry of entries) if (!entry.localFile) {
      entry.localFile = inside(extractionRoot, entry.member);
      assert.equal(statSync(entry.localFile).size, entry.expectedBytes);
    }
  }
}
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
let parser;
try { parser = await server.ssrLoadModule("/src/lib/parse.ts"); } finally { await server.close(); }
const counts = player => Object.fromEntries([18, 19, 20, 21].map(move => [move, Object.fromEntries(["attempts", "hitAttempts", "noHitAttempts", "incompleteAttempts"].filter(field => player?.moveStats?.[move]?.[field] !== undefined).map(field => [field, player.moveStats[move][field]]))]));
function differences(a, b, location = "", result = []) {
  if (Object.is(a, b)) return result;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${location}/${key}`, result);
  } else result.push({ path: location, bounded: a ?? null, retained: b ?? null });
  return result;
}
const reports = [];
for (const entry of cases) {
  assert.equal(fingerprint(), parserSha256, "Parser inputs changed during the audit; rerun before accepting results");
  const bytes = readFileSync(entry.localFile);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const bounded = parser.parseReplay("audit", entry.member, buffer);
  const retained = parser.parseReplayRetainedForVerification("audit", entry.member, buffer);
  const game = new SlippiGame(bytes);
  let lastFinalized = -124;
  let finalizedCount = 0;
  let firstFinalizedRewrite = null;
  game.parser.on("finalized-frame", frame => { lastFinalized = frame.frame; finalizedCount++; });
  const handleCommand = game.parser.handleCommand.bind(game.parser);
  game.parser.handleCommand = (command, payload) => {
    if (firstFinalizedRewrite === null && (command === Command.PRE_FRAME_UPDATE || command === Command.POST_FRAME_UPDATE) && payload.frame <= game.parser.lastFinalizedFrame) {
      firstFinalizedRewrite = { frame: payload.frame, finalizedBoundary: game.parser.lastFinalizedFrame, command, observation: "raw-pre-post-before-dispatch" };
    }
    return handleCommand(command, payload);
  };
  const settings = game.getSettings(); // Same initial settings snapshot as production.
  const stats = game.getStats();
  lastFinalized = game.parser.lastFinalizedFrame;
  const metadata = game.getMetadata();
  const latest = game.getLatestFrame();
  const frames = game.getFrames();
  const firstMissing = {};
  for (const player of settings.players) {
    for (let n = -123; n <= bounded.durationFrames; n++) {
      if (!frames[n]?.players?.[player.playerIndex]?.post) { firstMissing[player.playerIndex] = n; break; }
    }
  }
  const diff = differences(bounded, retained);
  const report = { bundle: entry.bundle, file: entry.member, localFile: entry.localFile, bytes: entry.expectedBytes,
    replaySha256: createHash("sha256").update(bytes).digest("hex"), auditedCompressedBytes: entry.auditedCompressedBytes,
    slpVersion: settings.slpVersion, correctedStatsVersion: bounded.statsVersion,
    durationFrames: bounded.durationFrames, statsLastFrame: stats?.lastFrame, metadataLastFrame: metadata?.lastFrame,
    expectedLastFrame: Math.max(bounded.durationFrames, Number.isInteger(metadata?.lastFrame) ? metadata.lastFrame : bounded.durationFrames),
    latestFrame: latest?.frame, lastFinalized, finalizedCount, firstFinalizedRewrite, statsLastProcessedFrame: game.statsComputer.lastProcessedFrame,
    lastRawFrame: Math.max(...Object.keys(frames).map(Number)), firstMissingPost: firstMissing,
    finalPosts: settings.players.map(player => ({ playerIndex: player.playerIndex, present: Boolean(frames[bounded.durationFrames]?.players?.[player.playerIndex]?.post), stocks: frames[bounded.durationFrames]?.players?.[player.playerIndex]?.post?.stocksRemaining ?? null })),
    equal: diff.length === 0, specialsEqual: bounded.players.every((player, slot) => JSON.stringify(counts(player)) === JSON.stringify(counts(retained.players[slot]))), differences: diff,
    players: settings.players.map((player, slot) => ({ playerIndex: player.playerIndex, characterId: player.characterId, bounded: counts(bounded.players[slot]), retained: counts(retained.players[slot]) })),
  };
  reports.push(report);
  assert.equal(fingerprint(), parserSha256, "Parser inputs changed during the audit; rerun before accepting results");
  writeFileSync(outputPath, `${JSON.stringify({ at: new Date().toISOString(), manifestPath, parserSha256, auditSha256, replayCount: reports.length, mismatches: reports.filter(row => !row.equal).length, cases: reports }, null, 2)}\n`);
  console.log(JSON.stringify({ file: entry.member, duration: report.durationFrames, lastFinalized, statsLastProcessed: report.statsLastProcessedFrame, equal: report.equal, differences: diff.length }));
}
console.log(JSON.stringify({ output: outputPath, replayCount: reports.length, mismatches: reports.filter(row => !row.equal).length }));
