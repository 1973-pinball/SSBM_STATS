const compare = (a, b) => String(a).localeCompare(String(b), "en");
const byId = (a, b) => compare(a.id, b.id);

export const EMPIRICAL_RELIABILITY_BUCKETS = Object.freeze([
  Object.freeze({ lower: 0.5, upper: 0.6, favoriteWinRate: 0.539, n: 724 }),
  Object.freeze({ lower: 0.6, upper: 0.7, favoriteWinRate: 0.659, n: 925 }),
  Object.freeze({ lower: 0.7, upper: 0.8, favoriteWinRate: 0.705, n: 904 }),
  Object.freeze({ lower: 0.8, upper: 0.9, favoriteWinRate: 0.737, n: 1171 }),
  Object.freeze({ lower: 0.9, upper: 1, favoriteWinRate: 0.873, n: 2520 }),
]);

const rows = (value) => Array.isArray(value) ? value : [];
const sourceId = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0
  ? String(value)
  : typeof value === "string" && value.trim() && value.trim() !== "0" ? value.trim() : null;
const canonicalId = (kind, value) => `startgg:${kind}:${value}`;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum ? value : null;
const cleanText = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

function assertBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || bundle.schemaVersion !== 1 || !sourceId(bundle.event?.id)
      || !cleanText(bundle.event?.slug) || !Array.isArray(bundle.entrants) || !Array.isArray(bundle.seeds)
      || !Array.isArray(bundle.sets) || !Array.isArray(bundle.phaseGroups)) {
    throw new Error("A complete raw Start.gg event bundle is required");
  }
  const fetchedAt = cleanText(bundle.provenance?.fetchedAt);
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("Bundle provenance needs a valid fetchedAt timestamp");
}

function uniqueIndex(values, label) {
  const result = new Map();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`Duplicate ${label} ID`);
    result.set(value.id, value);
  }
  return result;
}

function entrantRows(bundle) {
  return rows(bundle.entrants).map((entrant) => {
    const entrantId = sourceId(entrant?.id);
    const participants = rows(entrant?.participants);
    const participant = participants[0];
    const playerId = sourceId(participant?.player?.id);
    const name = cleanText(participant?.gamerTag) ?? cleanText(entrant?.name);
    if (!entrantId || participants.length !== 1 || !playerId || !name) {
      throw new Error("Every upcoming singles entrant needs one public player ID and name");
    }
    return {
      id: entrantId,
      canonicalEntrantId: canonicalId("entrant", entrantId),
      playerId,
      canonicalPlayerId: canonicalId("player", playerId),
      name,
      entrantName: cleanText(entrant?.name) ?? name,
    };
  }).sort(byId);
}

/**
 * Select the one root phase that seeds every downloaded entrant exactly once.
 * A phase reached through another seed's progressionSeedId is never a root.
 */
