#!/usr/bin/env node
/** Bounded, local-only source audit. Run from the repository root:
 * node scripts/ranked-source-pilot.mjs [--cache ABSOLUTE_DIRECTORY]
 * No production import, source mutation, rank inference from filename order,
 * or completeness-guard overrides. Downloads only the four pinned shards.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const REPOSITORY = "erickfm/melee-ranked-replays";
export const REVISION = "ef54ddc230e01373ff2a179b49a7e559af788081";
export const SAMPLES = [
  { path: "BOWSER/BOWSER_master-master_a2.tar.gz", bytes: 2000229, sha256: "3015b8df142c5c4fa82aab3398920f9fcfc93006cc17188c1e45edb8763f8ccd" },
  { path: "PICHU/PICHU_master-master_a3.tar.gz", bytes: 3222139, sha256: "2454566028e3ce559c98a3542020d660a7ca43e159bd41ff47952426773f8f43" },
  { path: "PICHU/PICHU_diamond-diamond_a6.tar.gz", bytes: 3380219, sha256: "e951d89a7210ad8f9569e42e6c9298536907e1471f86f1e5d04d498ed09bd32a" },
  { path: "PICHU/PICHU_master-diamond_a6.tar.gz", bytes: 5086385, sha256: "fb5c8a600ca838062c2cabf331cbad34673b6bf3e7dab795656e78e3ddfa885b" },
];
const MAX_DOWNLOAD_BYTES = 15_000_000;
const MAX_TAR_BYTES = 512 * 1024 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const json = value => JSON.stringify(value, null, 2) + "\n";
const countBy = (items, getKey) => items.reduce((counts, item) => {
  const key = String(getKey(item) ?? "unavailable"); counts[key] = (counts[key] ?? 0) + 1; return counts;
}, {});

export function safeMemberName(name) {
  assert.ok(typeof name === "string" && name.length > 0 && !name.includes("\\") && !name.includes("\0"), "unsafe tar member name");
  assert.ok(!name.startsWith("/") && !/^[a-z]:/i.test(name), "absolute tar member name");
  assert.ok(!name.split("/").includes(".."), "tar member traversal");
  return name.replace(/^(\.\/)+/, "");
}

const tarString = (bytes, start, length) => bytes.subarray(start, start + length).toString("utf8").split("\0", 1)[0];
const tarNumber = (bytes, start, length) => {
  const raw = tarString(bytes, start, length).trim();
  assert.match(raw, /^[0-7]*$/, "unsupported tar numeric encoding");
  const value = raw ? Number.parseInt(raw, 8) : 0;
  assert.ok(Number.isSafeInteger(value) && value >= 0, "invalid tar size");
  return value;
};
function paxFields(bytes) {
  const fields = Object.create(null);
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at);
    assert.ok(space > at, "invalid PAX length");
    const length = Number(bytes.subarray(at, space).toString("ascii"));
    assert.ok(Number.isSafeInteger(length) && length > space - at + 1 && at + length <= bytes.length, "invalid PAX record");
    assert.equal(bytes[at + length - 1], 10, "PAX record must end in newline");
    const text = bytes.subarray(space + 1, at + length - 1).toString("utf8");
    const equal = text.indexOf("=");
    assert.ok(equal > 0, "invalid PAX field");
    fields[text.slice(0, equal)] = text.slice(equal + 1);
    at += length;
  }
  return fields;
}

/** Parse members without trusting tar paths for extraction. Links are rejected. */
export function inspectTar(bytes) {
  assert.ok(bytes.length <= MAX_TAR_BYTES, "expanded tar exceeds pilot bound");
  const entries = [];
  let local = {}, global = {}, longName = null, terminated = false;
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(bytes.subarray(at).every(byte => byte === 0), "nonzero data after tar terminator");
      terminated = true; break;
    }
    const stored = tarNumber(header, 148, 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(actual, stored, "tar header checksum mismatch");
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    const start = at + 512, end = start + size;
    assert.ok(end <= bytes.length, "truncated tar member");
    const payload = bytes.subarray(start, end);
    if (type === "x") local = paxFields(payload);
    else if (type === "g") global = { ...global, ...paxFields(payload) };
    else if (type === "L") longName = tarString(payload, 0, size).replace(/\n$/, "");
    else {
      assert.ok(["0", "\0", "5"].includes(type), `unsupported/link tar member type ${type}`);
      const fields = { ...global, ...local };
      const prefix = tarString(header, 345, 155);
      const name = safeMemberName(fields.path ?? longName ?? [prefix, tarString(header, 0, 100)].filter(Boolean).join("/"));
      if (fields.size !== undefined) assert.equal(Number(fields.size), size, "PAX size mismatch");
      if (type !== "5") {
        assert.ok(size <= MAX_REPLAY_BYTES, "tar member exceeds replay bound");
        assert.ok(name.toLowerCase().endsWith(".slp"), `unexpected non-replay member ${name}`);
        entries.push({ name, bytes: payload });
      }
      local = {}; longName = null;
    }
    at = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(terminated, "missing tar terminator");
  return entries;
}

