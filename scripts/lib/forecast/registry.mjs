import { createHash } from "node:crypto";

export const LIQUIPEDIA_SOURCE = "https://liquipedia.net/smash/Major_Tournaments/Melee";
const byId = (a, b) => a.id.localeCompare(b.id, "en");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Name+year is the bundled snapshot's identity, NOT the date (which can be corrected).
export function majorId(major) {
  return `liquipedia:major:${hash(JSON.stringify([major.name, major.year])).slice(0, 20)}`;
}

export function normalizeEventSlug(value) {
  if (typeof value !== "string") throw new Error("An exact Start.gg event slug is required");
  let slug = value.trim();
  if (/^https?:/i.test(slug)) {
    const url = new URL(slug);
    if (url.protocol !== "https:" || !["start.gg", "www.start.gg"].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) {
      throw new Error("Use an HTTPS Start.gg event URL without credentials or query parameters");
    }
    slug = url.pathname;
  }
  slug = slug.replace(/^\/+|\/+$/g, "").replace(/\/(overview|details)$/, "");
  if (!/^tournament\/[a-zA-Z0-9_-]+\/event\/[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error("Expected tournament/<tournament>/event/<event>, not a tournament-only URL");
  }
  return slug;
}

function numericId(value, label) {
  if (!/^[1-9]\d*$/.test(String(value ?? ""))) throw new Error(`${label} must be a positive source ID`);
  return String(value);
}

function validateMapping(mapping) {
  const confidence = mapping.confidence;
  if (!["candidate", "verified"].includes(confidence)) throw new Error("Mapping confidence must be candidate or verified");
  const eventSlug = normalizeEventSlug(mapping.eventSlug);
  const evidence = new URL(mapping.evidenceUrl);
  if (evidence.protocol !== "https:" || evidence.username || evidence.password) throw new Error("Mapping evidence must be an HTTPS source URL");
  const eventId = mapping.eventId == null ? null : numericId(mapping.eventId, "eventId");
  const tournamentId = mapping.tournamentId == null ? null : numericId(mapping.tournamentId, "tournamentId");
  if (confidence === "verified" && (!eventId || !tournamentId || !mapping.notes?.trim())) {
    throw new Error("Verified mappings require eventId, tournamentId, and verification notes");
  }
  return { eventSlug, eventId, tournamentId, confidence, evidenceUrl: evidence.href, notes: mapping.notes ?? "" };
}

export function buildRegistry(snapshot, mappingFile = { schemaVersion: 1, mappings: [] }) {
  if (!Array.isArray(snapshot?.majors) || !snapshot.majors.length) throw new Error("The Liquipedia snapshot has no majors");
  if (mappingFile.schemaVersion !== 1 || !Array.isArray(mappingFile.mappings)) throw new Error("Unsupported mapping file schema");
  const entries = new Map();
  for (const major of snapshot.majors) {
    if (!major.name || !Number.isInteger(major.year) || !["major", "supermajor"].includes(major.tier)) {
      throw new Error("Invalid major in Liquipedia snapshot");
    }
    const id = majorId(major);
    if (entries.has(id)) throw new Error(`Duplicate major name/year: ${major.name} ${major.year}`);
    entries.set(id, {
      id, name: major.name, year: major.year, tier: major.tier, format: "singles",
      online: major.online === true, eligible: major.online !== true,
      liquipediaEndDate: major.date ?? null,
      datePrecision: /^\d{4}-\d{2}-\d{2}$/.test(major.date) ? "day" : /^\d{4}-\d{2}$/.test(major.date) ? "month" : "unknown",
      // Keep historical outcomes labelled; they are NOT pre-event predictors.
      historicalOutcome: { winner: major.winner, runnerUp: major.runnerUp ?? null },
      sources: [{ provider: "liquipedia", url: LIQUIPEDIA_SOURCE, snapshotAsOf: snapshot.asOf ?? null }],
      mappingStatus: "unmapped", startgg: null,
    });
  }
  const mapped = new Set();
  const usedSlugs = new Set();
  const usedEvents = new Set();
  for (const mapping of mappingFile.mappings) {
    const id = majorId({ name: mapping.majorName, year: mapping.year });
    const entry = entries.get(id);
    if (!entry) throw new Error(`Mapping refers to an unknown major: ${mapping.majorName} ${mapping.year}`);
    if (mapped.has(id)) throw new Error(`Multiple mappings for ${entry.name}`);
    const startgg = validateMapping(mapping);
    if (usedSlugs.has(startgg.eventSlug) || (startgg.eventId && usedEvents.has(startgg.eventId))) {
      throw new Error(`Start.gg event mapped to multiple majors: ${startgg.eventSlug}`);
    }
    mapped.add(id); usedSlugs.add(startgg.eventSlug);
    if (startgg.eventId) usedEvents.add(startgg.eventId);
    entry.startgg = startgg;
    entry.mappingStatus = startgg.confidence;
  }
  const events = [...entries.values()].sort(byId);
  return {
    schemaVersion: 1, snapshotAsOf: snapshot.asOf ?? null,
    license: { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/", attribution: "Liquipedia contributors", source: LIQUIPEDIA_SOURCE },
    counts: {
      total: events.length, offline: events.filter((e) => e.eligible).length,
      excludedOnline: events.filter((e) => !e.eligible).length,
      verifiedOffline: events.filter((e) => e.eligible && e.mappingStatus === "verified").length,
      candidateOffline: events.filter((e) => e.eligible && e.mappingStatus === "candidate").length,
      unmappedOffline: events.filter((e) => e.eligible && e.mappingStatus === "unmapped").length,
    },
    events,
  };
}

// A reviewed slug alone is insufficient: validate downloaded source metadata too.
// Liquipedia records an END date; never use that as a pre-event training cutoff.
export function attachMajor(bundle, registry) {
  const event = bundle?.event;
  const slug = normalizeEventSlug(event?.slug);
  const entry = registry.events.find((row) => row.startgg?.eventSlug === slug);
  if (!entry || entry.mappingStatus !== "verified") throw new Error(`No verified major mapping for ${slug}`);
  if (!entry.eligible) throw new Error(`Online major is excluded: ${entry.name}`);
  if (String(event.id) !== entry.startgg.eventId || String(event.tournament?.id) !== entry.startgg.tournamentId) {
    throw new Error(`Source IDs disagree with verified mapping for ${entry.name}`);
  }
  if (String(event.videogame?.id) !== "1") throw new Error(`Mapped event is not Melee: ${slug}`);
  if (event.isOnline === true || event.tournament?.isOnline === true) throw new Error(`Mapped event is online: ${slug}`);
  if (event.isOnline !== false && event.tournament?.isOnline !== false) throw new Error(`Mapped event has unknown venue type: ${slug}`);
  const min = event.teamRosterSize?.minPlayers ?? event.entrantSizeMin;
  const max = event.teamRosterSize?.maxPlayers;
  if (min !== 1 || (max != null && max !== 1) || (event.entrantSizeMin != null && event.entrantSizeMin !== 1)) {
    throw new Error(`Mapped event is not singles: ${slug}`);
  }
  if (!Number.isFinite(event.startAt) || event.startAt <= 0) throw new Error(`Missing precise event start time: ${slug}`);
  const start = new Date(event.startAt * 1000);
  if (start.getUTCFullYear() !== entry.year) throw new Error(`Event year disagrees with ${entry.name}`);
  if (entry.datePrecision === "day") {
    const endDay = Date.parse(`${entry.liquipediaEndDate}T00:00:00Z`);
    // Time zones and multi-day pools can differ; grossly wrong mappings fail.
    const days = (endDay - start.getTime()) / 86_400_000;
    if (days < -2 || days > 14) throw new Error(`Event date disagrees with ${entry.name}`);
  } else if (entry.datePrecision === "month" && start.toISOString().slice(0, 7) !== entry.liquipediaEndDate) {
    throw new Error(`Event month disagrees with ${entry.name}`);
  }
  return { ...bundle, major: entry };
}