export function selectRootFullFieldSeedPhase(bundle) {
  assertBundle(bundle);
  const entrants = entrantRows(bundle);
  if (!entrants.length) throw new Error("The upcoming event has no entrants");
  const entrantIds = new Set(entrants.map((entrant) => entrant.id));
  if (entrantIds.size !== entrants.length) throw new Error("Duplicate upcoming entrant ID");

  const normalizedSeeds = rows(bundle.seeds).map((seed) => {
    const id = sourceId(seed?.id);
    const entrantId = sourceId(seed?.entrant?.id ?? seed?.entrantId);
    const phaseId = sourceId(seed?.phase?.id);
    const seedNum = integer(seed?.seedNum, 1);
    if (!id) throw new Error("Every upcoming seed needs a source ID");
    return { id, entrantId, phaseId, seedNum, isBye: seed?.isBye === true,
      progressionSeedId: sourceId(seed?.progressionSeedId), phase: seed?.phase ?? null };
  });
  uniqueIndex(normalizedSeeds, "seed");
  const incoming = new Set(normalizedSeeds.map((seed) => seed.progressionSeedId).filter(Boolean));
  const byPhase = new Map();
  for (const seed of normalizedSeeds) {
    if (!seed.phaseId) continue;
    if (!byPhase.has(seed.phaseId)) byPhase.set(seed.phaseId, []);
    byPhase.get(seed.phaseId).push(seed);
  }
  const candidates = [];
  for (const [phaseId, seeds] of byPhase) {
    if (seeds.length !== entrants.length || seeds.some((seed) => incoming.has(seed.id) || seed.isBye
        || !seed.entrantId || !entrantIds.has(seed.entrantId) || seed.seedNum == null)) continue;
    const seededEntrants = new Set(seeds.map((seed) => seed.entrantId));
    const ranks = new Set(seeds.map((seed) => seed.seedNum));
    if (seededEntrants.size !== entrants.length || ranks.size !== entrants.length
        || [...ranks].some((rank) => rank < 1 || rank > entrants.length)) continue;
    const eventPhase = rows(bundle.event.phases).find((phase) => sourceId(phase?.id) === phaseId);
    candidates.push({
      phaseId,
      phaseName: cleanText(eventPhase?.name) ?? cleanText(seeds[0]?.phase?.name) ?? `Phase ${phaseId}`,
      phaseOrder: integer(eventPhase?.phaseOrder, 0) ?? integer(seeds[0]?.phase?.phaseOrder, 0),
      entrantCount: entrants.length,
      seeds: [...seeds].sort((a, b) => a.seedNum - b.seedNum || compare(a.id, b.id))
        .map(({ id, entrantId, seedNum }) => ({ id, entrantId, seedNum })),
    });
  }
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? "Upcoming event has multiple root full-field seed phases"
      : "Upcoming event has no unique root full-field seed phase");
  }
  return candidates[0];
}

function groupPhaseIndex(bundle) {
  const groups = rows(bundle.phaseGroups).map((group) => {
    const id = sourceId(group?.id);
    const phaseId = sourceId(group?.phase?.id);
    if (!id || !phaseId) throw new Error("Every phase group needs source and phase IDs");
    const eventPhase = rows(bundle.event.phases).find((phase) => sourceId(phase?.id) === phaseId);
    return {
      id, phaseId, displayIdentifier: cleanText(group?.displayIdentifier),
      phaseName: cleanText(eventPhase?.name) ?? cleanText(group?.phase?.name) ?? `Phase ${phaseId}`,
      phaseOrder: integer(eventPhase?.phaseOrder, 0) ?? integer(group?.phase?.phaseOrder, 0),
    };
  });
  return uniqueIndex(groups, "phase group");
}

function setMetadata(bundle, set, group, setId) {
  const eventId = sourceId(bundle.event.id);
  return {
    setId,
    canonicalSetId: canonicalId("set", setId),
    eventId,
    canonicalEventId: canonicalId("event", eventId),
    phaseId: group?.phaseId ?? null,
    phaseName: group?.phaseName ?? "Phase not reported",
    phaseOrder: group?.phaseOrder ?? null,
    phaseGroupId: group?.id ?? sourceId(set?.phaseGroup?.id),
    phaseGroupName: cleanText(set?.phaseGroup?.displayIdentifier)
      ?? group?.displayIdentifier ?? sourceId(set?.phaseGroup?.id) ?? "Group not reported",
    round: Number.isSafeInteger(set?.round) ? set.round : null,
    roundName: cleanText(set?.fullRoundText) ?? "Round not reported",
    identifier: cleanText(set?.identifier),
    startAt: Number.isFinite(set?.startAt) && set.startAt > 0 ? set.startAt : null,
  };
}

function setEntrantIds(set) {
  const ids = rows(set?.slots).map((slot) => sourceId(slot?.entrant?.id)).filter(Boolean);
  return ids.length >= 1 && ids.length <= 2 && new Set(ids).size === ids.length ? ids : null;
}