/** Slippi JS exposes the game-start netplay name as displayName. Never use
 * filename order (the mirror sorts rank pairs), anonymous codes, or characters. */
export function resolveSideTier(player, metadataPlayer) {
  const evidence = [
    ["gameStart.displayName", player.displayName],
    ["gameStart.netplay.name", player.netplay?.name],
    ["metadata.players.names.netplay", metadataPlayer?.names?.netplay],
  ].filter(([, label]) => typeof label === "string" && label.trim())
    .map(([field, label]) => ({ field, label, tier: /^(platinum|diamond|master) player$/i.exec(label.trim())?.[1]?.toLowerCase() ?? null }));
  const tiers = [...new Set(evidence.map(item => item.tier).filter(Boolean))];
  const tier = tiers.length === 1 ? tiers[0] : null;
  return { tier, status: tiers.length > 1 ? "conflict" : tier ? "source-label" : "unknown", evidence, timing: "unknown" };
}

export function rankPairAgrees(sides, name) {
  const pair = /(?:^|_)(platinum|diamond|master)-(platinum|diamond|master)(?:_|-)/i.exec(path.basename(name));
  return Boolean(pair && sides.length === 2 && sides.every(side => side.tier)
    && [pair[1].toLowerCase(), pair[2].toLowerCase()].sort().join("+") === sides.map(side => side.tier).sort().join("+"));
}

export function candidateRejectionReasons(audit) {
  const reasons = [];
  if (!audit.full) reasons.push("full-parse-unavailable");
  if (!audit.rankPairAgreement) reasons.push("tier-evidence-unresolved-or-conflicting");
  if (audit.isTeams || audit.sides?.length !== 2) reasons.push("not-singles");
  if (![2, 3, 8, 28, 31, 32].includes(audit.stageId)) reasons.push("unsupported-stage");
  if (!audit.end || ![1, 2, 3, 7].includes(audit.end.gameEndMethod)) reasons.push("missing-or-unresolved-end-event");
  if (audit.frames?.firstFrame !== -123 || audit.frames?.missingFrameIds !== 0
    || audit.sides?.some(side => side.preFrames !== audit.frames.count || side.postFrames !== audit.frames.count)) reasons.push("incomplete-frame-sequence");
  if (!Number.isInteger(audit.frames?.guardFinalizedLastFrame) || audit.frames?.guardFinalizedLastFrame !== audit.frames?.lastFrame) reasons.push("finalized-frame-integrity-failed");
  if (!audit.retainedParity?.equal) reasons.push("bounded-retained-parser-parity-failed");
  return reasons;
}

function differingValues(a, b, key = "", differences = []) {
  if (Object.is(a, b)) return differences;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    for (const child of new Set([...Object.keys(a), ...Object.keys(b)])) {
      differingValues(a[child], b[child], key ? `${key}.${child}` : child, differences);
    }
  } else differences.push({ path: key, bounded: a ?? null, retained: b ?? null });
  return differences;
}

