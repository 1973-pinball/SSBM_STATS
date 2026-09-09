import { normalizeComparisonTag } from "./dataset.mjs";

const compare = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const byEvent = (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity)
  || compare(a.name ?? "", b.name ?? "") || compare(a.eventId ?? "", b.eventId ?? "");
const unique = (values) => [...new Set(values)].sort(compare);
const MATCH_STATUSES = new Set(["exact_alias_match", "normalized_alias_match"]);
const MISSING_TOP_TWO_STATUSES = new Set([
  "missing_standing",
  "multiple_standings",
  "invalid_standing",
  "missing_entrant",
  "unresolved_entrant_identity",
]);
const isAuthoritativePlayerId = (value) => typeof value === "string" && /^startgg:player:[^:]+$/.test(value);
const canonicalId = (value) => typeof value === "string" || typeof value === "number" ? String(value) : null;
const isCompleted = (value) => value === 3 || String(value).toUpperCase() === "COMPLETED";
const isDoubleElimination = (value) => String(value).toUpperCase() === "DOUBLE_ELIMINATION";
const isChampionshipPhaseName = (value) => typeof value === "string"
  && /\b(?:finals?|championship|playoffs?|top[ -]?\d+)\b/i.test(value)
  && !/\b(?:pool|group|gauntlet)\b/i.test(value);

function uniqueIndex(rows, field, label) {
  const index = new Map();
  for (const row of rows) {
    const value = row?.[field];
    if (typeof value !== "string" || !value) throw new Error(`${label} needs a non-empty ${field}`);
    if (index.has(value)) throw new Error(`Duplicate ${label} ${field}: ${value}`);
    index.set(value, row);
  }
  return index;
}