function resolveSlot({ slot, setId, group, root, rootSeeds, rootSeedByEntrant, entrants, sets }) {
  const prerequisiteType = slot?.prereqType;
  const prerequisiteId = sourceId(slot?.prereqId);
  const populatedEntrantId = sourceId(slot?.entrant?.id);
  const origin = { prerequisiteType: prerequisiteType ?? null, prerequisiteId,
    prerequisitePlacement: integer(slot?.prereqPlacement, 1), populatedEntrantId };
  if (prerequisiteType === "bye") return { ...origin, resolution: "bye", entrant: null };
  if (prerequisiteType === "seed") {
    if (!prerequisiteId) return { ...origin, resolution: "invalid", reason: "missing_seed_prerequisite", entrant: null };
    const seed = rootSeeds.get(prerequisiteId);
    // Only the selected root phase is a direct pre-event source. Seeds in
    // later phases can be projections reached through opaque progression links.
    if (!seed || group?.phaseId !== root.phaseId) {
      return { ...origin, resolution: "unresolved", reason: "later_phase_seed_projection", entrant: null };
    }
    const entrant = entrants.get(seed.entrantId);
    if (!entrant || populatedEntrantId !== entrant.id) {
      return { ...origin, resolution: "invalid", reason: "seed_entrant_mismatch", entrant: null };
    }
    return { ...origin, resolution: "resolved", reason: null,
      entrant: { ...entrant, seedNum: seed.seedNum }, originLabel: `Seed ${seed.seedNum}` };
  }
  if (prerequisiteType === "set") {
    if (!prerequisiteId || prerequisiteId === setId || !sets.has(prerequisiteId)) {
      return { ...origin, resolution: "invalid", reason: "missing_or_self_set_prerequisite", entrant: null };
    }
    const prerequisite = sets.get(prerequisiteId);
    if (prerequisite.state !== 3) {
      return { ...origin, resolution: "unresolved", reason: "prerequisite_set_incomplete", entrant: null,
        originLabel: `${origin.prerequisitePlacement === 2 ? "Loser" : "Winner"} of ${prerequisiteId}` };
    }
    const prerequisiteEntrants = setEntrantIds(prerequisite);
    const winnerId = sourceId(prerequisite.winnerId);
    if (!prerequisiteEntrants || !winnerId || !prerequisiteEntrants.includes(winnerId)
        || ![1, 2].includes(origin.prerequisitePlacement)
        || (origin.prerequisitePlacement === 2 && prerequisiteEntrants.length !== 2)) {
      return { ...origin, resolution: "invalid", reason: "invalid_completed_prerequisite_result", entrant: null };
    }
    const resolvedId = origin.prerequisitePlacement === 1
      ? winnerId : prerequisiteEntrants.find((entrantId) => entrantId !== winnerId);
    const entrant = entrants.get(resolvedId);
    if (!entrant || populatedEntrantId && populatedEntrantId !== entrant.id) {
      return { ...origin, resolution: "invalid", reason: "prerequisite_entrant_mismatch", entrant: null };
    }
    const rootSeed = rootSeedByEntrant.get(entrant.id);
    if (!rootSeed) return { ...origin, resolution: "invalid", reason: "resolved_entrant_has_no_root_seed", entrant: null };
    return { ...origin, resolution: "resolved", reason: null,
      entrant: { ...entrant, seedNum: rootSeed.seedNum },
      originLabel: `${origin.prerequisitePlacement === 1 ? "Winner" : "Loser"} of ${prerequisiteId}` };
  }
  return { ...origin, resolution: "invalid", reason: "unsupported_prerequisite_type", entrant: null };
}

const bracketSort = (a, b) => (a.phaseOrder ?? Number.MAX_SAFE_INTEGER) - (b.phaseOrder ?? Number.MAX_SAFE_INTEGER)
  || compare(a.phaseName, b.phaseName) || compare(a.phaseGroupName, b.phaseGroupName)
  || compare(a.phaseGroupId ?? "", b.phaseGroupId ?? "")
  || compare(a.roundName, b.roundName) || (a.round ?? 0) - (b.round ?? 0)
  || compare(a.identifier ?? "", b.identifier ?? "") || compare(a.setId, b.setId);

/**
 * Account for every source row. Direct root seeds are fixed immediately; a
 * winner/loser feeder becomes fixed only after its referenced set completes.
 */