async function fetchBounded(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  const length = Number(response.headers.get("content-length"));
  if (length) assert.ok(length <= limit, "HTTP content exceeds pilot download limit");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= limit, "HTTP response exceeds pilot download limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function inspectReplay(bytes, parser, SlippiGame, SlpParserEvent, charName, watchSpecialMoveFrameIntegrity) {
  const started = performance.now();
  const id = sha256(bytes);
  const game = new SlippiGame(toArrayBuffer(bytes));
  // Observe the existing guard on an independent audit reader; no override.
  const finalizedIntegrity = watchSpecialMoveFrameIntegrity(game.parser);
  const events = { rollbackFrames: 0, finalizedFrames: 0, finalizedLastFrame: null };
  if (game.parser?.on) {
    game.parser.on(SlpParserEvent.ROLLBACK_FRAME, () => events.rollbackFrames++);
    game.parser.on(SlpParserEvent.FINALIZED_FRAME, frame => {
      events.finalizedFrames++; events.finalizedLastFrame = frame.frame;
    });
  }
  try {
    const settings = game.getSettings();
    assert.ok(settings?.players?.length, "no settings");
    const metadata = game.getMetadata();
    const end = game.getGameEnd();
    const stats = game.getStats();
    const frames = game.getFrames();
    const frameIds = Object.keys(frames).map(Number).sort((a, b) => a - b);
    const firstFrame = frameIds[0] ?? null, lastFrame = frameIds.at(-1) ?? null;
    const latest = lastFrame === null ? null : frames[lastFrame];
    const sides = settings.players.map(player => ({
      playerIndex: player.playerIndex, port: player.port, characterId: player.characterId,
      characterName: charName(player.characterId), type: player.type,
      ...resolveSideTier(player, metadata?.players?.[player.playerIndex]),
      connectCodePresent: Boolean(player.connectCode), userIdPresent: Boolean(player.userId),
      terminalStocks: latest?.players?.[player.playerIndex]?.post?.stocksRemaining ?? null,
      preFrames: frameIds.filter(fn => Boolean(frames[fn].players?.[player.playerIndex]?.pre)).length,
      postFrames: frameIds.filter(fn => Boolean(frames[fn].players?.[player.playerIndex]?.post)).length,
    }));
    let full = null, header = null, fullError = null, headerError = null;
    const parseStart = performance.now();
    try { full = parser.parseReplay(id, id + ".slp", toArrayBuffer(bytes)); }
    catch (error) { fullError = { name: error.name, message: error.message }; }
    const parserMilliseconds = performance.now() - parseStart;
    const retainedStarted = performance.now();
    let retainedParity;
    try {
      const retained = parser.parseReplayRetainedForVerification(id, id + ".slp", toArrayBuffer(bytes));
      const differences = differingValues(full, retained);
      retainedParity = { equal: differences.length === 0, differences };
    } catch (error) { retainedParity = { equal: false, error: { name: error.name, message: error.message } }; }
    const retainedParserMilliseconds = performance.now() - retainedStarted;
    try { header = parser.parseHeader(id, id + ".slp", toArrayBuffer(bytes)); }
    catch (error) { headerError = { name: error.name, message: error.message }; }
    const rawLength = bytes.length >= 15 && bytes[0] === 0x7b ? bytes.readUInt32BE(11) : 0;
    const rawCommandSha256 = rawLength > 0 && 15 + rawLength <= bytes.length ? sha256(bytes.subarray(15, 15 + rawLength)) : null;
    const missingFrameIds = firstFrame === null ? null : lastFrame - firstFrame + 1 - frameIds.length;
    const coverage = full?.players.map((side, i) => {
      const moves = Object.entries(side.moveStats ?? {});
      const overall = stats?.overall?.find(item => item.playerIndex === sides[i].playerIndex);
      const actions = stats?.actionCounts?.find(item => item.playerIndex === sides[i].playerIndex);
      const special = Object.fromEntries([18, 19, 20, 21].map(moveId => {
        const move = side.moveStats?.[moveId];
        return [moveId, {
          attempts: move?.attempts ?? null,
          hitAttempts: move?.hitAttempts ?? null,
          noHitAttempts: move?.noHitAttempts ?? null,
          incompleteAttempts: move?.incompleteAttempts ?? null,
        }];
      }));
      return {
        playerIndex: sides[i].playerIndex, tier: sides[i].tier,
        overallAvailable: Boolean(overall), actionsAvailable: Boolean(actions),
        moveRows: moves.length, moveAttemptsAvailable: moves.some(([, move]) => typeof move.attempts === "number"),
        special, lCancelOpportunities: side.lCancelSuccess + side.lCancelFail,
        lCancelParity: Boolean(actions && side.lCancelSuccess === actions.lCancelCount.success && side.lCancelFail === actions.lCancelCount.fail),
        damageParity: Boolean(overall && side.totalDamage === overall.totalDamage),
        damage: { dashboard: side.totalDamage, library: overall?.totalDamage ?? null },
        lCancel: { dashboardSuccess: side.lCancelSuccess, dashboardFail: side.lCancelFail,
          librarySuccess: actions?.lCancelCount?.success ?? null, libraryFail: actions?.lCancelCount?.fail ?? null },
        openingsPerKill: side.openingsPerKill, damagePerOpening: side.damagePerOpening, inputsPerMinute: side.inputsPerMinute,
        defenseAvailable: side.defense !== undefined, recoveryAvailable: side.recovery !== undefined, punishAvailable: side.punish !== undefined,
      };
    }) ?? [];
    return {
      sha256: id, bytes: bytes.length, rawCommandSha256, slpVersion: settings.slpVersion,
      stageId: settings.stageId, isTeams: Boolean(settings.isTeams), sides,
      metadata, matchInfo: settings.matchInfo ?? null,
      frames: { count: frameIds.length, firstFrame, lastFrame, missingFrameIds, statsLastFrame: stats?.lastFrame ?? null, guardFinalizedLastFrame: finalizedIntegrity(), ...events },
      end: end ?? null, libraryWinners: game.getWinners(),
      full: full ? { statsVersion: full.statsVersion, playedAt: full.playedAt, durationFrames: full.durationFrames, gameType: full.gameType,
        winnerIndex: full.winnerIndex, characterIds: full.players.map(side => side.characterId), coverage } : null,
      fullError, header: header ? { playedAt: header.playedAt, durationFrames: header.durationFrames, winnerIndex: header.winnerIndex } : null, headerError,
      retainedParity, parserMilliseconds, retainedParserMilliseconds, auditMilliseconds: performance.now() - started,
    };
  } finally { game.disconnect?.(); }
}