function append(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function aliasObservations(dataset, entrantsById) {
  const byEvent = new Map();
  const byEntrant = new Map();
  const byPlayer = new Map();
  const resolved = [];
  const all = [];
  const eventProvenance = new Map(dataset.events.map((event) => [
    event.id,
    new Set(Array.isArray(event.source?.provenanceIds) ? event.source.provenanceIds : []),
  ]));
  for (const alias of [...dataset.aliases].sort((a, b) => compare(a?.id ?? "", b?.id ?? ""))) {
    if (typeof alias?.tag !== "string" || !alias.tag.trim() || typeof alias.playerId !== "string") continue;
    const comparisonTag = normalizeComparisonTag(alias.tag);
    for (const entrantId of unique(Array.isArray(alias.entrantIds) ? alias.entrantIds : [])) {
      const entrant = entrantsById.get(entrantId);
      if (!entrant || typeof entrant.eventId !== "string") continue;
      const provenanceIds = unique((Array.isArray(alias.source?.provenanceIds) ? alias.source.provenanceIds : [])
        .filter((provenanceId) => eventProvenance.get(entrant.eventId)?.has(provenanceId)));
      const observation = {
        aliasId: alias.id ?? null,
        tag: alias.tag,
        comparisonTag,
        playerId: alias.playerId,
        entrantId,
        eventId: entrant.eventId,
        provenanceIds,
        identityResolved: entrant.identityConflict !== true && entrant.playerId === alias.playerId,
      };
      append(byEvent, entrant.eventId, observation);
      all.push(observation);
      // Only independently resolved joins can describe a reported finisher.
      // Unresolved observations stay in the event index so they can make a
      // historical-name lookup ambiguous rather than disappearing from review.
      if (observation.identityResolved) {
        append(byEntrant, entrantId, observation);
        append(byPlayer, alias.playerId, observation);
        resolved.push(observation);
      }
    }
  }
  const sortAliases = (rows) => rows.sort((a, b) => compare(a.tag, b.tag)
    || compare(a.playerId, b.playerId) || compare(a.entrantId, b.entrantId) || compare(a.aliasId ?? "", b.aliasId ?? ""));
  for (const rows of byEvent.values()) sortAliases(rows);
  for (const rows of byEntrant.values()) sortAliases(rows);
  for (const rows of byPlayer.values()) sortAliases(rows);
  sortAliases(resolved);
  sortAliases(all);
  return { byEvent, byEntrant, byPlayer, resolved, all };
}

function aliasSelection(expectedTag, observations) {
  if (typeof expectedTag !== "string" || !expectedTag.trim()) return { mode: null, rows: [], playerIds: [] };
  const exact = observations.filter((alias) => alias.tag === expectedTag);
  const normalized = observations.filter((alias) => alias.comparisonTag === normalizeComparisonTag(expectedTag));
  const rows = exact.length ? exact : normalized;
  return {
    mode: exact.length ? "exact" : normalized.length ? "normalized" : null,
    rows,
    playerIds: unique(rows.map((alias) => alias.playerId)),
  };
}

function corroborationAliasSelection(expectedTag, observations) {
  // Corroboration is provenance-bearing evidence, not merely another tag
  // comparison. Unprovenanced aliases remain visible to the raw audit only.
  return aliasSelection(expectedTag, observations.filter((alias) => alias.provenanceIds.length > 0));
}

function aliasEvidence(kind, selection, playerId) {
  const rows = selection.rows.filter((alias) => alias.playerId === playerId);
  return {
    kind,
    matchMode: selection.mode,
    playerId,
    aliasIds: unique(rows.map((alias) => alias.aliasId).filter(Boolean)),
    tags: unique(rows.map((alias) => alias.tag)),
    eventIds: unique(rows.map((alias) => alias.eventId)),
    entrantIds: unique(rows.map((alias) => alias.entrantId)),
    provenanceIds: unique(rows.flatMap((alias) => alias.provenanceIds)),
  };
}

function corpusHistorySelection(expectedTag, aliases, playerId) {
  const candidates = corroborationAliasSelection(expectedTag, aliases.all);
  if (candidates.playerIds.length !== 1 || candidates.playerIds[0] !== playerId) return null;
  const resolved = corroborationAliasSelection(expectedTag, aliases.resolved);
  return resolved.playerIds.length === 1 && resolved.playerIds[0] === playerId ? resolved : null;
}

function standingCorroboration(result, aliases) {
  if (MATCH_STATUSES.has(result.status) || typeof result.playerId !== "string") return null;
  const entrantSelection = corroborationAliasSelection(result.expectedTag, aliases.byEntrant.get(result.entrantId) ?? []);
  if (entrantSelection.playerIds.length === 1 && entrantSelection.playerIds[0] === result.playerId) {
    return aliasEvidence("reported_entrant_alias", entrantSelection, result.playerId);
  }
  if (!isAuthoritativePlayerId(result.playerId)) return null;
  const historySelection = corpusHistorySelection(result.expectedTag, aliases, result.playerId);
  // Alias history is corroboration only after the standing resolved a player ID,
  // and only when the label is unique within this immutable dataset corpus.
  if (historySelection != null) {
    return aliasEvidence("authoritative_player_alias_history", historySelection, result.playerId);
  }
  return null;
}

function standingView(standing) {
  return {
    standingId: standing.id ?? null,
    entrantId: standing.entrantId ?? null,
    exclusionReasons: unique(Array.isArray(standing.exclusionReasons) ? standing.exclusionReasons : []),
  };
}

function candidateViews(observations, standingsByEntrant) {
  const grouped = new Map();
  for (const alias of observations) {
    if (!grouped.has(alias.playerId)) grouped.set(alias.playerId, { entrantIds: [], resolvedEntrantIds: [], tags: [] });
    const row = grouped.get(alias.playerId);
    row.entrantIds.push(alias.entrantId);
    if (alias.identityResolved) row.resolvedEntrantIds.push(alias.entrantId);
    row.tags.push(alias.tag);
  }
  return [...grouped.entries()].sort(([a], [b]) => compare(a, b)).map(([playerId, row]) => {
    const entrantIds = unique(row.entrantIds);
    const placements = [...new Set(entrantIds.flatMap((entrantId) => (standingsByEntrant.get(entrantId) ?? [])
      .map((standing) => standing.placement)
      .filter((placement) => Number.isSafeInteger(placement))))].sort((a, b) => a - b);
    return {
      playerId,
      entrantIds,
      resolvedEntrantIds: unique(row.resolvedEntrantIds),
      placements,
      tags: unique(row.tags),
    };
  });
}

function championshipContext(event, set, eventSets) {
  if (event?.source?.system !== "start.gg" || !Array.isArray(event.source.provenanceIds)
      || event.source.provenanceIds.length === 0) return null;
  const groupId = canonicalId(set.bracket?.phaseGroup?.id);
  if (groupId == null || !Array.isArray(event.phaseGroups) || !Array.isArray(event.phases)) return null;
  const groups = event.phaseGroups.filter((group) => canonicalId(group?.id) === groupId);
  if (groups.length !== 1) return null;
  const group = groups[0];
  const phaseId = canonicalId(group.phase?.id);
  if (phaseId == null) return null;
  const phases = event.phases.filter((phase) => canonicalId(phase?.id) === phaseId);
  const phaseGroups = event.phaseGroups.filter((candidate) => canonicalId(candidate?.phase?.id) === phaseId);
  if (phases.length !== 1 || phaseGroups.length !== 1) return null;
  const phase = phases[0];
  if (!isDoubleElimination(group.bracketType) || !isDoubleElimination(group.phase?.bracketType)
      || !isDoubleElimination(phase.bracketType) || !isDoubleElimination(set.bracket.phaseGroup.bracketType)
      || !isCompleted(group.state) || !isCompleted(group.phase?.state) || !isCompleted(phase.state)
      || !isCompleted(set.bracket.phaseGroup.state) || !isChampionshipPhaseName(phase.name)) return null;
  if (set.bracket.winnerProgressionSeed != null || set.bracket.loserProgressionSeed != null) return null;

  const sourceSetId = canonicalId(set.source?.id);
  if (sourceSetId == null) return null;
  const outgoingSetIds = unique(eventSets.filter((candidate) => candidate.id !== set.id
    && (candidate.bracket?.slots ?? []).some((slot) => slot?.prereqType === "set"
      && canonicalId(slot.prereqId) === sourceSetId)).map((candidate) => candidate.id));
  if (outgoingSetIds.length > 0) return null;
  const incomingSetIds = unique((set.bracket.slots ?? [])
    .filter((slot) => slot?.prereqType === "set" && canonicalId(slot.prereqId) != null)
    .map((slot) => canonicalId(slot.prereqId)));
  if (incomingSetIds.length === 0) return null;
  const groupSetSourceIds = new Set(eventSets
    .filter((candidate) => canonicalId(candidate.bracket?.phaseGroup?.id) === groupId)
    .map((candidate) => canonicalId(candidate.source?.id)).filter(Boolean));
  if (incomingSetIds.some((id) => !groupSetSourceIds.has(id))) return null;
  return {
    phaseId,
    phaseName: phase.name,
    phaseGroupId: groupId,
    bracketType: "DOUBLE_ELIMINATION",
    incomingSetIds,
    outgoingSetIds,
    provenanceIds: unique(event.source.provenanceIds),
  };
}

function terminalSetEvidence(dataset, eventsById, entrantsById) {
  const byEvent = new Map();
  if (!Array.isArray(dataset.sets)) return byEvent;
  uniqueIndex(dataset.sets, "id", "set");
  const setsByEvent = new Map();
  for (const set of dataset.sets) append(setsByEvent, set?.eventId, set);
  for (const set of [...dataset.sets].sort((a, b) => compare(a?.id ?? "", b?.id ?? ""))) {
    if (set?.eligible !== true || set.bracket?.wPlacement !== 1 || set.bracket?.lPlacement !== 2) continue;
    if (!/^Grand Final(?: Reset)?$/i.test(set.bracket.fullRoundText ?? "") || set.source?.system !== "start.gg") continue;
    if (!Array.isArray(set.entrantIds) || set.entrantIds.length !== 2
        || set.entrantIds.some((entrantId) => typeof entrantId !== "string")
        || set.entrantIds[0] === set.entrantIds[1]
        || !set.entrantIds.includes(set.winnerEntrantId)) continue;
    const entrants = set.entrantIds.map((entrantId) => entrantsById.get(entrantId));
    if (entrants.some((entrant) => !entrant || entrant.eventId !== set.eventId
        || typeof entrant.playerId !== "string" || entrant.identityConflict === true)) continue;
    const loserEntrantId = set.entrantIds.find((entrantId) => entrantId !== set.winnerEntrantId);
    const winner = entrantsById.get(set.winnerEntrantId);
    const runnerUp = entrantsById.get(loserEntrantId);
    if (winner.playerId !== set.winnerPlayerId) continue;
    const provenanceIds = unique(Array.isArray(set.source?.provenanceIds) ? set.source.provenanceIds : []);
    if (!provenanceIds.length) continue;
    const event = eventsById.get(set.eventId);
    const championship = championshipContext(event, set, setsByEvent.get(set.eventId) ?? []);
    if (championship == null || !championship.provenanceIds.some((id) => provenanceIds.includes(id))) continue;
    append(byEvent, set.eventId, {
      setId: set.id,
      fullRoundText: set.bracket.fullRoundText ?? null,
      winnerEntrantId: winner.id,
      winnerPlayerId: winner.playerId,
      runnerUpEntrantId: runnerUp.id,
      runnerUpPlayerId: runnerUp.playerId,
      scores: Array.isArray(set.scores) ? [...set.scores] : [],
      provenanceIds,
      championship,
    });
  }
  return byEvent;
}

function terminalSetCorroboration(result, eventTerminalSets, aliases) {
  if (!MISSING_TOP_TWO_STATUSES.has(result.status) || eventTerminalSets.length !== 1) return null;
  const terminal = eventTerminalSets[0];
  const entrantId = result.role === "winner" ? terminal.winnerEntrantId : terminal.runnerUpEntrantId;
  const playerId = result.role === "winner" ? terminal.winnerPlayerId : terminal.runnerUpPlayerId;
  const entrantSelection = corroborationAliasSelection(result.expectedTag, aliases.byEntrant.get(entrantId) ?? []);
  const historySelection = isAuthoritativePlayerId(playerId)
    ? corpusHistorySelection(result.expectedTag, aliases, playerId)
    : null;
  const aliasMatch = entrantSelection.playerIds.length === 1 && entrantSelection.playerIds[0] === playerId
    ? aliasEvidence("reported_entrant_alias", entrantSelection, playerId)
    : historySelection != null
      ? aliasEvidence("authoritative_player_alias_history", historySelection, playerId)
      : null;
  if (!aliasMatch) return null;
  return {
    kind: "validated_terminal_championship_placement",
    role: result.role,
    placement: result.placement,
    setId: terminal.setId,
    fullRoundText: terminal.fullRoundText,
    entrantId,
    playerId,
    scores: terminal.scores,
    provenanceIds: terminal.provenanceIds,
    championship: terminal.championship,
    aliasMatch,
  };
}

function roleResult({ role, placement, expectedTag, eventId, eventAliases, entrantAliases,
  standings, entrantsById, standingsByEntrant }) {
  const expected = typeof expectedTag === "string" && expectedTag.trim() ? expectedTag : null;
  const result = {
    role,
    placement,
    expectedTag: expected,
    expectedComparisonTag: expected == null ? null : normalizeComparisonTag(expected),
    status: null,
    reviewSignals: [],
    standings: standings.map(standingView),
    entrantId: null,
    playerId: null,
    observedAliases: [],
    aliasCandidateMode: null,
    aliasCandidates: [],
  };
  if (expected == null) result.reviewSignals.push("missing_historical_outcome");
  if (standings.length === 0) {
    result.status = "missing_standing";
    result.reviewSignals.push(result.status);
    return result;
  }
  if (standings.length > 1) {
    result.status = "multiple_standings";
    result.reviewSignals.push(result.status);
    return result;
  }
  const standing = standings[0];
  if (!Array.isArray(standing.exclusionReasons) || standing.exclusionReasons.length > 0) {
    result.status = "invalid_standing";
    result.reviewSignals.push(result.status);
    return result;
  }
  const entrant = entrantsById.get(standing.entrantId);
  if (!entrant || entrant.eventId !== eventId) {
    result.status = "missing_entrant";
    result.reviewSignals.push(result.status);
    return result;
  }
  result.entrantId = entrant.id;
  if (typeof entrant.playerId !== "string" || !entrant.playerId || entrant.identityConflict === true) {
    result.status = "unresolved_entrant_identity";
    result.reviewSignals.push(result.status);
    return result;
  }
  result.playerId = entrant.playerId;
  result.observedAliases = unique((entrantAliases.get(entrant.id) ?? []).map((alias) => alias.tag));
  if (expected == null) {
    result.status = "missing_historical_outcome";
    return result;
  }

  const exact = eventAliases.filter((alias) => alias.tag === expected);
  const normalized = eventAliases.filter((alias) => alias.comparisonTag === result.expectedComparisonTag);
  const exactPlayerIds = unique(exact.map((alias) => alias.playerId));
  const normalizedPlayerIds = unique(normalized.map((alias) => alias.playerId));
  const exactResolvedPlayerIds = unique(exact.filter((alias) => alias.identityResolved).map((alias) => alias.playerId));
  const normalizedResolvedPlayerIds = unique(normalized.filter((alias) => alias.identityResolved).map((alias) => alias.playerId));
  const candidates = exact.length ? exact : normalized;
  result.aliasCandidateMode = exact.length ? "exact" : normalized.length ? "normalized" : null;
  result.aliasCandidates = candidateViews(candidates, standingsByEntrant);

  if (exactPlayerIds.length > 1) {
    result.status = "ambiguous_alias";
  } else if (exactPlayerIds.length === 1) {
    result.status = exactPlayerIds[0] === entrant.playerId
      ? exactResolvedPlayerIds.includes(entrant.playerId) ? "exact_alias_match" : "ambiguous_alias"
      : "alias_mismatch";
  } else if (normalizedPlayerIds.length > 1) {
    result.status = "ambiguous_alias";
  } else if (normalizedPlayerIds.length === 1) {
    result.status = normalizedPlayerIds[0] === entrant.playerId
      ? normalizedResolvedPlayerIds.includes(entrant.playerId) ? "normalized_alias_match" : "ambiguous_alias"
      : "alias_mismatch";
  } else {
    result.status = "alias_mismatch";
  }
  if (!MATCH_STATUSES.has(result.status)) result.reviewSignals.push(result.status);
  return result;
}

function eventSummary(results, extraSignals = []) {
  const roles = (status) => results.filter((result) => status(result.status)).map((result) => result.role);
  const summary = {
    exactAliasMatches: roles((status) => status === "exact_alias_match"),
    normalizedAliasMatches: roles((status) => status === "normalized_alias_match"),
    ambiguousAliases: roles((status) => status === "ambiguous_alias"),
    mismatches: roles((status) => status === "alias_mismatch"),
    missingTopTwoData: results.filter((result) => result.reviewSignals.some((signal) => MISSING_TOP_TWO_STATUSES.has(signal)))
      .map((result) => result.role),
    missingHistoricalOutcomes: results.filter((result) => result.reviewSignals.includes("missing_historical_outcome"))
      .map((result) => result.role),
  };
  const reviewSignals = unique([
    ...extraSignals,
    ...results.flatMap((result) => result.reviewSignals.map((signal) => `${result.role}:${signal}`)),
  ]);
  return { summary, reviewSignals };
}

/**
 * Advisory reconciliation between independently sourced historical labels and
 * canonical Start.gg placements. Historical names are compared with event-local
 * aliases only; they are never used to assign or merge player identities.
 */
export function auditHistoricalOutcomes(registry, dataset, { datasetSha256 = null } = {}) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.events)) {
    throw new Error("Outcome reconciliation needs registry schemaVersion 1");
  }
  for (const field of ["events", "standings", "entrants", "aliases"]) {
    if (dataset?.schemaVersion !== 1 || !Array.isArray(dataset?.[field])) {
      throw new Error(`Outcome reconciliation needs normalized dataset ${field}`);
    }
  }
  const registryById = uniqueIndex(registry.events, "id", "registry event");
  const entrantsById = uniqueIndex(dataset.entrants, "id", "entrant");
  const eventsById = uniqueIndex(dataset.events, "id", "dataset event");
  uniqueIndex(dataset.standings, "id", "standing");
  uniqueIndex(dataset.aliases, "id", "alias");
  const aliases = aliasObservations(dataset, entrantsById);
  const standingsByEventPlacement = new Map();
  const standingsByEntrant = new Map();
  for (const standing of [...dataset.standings].sort((a, b) => compare(a?.id ?? "", b?.id ?? ""))) {
    if (typeof standing?.eventId === "string" && Number.isSafeInteger(standing.placement)) {
      append(standingsByEventPlacement, `${standing.eventId}:${standing.placement}`, standing);
    }
    if (typeof standing?.entrantId === "string") append(standingsByEntrant, standing.entrantId, standing);
  }
  const terminalSetsByEvent = terminalSetEvidence(dataset, eventsById, entrantsById);

  const events = dataset.events.map((event) => {
    const majorId = typeof event.major?.id === "string" ? event.major.id : null;
    const registryEvent = majorId == null ? null : registryById.get(majorId) ?? null;
    const historicalOutcome = registryEvent?.historicalOutcome ?? null;
    const localAliases = aliases.byEvent.get(event.id) ?? [];
    const winner = roleResult({
      role: "winner", placement: 1, expectedTag: historicalOutcome?.winner,
      eventId: event.id, eventAliases: localAliases, entrantAliases: aliases.byEntrant,
      standings: standingsByEventPlacement.get(`${event.id}:1`) ?? [], entrantsById, standingsByEntrant,
    });
    const runnerUp = roleResult({
      role: "runnerUp", placement: 2, expectedTag: historicalOutcome?.runnerUp,
      eventId: event.id, eventAliases: localAliases, entrantAliases: aliases.byEntrant,
      standings: standingsByEventPlacement.get(`${event.id}:2`) ?? [], entrantsById, standingsByEntrant,
    });
    const eventTerminalSets = terminalSetsByEvent.get(event.id) ?? [];
    winner.corroboration = standingCorroboration(winner, aliases)
      ?? terminalSetCorroboration(winner, eventTerminalSets, aliases);
    runnerUp.corroboration = standingCorroboration(runnerUp, aliases)
      ?? terminalSetCorroboration(runnerUp, eventTerminalSets, aliases);
    winner.reconciled = MATCH_STATUSES.has(winner.status) || winner.corroboration != null;
    runnerUp.reconciled = MATCH_STATUSES.has(runnerUp.status) || runnerUp.corroboration != null;
    const extraSignals = registryEvent == null ? [majorId == null ? "missing_major_id" : "registry_event_missing"] : [];
    const { summary, reviewSignals } = eventSummary([winner, runnerUp], extraSignals);
    const reconciled = extraSignals.length === 0 && winner.reconciled && runnerUp.reconciled;
    return {
      eventId: event.id,
      majorId,
      name: registryEvent?.name ?? event.major?.name ?? event.name ?? null,
      year: registryEvent?.year ?? event.major?.year ?? null,
      historicalOutcome: historicalOutcome == null ? null : {
        winner: historicalOutcome.winner ?? null,
        runnerUp: historicalOutcome.runnerUp ?? null,
      },
      status: reviewSignals.length ? "review" : "matched",
      reconciliationStatus: reconciled ? reviewSignals.length ? "corroborated" : "direct" : "unresolved",
      reviewSignals,
      summary,
      results: { winner, runnerUp },
    };
  }).sort(byEvent);

  const results = events.flatMap((event) => [event.results.winner, event.results.runnerUp]);
  const count = (status) => results.filter((result) => status(result.status)).length;
  const counts = {
    datasetEvents: events.length,
    matchedEvents: events.filter((event) => event.status === "matched").length,
    reviewEvents: events.filter((event) => event.status === "review").length,
    roleComparisons: results.length,
    exactAliasMatches: count((status) => status === "exact_alias_match"),
    normalizedAliasMatches: count((status) => status === "normalized_alias_match"),
    ambiguousAliases: count((status) => status === "ambiguous_alias"),
    mismatches: count((status) => status === "alias_mismatch"),
    missingTopTwoData: results.filter((result) => result.reviewSignals.some((signal) => MISSING_TOP_TWO_STATUSES.has(signal))).length,
    missingHistoricalOutcomes: results.filter((result) => result.reviewSignals.includes("missing_historical_outcome")).length,
    missingRegistryEvents: events.filter((event) => event.reviewSignals.includes("missing_major_id")
      || event.reviewSignals.includes("registry_event_missing")).length,
  };
  const corroborations = results.map((result) => result.corroboration).filter(Boolean);
  const corroborationCounts = {
    reconciledEvents: events.filter((event) => event.reconciliationStatus !== "unresolved").length,
    corroboratedReviewEvents: events.filter((event) => event.reconciliationStatus === "corroborated").length,
    unresolvedReviewEvents: events.filter((event) => event.reconciliationStatus === "unresolved").length,
    corroboratedRoles: corroborations.length,
    reportedEntrantAliases: corroborations.filter((evidence) => (evidence.aliasMatch ?? evidence).kind === "reported_entrant_alias").length,
    authoritativePlayerAliasHistories: corroborations
      .filter((evidence) => (evidence.aliasMatch ?? evidence).kind === "authoritative_player_alias_history").length,
    validatedTerminalChampionshipPlacements: corroborations
      .filter((evidence) => evidence.kind === "validated_terminal_championship_placement").length,
  };
  return {
    schemaVersion: 1,
    kind: "forecast-historical-outcome-reconciliation-v1",
    datasetSha256,
    registrySnapshotAsOf: registry.snapshotAsOf ?? null,
    advisoryOnly: true,
    allMatched: events.length > 0 && counts.reviewEvents === 0,
    allReconciled: events.length > 0 && corroborationCounts.unresolvedReviewEvents === 0,
    counts,
    corroborationCounts,
    methodology: {
      exact: "The historical label exactly equals one event-local canonical alias and that player owns the reported placement.",
      normalized: "With no exact candidate, NFKC + lowercase + trim uniquely matches an event-local canonical alias owned by the reported finisher.",
      conservativeIdentity: "Historical labels never assign, merge, or repair player identities; ambiguous and mismatched aliases remain review signals.",
      corroboration: "A raw review signal may be corroborated only after a standing or validated terminal championship placement independently resolves the entrant and authoritative player ID. Event-local entrant aliases are preferred; cross-event alias history must be unique within this immutable dataset corpus to that already-resolved player.",
      terminalChampionship: "Set fallback requires provenance-linked Start.gg evidence, an explicit championship phase name, matching completed double-elimination phase/group metadata, a unique group in that phase, an exact Grand Final/Reset label, no progression or outgoing set edge, and set ancestry inside that group.",
      temporalScope: "Cross-event alias history is post-event QA and may include observations after the audited event; it must never be used as a predictive or backtest feature.",
      sourceWarnings: "Corroboration never removes the raw mismatch, homonym, or malformed-standing signal from the report.",
      trainingEffect: "This audit is advisory and never changes event or set eligibility, training rows, routing, or backtest features.",
      completenessEffect: "allReconciled means only that every raw review role has conservative corroborating evidence in this report; it is not a source-completeness or corpus-readiness claim.",
    },
    events,
  };
}