export function buildFixedRootMatchups(bundle) {
  assertBundle(bundle);
  const root = selectRootFullFieldSeedPhase(bundle);
  const entrants = entrantRows(bundle);
  const entrantIndex = uniqueIndex(entrants, "entrant");
  const rootSeedIndex = uniqueIndex(root.seeds, "root seed");
  const rootSeedByEntrant = new Map(root.seeds.map((seed) => [seed.entrantId, seed]));
  const groupIndex = groupPhaseIndex(bundle);
  const normalizedSets = rows(bundle.sets).map((set) => {
    const id = sourceId(set?.id);
    if (!id) throw new Error("Every bracket set needs a source ID");
    return { ...set, id };
  });
  const setIndex = uniqueIndex(normalizedSets, "bracket set");
  const sourceRows = normalizedSets.map((set) => {
    const setId = set.id;
    const groupId = sourceId(set?.phaseGroup?.id);
    const group = groupId ? groupIndex.get(groupId) : null;
    const metadata = setMetadata(bundle, set, group, setId);
    if (set?.state === 3 && cleanText(set?.displayScore)?.toLowerCase() === "bye") {
      return { ...metadata, status: "bye", reason: "source_auto_advance", slotOrigins: [] };
    }
    if (set?.state === 3) return { ...metadata, status: "completed", slotOrigins: [] };
    // A populated result on a nominally uncompleted row is not a pre-match
    // input. Refuse it instead of allowing current winner information through.
    if (sourceId(set?.winnerId)) return { ...metadata, status: "invalid", reason: "winner_on_uncompleted_set", slotOrigins: [] };
    if (!group) return { ...metadata, status: "invalid", reason: "missing_phase_group", slotOrigins: [] };
    const sourceSlots = rows(set?.slots);
    if (sourceSlots.length !== 2) return { ...metadata, status: "invalid", reason: "not_two_slots", slotOrigins: [] };
    const slotOrigins = sourceSlots.map((slot) => resolveSlot({ slot, setId, group, root,
      rootSeeds: rootSeedIndex, rootSeedByEntrant, entrants: entrantIndex, sets: setIndex }));
    if (slotOrigins.some((slot) => slot.resolution === "invalid")) {
      return { ...metadata, status: "invalid", reason: "invalid_slot", slotOrigins };
    }
    if (slotOrigins.some((slot) => slot.resolution === "bye")) {
      return { ...metadata, status: "bye", reason: null, slotOrigins };
    }
    if (slotOrigins.some((slot) => slot.resolution !== "resolved")) {
      return { ...metadata, status: "unresolved_feeder", reason: null, slotOrigins };
    }
    const resolvedEntrants = slotOrigins.map((slot) => slot.entrant);
    if (resolvedEntrants[0].id === resolvedEntrants[1].id
        || resolvedEntrants[0].playerId === resolvedEntrants[1].playerId) {
      return { ...metadata, status: "invalid", reason: "same_entrant_or_player", slotOrigins };
    }
    return { ...metadata, status: "fixed_matchup", reason: null, slotOrigins,
      entrants: resolvedEntrants };
  }).sort(bracketSort);
  const matches = sourceRows.filter((row) => row.status === "fixed_matchup");
  const directSeedMatches = matches.filter((row) => row.slotOrigins.every(
    (slot) => slot.prerequisiteType === "seed",
  )).length;
  const statusCounts = Object.fromEntries(["fixed_matchup", "unresolved_feeder", "bye", "completed", "invalid"]
    .map((status) => [status, sourceRows.filter((row) => row.status === status).length]));
  return {
    rootPhase: root,
    counts: {
      sourceSets: rows(bundle.sets).length,
      fixedUncompletedMatches: matches.length,
      directSeedMatches,
      resolvedFeederMatches: matches.length - directSeedMatches,
      completedSets: statusCounts.completed,
      unresolvedSets: statusCounts.unresolved_feeder + statusCounts.bye + statusCounts.invalid,
      statuses: statusCounts,
    },
    sourceRows,
    matches,
  };
}

