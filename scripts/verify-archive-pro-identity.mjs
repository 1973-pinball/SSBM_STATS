import assert from "node:assert/strict";
import { compileReviewedProRegistry, resolveArchiveProIdentity, assertDistinctSinglesIdentities } from "./lib/archive-pro-identity.mjs";

const sourceUrl = "https://example.com/event";
const registry = { schemaVersion: 1, reviewedAt: "2026-11-02", overrides: [{
  kind: "event_aliases", eventId: "event", resolution: "probable", sourceUrl,
  aliases: [{ observedAlias: "Player", playerId: "player" }],
}] };
const aliases = compileReviewedProRegistry(registry, [
  { player_id: "player", ranking_series: "SSBMRank", rank: 100, source_url: sourceUrl },
], new Set(["event"]));
const base = { legacyIdentity: null, aliases, eventId: "event", player: { displayName: " PLAYER " }, format: "singles", tier: "probable" };
const resolved = { playerId: "player", resolution: "probable", sourceUrl };
assert.deepEqual(resolveArchiveProIdentity(base), resolved);
for (const tier of ["unclassified", "excluded", null]) {
  assert.equal(resolveArchiveProIdentity({ ...base, tier }), null, "new identities cannot promote tournament membership");
}
assert.equal(resolveArchiveProIdentity({ ...base, format: "doubles" }), null, "singles evidence does not authorize doubles");
assert.equal(resolveArchiveProIdentity({ ...base, eventId: "another" }), null);
assert.equal(resolveArchiveProIdentity({ ...base, player: { connectCode: "PLAYER" } }), null);
const exact = { ...resolved, resolution: "verified", sourceUrl: "https://example.com/exact-set" };
assert.deepEqual(resolveArchiveProIdentity({ ...base, legacyIdentity: exact }), exact, "existing stronger evidence is preserved");
assert.throws(() => resolveArchiveProIdentity({ ...base, legacyIdentity: { ...exact, playerId: "someone-else" } }), /Conflicting/);
const ampp = { playerId: "ampp", resolution: "probable", sourceUrl: "https://example.com/regional" };
assert.deepEqual(resolveArchiveProIdentity({ ...base, player: { displayName: "Ampp" }, legacyIdentity: ampp }), ampp,
  "the explicit legacy regional-ranking exception is retained");
assert.throws(() => assertDistinctSinglesIdentities([resolved, resolved], "singles"), /both sides/);
assertDistinctSinglesIdentities([resolved, null], "singles");
console.log("Archive Pro identity gates passed: conservative singles, event scope, conflicts, legacy evidence, and Ampp.");
