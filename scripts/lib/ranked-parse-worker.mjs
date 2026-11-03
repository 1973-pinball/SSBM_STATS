import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { SlippiGame } from "@slippi/slippi-js/node";
import { resolveSideTier } from "../ranked-source-pilot.mjs";
import { RANKED_STAGES, RANKED_TIERS } from "./ranked-aggregation.mjs";
import { sha256 } from "./ranked-source-stream.mjs";

const parser = await import(pathToFileURL(workerData.parser).href);
const sanitize = record => ({ statsVersion: record.statsVersion, durationFrames: record.durationFrames,
  stageId: record.stageId, isTeams: record.isTeams, winnerIndex: record.winnerIndex,
  players: record.players.map(({ characterId, isCpu, stocksRemaining, kills, totalDamage, openingsPerKill, damagePerOpening,
    inputsPerMinute, neutralWins, counterHits, beneficialTrades, lCancelSuccess, lCancelFail, grabSuccess, techs, actions,
    moveStats, defense, recovery, punish }) => ({ characterId, isCpu, stocksRemaining, kills, totalDamage, openingsPerKill, damagePerOpening,
    inputsPerMinute, neutralWins, counterHits, beneficialTrades, lCancelSuccess, lCancelFail, grabSuccess, techs, actions,
    moveStats, defense, recovery, punish })) });

export function inspectRankedReplay(arrayBuffer) {
  const bytes = Buffer.from(arrayBuffer), replayHash = sha256(bytes), reasons = [];
  const result = { sha256: replayHash, bytes: bytes.length, rawCommandSha256: null, tiers: [], playerIndexes: [],
    frameCount: null, lastFrame: null, endMethod: null, reasons, record: null };
  const rawLength = bytes.length >= 15 && bytes[0] === 0x7b ? bytes.readUInt32BE(11) : 0;
  if (rawLength > 0 && 15 + rawLength <= bytes.length) result.rawCommandSha256 = sha256(bytes.subarray(15, 15 + rawLength));
  const game = new SlippiGame(arrayBuffer);
  parser.dropUnreadComputers(game);
  const finalized = parser.watchSpecialMoveFrameIntegrity(game.parser);
  try {
    const settings = game.getSettings(), metadata = parser.readReplayMetadata(game, bytes);
    if (!settings || settings.isTeams || settings.players.length !== 2) { reasons.push("not-singles"); return result; }
    result.playerIndexes = settings.players.map(side => side.playerIndex);
    result.tiers = settings.players.map(side => resolveSideTier(side, metadata?.players?.[side.playerIndex]).tier);
    if (!result.tiers.every(tier => RANKED_TIERS.includes(tier))) reasons.push("unresolved-or-conflicting-side-tier");
    if (!RANKED_STAGES.includes(settings.stageId)) reasons.push("unsupported-stage");
    if (settings.players.some(side => side.type !== 0)) reasons.push("not-confirmed-human");
    if (settings.players.some(side => !Number.isInteger(side.characterId) || side.characterId < 0 || side.characterId > 25)) reasons.push("unsupported-character");
    const end = game.getGameEnd(); result.endMethod = end?.gameEndMethod ?? null;
    if (!end || ![1, 2, 3].includes(end.gameEndMethod)) reasons.push("missing-unresolved-or-no-contest-end");
    if (end && Number.isInteger(end.lrasInitiatorIndex) && end.lrasInitiatorIndex >= 0) reasons.push("lras-end");
    if (reasons.length) return result;
    const stats = game.getStats(), frames = game.getFrames(), ids = Object.keys(frames).map(Number).sort((a, b) => a - b);
    const last = ids.at(-1); result.frameCount = ids.length; result.lastFrame = last ?? null;
    if (ids[0] !== -123 || !Number.isInteger(last) || last + 124 !== ids.length
      || ids.some(frame => settings.players.some(side => !frames[frame]?.players?.[side.playerIndex]?.pre || !frames[frame]?.players?.[side.playerIndex]?.post))) reasons.push("incomplete-frame-sequence");
    if (finalized() !== last) reasons.push("finalized-frame-integrity-failed");
    if (settings.players.some(side => frames[-123]?.players?.[side.playerIndex]?.post?.stocksRemaining !== 4)) reasons.push("nonstandard-starting-stocks");
    if (!Number.isInteger(last) || last < 1800 || last > 8 * 60 * 60 + 600) reasons.push("unsupported-game-duration");
    if (settings.players.some(side => !stats?.overall?.some(row => row.playerIndex === side.playerIndex)
      || !stats?.actionCounts?.some(row => row.playerIndex === side.playerIndex))) reasons.push("missing-base-metric-computer");
    const attackFields = ["jab1", "jab2", "jab3", "jabm", "dash", "ftilt", "utilt", "dtilt", "fsmash", "usmash", "dsmash", "nair", "fair", "bair", "uair", "dair"];
    if (settings.players.some(side => {
      const attacks = stats?.actionCounts?.find(row => row.playerIndex === side.playerIndex)?.attackCount;
      return attackFields.some(field => !Number.isSafeInteger(attacks?.[field]) || attacks[field] < 0);
    })) reasons.push("incomplete-normal-move-computer");
    if (reasons.length) return result;
    const record = parser.parseReplay(replayHash, "ranked-local.slp", arrayBuffer);
    const retained = parser.parseReplayRetainedForVerification(replayHash, "ranked-local.slp", arrayBuffer);
    try { assert.deepEqual(record, retained); } catch { reasons.push("bounded-retained-parser-parity-failed"); }
    if (record.parseError || record.statsLevel || record.statsVersion !== parser.CURRENT_STATS_VERSION || record.isTeams
      || record.durationFrames !== last || record.players.length !== 2
      || record.players.some((side, slot) => side.characterId !== settings.players[slot].characterId || side.port !== settings.players[slot].port)) reasons.push("parsed-metadata-mismatch");
    for (let slot = 0; slot < record.players.length; slot++) {
      const side = record.players[slot], index = settings.players[slot].playerIndex;
      const overall = stats.overall.find(row => row.playerIndex === index), actions = stats.actionCounts.find(row => row.playerIndex === index);
      if (side.totalDamage !== overall.totalDamage || side.lCancelSuccess !== actions.lCancelCount.success || side.lCancelFail !== actions.lCancelCount.fail) reasons.push("library-headline-parity-failed");
    }
    if (!reasons.length) result.record = sanitize(record);
  } catch (error) { reasons.push(`parse-error:${error.name ?? "Error"}`); }
  finally { game.disconnect?.(); }
  result.reasons = [...new Set(reasons)];
  return result;
}

parentPort.on("message", ({ id, buffer }) => {
  try { parentPort.postMessage({ id, result: inspectRankedReplay(buffer) }); }
  catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
});
