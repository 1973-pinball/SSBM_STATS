/**
 * Local state/trajectory audit, independent of retained-vs-streaming parity.
 * No replay paths, identities, dates, or raw frames enter the output.
 * node --experimental-strip-types scripts/audit-defensive-replays.mjs <folder> [count] [output.json]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SlippiGame } from "@slippi/slippi-js";
import { createDefensiveAccumulator, addDefensiveFrame, finishDefensiveAccumulator } from "../src/lib/defensiveInteractions.ts";

const [directory, requested = "40", output] = process.argv.slice(2);
if (!directory) throw new Error("Provide a local replay folder; output contains only sanitized audit evidence.");
async function discover(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await discover(join(root, entry.name)));
    else if (entry.name.toLowerCase().endsWith(".slp")) result.push(join(root, entry.name));
  }
  return result;
}
const files = (await discover(directory)).sort();
const count = Math.min(files.length, Number(requested));
const selected = [...new Set(Array.from({ length: count }, (_, i) => Math.floor(i * (files.length - 1) / Math.max(1, count - 1))))];
const report = { method: "local action-state and trajectory audit; no video review", sourceFiles: files.length,
  selectedFileIndices: selected, games: 0, unsupportedGames: 0, unavailablePlayerGames: 0,
  totals: {}, independent: { evaluated: 0, confirmed: 0, mismatch: 0, unresolved: 0 },
  omittedTransitions: {}, examples: [], mismatches: [], candidateOnly: [] };
const shieldStates = new Set([178, 179, 181, 182]);
const ledgeStates = new Set([252, 253]);
const deadOrDisrupted = s => (s >= 0 && s <= 10) || (s >= 75 && s <= 91) || s === 38 || s === 185 || s === 193 || (s >= 205 && s <= 232) ||
  ((s >= 266 && s <= 304) && s !== 293) || (s >= 327 && s <= 338) || s === 251;
const isCapture = s => (s >= 223 && s <= 232) || ((s >= 266 && s <= 304) && s !== 293) || (s >= 327 && s <= 338);
const round = n => typeof n === "number" ? Math.round(n * 10) / 10 : null;
const increment = (target, key) => { target[key] = (target[key] ?? 0) + 1; };

function stateRuns(frames, player, first, last) {
  const rows = [];
  for (let fn = first; fn <= last; fn++) {
    const p = frames[fn]?.players[player]?.post;
    if (!p) continue;
    const prior = rows.at(-1);
    if (prior?.state === p.actionStateId && prior.end === fn - 1 && prior.percent === round(p.percent)) {
      prior.end = fn; prior.to = [round(p.positionX), round(p.positionY)];
    } else rows.push({ frame: fn, end: fn, state: p.actionStateId, percent: round(p.percent),
      from: [round(p.positionX), round(p.positionY)], to: [round(p.positionX), round(p.positionY)], airborne: p.isAirborne });
  }
  return rows;
}

// Independent raw-frame episode interpretation. It does not inspect detector
// pending state, reuse detector predicates, or invoke Slippi conversion stats.
function independentlyClassify(event, frames, playerIndices) {
  const player = event.playerIndex, opponent = playerIndices.find(p => p !== player);
  const start = event.startFrame;
  const first = frames[start].players[player].post;
  const before = frames[start - 1].players[player].post;
  let section;
  if (ledgeStates.has(before.actionStateId)) section = "ledge";
  else if (shieldStates.has(before.actionStateId)) {
    let contact = false;
    for (let fn = start - 1; fn >= start - 30; fn--) {
      const p = frames[fn]?.players[player]?.post;
      if (!p || !shieldStates.has(p.actionStateId)) break;
      if (p.actionStateId === 181) contact = true;
    }
    section = contact ? "oos" : "shieldExits";
  } else return { status: "mismatch", reason: "event does not begin at a raw ledge/shield exit" };
  const state = first.actionStateId;
  let option;
  if (section === "ledge") {
    option = ({ 254: "getup", 255: "getup", 256: "attack", 257: "attack", 258: "roll", 259: "roll",
      260: "jump", 261: "jump", 262: "jump", 263: "jump" })[state];
    if (!option && state >= 27 && state <= 34) option = state <= 28 ? "dropJump" : "drop";
  } else {
    option = ({ 212: "grab", 214: "grab", 233: "rollForward", 234: "rollBackward", 235: "spotDodge", 180: "shieldRelease", 14: "shieldRelease" })[state];
    if (!option && state >= 24 && state <= 28) option = "jump";
    else if (!option && ((state >= 29 && state <= 34) || state === 244)) option = "fall";
  }
  let uncertain = !option;
  if (option === "drop" || option === "dropJump" || (option === "jump" && section !== "ledge")) {
    let jump = state >= 24 && state <= 28;
    let airDodge = false;
    for (let fn = start + 1; fn <= Math.min(start + (section === "ledge" ? 29 : 14), event.endFrame); fn++) {
      const p = frames[fn].players[player].post, s = p.actionStateId;
      if (s >= 24 && s <= 28) { jump = true; if (section === "ledge") option = "dropJump"; }
      else if (s === 236) airDodge = true;
      else if ((s >= 65 && s <= 69) || (p.internalCharacterId === 24 && [347, 348, 349].includes(s))) {
        option = section === "ledge" ? "dropAerial" : "aerial"; break;
      } else if (ledgeStates.has(s) && section === "ledge") { option = "regrab"; break; }
      else if (!p.isAirborne) {
        const pre = frames[fn].players[player].pre;
        const instant = pre?.actionStateId >= 24 && pre?.actionStateId <= 34 && ((pre.buttons ?? pre.physicalButtons ?? 0) & 96) !== 0;
        if (s === 43 && jump && (airDodge || instant)) option = section === "ledge" ? "ledgedash" : "wavedash";
        else if (s >= 341) uncertain = true;
        break;
      } else if (!(s >= 29 && s <= 34) && !deadOrDisrupted(s)) { uncertain = true; break; }
    }
  }
  if (uncertain) return { status: "unresolved", reason: "unsupported or ambiguous action sequence", expectedSection: section };
  if (option !== event.option || section !== event.section) return { status: "mismatch", reason: "option/pressure mismatch", expectedSection: section, expectedOption: option };
  // Independently locate damage/grab onset. Outcomes whose only evidence is a
  // command-capture state remain bounded by the replay's recorded state table.
  let outcome = null, interactionFrame = null;
  for (let fn = start; fn <= event.endFrame; fn++) {
    const p = frames[fn].players[player].post, q = frames[fn].players[opponent].post;
    const pp = frames[fn - 1].players[player].post, pq = frames[fn - 1].players[opponent].post;
    const incoming = (p.percent > pp.percent && p.lastHitBy === opponent && ((p.actionStateId >= 75 && p.actionStateId <= 91) || p.hitlagRemaining > 0)) ||
      (isCapture(p.actionStateId) && !isCapture(pp.actionStateId));
    const outgoing = (q.percent > pq.percent && q.lastHitBy === player && ((q.actionStateId >= 75 && q.actionStateId <= 91) || q.hitlagRemaining > 0)) ||
      (isCapture(q.actionStateId) && !isCapture(pq.actionStateId));
    if (incoming || outgoing) { outcome = incoming && outgoing ? "traded" : incoming ? "punished" : "hit"; interactionFrame = fn; break; }
  }
  if (outcome && event.outcome !== "incomplete" && outcome !== event.outcome) return { status: "mismatch", reason: "first interaction mismatch", expectedOutcome: outcome };
  if (!outcome && ["hit", "punished", "traded"].includes(event.outcome)) return { status: "mismatch", reason: "reported hit/grab lacks onset" };
  if (event.outcome === "noHit" && event.endFrame - start !== 29) return { status: "mismatch", reason: "noHit without full 30-frame window" };
  if (event.outcome === "incomplete") {
    const end = event.endFrame, p = frames[end].players[player].post, q = frames[end].players[opponent].post;
    const pp = frames[end - 1].players[player].post, pq = frames[end - 1].players[opponent].post;
    const superseded = end > start && !deadOrDisrupted(p.actionStateId) &&
      ((ledgeStates.has(pp.actionStateId) && !ledgeStates.has(p.actionStateId)) ||
       (shieldStates.has(pp.actionStateId) && !shieldStates.has(p.actionStateId)));
    const interrupted = p.stocksRemaining !== pp.stocksRemaining || q.stocksRemaining !== pq.stocksRemaining ||
      deadOrDisrupted(p.actionStateId) || (q.actionStateId >= 0 && q.actionStateId <= 10);
    const truncated = !frames[end + 1];
    if (!superseded && !interrupted && !truncated) return { status: "mismatch", reason: "censored outcome lacks interruption, replacement, or terminal evidence" };
    if (outcome && (interactionFrame < end || !superseded)) return { status: "mismatch", reason: "interaction occurred before claimed censoring", expectedOutcome: outcome };
  }
  return { status: "confirmed", expectedSection: section, expectedOption: option };
}

for (const fileIndex of selected) {
  const game = new SlippiGame(await readFile(files[fileIndex]));
  const settings = game.getSettings();
  if (!settings || settings.isTeams || settings.players.length !== 2) { report.unsupportedGames++; continue; }
  const frames = game.getFrames();
  const frameNumbers = Object.keys(frames).map(Number).sort((a, b) => a - b);
  const events = [];
  const acc = createDefensiveAccumulator(settings, event => events.push(event));
  for (const fn of frameNumbers) addDefensiveFrame(acc, frames[fn]);
  const measured = finishDefensiveAccumulator(acc);
  report.games++;
  const indices = settings.players.map(p => p.playerIndex);
  const starts = new Set(events.map(e => `${e.playerIndex}:${e.startFrame}`));
  for (const player of indices) {
    if (!measured.get(player)) { report.unavailablePlayerGames++; continue; }
    for (const fn of frameNumbers) {
      const p = frames[fn]?.players[player]?.post, before = frames[fn - 1]?.players[player]?.post;
      if (!p || !before) continue;
      const source = ledgeStates.has(before.actionStateId) && !ledgeStates.has(p.actionStateId) ? "ledge"
        : shieldStates.has(before.actionStateId) && !shieldStates.has(p.actionStateId) ? "shield" : null;
      if (!source || starts.has(`${player}:${fn}`)) continue;
      increment(report.omittedTransitions, `${source}:${p.actionStateId}:${deadOrDisrupted(p.actionStateId) ? "disrupted" : "candidate"}`);
      if (!deadOrDisrupted(p.actionStateId) && report.candidateOnly.length < 30) report.candidateOnly.push({ replayIndex: fileIndex, playerIndex: player, frame: fn, source, state: p.actionStateId });
    }
  }
  for (const event of events) {
    if (!measured.get(event.playerIndex)) continue;
    const classification = independentlyClassify(event, frames, indices);
    increment(report.totals, `${event.section}/${event.option}/${event.outcome}`);
    report.independent.evaluated++; report.independent[classification.status]++;
    const evidence = { replayIndex: fileIndex, stageId: settings.stageId,
      characterId: settings.players.find(p => p.playerIndex === event.playerIndex).characterId,
      ...event, ...classification,
      playerStates: stateRuns(frames, event.playerIndex, event.startFrame - 4, event.endFrame),
      opponentStates: stateRuns(frames, indices.find(p => p !== event.playerIndex), event.startFrame - 2, event.endFrame),
      landingInputs: Array.from({ length: event.endFrame - event.startFrame + 1 }, (_, i) => event.startFrame + i)
        .filter(fn => frames[fn].players[event.playerIndex].post.actionStateId === 43 && frames[fn - 1].players[event.playerIndex].post.actionStateId !== 43)
        .map(fn => { const pre = frames[fn].players[event.playerIndex].pre; return { frame: fn, buttons: pre.buttons,
          physicalButtons: pre.physicalButtons, trigger: pre.trigger, physicalLTrigger: pre.physicalLTrigger, physicalRTrigger: pre.physicalRTrigger,
          preState: pre.actionStateId, joystickX: round(pre.joystickX), joystickY: round(pre.joystickY) }; }),
    };
    if (classification.status === "mismatch" && report.mismatches.length < 100) report.mismatches.push(evidence);
    const bucket = `${event.section}/${event.option}/${event.outcome}`;
    if (report.examples.filter(e => `${e.section}/${e.option}/${e.outcome}` === bucket).length < 2) report.examples.push(evidence);
  }
}
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, examples: `${report.examples.length} sanitized examples${output ? " in output" : " (provide output path to inspect)"}`,
  mismatches: report.mismatches.map(({ playerStates: _playerStates, opponentStates: _opponentStates, ...summary }) => summary) }, null, 2));
