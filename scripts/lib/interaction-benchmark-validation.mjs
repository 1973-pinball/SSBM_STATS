import assert from "node:assert/strict";

const cStickFields = ["cStickInputs", "cStickSamples"];
const fields = {
  ledge: ["attempts", "punished", "hit", "traded", "noHit", "incomplete"],
  oos: ["attempts", "punished", "hit", "traded", "noHit", "incomplete", ...cStickFields],
  shieldExits: ["attempts", "punished", "hit", "traded", "noHit", "incomplete", ...cStickFields],
  recoveries: ["attempts", "reachedLedge", "hitDuringRecovery", "returned", "died", "incomplete"],
  edgeguards: ["opportunities", "contested", "completedContests", "stocksTaken", "opponentReturned", "uncontestedDeaths", "incomplete"],
  beforeOpening: ["openings", "damage", "kills", "incomplete"],
};
export const INTERACTION_FAMILIES = Object.keys(fields);
const cohorts = ["venue", "tournament", "pro"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const keys = (value, expected, label) => {
  assert.ok(object(value), `${label}: expected an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label}: unexpected or missing fields (privacy allowlist)`);
};

/** Run after schema validation on decoded data. Option keys such as "grab"
 * are public categories, even when a player's public ID happens to match. */
export function assertNoInteractionIdentityValues(data, identities) {
  const strings = new Set();
  const visit = value => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) Object.values(value).forEach(visit);
  };
  visit(data);
  for (const id of identities) assert.ok(!strings.has(id), "replay or player identity in shipped artifact value");
}

