/** Independent recovery-export reference. Does not import the production aggregator. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const specialIds = [18, 19, 20, 21];
const outcomeFields = ["hitAttempts", "noHitAttempts", "incompleteAttempts"];
const dimensionFields = ["scope", "population", "series_id", "tournament_id", "set_id", "player_id", "format",
  "character_id", "opponent_character_id", "stage_id"];
const actionFields = ["rolls", "airDodges", "spotDodges", "wavedashes", "wavelands", "dashDances", "ledgeGrabs", "crouchCancels", "grabs"];
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const dimensionKey = (row) => JSON.stringify(dimensionFields.map((field) => row[field]));

export function assertRecoveryRecordMeasurements(record, getSpecialMoveCapability) {
  assert.equal(record.statsVersion, 6, "recovery reference requires the unchanged stats-v6 parser");
  const singles = !record.isTeams && record.players.length === 2;
  for (const player of record.players) {
    assert.ok(count(player.actions?.crouchCancels), "current crouch-cancel measurements required");
    for (const [id, move] of Object.entries(player.moveStats ?? {})) {
      const special = specialIds.includes(Number(id));
      if (special && move.attempts !== undefined) {
        assert.ok(singles && count(move.attempts), "special attempts require a singles count");
        if (getSpecialMoveCapability) assert.ok(getSpecialMoveCapability(player.characterId, Number(id)).attempts,
          "unsupported special initiation measurement");
      }
      if (!outcomeFields.some((field) => move[field] !== undefined)) continue;
      assert.ok(special && singles && count(move.attempts) && outcomeFields.every((field) => count(move[field])),
        "outcomes require complete special-use counts in singles");
      assert.equal(outcomeFields.reduce((sum, field) => sum + move[field], 0), move.attempts,
        "special outcomes must partition attempts exactly");
      if (getSpecialMoveCapability) assert.ok(getSpecialMoveCapability(player.characterId, Number(id)).outcomes,
        "unsupported special outcome measurement");
    }
  }
}

function newMetrics() {
  return {
    durationFrames: 0, damageTotal: 0, neutralWins: 0,
    openingsPerKillSum: 0, openingsPerKillSamples: 0, damagePerOpeningSum: 0, damagePerOpeningSamples: 0,
    inputsPerMinuteSum: 0, inputsPerMinuteSamples: 0, lCancelSuccess: 0, lCancelFail: 0,
    techInPlace: 0, techToward: 0, techAway: 0, techMissed: 0, wallTechSuccess: 0, wallTechMissed: 0,
    actions: Object.fromEntries(actionFields.map((field) => [field, 0])), playerBalanced: null, moves: null,
  };
}

function dimensions(scope, population, format, context, character, opponent, stage) {
  return { scope, population, series_id: context.series ?? null, tournament_id: context.tournament ?? null,
    set_id: null, player_id: context.player ?? null, format, character_id: character,
    opponent_character_id: opponent, stage_id: stage };
}

function metricSums(target, record, player, includeMoves) {
  target.durationFrames += record.durationFrames;
  for (const [out, field] of [["damageTotal", "totalDamage"], ["neutralWins", "neutralWins"],
    ["lCancelSuccess", "lCancelSuccess"], ["lCancelFail", "lCancelFail"]]) target[out] += player[field] ?? 0;
  for (const field of ["openingsPerKill", "damagePerOpening", "inputsPerMinute"]) {
    if (!Number.isFinite(player[field])) continue;
    target[`${field}Sum`] += player[field]; target[`${field}Samples`]++;
  }
  for (const [out, field] of [["techInPlace", "inPlace"], ["techToward", "toward"], ["techAway", "away"],
    ["techMissed", "missed"], ["wallTechSuccess", "wallSuccess"], ["wallTechMissed", "wallMissed"]]) {
    target[out] += player.techs?.[field] ?? 0;
  }
  for (const field of actionFields) target.actions[field] += player.actions?.[field] ?? 0;
  if (!includeMoves) return;
  target.moves ??= {};
  for (const [id, move] of Object.entries(player.moveStats ?? {})) {
    const sum = target.moves[id] ??= { attempts: 0, landed: 0, damage: 0, kills: 0, killPctSum: 0,
      openings: 0, openingDmg: 0, lCancelSuccess: 0, lCancelFail: 0 };
    for (const field of ["attempts", "landed", "damage", "kills", "killPctSum", "openings", "openingDmg"]) {
      sum[field] += move[field] ?? 0;
    }
    sum.lCancelSuccess += move.lcSuccess ?? 0;
    sum.lCancelFail += move.lcFail ?? 0;
    if (!specialIds.includes(Number(id))) continue;
    // The parser's explicit numeric zero is measured; missing values are not.
    if (move.attempts !== undefined) sum.attemptGames = (sum.attemptGames ?? 0) + 1;
    if (outcomeFields.every((field) => move[field] !== undefined)) {
      sum.outcomeGames = (sum.outcomeGames ?? 0) + 1;
      for (const field of outcomeFields) sum[field] = (sum[field] ?? 0) + move[field];
    }
  }
}

const normalize = (value) => typeof value === "string" && value.trim() ? value.trim().toLocaleLowerCase("en-US") : null;
function privateIdentity(player, event) {
  if (player.connectCode) return `code:${player.connectCode.toUpperCase()}`;
  if (player.userIdHash) return `uid:${player.userIdHash}`;
  if (normalize(player.displayName)) return `display:${normalize(player.displayName)}`;
  if (normalize(player.nametag)) return `event:${event}:tag:${normalize(player.nametag)}`;
  return null;
}

function rateSummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * q, left = Math.floor(index), weight = index - left;
    return weight ? sorted[left] + (sorted[left + 1] - sorted[left]) * weight : sorted[left];
  };
  return { qualifiedPlayers: sorted.length,
    equalWeightMean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p25: percentile(0.25), median: percentile(0.5), p75: percentile(0.75) };
}

function retains(row) {
  const matchup = row.opponent_character_id !== null, stage = row.stage_id !== null;
  if (!matchup && !stage) return true;
  const minimum = row.scope === "community" ? 25 : ["player", "pro"].includes(row.scope)
    ? (matchup && stage ? 5 : 3) : (matchup && stage ? 10 : 5);
  return row.game_count >= minimum;
}

export function createRecoveryRollups(datasetId) {
  assert.ok(typeof datasetId === "string" && datasetId.length, "dataset ID required");
  const cells = new Map(), distinctPro = new Map(), balances = new Map(), mappedPlayers = new Set();
  let mappedPlayerSides = 0, selectedGames = 0, mappedGames = 0, finished = null;

  function contribute(dims, record, side, slot, moves, identity) {
    const key = dimensionKey(dims);
    let row = cells.get(key);
    if (!row) {
      row = { rollup_key: `r:${sha(`${datasetId}:${JSON.stringify(dims)}`)}`, dataset_id: datasetId, ...dims,
        game_count: 0, win_rate_game_count: 0, wins: 0, identified_player_count: dims.player_id ? 1 : null,
        player_balanced_sample_count: null, metrics: newMetrics(), stats_version: 6, published: false };
      cells.set(key, row);
    }
    row.game_count++;
    const winner = record.isTeams ? record.winnerTeamId : record.winnerIndex;
    if (winner !== null) {
      row.win_rate_game_count++;
      if (winner === (record.isTeams ? side.teamId : slot)) row.wins++;
    }
    if (dims.scope === "pro") {
      assert.ok(identity?.playerId, "pooled Pro needs an approved identity");
      const ids = distinctPro.get(key) ?? new Set(); ids.add(identity.playerId); distinctPro.set(key, ids);
      row.identified_player_count = ids.size;
    }
    metricSums(row.metrics, record, side, moves);
  }

  function addScope(scope, population, context, game, side, slot, identity) {
    const { record, format } = game;
    const opponent = !record.isTeams && record.players.length === 2 ? record.players[1 - slot].characterId : null;
    const tuples = [[null, null, null, scope === "pro"], [side.characterId, null, null, true],
      [side.characterId, null, record.stageId, false]];
    if (opponent !== null) {
      tuples.push([side.characterId, opponent, null, true], [side.characterId, opponent, record.stageId, false]);
      if (scope === "pro") tuples.push([null, opponent, null, true]);
    }
    for (const [character, versus, stage, moves] of tuples) {
      contribute(dimensions(scope, population, format, context, character, versus, stage), record, side, slot, moves, identity);
    }
  }

  function add(game) {
    assert.equal(finished, null, "cannot add games after finishing the reference");
    const { record, tier, identities, format, eventId, seriesId } = game;
    assert.ok(["verified", "probable", "unclassified"].includes(tier), "reference accepts selected nonexcluded games only");
    assert.equal(format, record.isTeams ? "doubles" : "singles");
    assert.equal(identities.length, record.players.length);
    assertRecoveryRecordMeasurements(record);
    selectedGames++;
    const conservative = tier === "verified" || tier === "probable";
    if (conservative && identities.some(Boolean)) mappedGames++;
    for (const [slot, side] of record.players.entries()) {
      for (const population of conservative ? ["broad", "conservative"] : ["broad"]) {
        addScope("community", population, {}, game, side, slot);
        addScope("series", population, { series: seriesId }, game, side, slot);
        addScope("tournament", population, { series: seriesId, tournament: `${datasetId}:${eventId}` }, game, side, slot);
      }
      if (!conservative) continue;
      const privateId = privateIdentity(side, eventId);
      if (privateId) {
        const key = `${format}|${privateId}|${side.characterId}`;
        const balance = balances.get(key) ?? { format, character: side.characterId, games: 0,
          lc: [0, 0], tech: [0, 0] };
        balance.games++;
        balance.lc[0] += side.lCancelSuccess ?? 0; balance.lc[1] += side.lCancelFail ?? 0;
        for (const field of ["inPlace", "toward", "away", "wallSuccess"]) balance.tech[0] += side.techs?.[field] ?? 0;
        balance.tech[1] += (side.techs?.missed ?? 0) + (side.techs?.wallMissed ?? 0);
        balances.set(key, balance);
      }
      const identity = identities[slot];
      if (!identity) continue;
      mappedPlayerSides++; mappedPlayers.add(identity.playerId);
      addScope("pro", "conservative", {}, game, side, slot, identity);
      for (const context of [{ player: identity.playerId }, { player: identity.playerId, series: seriesId },
        { player: identity.playerId, series: seriesId, tournament: `${datasetId}:${eventId}` }]) {
        addScope("player", "conservative", context, game, side, slot, identity);
      }
    }
  }

  function finish() {
    if (finished) return finished;
    const cohorts = new Map();
    for (const balance of balances.values()) {
      if (balance.games < 10) continue;
      const key = `${balance.format}|${balance.character}`;
      const cohort = cohorts.get(key) ?? { lc: [], tech: [] };
      for (const [field, minimum] of [["lc", 50], ["tech", 20]]) {
        const attempts = balance[field][0] + balance[field][1];
        if (attempts >= minimum) cohort[field].push(balance[field][0] / attempts);
      }
      cohorts.set(key, cohort);
    }
    for (const row of cells.values()) {
      const m = row.metrics;
      if (row.scope === "community" && row.population === "conservative" && row.character_id !== null
        && row.opponent_character_id === null && row.stage_id === null) {
        const cohort = cohorts.get(`${row.format}|${row.character_id}`);
        if (cohort) {
          m.playerBalanced = { lCancel: rateSummary(cohort.lc), techSuccess: rateSummary(cohort.tech) };
          row.player_balanced_sample_count = Math.max(cohort.lc.length, cohort.tech.length);
        }
      }
      for (const [field, digits] of [["damageTotal", 3], ["openingsPerKillSum", 6], ["damagePerOpeningSum", 6], ["inputsPerMinuteSum", 6]]) {
        m[field] = Number(m[field].toFixed(digits));
      }
      for (const move of Object.values(m.moves ?? {})) for (const field of ["damage", "killPctSum", "openingDmg"]) {
        move[field] = Number(move[field].toFixed(3));
      }
    }
    const rows = new Map([...cells].filter(([, row]) => retains(row)));
    finished = { rows, allRows: cells, summary: { computed: cells.size, exported: rows.size,
      omittedSparse: cells.size - rows.size, privateIdentityGroupsConsidered: balances.size,
      balancedCohorts: cohorts.size, selectedGames, mappedGames, mappedPlayerSides, mappedPlayerIds: [...mappedPlayers].sort() } };
    return finished;
  }
  return { add, finish };
}

function asRows(rows) { return rows instanceof Map ? [...rows.values()] : [...rows]; }
export function assertRecoveryRows(actual, expected) {
  const a = asRows(actual), e = asRows(expected), actualByKey = new Map(a.map((row) => [dimensionKey(row), row]));
  assert.equal(actualByKey.size, a.length, "export contains duplicate rollup dimensions");
  assert.equal(a.length, e.length, "exported rollup count includes every retained reference cell");
  function compare(found, wanted, at) {
    if (typeof wanted === "number" && at.includes(".playerBalanced.") && Number.isFinite(wanted) && typeof found === "number") {
      assert.ok(Number.isFinite(found) && Math.abs(found - wanted) <= 1e-12, `${at}: player-balanced float mismatch`);
    } else if (wanted !== null && typeof wanted === "object") {
      assert.ok(found !== null && typeof found === "object", `${at}: missing object`);
      assert.deepEqual(Object.keys(found).sort(), Object.keys(wanted).sort(), `${at}: exact public field set`);
      for (const key of Object.keys(wanted)) compare(found[key], wanted[key], `${at}.${key}`);
    } else assert.equal(found, wanted, `${at}: value mismatch`);
  }
  for (const row of e) {
    const key = dimensionKey(row);
    assert.ok(actualByKey.has(key), `missing rollup ${key}`);
    compare(actualByKey.get(key), row, key);
  }
  return { comparedRows: e.length };
}

export function assertRecoveryCoverage(rows, getSpecialMoveCapability, { requiredCharacters = Array.from({ length: 26 }, (_, i) => i) } = {}) {
  const list = asRows(rows), sparseUnavailable = [];
  const globalCharacter = (row) => row.format === "singles" && row.character_id !== null && row.opponent_character_id === null
    && row.stage_id === null && row.series_id === null && row.tournament_id === null && row.set_id === null;
  const communities = list.filter((row) => row.scope === "community" && globalCharacter(row));
  for (const population of ["broad", "conservative"]) for (const character of requiredCharacters) {
    const matches = communities.filter((row) => row.population === population && row.character_id === character);
    assert.equal(matches.length, 1, `${population} character ${character}: exactly one reference cohort required`);
    const row = matches[0];
    for (const moveId of specialIds) {
      const move = row.metrics.moves?.[moveId], capability = getSpecialMoveCapability(character, moveId);
      assert.ok((move?.attemptGames ?? 0) > 0, `${population} character ${character} move ${moveId}: positive attempts required`);
      if (capability.outcomes && row.game_count >= 25) {
        assert.ok((move?.outcomeGames ?? 0) > 0, `${population} character ${character} move ${moveId}: supported ample outcomes required`);
      }
    }
  }
  const pro = list.filter((row) => ["player", "pro"].includes(row.scope) && globalCharacter(row));
  for (const row of pro) for (const moveId of specialIds) {
    const move = row.metrics.moves?.[moveId], capability = getSpecialMoveCapability(row.character_id, moveId);
    const missing = [capability.attempts && !(move?.attemptGames > 0) ? "attempts" : null,
      capability.outcomes && !(move?.outcomeGames > 0) ? "outcomes" : null].filter(Boolean);
    if (row.game_count >= 25) assert.deepEqual(missing, [], `${row.scope} ${row.player_id ?? "all"} character ${row.character_id} move ${moveId}: ample coverage required`);
    else if (missing.length) sparseUnavailable.push({ scope: row.scope, playerId: row.player_id, characterId: row.character_id,
      moveId, gameSides: row.game_count, missing });
  }
  return { communityCharacterRows: communities.length, namedCharacterRows: pro.filter((row) => row.scope === "player").length,
    aggregateCharacters: pro.filter((row) => row.scope === "pro").length, sparseUnavailable };
}