export function empiricalReliability(probability) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Prediction probability must be between zero and one");
  }
  const favoriteProbability = Math.max(probability, 1 - probability);
  const index = Math.min(EMPIRICAL_RELIABILITY_BUCKETS.length - 1,
    Math.floor((favoriteProbability - 0.5) * 10));
  return { favoriteProbability, ...EMPIRICAL_RELIABILITY_BUCKETS[index] };
}

function supportStatus(prediction) {
  const known = integer(prediction.knownPlayers, 0);
  const seed = prediction.seedCovered === true;
  if (known === 2 && seed) return "history + seed";
  if (known === 2) return "history only";
  if (known === 1 && seed) return "partial history + seed";
  if (known === 0 && seed) return "seed only";
  return "limited evidence";
}

function predictionEvidence(prediction, entrants) {
  const parts = [`seeds ${entrants[0].seedNum} vs ${entrants[1].seedNum}`];
  const known = integer(prediction.knownPlayers, 0);
  const form = integer(prediction.formKnownPlayers, 0);
  if (known != null) parts.push(`${known}/2 player histories`);
  if (form != null) parts.push(`${form}/2 recent-form histories`);
  if (Array.isArray(prediction.historySetCounts) && prediction.historySetCounts.length === 2
      && prediction.historySetCounts.every((value) => integer(value, 0) != null)) {
    parts.push(`${prediction.historySetCounts[0]}/${prediction.historySetCounts[1]} prior sets`);
  }
  if (prediction.seedCovered === false) parts.push("seed feature unavailable to model");
  return parts.join("; ");
}

/**
 * Call a fitted model without exposing raw source results. `predict` receives
 * only a canonical pairwise set shell: id, eventId, entrantIds and playerIds.
 */
export function buildUpcomingMatchupReport({
  bundle, predict, model, sourceSha256 = null, historicalDatasetSha256 = null,
  refreshCommand = "npm run forecast -- download --refresh --event " + bundle?.event?.slug,
} = {}) {
  if (typeof predict !== "function") throw new Error("A fitted pairwise predict function is required");
  if (!model || !cleanText(model.id) || !cleanText(model.name)) throw new Error("Model id and name are required");
  const structural = buildFixedRootMatchups(bundle);
  const matches = structural.matches.map((match) => {
    const predictionInput = Object.freeze({
      id: match.canonicalSetId,
      eventId: match.canonicalEventId,
      entrantIds: Object.freeze(match.entrants.map((entrant) => entrant.canonicalEntrantId)),
      playerIds: Object.freeze(match.entrants.map((entrant) => entrant.canonicalPlayerId)),
    });
    const predicted = predict(predictionInput);
    if (!predicted || typeof predicted !== "object" || !Number.isFinite(predicted.p)
        || predicted.p < 0 || predicted.p > 1) throw new Error("Model returned an invalid prediction");
    const prediction = { ...predicted, p: predicted.p };
    const favoriteIndex = prediction.p === 0.5 ? null : prediction.p > 0.5 ? 0 : 1;
    return {
      ...match,
      prediction: {
        ...prediction,
        favoriteIndex,
        favoritePlayerId: favoriteIndex == null ? null : match.entrants[favoriteIndex].canonicalPlayerId,
        favoriteName: favoriteIndex == null ? null : match.entrants[favoriteIndex].name,
        estimatedWinChance: favoriteIndex == null ? 0.5 : Math.max(prediction.p, 1 - prediction.p),
        reliability: empiricalReliability(prediction.p),
        evidence: predictionEvidence(prediction, match.entrants),
        status: supportStatus(prediction),
      },
    };
  });
  return {
    schemaVersion: 1,
    kind: "upcoming-pairwise-matchup-report-v1",
    status: "experimental-not-validated",
    productize: false,
    event: {
      id: sourceId(bundle.event.id), slug: bundle.event.slug,
      name: cleanText(bundle.event.tournament?.name) ?? cleanText(bundle.event.name),
      sourceUrl: `https://www.start.gg/${bundle.event.slug}`,
      state: cleanText(bundle.event.state) ?? String(bundle.event.state ?? "unknown"),
      previewSetRows: rows(bundle.sets).filter((set) => String(set?.id ?? "").startsWith("preview_")).length,
      fetchedAt: new Date(bundle.provenance.fetchedAt).toISOString(),
      sourceSha256,
    },
    generatedAt: new Date(bundle.provenance.fetchedAt).toISOString(),
    historicalDatasetSha256,
    model: { ...model },
    rootPhase: structural.rootPhase,
    counts: structural.counts,
    sourceRows: structural.sourceRows,
    matches,
    refreshCommand,
    caveats: [
      "Estimated win chance is a conditional set probability, not a statistical confidence interval.",
      "Empirical reliability is descriptive held-out accuracy for predictions in the same strength bucket, not an event-adjusted uncertainty interval.",
      "The reliability buckets contain 6,244 held-out sets from five selected 2025 majors; they are not Riptide-specific guarantees.",
      "Historical seed availability is assumed because those archived seed snapshots were fetched after their events.",
      "Direct seeds are fixed only in the selected root phase; winner/loser feeders become fixed only after their referenced sets complete with a valid result.",
      "Unresolved feeders, later-phase seed projections, byes and completed sets receive no new pre-event prediction.",
      "This report does not estimate title or top-eight probabilities and does not fill later rounds with chalk.",
      "Start.gg brackets and registrations can change after this source snapshot; refresh before relying on it.",
      "The complete bundle reconciles all paginated rows, but Start.gg provides no atomic multi-query snapshot guarantee.",
    ],
  };
}

