/** Public ranked aggregates: no replay identity, path, tag or connect code leaves this module. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INTERACTION_CODEC_OPTIONS } from "../../src/lib/interactionBenchmarkCodec.mjs";

export const RANKED_SCHEMA_VERSION = 1;
export const RANKED_QUALITY_VERSION = "ranked-quality-v1";
export const RANKED_TIERS = ["diamond", "master", "platinum"];
export const RANKED_STAGES = [2, 3, 8, 28, 31, 32];
export const ACTIONS = ["rolls", "airDodges", "spotDodges", "wavedashes", "wavelands", "dashDances", "ledgeGrabs", "crouchCancels", "grabs"];
const NORMAL_ATTEMPTS = [2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const OUTCOMES = ["hitAttempts", "noHitAttempts", "incompleteAttempts"];
const MOVE_FIELDS = ["landed", "damage", "kills", "killPctSum", "openings", "openingDmg"];
const FAMILIES = Object.keys(INTERACTION_CODEC_OPTIONS);
export const INTERACTION_FIELDS = {
  ledge: ["attempts", "punished", "hit", "traded", "noHit", "incomplete"],
  oos: ["attempts", "punished", "hit", "traded", "noHit", "incomplete", "cStickInputs", "cStickSamples"],
  shieldExits: ["attempts", "punished", "hit", "traded", "noHit", "incomplete", "cStickInputs", "cStickSamples"],
  recoveries: ["attempts", "reachedLedge", "hitDuringRecovery", "returned", "died", "incomplete"],
  edgeguards: ["opportunities", "contested", "completedContests", "stocksTaken", "opponentReturned", "uncontestedDeaths", "incomplete"],
  beforeOpening: ["openings", "damage", "kills", "incomplete"],
};
const sample = () => ({ playerGames: 0, durationFrames: 0 });
const numeric = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
const count = n => Number.isSafeInteger(n) && n >= 0;
const hash = value => createHash("sha256").update(value).digest("hex");
export const rankedCellKey = row => JSON.stringify([row.tier, row.characterId, row.opponentCharacterId, row.stageId]);
const increment = (coverage, frames) => { coverage.playerGames++; coverage.durationFrames += frames; };

function emptyMetrics() {
  return { durationFrames: 0, damageTotal: 0, neutralWins: 0,
    openingsPerKillSum: 0, openingsPerKillSamples: 0, damagePerOpeningSum: 0, damagePerOpeningSamples: 0,
    inputsPerMinuteSum: 0, inputsPerMinuteSamples: 0, lCancelSuccess: 0, lCancelFail: 0,
    techInPlace: 0, techToward: 0, techAway: 0, techMissed: 0, wallTechSuccess: 0, wallTechMissed: 0,
    actions: Object.fromEntries(ACTIONS.map(key => [key, 0])), playerBalanced: null, moves: {} };
}
function emptyCoverage() {
  return { statsPlayerGames: 0, statsDurationFrames: 0, actionPlayerGames: 0, actionDurationFrames: 0,
    movePlayerGames: 0, moveDurationFrames: 0,
    metrics: Object.fromEntries(["damageTotal", "neutralWins", "openingsPerKill", "damagePerOpening", "inputsPerMinute", "lCancel", "tech", "wallTech"].map(key => [key, sample()])),
    actions: Object.fromEntries(ACTIONS.map(key => [key, sample()])), moves: {} };
}
function emptyInteractions() {
  return { games: 0, defenseGames: 0, recoveryGames: 0, punishGames: 0, ...Object.fromEntries(FAMILIES.map(key => [key, {}])) };
}
function addInteractions(target, player) {
  target.games++;
  for (const [group, coverage, families] of [["defense", "defenseGames", ["ledge", "oos", "shieldExits"]],
    ["recovery", "recoveryGames", ["recoveries", "edgeguards"]], ["punish", "punishGames", ["beforeOpening"]]]) {
    if (player[group] === undefined) continue;
    assert.ok(player[group] && typeof player[group] === "object", "invalid interaction group");
    target[coverage]++;
    for (const family of families) {
      assert.ok(player[group][family] && typeof player[group][family] === "object", "missing interaction family");
      for (const [option, counters] of Object.entries(player[group][family])) {
        assert.ok(INTERACTION_CODEC_OPTIONS[family].includes(option), "unknown interaction option");
        const optional = ["cStickInputs", "cStickSamples"];
        const hasOptional = optional.some(field => Object.hasOwn(counters, field));
        const expected = INTERACTION_FIELDS[family].filter(field => !optional.includes(field) || hasOptional);
        assert.deepEqual(Object.keys(counters).sort(), [...expected].sort(), "incomplete interaction counter fields");
        if (["ledge", "oos", "shieldExits"].includes(family)) {
          assert.equal(counters.attempts, counters.punished + counters.hit + counters.traded + counters.noHit + counters.incomplete, "defensive outcome partition");
          if (hasOptional) assert.ok(counters.cStickInputs <= counters.cStickSamples && counters.cStickSamples <= counters.attempts, "C-stick measurement bounds");
        } else if (family === "recoveries") {
          assert.equal(counters.attempts, counters.returned + counters.died + counters.incomplete, "recovery outcome partition");
          assert.ok(counters.reachedLedge <= counters.attempts && counters.hitDuringRecovery <= counters.attempts, "recovery milestone bounds");
        } else if (family === "edgeguards") {
          assert.equal(counters.opportunities, counters.stocksTaken + counters.opponentReturned + counters.uncontestedDeaths + counters.incomplete, "edgeguard outcome partition");
          assert.ok(counters.completedContests <= counters.contested && counters.contested <= counters.opportunities
            && counters.completedContests <= counters.opportunities - counters.incomplete && counters.stocksTaken <= counters.completedContests, "edgeguard measurement bounds");
        } else assert.ok(counters.incomplete <= counters.openings && counters.kills <= counters.openings - counters.incomplete, "opening outcome bounds");
        const row = target[family][option] ??= {};
        for (const [field, value] of Object.entries(counters)) {
          assert.ok(INTERACTION_FIELDS[family].includes(field), "unknown interaction counter");
          assert.ok(field === "damage" ? numeric(value) : count(value), "invalid interaction count");
          row[field] = (row[field] ?? 0) + value;
        }
      }
    }
  }
}
function addSide(row, record, side, slot, replayHash) {
  row.playerGames++;
  row._games.add(replayHash);
  if (record.winnerIndex !== null) { row.decidedPlayerGames++; if (record.winnerIndex === slot) row.wins++; }
  const frames = record.durationFrames, m = row.metrics, c = row.coverage;
  m.durationFrames += frames;
  for (const group of ["stats", "action", "move"]) { c[`${group}PlayerGames`]++; c[`${group}DurationFrames`] += frames; }
  for (const [target, source] of [["damageTotal", "totalDamage"], ["neutralWins", "neutralWins"]]) {
    assert.ok(numeric(side[source]), `invalid ${source}`); m[target] += side[source]; increment(c.metrics[target], frames);
  }
  for (const field of ["openingsPerKill", "damagePerOpening", "inputsPerMinute"]) {
    if (side[field] === null) continue;
    assert.ok(numeric(side[field]), `invalid ${field}`);
    m[`${field}Sum`] += side[field]; m[`${field}Samples`]++; increment(c.metrics[field], frames);
  }
  for (const field of ["lCancelSuccess", "lCancelFail"]) { assert.ok(count(side[field])); m[field] += side[field]; }
  increment(c.metrics.lCancel, frames);
  for (const [target, source] of [["techInPlace", "inPlace"], ["techToward", "toward"], ["techAway", "away"], ["techMissed", "missed"], ["wallTechSuccess", "wallSuccess"], ["wallTechMissed", "wallMissed"]]) {
    assert.ok(count(side.techs?.[source]), `invalid ${source}`); m[target] += side.techs[source];
  }
  increment(c.metrics.tech, frames); increment(c.metrics.wallTech, frames);
  for (const action of ACTIONS) { assert.ok(count(side.actions?.[action]), `invalid action ${action}`); m.actions[action] += side.actions[action]; increment(c.actions[action], frames); }
  assert.ok(side.moveStats && typeof side.moveStats === "object", "missing measured move stats");
  for (const id of new Set([...NORMAL_ATTEMPTS.map(String), ...Object.keys(side.moveStats)])) {
    assert.ok(/^\d+$/.test(id) && Number(id) <= 255, "invalid move id");
    const move = side.moveStats[id];
    const target = m.moves[id] ??= { ...Object.fromEntries(MOVE_FIELDS.map(key => [key, 0])), lCancelSuccess: 0, lCancelFail: 0 };
    const coverage = c.moves[id] ??= { landed: sample(), attempts: sample(), outcomes: sample(), lCancel: sample() };
    // Absent normal moves are measured zero only after ingestion verified the
    // corresponding action-count computer. Unsupported specials stay absent.
    const attempts = move?.attempts ?? (NORMAL_ATTEMPTS.includes(Number(id)) ? 0 : undefined);
    if (attempts !== undefined) {
      assert.ok(count(attempts), "invalid move attempts");
      target.attempts = (target.attempts ?? 0) + attempts;
      target.attemptGames = (target.attemptGames ?? 0) + 1;
      increment(coverage.attempts, frames);
    }
    if (move) {
      for (const field of MOVE_FIELDS) { assert.ok(numeric(move[field]), `invalid move ${field}`); target[field] += move[field]; }
      for (const [targetField, source] of [["lCancelSuccess", "lcSuccess"], ["lCancelFail", "lcFail"]]) {
        assert.ok(count(move[source])); target[targetField] += move[source];
      }
      if (OUTCOMES.some(field => move[field] !== undefined)) {
        assert.ok([18, 19, 20, 21].includes(Number(id)) && OUTCOMES.every(field => count(move[field]))
          && OUTCOMES.reduce((sum, field) => sum + move[field], 0) === attempts, "invalid special outcome partition");
        target.outcomeGames = (target.outcomeGames ?? 0) + 1;
        for (const field of OUTCOMES) target[field] = (target[field] ?? 0) + move[field];
        increment(coverage.outcomes, frames);
      }
    }
  }
  addInteractions(row.interactions, side);
}

/** Input is local-only parsed data. Byte hashes, never anonymous tier labels,
 * identify duplicate replays. Dittos retain both distinct player slots. */