export async function runPilot(cache) {
  const startedAt = new Date().toISOString(), started = performance.now();
  const downloadBytes = SAMPLES.reduce((sum, sample) => sum + sample.bytes, 0);
  assert.ok(downloadBytes <= MAX_DOWNLOAD_BYTES);
  cache = path.resolve(cache);
  await mkdir(path.join(cache, "archives"), { recursive: true });
  await mkdir(path.join(cache, "replays"), { recursive: true });
  const manifest = { repository: REPOSITORY, revision: REVISION, startedAt,
    limits: { compressedBytes: MAX_DOWNLOAD_BYTES, expandedTarBytesPerShard: MAX_TAR_BYTES, replayBytes: MAX_REPLAY_BYTES },
    rankEvidence: "Per-slot anonymized game-start netplay name, exposed as displayName by slippi-js; filename pair is an unordered cross-check only.",
    rankTiming: "unknown; historical source labels, not current or confirmed game-time ranks",
    attribution: "Mirror redistributed by erickfm; dataset card labels the mirror MIT. Slippi-AI credits Fizzi for anonymized ranked dumps. Upstream release terms require separate confirmation before publication.",
    references: [
      `https://huggingface.co/datasets/${REPOSITORY}/tree/${REVISION}`,
      "https://github.com/vladfi1/slippi-ai#acknowledgements", "https://github.com/ericyuegu/hal#raw-replays",
    ],
    files: [],
  };
  for (const directory of [...new Set(SAMPLES.map(sample => sample.path.split("/")[0]))]) {
    const url = `https://huggingface.co/api/datasets/${REPOSITORY}/tree/${REVISION}/${directory}?recursive=false&expand=false`;
    const receipt = await fetchBounded(url, 2_000_000);
    await writeFile(path.join(cache, `hf-tree-${directory}.json`), receipt);
    const entries = JSON.parse(receipt);
    for (const sample of SAMPLES.filter(item => item.path.startsWith(directory + "/"))) {
      const evidence = entries.find(item => item.path === sample.path);
      assert.ok(evidence?.lfs, `missing pinned LFS evidence for ${sample.path}`);
      assert.equal(evidence.size, sample.bytes); assert.equal(evidence.lfs.size, sample.bytes);
      assert.equal(evidence.lfs.oid, sample.sha256);
      manifest.files.push({ ...sample, treeApiUrl: url, treeEntry: evidence });
    }
  }
  const cardUrl = `https://huggingface.co/datasets/${REPOSITORY}/raw/${REVISION}/README.md`;
  const card = await fetchBounded(cardUrl, 100_000);
  await writeFile(path.join(cache, "source-dataset-card.md"), card);
  manifest.datasetCard = { url: cardUrl, sha256: sha256(card) };
  await writeFile(path.join(cache, "source-manifest.json"), json(manifest));

  const occurrences = [], unique = new Map();
  let extractedBytes = 0, newlyDownloadedBytes = 0, expandedTarBytes = 0;
  for (const sample of SAMPLES) {
    const archive = path.join(cache, "archives", path.basename(sample.path));
    let bytes;
    try { bytes = await readFile(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!bytes) {
      bytes = await fetchBounded(`https://huggingface.co/datasets/${REPOSITORY}/resolve/${REVISION}/${sample.path}`, sample.bytes);
      newlyDownloadedBytes += bytes.length;
      assert.ok(newlyDownloadedBytes <= MAX_DOWNLOAD_BYTES);
      assert.equal(bytes.length, sample.bytes); assert.equal(sha256(bytes), sample.sha256);
      await writeFile(archive, bytes, { flag: "wx" });
    }
    assert.equal(bytes.length, sample.bytes); assert.equal(sha256(bytes), sample.sha256);
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
    expandedTarBytes += tar.length;
    const entries = inspectTar(tar);
    for (const entry of entries) {
      const hash = sha256(entry.bytes);
      const record = { archive: sample.path, member: entry.name, sha256: hash, bytes: entry.bytes.length };
      occurrences.push(record);
      if (!unique.has(hash)) {
        const file = path.join(cache, "replays", hash + ".slp");
        try { await writeFile(file, entry.bytes, { flag: "wx" }); }
        catch (error) { if (error.code !== "EEXIST") throw error; assert.equal(sha256(await readFile(file)), hash); }
        unique.set(hash, { file, occurrence: record }); extractedBytes += entry.bytes.length;
      }
    }
    console.log(`${sample.path}: checksum verified; ${entries.length} replay entries`);
  }
  await writeFile(path.join(cache, "replay-occurrences.ndjson"), occurrences.map(row => JSON.stringify(row)).join("\n") + "\n");
  const [{ createServer }, { SlippiGame, SlpParserEvent }] = await Promise.all([import("vite"), import("@slippi/slippi-js/node")]);
  const server = await createServer({ configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  const results = [];
  try {
    const parser = await server.ssrLoadModule("/src/lib/parse.ts");
    const { charName } = await server.ssrLoadModule("/src/lib/melee.ts");
    const { watchSpecialMoveFrameIntegrity } = await server.ssrLoadModule("/src/lib/specialMoves.ts");
    for (const [hash, item] of unique) {
      let audit;
      try { audit = await inspectReplay(await readFile(item.file), parser, SlippiGame, SlpParserEvent, charName, watchSpecialMoveFrameIntegrity); }
      catch (error) { audit = { sha256: hash, inspectionError: { name: error.name, message: error.message } }; }
      const copies = occurrences.filter(row => row.sha256 === hash);
      audit.occurrences = copies;
      audit.rankPairAgreement = audit.sides ? copies.every(copy => rankPairAgrees(audit.sides, copy.member)) : false;
      audit.candidateRejectionReasons = candidateRejectionReasons(audit);
      results.push(audit);
      await writeFile(path.join(cache, "replay-audit.ndjson"), results.map(row => JSON.stringify(row)).join("\n") + "\n");
      console.log(`Audited ${results.length}/${unique.size}: ${audit.inspectionError?.message ?? audit.fullError?.message ?? "parsed"}`);
    }
  } finally { await server.close(); }
  const successful = results.filter(row => row.full), sides = successful.flatMap(row => row.sides);
  const measured = successful.flatMap(row => row.full.coverage);
  const rawHashes = countBy(results.filter(row => row.rawCommandSha256), row => row.rawCommandSha256);
  const summary = {
    revision: REVISION, startedAt, finishedAt: new Date().toISOString(), cache,
    downloadedArchiveBytes: downloadBytes, newlyDownloadedBytes, expandedTarBytes, uniqueReplayBytes: extractedBytes,
    archiveReplayEntries: occurrences.length, uniqueReplayFiles: unique.size, duplicateContentCopies: occurrences.length - unique.size,
    rawCommandHashDuplicatesAmongDistinctFiles: Object.values(rawHashes).reduce((sum, count) => sum + count - 1, 0),
    inspected: results.filter(row => !row.inspectionError).length, fullParsed: successful.length,
    fullErrors: countBy(results.filter(row => row.fullError || row.inspectionError), row => (row.fullError ?? row.inspectionError).name),
    tiers: countBy(sides, row => row.tier), sourceLabels: countBy(sides.flatMap(side => side.evidence), row => row.label),
    unknownOrConflictingTierSides: sides.filter(side => !side.tier).length,
    rankPairConflicts: results.filter(row => !row.rankPairAgreement).length,
    mixedTierGames: successful.filter(row => new Set(row.sides.map(side => side.tier)).size > 1).length,
    mixedTierFirstSlotCounts: countBy(successful.filter(row => new Set(row.sides.map(side => side.tier)).size > 1), row => row.sides[0].tier),
    dittos: successful.filter(row => new Set(row.sides.map(side => side.characterId)).size === 1).length,
    characters: countBy(sides, row => `${row.characterId}:${row.characterName}`),
    stages: countBy(successful, row => row.stageId), slpVersions: countBy(successful, row => row.slpVersion),
    statsVersions: countBy(successful, row => row.full.statsVersion),
    missingDates: successful.filter(row => !row.full.playedAt).length,
    missingMetadataLastFrame: successful.filter(row => typeof row.metadata?.lastFrame !== "number").length,
    missingGameEnd: successful.filter(row => !row.end).length,
    frameGapGames: successful.filter(row => row.frames.missingFrameIds !== 0).length,
    incompletePlayerFrameGames: successful.filter(row => row.sides.some(side => side.preFrames !== row.frames.count || side.postFrames !== row.frames.count)).length,
    rollbackGames: successful.filter(row => row.frames.rollbackFrames > 0).length,
    rollbackFrames: successful.reduce((sum, row) => sum + row.frames.rollbackFrames, 0),
    endMethods: countBy(successful, row => row.end?.gameEndMethod),
    decidedWinners: successful.filter(row => row.full.winnerIndex !== null).length,
    boundedRetainedParityGames: successful.filter(row => row.retainedParity.equal).length,
    boundedRetainedParityFailures: successful.filter(row => !row.retainedParity.equal).map(row => ({ sha256: row.sha256,
      member: row.occurrences[0].member, differingPaths: row.retainedParity.differences?.map(item => item.path) ?? [], error: row.retainedParity.error ?? null })),
    frameIntegrityGuardFailures: successful.filter(row => row.frames.guardFinalizedLastFrame === null).length,
    provisionalCompleteCandidates: successful.filter(row => row.candidateRejectionReasons.length === 0).length,
    provisionalCandidateSidesByTier: countBy(successful.filter(row => row.candidateRejectionReasons.length === 0).flatMap(row => row.sides), side => side.tier),
    candidateRejections: countBy(results.flatMap(row => row.candidateRejectionReasons), reason => reason),
    headerFullDurationDisagreements: successful.filter(row => row.header?.durationFrames !== row.full.durationFrames).length,
    metricSides: {
      parsed: measured.length, overall: measured.filter(row => row.overallAvailable).length, actions: measured.filter(row => row.actionsAvailable).length,
      moves: measured.filter(row => row.moveRows > 0).length, moveAttempts: measured.filter(row => row.moveAttemptsAvailable).length,
      lCancelOpportunities: measured.filter(row => row.lCancelOpportunities > 0).length,
      lCancelLibraryParity: measured.filter(row => row.lCancelParity).length, damageLibraryParity: measured.filter(row => row.damageParity).length,
      openingsPerKill: measured.filter(row => row.openingsPerKill !== null).length,
      damagePerOpening: measured.filter(row => row.damagePerOpening !== null).length,
      inputsPerMinute: measured.filter(row => row.inputsPerMinute !== null).length,
      specialAttempts: Object.fromEntries([18, 19, 20, 21].map(id => [id, measured.filter(row => row.special[id].attempts !== null).length])),
      specialOutcomes: Object.fromEntries([18, 19, 20, 21].map(id => [id, measured.filter(row => row.special[id].hitAttempts !== null).length])),
      defense: measured.filter(row => row.defenseAvailable).length, recovery: measured.filter(row => row.recoveryAvailable).length, punish: measured.filter(row => row.punishAvailable).length,
    },
    parserSeconds: results.reduce((sum, row) => sum + (row.parserMilliseconds ?? 0), 0) / 1000,
    retainedParserSeconds: results.reduce((sum, row) => sum + (row.retainedParserMilliseconds ?? 0), 0) / 1000,
    auditSeconds: results.reduce((sum, row) => sum + (row.auditMilliseconds ?? 0), 0) / 1000,
    wallSeconds: (performance.now() - started) / 1000,
    parserSourceSha256: sha256(await readFile("src/lib/parse.ts")), packageLockSha256: sha256(await readFile("package-lock.json")),
    runtime: { node: process.version, platform: process.platform, arch: process.arch,
      slippiJs: JSON.parse(await readFile("node_modules/@slippi/slippi-js/package.json", "utf8")).version },
    limitations: [
      "Purposive tiny character-shard sample; not representative of the full corpus or present ladder.",
      "Historical source tier labels only; rank timing, season, dates and unique-player identity are not established.",
      "No per-player balancing or unique-player counts may be inferred from repeated anonymous tier names.",
      "Content hashes deduplicate identical bytes; raw-command hashes are an additional audit, not a validated cross-encoding identity.",
      "A zero observed duplicate count cannot validate cross-character duplicate handling without overlapping shards.",
      "Parser output availability is reported as observed; no completeness guards were changed or bypassed.",
      "Bulk ingestion is blocked on missing-end and heavy-rollback bounded/retained parser parity; keep completeness guards intact.",
      "Real dittos and cross-shard duplicates are absent from this selection; broader coverage and upstream redistribution terms remain separate gates.",
    ],
  };
  summary.sourceFingerprints = Object.fromEntries(await Promise.all([
    "scripts/ranked-source-pilot.mjs", "src/lib/parse.ts", "src/lib/replayMetadata.ts", "src/lib/types.ts",
    "src/lib/specialMoves.ts", "src/lib/downBSpecial.ts", "src/lib/interactionAnalysis.ts",
    "src/lib/defensiveInteractions.ts", "src/lib/recoveryInteractions.ts", "src/lib/punishContext.ts",
  ].map(async file => [file, sha256(await readFile(file))])));
  summary.sampleOnlyEstimates = {
    compressedBytesPerGame: downloadBytes / unique.size,
    replayBytesPerGame: extractedBytes / unique.size,
    singleProcessParserSecondsPerGame: summary.parserSeconds / successful.length,
    per1000Games: { compressedGB: downloadBytes / unique.size / 1e6, extractedGB: extractedBytes / unique.size / 1e6,
      parserMinutes: summary.parserSeconds / successful.length * 1000 / 60 },
    caveat: "Linear illustration from 13 tiny biased character-shard games, excluding corpus-wide duplicate inflation, indexes, receipts, concurrency and downloading. Not a full-corpus forecast.",
  };
  const candidateMeasurements = successful.filter(row => row.candidateRejectionReasons.length === 0).flatMap(row => row.full.coverage);
  summary.provisionalCandidateMetricSides = {
    total: candidateMeasurements.length,
    specialAttempts: Object.fromEntries([18, 19, 20, 21].map(id => [id, candidateMeasurements.filter(row => row.special[id].attempts !== null).length])),
    specialOutcomes: Object.fromEntries([18, 19, 20, 21].map(id => [id, candidateMeasurements.filter(row => row.special[id].hitAttempts !== null).length])),
    defense: candidateMeasurements.filter(row => row.defenseAvailable).length,
    recovery: candidateMeasurements.filter(row => row.recoveryAvailable).length,
    punish: candidateMeasurements.filter(row => row.punishAvailable).length,
  };
  await writeFile(path.join(cache, "summary.json"), json(summary));
  const markdown = ["# Ranked source pilot", "", `Pinned source: https://huggingface.co/datasets/${REPOSITORY}/tree/${REVISION}`, "",
    `Audit started ${startedAt}. Reproduce with: node scripts/ranked-source-pilot.mjs --cache "${cache}"`, "",
    "Raw replays and all receipts stay local; no production import or publication occurred.", "",
    "```json", JSON.stringify(summary, null, 2), "```", ""].join("\n");
  await writeFile(path.join(cache, "audit.md"), markdown);
  console.log(JSON.stringify({ cache, uniqueReplays: unique.size, tierSides: summary.tiers,
    completeCandidates: summary.provisionalCompleteCandidates, parityFailures: summary.boundedRetainedParityFailures.length,
    bulkIngestion: "blocked pending parser parity, source terms, and broader source verification", summaryFile: path.join(cache, "summary.json") }, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--cache"), "Usage: node scripts/ranked-source-pilot.mjs [--cache DIRECTORY]");
  await runPilot(args[1] ?? path.join(homedir(), ".cache", "SSBM_DASHBOARD_ranked_pilot", REVISION));
}