const percent = (value) => (value * 100).toFixed(1) + "%";
const safe = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

function validateReport(report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== "upcoming-pairwise-matchup-report-v1"
      || !Array.isArray(report.matches)) throw new Error("Unsupported upcoming matchup report");
}

function displaySides(match) {
  const favoriteIndex = match.prediction.favoriteIndex;
  if (favoriteIndex == null) return { favorite: match.entrants[0], underdog: match.entrants[1], tied: true };
  return { favorite: match.entrants[favoriteIndex], underdog: match.entrants[1 - favoriteIndex], tied: false };
}

function basis(match) {
  const counts = Array.isArray(match.prediction.historySetCounts)
    ? [...match.prediction.historySetCounts] : [0, 0];
  if (match.prediction.favoriteIndex === 1) counts.reverse();
  const known = match.prediction.knownPlayers === 2 ? "H2"
    : match.prediction.knownPlayers === 1 ? "H1" : "S";
  return `${known} · ${counts[0] ?? 0}/${counts[1] ?? 0}`;
}

function shortRound(match) {
  const name = match.roundName
    .replace("Winners Round ", "W")
    .replace("Losers Round ", "L")
    .replace("Winners Quarter-Final", "WQF")
    .replace("Winners Semi-Final", "WSF")
    .replace("Winners Final", "WF")
    .replace("Losers Quarter-Final", "LQF")
    .replace("Losers Semi-Final", "LSF")
    .replace("Losers Final", "LF")
    .replace("Grand Final", "GF");
  return `${name}${match.identifier ? ` ${match.identifier}` : ""}`;
}

function defaultDetailFile(report) {
  const tournament = String(report.event.slug ?? "upcoming-event").split("/")[1] ?? "upcoming-event";
  return `./${tournament.replace(/[^a-zA-Z0-9_-]/g, "-")}-all-matchups.md`;
}

function header(report) {
  return [
    `# ${safe(report.event.name)} matchup board — experimental`,
    "",
    `[Start.gg bracket](${safe(report.event.sourceUrl)}) · ${safe(report.event.fetchedAt)} · state **${safe(report.event.state)}** · ${report.event.previewSetRows}/${report.counts.sourceSets} preview rows`,
    `Model: ${safe(report.model.name)} · **${report.counts.fixedUncompletedMatches}** determined (${report.counts.directSeedMatches} direct, ${report.counts.resolvedFeederMatches} resolved feeders) · ${report.counts.unresolvedSets} unresolved/bye · ${report.counts.completedSets} played`,
    "",
  ];
}

