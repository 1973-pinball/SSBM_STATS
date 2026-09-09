import { createHash } from 'node:crypto';

/**
 * Local-only, conservative normalization of cached Start.gg observations.
 * `sets` keeps one row per source set, including excluded rows, because an
 * incomplete/DQ set may still be important to the official bracket. Only rows
 * with `eligible === true` are suitable as historical match outcomes.
 *
 * Identity is NEVER inferred from a tag. Timestamps are reported source times,
 * not an invented within-event ordering. Standings are outcomes, not features;
 * phase seeds need a demonstrably pre-event observation before feature use.
 */
export function normalizeEvents(bundles) {
  if (!Array.isArray(bundles)) throw new TypeError('Expected an array of Start.gg event bundles');
  const quality = {
    counts: {}, exclusionReasons: {}, duplicateSets: [], conflictingSets: [],
    eventConflicts: [], entrantConflicts: [], missingEntrantIds: 0,
    anonymousPlayers: [], tagCollisions: [], renamedPlayers: [], invalidSeeds: [],
    invalidStandings: [], warnings: [],
  };
  const provenanceById = new Map();
  const eventObservations = new Map();
  const observations = [];
  for (const bundle of bundles) {
    if (bundle?.schemaVersion !== 1 || !sourceId(bundle.event?.id)) {
      throw new TypeError('Each bundle needs schemaVersion: 1 and a public event.id');
    }
    if (bundle.provenance?.source !== 'start.gg') {
      throw new TypeError('Each bundle must identify provenance.source as start.gg');
    }
    for (const field of ['entrants', 'sets', 'standings', 'seeds', 'phaseGroups']) {
      if (!Array.isArray(bundle[field])) {
        throw new TypeError(`Each bundle requires a complete ${field} array (use [] only for a confirmed empty source connection)`);
      }
    }
    if (!Array.isArray(bundle.provenance.requests)) {
      throw new TypeError('Each bundle requires a provenance.requests array');
    }
    const provenance = canonical({
      ...bundle.provenance,
      source: 'start.gg', eventId: sourceId(bundle.event.id),
      fetchedAt: bundle.provenance.fetchedAt ?? null,
      requests: bundle.provenance.requests ?? [],
      major: bundle.major ?? null,
    });
    const provenanceId = `startgg:observation:${digest(provenance)}`;
    provenanceById.set(provenanceId, { id: provenanceId, ...provenance });
    const observation = { bundle, eventId: id('event', bundle.event.id), provenanceId };
    observations.push(observation);
    append(eventObservations, observation.eventId, observation);
  }

  const events = [];
  const eventsById = new Map();
  for (const [eventId, group] of sortedEntries(eventObservations)) {
    const ordered = orderObservations(group, (x) => [x.bundle.event, x.bundle.major]);
    const event = ordered[0].bundle.event;
    const allEntrants = group.flatMap((x) => rows(x.bundle.entrants));
    const eligibility = eventEligibility(event, allEntrants);
    const chronology = eventChronology(event);
    const signatures = unique(group.map((x) => stable({
      eligibility: eventEligibility(x.bundle.event, rows(x.bundle.entrants)),
      chronology: eventChronology(x.bundle.event),
      tournamentId: sourceId(x.bundle.event.tournament?.id),
      majorId: x.bundle.major?.id ?? null,
    })));
    if (signatures.length > 1) {
      eligibility.reasons.push('event_source_conflict');
      quality.eventConflicts.push({ eventId, variants: signatures.length });
    }
    if (chronology.startAt == null) eligibility.reasons.push('event_missing_start');
    if (chronology.endAt != null && chronology.startAt != null && chronology.endAt < chronology.startAt) {
      eligibility.reasons.push('event_invalid_dates');
    }
    const row = {
      id: eventId, name: event.name ?? null, slug: event.slug ?? null,
      source: source(event.id, group),
      major: canonical(ordered[0].bundle.major ?? null),
      tournament: canonical(event.tournament ?? null),
      videogame: canonical(event.videogame ?? null),
      format: eligibility.format, online: eligibility.online,
      state: event.state ?? null, type: event.type ?? null, numEntrants: event.numEntrants ?? null,
      teamRosterSize: canonical(event.teamRosterSize ?? null),
      entrantSizeMin: event.entrantSizeMin ?? null,
      chronology,
      eligible: eligibility.reasons.length === 0,
      exclusionReasons: unique(eligibility.reasons),
      phaseGroups: uniqueObjects(group.flatMap((x) => rows(x.bundle.phaseGroups))),
      phases: uniqueObjects(group.flatMap((x) => rows(x.bundle.event.phases))),
    };
    events.push(row);
    eventsById.set(eventId, row);
  }
  events.sort((a, b) => (a.chronology.startAt ?? Infinity) - (b.chronology.startAt ?? Infinity) || compare(a.id, b.id));

  const entrantObservations = new Map();
  for (const observation of observations) {
    for (const entrant of rows(observation.bundle.entrants)) {
      if (!sourceId(entrant?.id)) { quality.missingEntrantIds++; continue; }
      append(entrantObservations, id('entrant', entrant.id), { ...observation, raw: entrant });
    }
  }
  const playersById = new Map();
  const aliasesByKey = new Map();
  const entrants = [];
  const entrantsById = new Map();
  for (const [entrantId, group] of sortedEntries(entrantObservations)) {
    const ordered = orderObservations(group, (x) => x.raw);
    const first = ordered[0];
    const identities = group.map((x) => entrantIdentities(x.raw, x.eventId));
    const conflict = unique(identities.map((x) => stable(x.map((p) => p.id).sort()))).length > 1 || unique(group.map((x) => x.eventId)).length > 1;
    for (let index = 0; index < group.length; index++) {
      const observation = group[index];
      for (const identity of identities[index]) {
        let player = playersById.get(identity.id);
        if (!player) {
          player = {
            id: identity.id, anonymous: identity.anonymous,
            sourcePlayerId: identity.sourcePlayerId,
            source: { system: 'start.gg', id: identity.sourcePlayerId, provenanceIds: [] },
            eventIds: [], entrantIds: [],
          };
          playersById.set(identity.id, player);
        }
        player.eventIds.push(observation.eventId);
        player.entrantIds.push(entrantId);
        player.source.provenanceIds.push(observation.provenanceId);
        if (identity.tag) {
          const aliasKey = stable([identity.id, identity.tag]);
          let alias = aliasesByKey.get(aliasKey);
          if (!alias) {
            alias = {
              id: `startgg:alias:${digest(aliasKey)}`, playerId: identity.id,
              tag: identity.tag, comparisonTag: comparisonTag(identity.tag),
              source: { system: 'start.gg', participantIds: [], provenanceIds: [] },
              eventIds: [], entrantIds: [],
            };
            aliasesByKey.set(aliasKey, alias);
          }
          if (identity.participantId) alias.source.participantIds.push(identity.participantId);
          alias.source.provenanceIds.push(observation.provenanceId);
          alias.eventIds.push(observation.eventId);
          alias.entrantIds.push(entrantId);
        }
      }
    }
    const resolved = entrantIdentities(first.raw, first.eventId);
    const row = {
      id: entrantId, eventId: first.eventId, name: first.raw.name ?? null,
      source: source(first.raw.id, group),
      participantIds: unique(rows(first.raw.participants).map((p) => sourceId(p.id)).filter(Boolean)),
      playerIds: resolved.map((p) => p.id).sort(compare),
      playerId: !conflict && resolved.length === 1 ? resolved[0].id : null,
      participantCount: rows(first.raw.participants).length,
      identityConflict: conflict,
    };
    if (conflict) quality.entrantConflicts.push({ entrantId, eventIds: unique(group.map((x) => x.eventId)), playerIdVariants: uniqueObjects(identities.map((x) => x.map((p) => p.id).sort(compare))) });
    entrants.push(row);
    entrantsById.set(entrantId, row);
  }
  const players = [...playersById.values()].sort(byId);
  const aliases = [...aliasesByKey.values()].sort(byId);
  const registrations = new Map();
  for (const row of entrants) {
    if (row.playerId) append(registrations, stable([row.eventId, row.playerId]), row);
  }
  for (const [, entries] of sortedEntries(registrations)) {
    if (entries.length < 2) continue;
    quality.multipleEntrantsPerPlayerEvent ??= [];
    quality.multipleEntrantsPerPlayerEvent.push({
      eventId: entries[0].eventId, playerId: entries[0].playerId,
      entrantIds: unique(entries.map(row => row.id)),
      participantIds: unique(entries.flatMap(row => row.participantIds)),
    });
  }
  if (quality.multipleEntrantsPerPlayerEvent?.length) {
    quality.warnings.push('Some player IDs have multiple entrants in one event. Keep registrations distinct and audit their outcomes before bracket simulation.');
  }
  for (const row of [...players, ...aliases]) {
    row.eventIds = unique(row.eventIds);
    row.entrantIds = unique(row.entrantIds);
    row.source.provenanceIds = unique(row.source.provenanceIds);
    if (row.source.participantIds) row.source.participantIds = unique(row.source.participantIds);
  }
  const tags = new Map();
  const tagsByPlayer = new Map();
  for (const alias of aliases) {
    append(tags, alias.comparisonTag, alias.playerId);
    append(tagsByPlayer, alias.playerId, alias.tag);
  }
  for (const [tag, identities] of sortedEntries(tags)) {
    const playerIds = unique(identities);
    if (playerIds.length > 1) quality.tagCollisions.push({ comparisonTag: tag, playerIds });
  }
  for (const [playerId, observedTags] of sortedEntries(tagsByPlayer)) {
    const playerTags = unique(observedTags);
    if (playerTags.length > 1) quality.renamedPlayers.push({ playerId, tags: playerTags });
  }
  quality.anonymousPlayers = players.filter((p) => p.anonymous).map((p) => p.id);

  const seedObservations = new Map();
  const standingObservations = new Map();
  const setObservations = new Map();
  let sourceSetRows = 0;
  for (const observation of observations) {
    for (const raw of rows(observation.bundle.seeds)) {
      const entrantId = sourceId(raw.entrant?.id ?? raw.entrantId);
      const phase = raw.phase ?? raw.phaseGroup?.phase ?? null;
      const phaseId = sourceId(phase?.id);
      const key = sourceId(raw.id) ? id('seed', raw.id) : `startgg:seed:${digest([observation.eventId, phaseId, sourceId(raw.phaseGroup?.id), entrantId])}`;
      append(seedObservations, key, { ...observation, raw });
    }
    for (const raw of rows(observation.bundle.standings)) {
      const entrantId = sourceId(raw.entrant?.id ?? raw.entrantId);
      const key = `${observation.eventId}:standing:${entrantId ?? `missing-${digest(raw)}`}`;
      append(standingObservations, key, { ...observation, raw });
    }
    for (const raw of rows(observation.bundle.sets)) {
      sourceSetRows++;
      const key = sourceId(raw.id) ? id('set', raw.id) : `startgg:set:missing:${digest([observation.eventId, raw])}`;
      append(setObservations, key, { ...observation, raw });
    }
  }

  const seeds = normalizeObservations(seedObservations, (seedId, group, first) => {
    const raw = first.raw;
    const phase = raw.phase ?? raw.phaseGroup?.phase ?? null;
    const entrantId = sourceId(raw.entrant?.id ?? raw.entrantId);
    const seedNum = integer(raw.seedNum, 1);
    const reasons = [];
    const entrant = entrantId ? entrantsById.get(id('entrant', entrantId)) : null;
    if (!entrant || entrant.eventId !== first.eventId) reasons.push('missing_entrant');
    if (entrant?.identityConflict) reasons.push('entrant_identity_conflict');
    if (seedNum == null) reasons.push('invalid_seed');
    if (!sourceId(phase?.id)) reasons.push('missing_phase');
    if (raw.isBye === true) reasons.push('bye_seed');
    if (variants(group, (x) => [x.eventId, sourceId(x.raw.entrant?.id ?? x.raw.entrantId), x.raw.seedNum, x.raw.groupSeedNum, x.raw.isBye, sourceId(x.raw.progressionSeedId), x.raw.phase ?? x.raw.phaseGroup?.phase, sourceId(x.raw.phaseGroup?.id)]) > 1) reasons.push('source_conflict');
    const startAt = eventsById.get(first.eventId)?.chronology.startAt;
    const fetchedTimes = group.map((x) => observedAt(x.bundle.provenance.fetchedAt)).filter((x) => x != null);
    const observedBeforeEvent = startAt != null && fetchedTimes.some((time) => time < startAt);
    if (reasons.length) quality.invalidSeeds.push({ seedId, reasons });
    return {
      id: seedId, eventId: first.eventId, entrantId: entrantId ? id('entrant', entrantId) : null,
      source: source(raw.id, group), seedNum,
      phase: canonical(phase), phaseGroupId: sourceId(raw.phaseGroup?.id),
      groupSeedNum: raw.groupSeedNum ?? null, isBye: raw.isBye ?? null,
      progressionSeedId: sourceId(raw.progressionSeedId), updatedAt: timestamp(raw.updatedAt),
      role: 'phase-seed', observedBeforeEvent,
      availability: observedBeforeEvent ? 'observed-pre-event' : 'unverified-historical',
      // null deliberately means unknown, not disallowed. A historical seed
      // baseline must document that it assumes these seeds were available.
      usableAsPreEventFeature: reasons.length ? false : observedBeforeEvent ? true : null,
      exclusionReasons: reasons,
    };
  });
  const standings = normalizeObservations(standingObservations, (standingId, group, first) => {
    const entrantId = sourceId(first.raw.entrant?.id ?? first.raw.entrantId);
    const placement = integer(first.raw.placement, 1);
    const reasons = [];
    const entrant = entrantId ? entrantsById.get(id('entrant', entrantId)) : null;
    if (!entrant || entrant.eventId !== first.eventId) reasons.push('missing_entrant');
    if (entrant?.identityConflict) reasons.push('entrant_identity_conflict');
    if (placement == null) reasons.push('invalid_placement');
    if (variants(group, (x) => [x.eventId, x.raw.placement]) > 1) reasons.push('source_conflict');
    if (reasons.length) quality.invalidStandings.push({ standingId, reasons });
    return {
      id: standingId, eventId: first.eventId,
      entrantId: entrantId ? id('entrant', entrantId) : null,
      source: source(first.raw.id, group), placement,
      role: 'outcome', usableAsPreEventFeature: false,
      exclusionReasons: reasons,
    };
  });
  const sets = normalizeObservations(setObservations, (setId, group, first) => {
    const raw = first.raw;
    const event = eventsById.get(first.eventId);
    const reasons = [...event.exclusionReasons];
    const sourceVariants = uniqueObjects(group.map((x) => ({ eventId: x.eventId, set: x.raw })));
    if (group.length > 1) quality.duplicateSets.push({ setId, sourceRows: group.length, removedCopies: group.length - 1 });
    if (sourceVariants.length > 1) {
      reasons.push('conflicting_set_id');
      quality.conflictingSets.push({ setId, variants: sourceVariants.length });
    }
    if (!sourceId(raw.id)) reasons.push('missing_set_id');
    const slots = rows(raw.slots);
    const entrantIds = slots.map((slot) => sourceId(slot.entrant?.id));
    const resolvedEntrants = entrantIds.map((entrantId) => entrantId ? entrantsById.get(id('entrant', entrantId)) : null);
    const scores = slots.map((slot) => score(slot.standing?.stats?.score?.value));
    const winnerSourceId = sourceId(raw.winnerId);
    if (slots.length !== 2 || entrantIds.some((entrantId) => !entrantId)) reasons.push('bye');
    if (resolvedEntrants.some((entrant) => !entrant || entrant.eventId !== first.eventId)) reasons.push('missing_entrant');
    if (resolvedEntrants.some((entrant) => entrant?.identityConflict)) reasons.push('entrant_identity_conflict');
    if (resolvedEntrants.some((entrant) => entrant && !entrant.playerId)) reasons.push('non_singles_entrant');
    if (integer(raw.state, 0) !== 3) reasons.push('unfinished');
    if (scores.some((value) => value != null && value < 0)) reasons.push('dq');
    if (scores.some((value) => value == null)) reasons.push('missing_or_invalid_score');
    if (slots.some((slot) => slot.entrant?.isDisqualified === true) || raw.isDQ === true) reasons.push('dq');
    if (entrantIds.length === 2 && entrantIds[0] && (entrantIds[0] === entrantIds[1] || resolvedEntrants[0]?.playerId && resolvedEntrants[0].playerId === resolvedEntrants[1]?.playerId)) reasons.push('self_match');
    const winnerIndex = entrantIds.indexOf(winnerSourceId);
    if (!winnerSourceId || winnerIndex < 0) reasons.push('missing_or_invalid_winner');
    if (scores.length === 2 && scores.every((value) => value != null && value >= 0) && (scores[0] === scores[1] || winnerIndex >= 0 && scores[winnerIndex] <= scores[1 - winnerIndex])) reasons.push('winner_score_mismatch');
    const exclusionReasons = unique(reasons);
    for (const reason of exclusionReasons) quality.exclusionReasons[reason] = (quality.exclusionReasons[reason] ?? 0) + 1;
    return {
      id: setId, eventId: first.eventId, source: source(raw.id, group),
      entrantIds: entrantIds.map((entrantId) => entrantId ? id('entrant', entrantId) : null),
      playerIds: resolvedEntrants.map((entrant) => entrant?.playerId ?? null),
      scores, winnerEntrantId: winnerSourceId ? id('entrant', winnerSourceId) : null,
      winnerPlayerId: winnerIndex >= 0 ? resolvedEntrants[winnerIndex]?.playerId ?? null : null,
      state: raw.state ?? null,
      timestamps: { createdAt: timestamp(raw.createdAt), startAt: timestamp(raw.startAt), startedAt: timestamp(raw.startedAt), completedAt: timestamp(raw.completedAt), updatedAt: timestamp(raw.updatedAt) },
      bracket: {
        round: raw.round ?? null, fullRoundText: raw.fullRoundText ?? null,
        identifier: raw.identifier ?? null, displayScore: raw.displayScore ?? null,
        lPlacement: raw.lPlacement ?? null, wPlacement: raw.wPlacement ?? null,
        winnerProgressionSeed: canonical(raw.winnerProgressionSeed ?? null),
        loserProgressionSeed: canonical(raw.loserProgressionSeed ?? null),
        phaseGroup: canonical(raw.phaseGroup ?? null),
        slots: slots.map((slot) => canonical({
          id: sourceId(slot.id), entrantId: sourceId(slot.entrant?.id),
          slotIndex: slot.slotIndex ?? null, seed: slot.seed ?? null,
          prereqId: sourceId(slot.prereqId), prereqType: slot.prereqType ?? null,
          prereqPlacement: slot.prereqPlacement ?? null,
          prereqCondition: slot.prereqCondition ?? null,
          standingId: sourceId(slot.standing?.id),
          placement: slot.standing?.placement ?? null,
          scoreLabel: slot.standing?.stats?.score?.label ?? null,
        })),
      },
      eligible: exclusionReasons.length === 0, exclusionReasons,
      ...(sourceVariants.length > 1 ? { conflictingObservations: sourceVariants } : {}),
    };
  });
  quality.exclusionReasons = canonical(quality.exclusionReasons);
  quality.counts = {
    sourceBundles: bundles.length, events: events.length, eligibleEvents: events.filter((x) => x.eligible).length,
    players: players.length, anonymousPlayers: quality.anonymousPlayers.length, aliases: aliases.length,
    entrants: entrants.length, seeds: seeds.length, standings: standings.length,
    sourceSetRows, sets: sets.length, duplicateSetCopies: sourceSetRows - sets.length,
    eligibleSets: sets.filter((x) => x.eligible).length, excludedSets: sets.filter((x) => !x.eligible).length,
  };
  quality.warnings.push('Excluded set rows are retained for bracket structure; train only on eligible sets.');
  quality.warnings.push('Source timestamps are not a guaranteed within-event chronology. Use strict pre-event cutoffs.');
  quality.warnings.push('Phase seeds are not final placements. Historical snapshots do not prove seeds were available before the event.');
  quality.warnings.push('Standings are post-event outcomes and must never be used as pre-event features.');
  return { schemaVersion: 1, events, players, aliases, entrants, seeds, sets, standings, quality, provenance: [...provenanceById.values()].sort(byId) };
}