/** Strict publication allowlists reject private fields anywhere in the shipped hierarchy. */
export function validateShippedInteractionSample(data, { statsVersion, optionKeys, requireNonempty = true }) {
  keys(data, ["schemaVersion", "statsVersion", "generatedAt", "sourceDataset", "sourceUrl", "method", "sample", "provenance", "rows"], "artifact");
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.statsVersion, statsVersion);
  assert.ok(Number.isFinite(Date.parse(data.generatedAt)), "valid generation timestamp");
  assert.match(data.sourceDataset, /^[a-zA-Z0-9_.-]+$/, "source version cannot contain a local path or private identifier");
  assert.equal(data.sourceUrl, "https://replays.nikki.sh/");
  assert.equal(typeof data.method, "string");
  assert.ok(!/[a-z]:[\\/]|\\\\|[A-Za-z0-9]{1,8}#\d{1,4}/i.test(data.method), "method cannot contain machine paths or connect codes");
  keys(data.sample, ["bundles", "games", "availableGames", "proPlayers"], "sample");
  for (const value of Object.values(data.sample)) assert.ok(integer(value));
  assert.ok(data.sample.games <= data.sample.availableGames);
  keys(data.provenance, ["parserSha256", "populationSha256", "sourceAuditSha256", "identityEvidenceSha256", "archives", "perBundle", "counts", "cohortPlayerGames"], "provenance");
  for (const field of ["parserSha256", "populationSha256", "sourceAuditSha256", "identityEvidenceSha256"]) assert.ok(sha(data.provenance[field]), field);
  assert.ok(integer(data.provenance.perBundle) && data.provenance.perBundle > 0);
  keys(data.provenance.cohortPlayerGames, cohorts, "cohort totals");
  for (const value of Object.values(data.provenance.cohortPlayerGames)) assert.ok(integer(value));
  assert.equal(data.provenance.archives.length, data.sample.bundles);
  assert.equal(data.provenance.counts.length, data.sample.bundles);
  const archives = new Set();
  for (const archive of data.provenance.archives) {
    keys(archive, ["bundle", "sha256"], "archive provenance");
    assert.match(archive.bundle, /^[^/\\]+\.(?:7z|zip)$/i);
    assert.ok(sha(archive.sha256));
    assert.ok(!archives.has(archive.bundle), "duplicate archive provenance");
    archives.add(archive.bundle);
  }
  const counted = new Set();
  for (const item of data.provenance.counts) {
    keys(item, ["bundle", "availableVenueGames", "availableTournamentGames", "sampledVenueGames", "sampledTournamentGames"], "bundle counts");
    assert.ok(archives.has(item.bundle) && !counted.has(item.bundle)); counted.add(item.bundle);
    for (const [key, value] of Object.entries(item)) if (key !== "bundle") assert.ok(integer(value));
    assert.ok(item.availableTournamentGames <= item.availableVenueGames);
    assert.equal(item.sampledVenueGames, Math.min(data.provenance.perBundle, item.availableVenueGames));
    assert.equal(item.sampledTournamentGames, Math.min(data.provenance.perBundle, item.availableTournamentGames));
  }
  assert.ok(Array.isArray(data.rows));
  if (requireNonempty) assert.ok(data.rows.length > 0 && data.sample.games > 0, "shipped benchmark must contain analyzed observations");
  const exact = new Set(), totals = Object.fromEntries(cohorts.map(cohort => [cohort, 0]));
  for (const row of data.rows) {
    keys(row, ["cohort", "characterId", "opponentCharacterId", "stageId", "games", "defenseGames", "recoveryGames", "punishGames", ...INTERACTION_FAMILIES], "rollup");
    assert.ok(cohorts.includes(row.cohort));
    assert.ok(integer(row.characterId) && row.characterId < 26 && integer(row.opponentCharacterId) && row.opponentCharacterId < 26);
    assert.ok([2, 3, 8, 28, 31, 32].includes(row.stageId));
    const key = [row.cohort, row.characterId, row.opponentCharacterId, row.stageId].join("|");
    assert.ok(!exact.has(key), "duplicate exact character/opponent/stage cell"); exact.add(key);
    assert.ok(integer(row.games) && row.games > 0);
    for (const field of ["defenseGames", "recoveryGames", "punishGames"]) assert.ok(integer(row[field]) && row[field] <= row.games);
    totals[row.cohort] += row.games;
    for (const family of INTERACTION_FAMILIES) {
      assert.ok(object(row[family]));
      const coverage = family === "beforeOpening" ? row.punishGames : ["recoveries", "edgeguards"].includes(family) ? row.recoveryGames : row.defenseGames;
      for (const [option, values] of Object.entries(row[family])) {
        assert.ok(optionKeys[family].includes(option), `${family}: unexpected option key`);
        const optionalInputs = family === "oos" || family === "shieldExits";
        const hasInputSamples = object(values) && cStickFields.some(field => Object.hasOwn(values, field));
        keys(values, fields[family].filter(field => !optionalInputs || !cStickFields.includes(field) || hasInputSamples), `${family} counters`);
        for (const [counter, value] of Object.entries(values)) assert.ok(counter === "damage" ? Number.isFinite(value) && value >= 0 : integer(value));
        assert.ok(coverage > 0 || Object.values(values).every(value => value === 0), "unmeasured games cannot supply observations");
        if (family === "recoveries") {
          assert.equal(values.attempts, values.returned + values.died + values.incomplete);
          assert.ok(values.reachedLedge <= values.attempts);
          assert.ok(values.hitDuringRecovery <= values.attempts);
        } else if (family === "edgeguards") {
          assert.equal(values.opportunities, values.stocksTaken + values.opponentReturned + values.uncontestedDeaths + values.incomplete);
          assert.ok(values.completedContests <= values.contested && values.contested <= values.opportunities);
          assert.ok(values.completedContests <= values.opportunities - values.incomplete && values.stocksTaken <= values.completedContests);
        } else if (family === "beforeOpening") {
          assert.ok(values.incomplete <= values.openings && values.kills <= values.openings - values.incomplete);
        } else {
          assert.equal(values.attempts, values.punished + values.hit + values.traded + values.noHit + values.incomplete);
          if (optionalInputs && hasInputSamples) assert.ok(values.cStickInputs <= values.cStickSamples && values.cStickSamples <= values.attempts);
        }
      }
    }
  }
  assert.deepEqual(totals, data.provenance.cohortPlayerGames, "published cohort totals must reconcile with exact cells");
  assert.ok(totals.venue <= data.sample.games * 2 && totals.tournament <= data.sample.games * 2 && totals.pro <= data.sample.games * 2);
  if (requireNonempty) for (const cohort of cohorts) assert.ok(totals[cohort] > 0, `${cohort} sample is empty`);
  return totals;
}