/** Compact default view: all picks in one row per pool, with only close calls expanded. */
export function upcomingMatchupMarkdown(report, { detailFile = defaultDetailFile(report) } = {}) {
  validateReport(report);
  const groups = new Map();
  for (const match of report.matches) {
    const key = `${match.phaseName} · ${match.phaseGroupName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }
  const lines = [
    ...header(report),
    `Open the [complete matchup table](${safe(detailFile)}) for opponents, seeds and evidence on every row.`,
    "",
    "## All picks at a glance",
    "",
    "Each entry is **model favorite · raw set-win estimate**, sorted highest to lowest within each pool. These are conditional matchup picks, not title odds.",
    "",
    "| Pool | Model picks |",
    "|---|---|",
  ];
  for (const [group, matches] of groups) {
    const picks = [...matches]
      .sort((a, b) => b.prediction.estimatedWinChance - a.prediction.estimatedWinChance
        || bracketSort(a, b))
      .map((match) => {
        const { favorite, tied } = displaySides(match);
        return tied ? `${safe(favorite.name)} 50%` : `${safe(favorite.name)} ${percent(match.prediction.estimatedWinChance)}`;
      });
    lines.push(`| ${safe(group)} | ${picks.join(" · ")} |`);
  }
  const closest = [...report.matches]
    .sort((a, b) => a.prediction.estimatedWinChance - b.prediction.estimatedWinChance
      || bracketSort(a, b)).slice(0, 12);
  lines.push("", "## Twelve closest calls", "",
    "| Pool | Matchup | Pick | Raw | Basis |",
    "|---|---|---|---:|---|");
  for (const match of closest) {
    const { favorite, tied } = displaySides(match);
    lines.push(`| ${safe(match.phaseGroupName)} | ${safe(match.entrants[0].name)} vs ${safe(match.entrants[1].name)} | `
      + `${safe(tied ? "No edge" : favorite.name)} | ${percent(match.prediction.estimatedWinChance)} | ${safe(basis(match))} |`);
  }
  lines.push("", "## Read this correctly", "",
    "- **Raw** is the model estimate. Held-out favorite results by raw band: 50s→53.9% (n=724), 60s→65.9% (925), 70s→70.5% (904), 80s→73.7% (1,171), 90s→87.3% (2,520). The model is overconfident at the high end.",
    "- **H2/H1/S** means history for two players / one player / seed-only; the numbers are favorite/underdog prior-set counts. Current seeds are present for every displayed matchup.",
    "- All rows are provisional Start.gg previews. Incomplete feeders and later-phase projections are excluded. This is not a title or top-eight simulation.",
    "- Training uses five selected 2025 majors and assumes their post-event seed snapshots reflect pre-event seeding.",
    "", "Refresh this same board:", "", "```sh", report.refreshCommand, "```", "");
  return lines.join("\n");
}

/** Dense complete table retained as a secondary file for matchup-level lookup. */
export function upcomingMatchupDetailedMarkdown(report) {
  validateReport(report);
  const lines = [
    ...header(report),
    "| Pool | Set | Forecast | Raw | Basis |",
    "|---|---|---|---:|---|",
  ];
  for (const match of report.matches) {
    const { favorite, underdog, tied } = displaySides(match);
    const forecast = tied
      ? `${safe(favorite.name)} [${favorite.seedNum}] = ${safe(underdog.name)} [${underdog.seedNum}]`
      : `${safe(favorite.name)} [${favorite.seedNum}] > ${safe(underdog.name)} [${underdog.seedNum}]`;
    lines.push(`| ${safe(match.phaseGroupName)} | ${safe(shortRound(match))} | ${forecast} | `
      + `${percent(match.prediction.estimatedWinChance)} | ${safe(basis(match))} |`);
  }
  if (!report.matches.length) lines.push("| — | — | No determined unplayed matchups | — | — |");
  lines.push("", "## Scope and caveats", "", ...report.caveats.map((caveat) => `- ${safe(caveat)}`), "",
    "Refresh command:", "", "```sh", report.refreshCommand, "```", "");
  return lines.join("\n");
}
