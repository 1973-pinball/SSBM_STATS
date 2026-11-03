import assert from "node:assert/strict";

export const strictProAlias = value => typeof value === "string" && value.trim()
  ? value.trim().normalize("NFKC").toLocaleLowerCase("en-US") : null;

/** Supplemental aliases require reviewed public event evidence and a global rank. */
export function compileReviewedProRegistry(registry, rankings, eventIds) {
  assert.equal(registry.schemaVersion, 1);
  assert.match(registry.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(registry.overrides) && registry.overrides.length > 0);
  const ranked = new Set(rankings.filter(row => ["SSBMRank", "MPGR"].includes(row.ranking_series)
    && Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= 100
    && /^https:\/\//.test(row.source_url ?? "")).map(row => row.player_id));
  const aliases = new Map();
  for (const group of registry.overrides) {
    assert.equal(group.kind, "event_aliases", "Only explicitly reviewed event labels are supported");
    assert.ok(eventIds.has(group.eventId), `Unknown reviewed event ${group.eventId}`);
    assert.equal(group.resolution, "probable", "Attendance and label evidence cannot claim verified replay identity");
    assert.ok(/^https:\/\//.test(group.sourceUrl ?? ""), "Public event evidence is required");
    assert.ok(Array.isArray(group.aliases) && group.aliases.length > 0);
    for (const row of group.aliases) {
      assert.ok(ranked.has(row.playerId), `Global Top 100 ranking evidence is required for ${row.playerId}`);
      const alias = strictProAlias(row.observedAlias);
      assert.ok(alias, "Reviewed aliases cannot be empty");
      const key = `${group.eventId}|${alias}`;
      assert.ok(!aliases.has(key), `Duplicate reviewed event alias ${key}`);
      aliases.set(key, { playerId: row.playerId, resolution: group.resolution, sourceUrl: group.sourceUrl });
    }
  }
  return aliases;
}

/** Every matching public label must agree; private connect codes are never used. */
export function resolveReviewedProIdentity(aliases, eventId, player) {
  const matches = [player.displayName, player.nametag].map(strictProAlias).filter(Boolean)
    .map(alias => aliases.get(`${eventId}|${alias}`)).filter(Boolean);
  assert.ok(new Set(matches.map(match => match.playerId)).size <= 1,
    "Conflicting reviewed display-name and controller-tag identities");
  return matches[0] ?? null;
}

/** The supplemental review authorizes existing conservative singles only. */
export function resolveArchiveProIdentity({ legacyIdentity, aliases, eventId, player, format, tier }) {
  const supplemental = format === "singles" && ["verified", "probable"].includes(tier)
    ? resolveReviewedProIdentity(aliases, eventId, player) : null;
  assert.ok(!legacyIdentity || !supplemental || legacyIdentity.playerId === supplemental.playerId,
    "Conflicting legacy and supplemental Pro identities");
  // Preserve the explicitly reviewed legacy exception for regionally ranked Ampp,
  // and retain stronger exact-set evidence when the same identity is repeated.
  return legacyIdentity ?? supplemental;
}

export function assertDistinctSinglesIdentities(identities, format) {
  if (format !== "singles") return;
  const named = identities.filter(Boolean).map(identity => identity.playerId);
  assert.equal(new Set(named).size, named.length, "One reviewed player cannot occupy both sides of a singles game");
}