export function createRankedAggregator({ statsVersion, interactionStatsVersion }) {
  const rows = new Map(), seen = new Map();
  return {
    add({ sha256, record, tiers }) {
      assert.match(sha256, /^[a-f0-9]{64}$/);
      assert.equal(record.statsVersion, statsVersion);
      assert.ok(!record.parseError && !record.statsLevel && !record.isTeams && record.players.length === 2);
      assert.ok(RANKED_STAGES.includes(record.stageId) && Number.isSafeInteger(record.durationFrames) && record.durationFrames >= 1800);
      assert.ok(record.winnerIndex === null || [0, 1].includes(record.winnerIndex));
      assert.ok(tiers.length === 2 && tiers.every(tier => RANKED_TIERS.includes(tier)));
      assert.ok(record.players.every(side => Number.isInteger(side.characterId) && side.characterId >= 0 && side.characterId < 26 && side.isCpu !== true));
      const signature = hash(JSON.stringify({ record, tiers }));
      if (seen.has(sha256)) { assert.equal(seen.get(sha256), signature, "conflicting parse or tier evidence for duplicate replay"); return false; }
      seen.set(sha256, signature);
      record.players.forEach((side, slot) => {
        const opponent = record.players[1 - slot];
        for (const characterId of [null, side.characterId]) for (const opponentCharacterId of [null, opponent.characterId]) for (const stageId of [null, record.stageId]) {
          const dimensions = { tier: tiers[slot], characterId, opponentCharacterId, stageId }, key = rankedCellKey(dimensions);
          let row = rows.get(key);
          if (!row) {
            row = { ...dimensions, playerGames: 0, distinctGames: 0, decidedPlayerGames: 0, wins: 0, uniquePlayers: null,
              metrics: emptyMetrics(), coverage: emptyCoverage(), interactions: emptyInteractions(), _games: new Set() };
            rows.set(key, row);
          }
          addSide(row, record, side, slot, sha256);
        }
      });
      return true;
    },
    finish() {
      return [...rows.values()].map(({ _games, ...row }) => {
        row.distinctGames = _games.size;
        for (const [id, coverage] of Object.entries(row.coverage.moves)) {
          coverage.landed = { playerGames: row.coverage.movePlayerGames, durationFrames: row.coverage.moveDurationFrames };
          if ([13, 14, 15, 16, 17].includes(Number(id))) coverage.lCancel = { ...coverage.landed };
        }
        assert.ok(row.wins <= row.decidedPlayerGames && row.decidedPlayerGames <= row.playerGames);
        assert.ok(row.distinctGames <= row.playerGames && row.playerGames <= row.distinctGames * 2);
        if (statsVersion < interactionStatsVersion) assert.equal(row.interactions.defenseGames + row.interactions.recoveryGames + row.interactions.punishGames, 0);
        return row;
      }).sort((a, b) => rankedCellKey(a).localeCompare(rankedCellKey(b)));
    },
    get uniqueGames() { return seen.size; },
  };
}

/** Only pooled rows are emitted. No private data is copied from the input. */
export function rankedShards(rows, metadata) {
  const shards = new Map();
  for (const row of rows) {
    const key = `${row.tier}-${row.characterId ?? "all"}`;
    let shard = shards.get(key);
    if (!shard) {
      shard = { schemaVersion: RANKED_SCHEMA_VERSION, datasetId: metadata.datasetId, statsVersion: metadata.statsVersion,
        interactionStatsVersion: metadata.interactionStatsVersion, tier: row.tier, characterId: row.characterId, rows: [] };
      shards.set(key, shard);
    }
    shard.rows.push(row);
  }
  return shards;
}
