/**
 * Lossless, versioned JSON transport for the interaction reference.
 * A row is [cohort, character, opponent, stage, games, defenseGames,
 * recoveryGames, punishGames, ledge, oos, shieldExits, recoveries,
 * edgeguards, beforeOpening]. Each family is sparse: [optionIndex, ...counts]
 * in the counter order below. Empty maps and explicit zero rows stay distinct.
 * This module has no Node/browser dependencies; builds and readers share it.
 */
const COHORTS = ["venue", "tournament", "pro"];
const FIELDS = {
  ledge: ["attempts", "punished", "hit", "traded", "noHit", "incomplete"],
  oos: ["attempts", "punished", "hit", "traded", "noHit", "incomplete"],
  shieldExits: ["attempts", "punished", "hit", "traded", "noHit", "incomplete"],
  recoveries: ["attempts", "reachedLedge", "returned", "died", "incomplete"],
  edgeguards: ["opportunities", "contested", "completedContests", "stocksTaken", "opponentReturned", "uncontestedDeaths", "incomplete"],
  beforeOpening: ["openings", "damage", "kills", "incomplete"],
};
const FAMILIES = Object.keys(FIELDS);
const SHIELD_OPTIONS = ["grab", "rollForward", "rollBackward", "spotDodge", "jump", "aerial", "wavedash", "fall", "shieldRelease", "unknown"];
// Tests compare this transport allowlist with the detector's public labels.
export const INTERACTION_CODEC_OPTIONS = {
  ledge: ["getup", "roll", "attack", "jump", "drop", "dropJump", "dropAerial", "ledgedash", "regrab", "unknown"],
  oos: SHIELD_OPTIONS,
  shieldExits: SHIELD_OPTIONS,
  recoveries: ["high", "low", "mixed", "unknown"],
  edgeguards: ["onstage", "holdLedge", "high", "low", "mixed", "unknown"],
  beforeOpening: ["jab", "dashAttack", "ftilt", "utilt", "dtilt", "fsmash", "usmash", "dsmash", "nair", "fair", "bair", "uair", "dair", "grab", "shield", "roll", "spotDodge", "airDodge", "jump", "landing", "ledge", "groundMovement", "specialOrUnique", "unknown"],
};
const DIMENSIONS = ["cohort", "characterId", "opponentCharacterId", "stageId", "games", "defenseGames", "recoveryGames", "punishGames"];
const META_FIELDS = ["schemaVersion", "statsVersion", "generatedAt", "sourceDataset", "sourceUrl", "method", "sample", "provenance"];
const check = (condition, label) => { if (!condition) throw new Error(`Invalid interaction reference: ${label}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function keys(value, expected, label) {
  check(object(value), `${label} must be an object`);
  const actual = Object.keys(value);
  check(actual.length === expected.length && actual.every(key => expected.includes(key)), `${label} privacy allowlist`);
}
function array(value, length, label) {
  check(Array.isArray(value) && (length === null || value.length === length), `${label} length`);
  check(Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean), `${label} extra fields or holes`);
}
function metadata(value) {
  keys(value, META_FIELDS, "metadata");
  check(value.schemaVersion === 1 && count(value.statsVersion), "analysis schema");
  check(typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt)), "generation time");
  check(typeof value.sourceDataset === "string" && /^[a-zA-Z0-9_.-]+$/.test(value.sourceDataset), "source dataset");
  check(value.sourceUrl === "https://replays.nikki.sh/", "source URL");
  check(typeof value.method === "string" && !/[a-z]:[\\/]|\\\\|[A-Za-z0-9]{1,8}#\d{1,4}/i.test(value.method), "method privacy");
  keys(value.sample, ["bundles", "games", "availableGames", "proPlayers"], "sample");
  check(Object.values(value.sample).every(count) && value.sample.games <= value.sample.availableGames, "sample counts");
  const provenance = value.provenance;
  keys(provenance, ["parserSha256", "populationSha256", "sourceAuditSha256", "identityEvidenceSha256", "archives", "perBundle", "counts", "cohortPlayerGames"], "provenance");
  for (const field of ["parserSha256", "populationSha256", "sourceAuditSha256", "identityEvidenceSha256"]) check(sha(provenance[field]), field);
  check(count(provenance.perBundle) && provenance.perBundle > 0, "per-bundle cap");
  keys(provenance.cohortPlayerGames, COHORTS, "cohort totals");
  check(Object.values(provenance.cohortPlayerGames).every(count), "cohort counts");
  array(provenance.archives, value.sample.bundles, "source archives");
  const archives = new Set();
  for (const source of provenance.archives) {
    keys(source, ["bundle", "sha256"], "archive");
    check(typeof source.bundle === "string" && /^[^/\\]+\.(?:7z|zip)$/i.test(source.bundle) && !archives.has(source.bundle) && sha(source.sha256), "archive identity");
    archives.add(source.bundle);
  }
  array(provenance.counts, value.sample.bundles, "bundle counts");
  const counted = new Set();
  for (const item of provenance.counts) {
    keys(item, ["bundle", "availableVenueGames", "availableTournamentGames", "sampledVenueGames", "sampledTournamentGames"], "bundle sample");
    check(archives.has(item.bundle) && !counted.has(item.bundle), "bundle membership"); counted.add(item.bundle);
    check(Object.entries(item).every(([key, val]) => key === "bundle" || count(val)), "bundle sample counts");
    check(item.availableTournamentGames <= item.availableVenueGames
      && item.sampledVenueGames === Math.min(provenance.perBundle, item.availableVenueGames)
      && item.sampledTournamentGames === Math.min(provenance.perBundle, item.availableTournamentGames), "bundle sample cap");
  }
}
function counter(value, family) {
  keys(value, FIELDS[family], `${family} counter`);
  for (const [field, val] of Object.entries(value)) check(field === "damage" ? number(val) : count(val), `${family} counter value`);
  if (family === "recoveries") {
    check(value.attempts === value.returned + value.died + value.incomplete && value.reachedLedge <= value.attempts, "recovery partition");
  } else if (family === "edgeguards") {
    check(value.opportunities === value.stocksTaken + value.opponentReturned + value.uncontestedDeaths + value.incomplete
      && value.completedContests <= value.contested && value.contested <= value.opportunities
      && value.completedContests <= value.opportunities - value.incomplete && value.stocksTaken <= value.completedContests, "edgeguard partition");
  } else if (family === "beforeOpening") {
    check(value.incomplete <= value.openings && value.kills <= value.openings - value.incomplete, "opening partition");
  } else check(value.attempts === value.punished + value.hit + value.traded + value.noHit + value.incomplete, "defensive partition");
}
function rawData(value) {
  keys(value, [...META_FIELDS, "rows"], "artifact");
  const { rows, ...meta } = value;
  metadata(meta); array(rows, null, "rows");
  const seen = new Set(), totals = Object.fromEntries(COHORTS.map(cohort => [cohort, 0]));
  for (const row of rows) {
    keys(row, [...DIMENSIONS, ...FAMILIES], "row");
    check(COHORTS.includes(row.cohort), "cohort");
    check(DIMENSIONS.slice(1).every(field => count(row[field])) && row.characterId < 26 && row.opponentCharacterId < 26
      && [2, 3, 8, 28, 31, 32].includes(row.stageId) && row.games > 0, "row dimensions");
    check(row.defenseGames <= row.games && row.recoveryGames <= row.games && row.punishGames <= row.games, "row coverage");
    const cell = DIMENSIONS.slice(0, 4).map(field => row[field]).join("|");
    check(!seen.has(cell), "duplicate exact cell"); seen.add(cell); totals[row.cohort] += row.games;
    for (const family of FAMILIES) {
      check(object(row[family]), `${family} map`);
      const coverage = family === "beforeOpening" ? row.punishGames : ["recoveries", "edgeguards"].includes(family) ? row.recoveryGames : row.defenseGames;
      for (const [option, value] of Object.entries(row[family])) {
        check(INTERACTION_CODEC_OPTIONS[family].includes(option), `${family} option privacy allowlist`);
        counter(value, family);
        check(coverage > 0 || Object.values(value).every(n => n === 0), "unmeasured observations");
      }
    }
  }
  check(COHORTS.every(cohort => count(totals[cohort]) && totals[cohort] <= meta.sample.games * 2
    && totals[cohort] === meta.provenance.cohortPlayerGames[cohort]), "cohort totals");
  return value;
}

/** Encode only validated public fields. The source data is never mutated. */
export function encodeInteractionBenchmarks(value) {
  rawData(value);
  const { rows, ...metadata } = value;
  const options = Object.fromEntries(FAMILIES.map(family => [family, [...new Set(rows.flatMap(row => Object.keys(row[family])))].sort()]));
  return { encoding: "ssbm-interactions", encodingVersion: 1, metadata, options,
    rows: rows.map(row => [COHORTS.indexOf(row.cohort), ...DIMENSIONS.slice(1).map(field => row[field]),
      ...FAMILIES.map(family => Object.entries(row[family]).map(([option, counts]) =>
        [options[family].indexOf(option), ...FIELDS[family].map(field => counts[field])]))]) };
}

/** Decode the compact format, or validate the original schema during migration. */
export function decodeInteractionBenchmarks(value) {
  if (!object(value) || !Object.hasOwn(value, "encoding")) return rawData(value);
  keys(value, ["encoding", "encodingVersion", "metadata", "options", "rows"], "compact envelope");
  check(value.encoding === "ssbm-interactions" && value.encodingVersion === 1, "encoding version");
  metadata(value.metadata); keys(value.options, FAMILIES, "option dictionaries");
  for (const family of FAMILIES) {
    const options = value.options[family]; array(options, null, `${family} dictionary`);
    check(new Set(options).size === options.length && options.every(option => INTERACTION_CODEC_OPTIONS[family].includes(option)), `${family} dictionary privacy allowlist`);
  }
  array(value.rows, null, "compact rows");
  const rows = value.rows.map(packed => {
    array(packed, DIMENSIONS.length + FAMILIES.length, "compact row");
    check(count(packed[0]) && packed[0] < COHORTS.length, "cohort index");
    const row = Object.fromEntries(DIMENSIONS.map((field, i) => [field, i === 0 ? COHORTS[packed[0]] : packed[i]]));
    FAMILIES.forEach((family, i) => {
      const bucket = packed[DIMENSIONS.length + i]; array(bucket, null, `${family} bucket`);
      const seen = new Set(); row[family] = {};
      for (const item of bucket) {
        array(item, FIELDS[family].length + 1, `${family} entry`);
        check(count(item[0]) && item[0] < value.options[family].length && !seen.has(item[0]), `${family} option index`);
        seen.add(item[0]);
        row[family][value.options[family][item[0]]] = Object.fromEntries(FIELDS[family].map((field, index) => [field, item[index + 1]]));
      }
    });
    return row;
  });
  return rawData({ ...value.metadata, rows });
}
