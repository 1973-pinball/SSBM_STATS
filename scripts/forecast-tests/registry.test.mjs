import test from "node:test";
import assert from "node:assert/strict";
import { buildRegistry, majorId, normalizeEventSlug, attachMajor } from "../lib/forecast/registry.mjs";

const major = { name: "Fixture Major", year: 2025, date: "2025-06-08", tier: "major", winner: "Fixture A" };
const snapshot = { asOf: "2025-06-10", majors: [major, { ...major, name: "Online Fixture", online: true }] };
const mapping = {
  majorName: major.name, year: major.year, eventSlug: "tournament/fixture/event/melee-singles",
  confidence: "verified", eventId: 10, tournamentId: 20,
  evidenceUrl: "https://www.start.gg/tournament/fixture/event/melee-singles", notes: "Synthetic test fixture, not a real event.",
};
const registry = () => buildRegistry(snapshot, { schemaVersion: 1, mappings: [mapping] });
const bundle = () => ({ event: {
  id: 10, slug: mapping.eventSlug, startAt: Date.parse("2025-06-07T12:00:00Z") / 1000,
  tournament: { id: 20, isOnline: false }, videogame: { id: 1 }, teamRosterSize: null, entrantSizeMin: 1,
} });

test("registry is stable, preserves online exclusions and end-date precision", () => {
  const result = registry();
  assert.deepEqual(result.counts, { total: 2, offline: 1, excludedOnline: 1, verifiedOffline: 1, candidateOffline: 0, unmappedOffline: 0 });
  assert.equal(majorId(major), majorId({ ...major, date: "2025-06-09" }));
  assert.equal(result.events.find((e) => e.name === major.name).datePrecision, "day");
  assert.deepEqual(result, buildRegistry({ ...snapshot, majors: [...snapshot.majors].reverse() }, { schemaVersion: 1, mappings: [mapping] }));
});

test("registry never silently accepts ambiguous or nonexistent mappings", () => {
  assert.throws(() => buildRegistry(snapshot, { schemaVersion: 1, mappings: [mapping, mapping] }), /Multiple mappings/);
  assert.throws(() => buildRegistry(snapshot, { schemaVersion: 1, mappings: [{ ...mapping, year: 2024 }] }), /unknown major/);
  assert.throws(() => buildRegistry(snapshot, { schemaVersion: 1, mappings: [{ ...mapping, eventId: null }] }), /Verified mappings require/);
  assert.throws(() => buildRegistry({ majors: [major, major] }), /Duplicate major/);
  assert.throws(() => buildRegistry(snapshot, { schemaVersion: 1, mappings: [mapping, { ...mapping, majorName: "Online Fixture" }] }), /multiple majors/);
});

test("exact event slugs accepted but foreign and ambiguous URLs rejected", () => {
  assert.equal(normalizeEventSlug(`${mapping.evidenceUrl}/overview/`), mapping.eventSlug);
  for (const url of ["https://evil.test/tournament/a/event/b", "https://start.gg@evil.test/tournament/a/event/b", "tournament/a", "https://start.gg/tournament/a/event/b?token=secret"]) {
    assert.throws(() => normalizeEventSlug(url));
  }
});

test("major attachment validates source IDs, year, date and format without mutation", () => {
  const raw = bundle();
  assert.equal(attachMajor(raw, registry()).major.name, major.name);
  assert.equal(raw.major, undefined);
  for (const patch of [
    { id: 11 }, { videogame: { id: 1386 } }, { isOnline: true },
    { teamRosterSize: { minPlayers: 2, maxPlayers: 2 } }, { startAt: null },
    { entrantSizeMin: 2 }, { entrantSizeMin: undefined }, { tournament: { id: 20 } },
    { startAt: Date.parse("2024-06-07T12:00:00Z") / 1000 },
    { startAt: Date.parse("2025-01-07T12:00:00Z") / 1000 },
  ]) assert.throws(() => attachMajor({ event: { ...raw.event, ...patch } }, registry()));
  const candidate = buildRegistry(snapshot, { schemaVersion: 1, mappings: [{ ...mapping, confidence: "candidate" }] });
  assert.throws(() => attachMajor(raw, candidate), /No verified/);
});