function eventEligibility(event, entrants) {
  const reasons = [];
  const gameId = sourceId(event.videogame?.id);
  if (gameId !== '1') reasons.push(gameId ? 'event_non_melee' : 'event_unknown_game');
  const roster = event.teamRosterSize;
  const max = integer(roster?.maxPlayers ?? roster?.max, 1);
  const min = integer(roster?.minPlayers ?? roster?.min ?? event.entrantSizeMin, 1);
  const counts = entrants.map((entrant) => rows(entrant.participants).length).filter((count) => count > 0);
  let format = 'unknown';
  if (max != null ? max === 1 && (min == null || min === 1) : min === 1 && !counts.some((count) => count > 1)) format = 'singles';
  else if ((max != null && max > 1) || (min != null && min > 1) || counts.some((count) => count > 1)) format = 'teams';
  else if (counts.length > 0 && counts.length === entrants.length && counts.every((count) => count === 1)) format = 'singles';
  if (format !== 'singles') reasons.push(format === 'teams' ? 'event_non_singles' : 'event_unknown_format');
  const online = event.isOnline === true || event.tournament?.isOnline === true ? true : event.isOnline === false || event.tournament?.isOnline === false ? false : null;
  if (online !== false) reasons.push(online ? 'event_online' : 'event_unknown_online');
  return { format, online, reasons };
}

function eventChronology(event) {
  const eventStart = timestamp(event.startAt);
  const eventEnd = timestamp(event.endAt);
  const tournamentStart = timestamp(event.tournament?.startAt);
  const tournamentEnd = timestamp(event.tournament?.endAt);
  return {
    startAt: eventStart ?? tournamentStart, endAt: eventEnd ?? tournamentEnd,
    startAtSource: eventStart != null ? 'event.startAt' : tournamentStart != null ? 'tournament.startAt' : null,
    endAtSource: eventEnd != null ? 'event.endAt' : tournamentEnd != null ? 'tournament.endAt' : null,
    reportedEventStartAt: eventStart, reportedEventEndAt: eventEnd,
    reportedTournamentStartAt: tournamentStart, reportedTournamentEndAt: tournamentEnd,
    precision: 'reported-source-timestamps',
  };
}

function entrantIdentities(entrant, eventId) {
  const participants = rows(entrant.participants);
  const identities = (participants.length ? participants : [{}]).map((participant, index) => {
    const playerId = sourceId(participant.player?.id);
    const participantId = sourceId(participant.id);
    const suffix = participants.length > 1 ? `:${participantId ?? `slot-${index}`}` : '';
    return {
      id: playerId ? id('player', playerId) : `${eventId}:anonymous-entrant:${sourceId(entrant.id)}${suffix}`,
      anonymous: !playerId, sourcePlayerId: playerId, participantId,
      tag: typeof participant.gamerTag === 'string' && participant.gamerTag.trim() ? participant.gamerTag.trim() : null,
    };
  });
  return identities;
}

function normalizeObservations(map, fn) {
  return sortedEntries(map).map(([key, group]) => fn(key, group, orderObservations(group, (x) => x.raw)[0]));
}
function variants(group, fn) { return unique(group.map((x) => stable(fn(x)))).length; }
function orderObservations(group, fn) { return [...group].sort((a, b) => compare(stable(fn(a)), stable(fn(b))) || compare(a.eventId, b.eventId) || compare(a.provenanceId, b.provenanceId)); }
function source(rawId, observations) { return { system: 'start.gg', id: sourceId(rawId), eventIds: unique(observations.map((x) => x.eventId)), provenanceIds: unique(observations.map((x) => x.provenanceId)) }; }
function sourceId(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && value.trim() && value !== '0' ? value.trim() : null; }
function id(kind, value) { return `startgg:${kind}:${sourceId(value)}`; }
function integer(value, min) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : null; }
function score(value) { return typeof value === 'number' && Number.isSafeInteger(value) ? value : null; }
function timestamp(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null; }
function observedAt(value) { const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(milliseconds) ? milliseconds / 1000 : null; }
function rows(value) { return Array.isArray(value) ? value : Array.isArray(value?.nodes) ? value.nodes : []; }
function comparisonTag(value) { return value.normalize('NFKC').toLowerCase().trim(); }
function append(map, key, value) { if (!map.has(key)) map.set(key, []); map.get(key).push(value); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function byId(a, b) { return compare(a.id, b.id); }
function sortedEntries(map) { return [...map.entries()].sort(([a], [b]) => compare(a, b)); }
function unique(values) { return [...new Set(values)].sort(compare); }
function uniqueObjects(values) { return unique(values.map(stable)).map((value) => JSON.parse(value)); }
function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex').slice(0, 24); }
function stable(value) { return JSON.stringify(canonical(value)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map((item) => canonical(item ?? null));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value ?? null;
}
