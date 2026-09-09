import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const DAY_MS = 86_400_000;
const EPSILON = 1e-12;

export const MODEL_KIND = "hierarchical_bradley_terry_v1";
export const DEFAULT_MODEL_OPTIONS = Object.freeze({
  playerLambda: 2,
  seriesLambda: 12,
  halfLifeDays: 730,
  maxIterations: 500,
  convergenceTolerance: 1e-7,
  damping: 0.65,
});

export async function readNdjson(file) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
};

const isoDay = (value) => {
  if (typeof value !== "string" || value.length < 10) return null;
  const day = value.slice(0, 10);
  return isDate(day) ? day : null;
};

const daysBetween = (later, earlier) => (
  Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)
) / DAY_MS;

const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

/**
 * Replay clocks are not authoritative. Prefer a sourced tournament start date;
 * otherwise accept a replay day only when its year agrees with the cited event
 * year. December 31 is a conservative fallback: an event with only a known year
 * cannot enter a forecast made earlier in that same year.
 */
const effectiveGameDay = (game, tournament) => {
  if (isDate(tournament?.start_date)) return tournament.start_date;
  const replayDay = isoDay(game.played_at);
  if (replayDay && (!tournament?.year || Number(replayDay.slice(0, 4)) === tournament.year)) return replayDay;
  return tournament?.year ? `${tournament.year}-12-31` : null;
};

/**
 * Build game-level pairwise observations. Set games remain game observations so
 * the fitted probability can be converted to best-of-N later, but their weights
 * sum to one per set so a BO5 does not count five times as much as a BO3.
 */
export function buildNamedObservations({ games, gamePlayers, tournaments, cutoff }) {
  if (!isDate(cutoff)) throw new Error(`Invalid cutoff date: ${cutoff}`);
  const tournamentById = new Map(tournaments.map((row) => [row.id, row]));
  const playersByGame = new Map();
  for (const row of gamePlayers) {
    const values = playersByGame.get(row.game_key) ?? [];
    values.push(row);
    playersByGame.set(row.game_key, values);
  }

  const eligible = [];
  for (const game of games) {
    if (game.format !== "singles" || game.winner_slot === null || game.winner_slot === undefined) continue;
    if (game.curation_tier !== "verified" && game.curation_tier !== "probable") continue;
    const sides = playersByGame.get(game.game_key) ?? [];
    if (sides.length !== 2 || sides.some((side) => !side.player_id)) continue;
    const bySlot = [...sides].sort((a, b) => a.slot - b.slot);
    if (bySlot[0].player_id === bySlot[1].player_id) continue;
    const winner = bySlot.find((side) => side.slot === game.winner_slot);
    if (!winner) continue;
    const tournament = tournamentById.get(game.tournament_id);
    const day = effectiveGameDay(game, tournament);
    if (!day || day > cutoff) continue;
    const [a, b] = [bySlot[0].player_id, bySlot[1].player_id].sort();
    eligible.push({
      gameKey: game.game_key,
      setId: game.set_id ?? null,
      tournamentId: game.tournament_id,
      seriesId: tournament?.series_id ?? null,
      day,
      a,
      b,
      y: winner.player_id === a ? 1 : 0,
      baseWeight: 1,
    });
  }

  const setSizes = new Map();
  for (const row of eligible) {
    if (row.setId) setSizes.set(row.setId, (setSizes.get(row.setId) ?? 0) + 1);
  }
  for (const row of eligible) {
    if (row.setId) row.baseWeight = 1 / setSizes.get(row.setId);
  }
  eligible.sort((left, right) => left.day.localeCompare(right.day)
    || left.tournamentId.localeCompare(right.tournamentId)
    || left.gameKey.localeCompare(right.gameKey));
  return eligible;
}

const keyForEffect = (playerId, seriesId) => `${playerId}\u0000${seriesId}`;

export function fitBradleyTerry(observations, referenceDay, overrides = {}) {
  const options = { ...DEFAULT_MODEL_OPTIONS, ...overrides };
  if (!observations.length) return null;
  const playerIds = [...new Set(observations.flatMap((row) => [row.a, row.b]))].sort();
  const effectKeys = [...new Set(observations.flatMap((row) => row.seriesId
    ? [keyForEffect(row.a, row.seriesId), keyForEffect(row.b, row.seriesId)]
    : []))].sort();
  const playerIndex = new Map(playerIds.map((id, index) => [id, index]));
  const effectOffset = playerIds.length;
  const effectIndex = new Map(effectKeys.map((key, index) => [key, effectOffset + index]));
  const parameterCount = playerIds.length + effectKeys.length;
  const beta = new Float64Array(parameterCount);
  let converged = false;
  let iterations = 0;

  const sparseTerms = (row) => {
    const terms = [
      [playerIndex.get(row.a), 1],
      [playerIndex.get(row.b), -1],
    ];
    if (row.seriesId) {
      terms.push(
        [effectIndex.get(keyForEffect(row.a, row.seriesId)), 1],
        [effectIndex.get(keyForEffect(row.b, row.seriesId)), -1],
      );
    }
    return terms;
  };
  const weightedRows = observations.map((row) => ({
    row,
    terms: sparseTerms(row),
    weight: row.baseWeight * (0.5 ** (Math.max(0, daysBetween(referenceDay, row.day)) / options.halfLifeDays)),
  }));

  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    iterations = iteration + 1;
    const gradient = new Float64Array(parameterCount);
    const hessianDiagonal = new Float64Array(parameterCount);
    for (let index = 0; index < parameterCount; index++) {
      const lambda = index < effectOffset ? options.playerLambda : options.seriesLambda;
      gradient[index] = lambda * beta[index];
      hessianDiagonal[index] = lambda;
    }
    for (const { row, terms, weight } of weightedRows) {
      let eta = 0;
      for (const [index, sign] of terms) eta += sign * beta[index];
      const probability = sigmoid(eta);
      const residual = weight * (probability - row.y);
      const curvature = weight * Math.max(1e-8, probability * (1 - probability));
      for (const [index, sign] of terms) {
        gradient[index] += sign * residual;
        hessianDiagonal[index] += curvature;
      }
    }
    let largestStep = 0;
    for (let index = 0; index < parameterCount; index++) {
      const rawStep = gradient[index] / Math.max(EPSILON, hessianDiagonal[index]);
      const step = Math.max(-0.5, Math.min(0.5, rawStep)) * options.damping;
      beta[index] -= step;
      largestStep = Math.max(largestStep, Math.abs(step));
    }
    if (largestStep < options.convergenceTolerance) {
      converged = true;
      break;
    }
  }

  const information = new Float64Array(parameterCount);
  for (let index = 0; index < parameterCount; index++) {
    information[index] = index < effectOffset ? options.playerLambda : options.seriesLambda;
  }
  let weightedLogLoss = 0;
  let totalWeight = 0;
  for (const { row, terms, weight } of weightedRows) {
    let eta = 0;
    for (const [index, sign] of terms) eta += sign * beta[index];
    const probability = sigmoid(eta);
    weightedLogLoss += -weight * (row.y * Math.log(Math.max(EPSILON, probability))
      + (1 - row.y) * Math.log(Math.max(EPSILON, 1 - probability)));
    totalWeight += weight;
    const curvature = weight * Math.max(1e-8, probability * (1 - probability));
    for (const [index] of terms) information[index] += curvature;
  }

  const ratings = new Map();
  for (const id of playerIds) {
    const index = playerIndex.get(id);
    ratings.set(id, { mean: beta[index], se: Math.sqrt(1 / information[index]) });
  }
  const seriesEffects = new Map();
  for (const key of effectKeys) {
    const index = effectIndex.get(key);
    seriesEffects.set(key, { mean: beta[index], se: Math.sqrt(1 / information[index]) });
  }
  const sampleCounts = new Map();
  const seriesSampleCounts = new Map();
  for (const row of observations) {
    sampleCounts.set(row.a, (sampleCounts.get(row.a) ?? 0) + 1);
    sampleCounts.set(row.b, (sampleCounts.get(row.b) ?? 0) + 1);
    if (row.seriesId) {
      const aKey = keyForEffect(row.a, row.seriesId);
      const bKey = keyForEffect(row.b, row.seriesId);
      seriesSampleCounts.set(aKey, (seriesSampleCounts.get(aKey) ?? 0) + 1);
      seriesSampleCounts.set(bKey, (seriesSampleCounts.get(bKey) ?? 0) + 1);
    }
  }

  return {
    kind: MODEL_KIND,
    options,
    ratings,
    seriesEffects,
    sampleCounts,
    seriesSampleCounts,
    converged,
    iterations,
    weightedLogLoss: weightedLogLoss / Math.max(EPSILON, totalWeight),
    trainingWeight: totalWeight,
  };
}

export function predictGame(model, a, b, seriesId = null) {
  const aRating = model.ratings.get(a)?.mean ?? 0;
  const bRating = model.ratings.get(b)?.mean ?? 0;
  const aSeries = seriesId ? model.seriesEffects.get(keyForEffect(a, seriesId))?.mean ?? 0 : 0;
  const bSeries = seriesId ? model.seriesEffects.get(keyForEffect(b, seriesId))?.mean ?? 0 : 0;
  return sigmoid(aRating - bRating + aSeries - bSeries);
}

const choose = (n, k) => {
  let result = 1;
  for (let index = 1; index <= k; index++) result *= (n - index + 1) / index;
  return result;
};

export function bestOfProbability(gameProbability, bestOf) {
  const winsNeeded = Math.floor(bestOf / 2) + 1;
  let result = 0;
  for (let wins = winsNeeded; wins <= bestOf; wins++) {
    result += choose(bestOf, wins) * (gameProbability ** wins) * ((1 - gameProbability) ** (bestOf - wins));
  }
  return result;
}

export function walkForwardValidate(observations, options = {}) {
  const minTrainingGames = options.minTrainingGames ?? 50;
  const byTournament = new Map();
  for (const row of observations) {
    const values = byTournament.get(row.tournamentId) ?? [];
    values.push(row);
    byTournament.set(row.tournamentId, values);
  }
  const eventGroups = [...byTournament.entries()].map(([tournamentId, rows]) => ({
    tournamentId,
    // Treat an event as available only after its latest eligible dated game.
    day: rows.reduce((latest, row) => row.day > latest ? row.day : latest, rows[0].day),
    rows,
  }));
  const byDay = new Map();
  for (const group of eventGroups) {
    const values = byDay.get(group.day) ?? [];
    values.push(group);
    byDay.set(group.day, values);
  }
  const days = [...byDay.keys()].sort();
  let weightedBrier = 0;
  let weightedLogLoss = 0;
  let totalWeight = 0;
  let predictions = 0;
  let folds = 0;
  let coveragePredictions = 0;
  for (const day of days) {
    const training = eventGroups.filter((group) => group.day < day).flatMap((group) => group.rows);
    const test = (byDay.get(day) ?? []).flatMap((group) => group.rows);
    if (training.length < minTrainingGames || !test.length) continue;
    const model = fitBradleyTerry(training, day, options.modelOptions);
    if (!model) continue;
    folds++;
    for (const row of test) {
      const probability = predictGame(model, row.a, row.b, row.seriesId);
      const weight = row.baseWeight;
      weightedBrier += weight * ((probability - row.y) ** 2);
      weightedLogLoss += -weight * (row.y * Math.log(Math.max(EPSILON, probability))
        + (1 - row.y) * Math.log(Math.max(EPSILON, 1 - probability)));
      totalWeight += weight;
      predictions++;
      if (model.ratings.has(row.a) && model.ratings.has(row.b)) coveragePredictions++;
    }
  }
  return {
    folds,
    predictions,
    brier: totalWeight ? weightedBrier / totalWeight : null,
    logLoss: totalWeight ? weightedLogLoss / totalWeight : null,
    baselineBrier: totalWeight ? 0.25 : null,
    baselineLogLoss: totalWeight ? Math.log(2) : null,
    knownPlayerCoverage: predictions ? coveragePredictions / predictions : null,
  };
}

const hashSeed = (value) => {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const makeRandom = (seed) => {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const normalRandom = (random) => {
  const first = Math.max(EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

const sourceKeys = ["playerId", "winnerOf", "loserOf"];
const validateSource = (source, precedingMatches, entrantIds, label) => {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${label} must be a source object`);
  const keys = sourceKeys.filter((key) => typeof source[key] === "string");
  if (keys.length !== 1 || Object.keys(source).some((key) => !sourceKeys.includes(key))) {
    throw new Error(`${label} must contain exactly one of playerId, winnerOf, or loserOf`);
  }
  if (source.playerId && !entrantIds.has(source.playerId)) throw new Error(`${label} names a non-entrant player`);
  const matchId = source.winnerOf ?? source.loserOf;
  if (matchId && !precedingMatches.has(matchId)) throw new Error(`${label} references a match that does not precede it: ${matchId}`);
};

export function validateForecastEvent(input, { playerIds, seriesIds }) {
  if (!input || typeof input !== "object") throw new Error("Forecast input must be a JSON object");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.id ?? "")) throw new Error("id must be a lowercase slug");
  if (typeof input.canonicalName !== "string" || !input.canonicalName.trim()) throw new Error("canonicalName is required");
  if (!isDate(input.startDate)) throw new Error("startDate must be YYYY-MM-DD");
  if (!isDate(input.dataCutoff)) throw new Error("dataCutoff must be YYYY-MM-DD");
  if (input.dataCutoff >= input.startDate) throw new Error("dataCutoff must precede startDate");
  if (!/^https:\/\//.test(input.entrantSourceUrl ?? "")) throw new Error("entrantSourceUrl must be an https URL");
  if (input.bracketSourceUrl !== null && input.bracketSourceUrl !== undefined
    && !/^https:\/\//.test(input.bracketSourceUrl)) throw new Error("bracketSourceUrl must be null or an https URL");
  if (input.seriesId !== null && input.seriesId !== undefined && !seriesIds.has(input.seriesId)) {
    throw new Error(`Unknown seriesId: ${input.seriesId}`);
  }
  if (!Number.isInteger(input.simulationCount) || input.simulationCount < 1000 || input.simulationCount > 1_000_000) {
    throw new Error("simulationCount must be an integer from 1,000 through 1,000,000");
  }
  if (!Array.isArray(input.entrants) || input.entrants.length < 2) throw new Error("At least two entrants are required");
  const entrantIds = new Set();
  const seeds = new Set();
  for (const entrant of input.entrants) {
    if (typeof entrant.playerId !== "string" || !playerIds.has(entrant.playerId)) {
      throw new Error(`Entrant ${entrant.playerId ?? "(missing)"} is not present in archive_players`);
    }
    if (entrantIds.has(entrant.playerId)) throw new Error(`Duplicate entrant: ${entrant.playerId}`);
    if (!Number.isInteger(entrant.seed) || entrant.seed < 1 || seeds.has(entrant.seed)) {
      throw new Error(`Entrant ${entrant.playerId} needs a unique positive integer seed`);
    }
    entrantIds.add(entrant.playerId);
    seeds.add(entrant.seed);
  }
  if (!input.bracket || !Array.isArray(input.bracket.matches) || !input.bracket.matches.length) {
    throw new Error("bracket.matches must contain an explicit, topologically ordered bracket");
  }
  const precedingMatches = new Set();
  const directAppearances = new Map();
  for (const [index, match] of input.bracket.matches.entries()) {
    if (!/^[A-Za-z0-9_-]+$/.test(match.id ?? "") || precedingMatches.has(match.id)) {
      throw new Error(`bracket.matches[${index}] has an invalid or duplicate id`);
    }
    validateSource(match.left, precedingMatches, entrantIds, `match ${match.id}.left`);
    validateSource(match.right, precedingMatches, entrantIds, `match ${match.id}.right`);
    for (const source of [match.left, match.right]) {
      if (source.playerId) directAppearances.set(source.playerId, (directAppearances.get(source.playerId) ?? 0) + 1);
    }
    if (![3, 5, 7].includes(match.bestOf)) throw new Error(`match ${match.id}.bestOf must be 3, 5, or 7`);
    if (match.playIf) {
      if (!precedingMatches.has(match.playIf.matchId) || !["left", "right"].includes(match.playIf.winnerSide)
        || !["left", "right"].includes(match.playIf.onFalse ?? "left")) {
        throw new Error(`match ${match.id}.playIf is invalid`);
      }
    }
    precedingMatches.add(match.id);
  }
  for (const entrantId of entrantIds) {
    if (directAppearances.get(entrantId) !== 1) throw new Error(`Entrant ${entrantId} must appear directly in exactly one bracket source`);
  }
  const expectedTop = Math.min(8, entrantIds.size);
  if (!Array.isArray(input.bracket.top8From) || input.bracket.top8From.length !== expectedTop) {
    throw new Error(`bracket.top8From must contain exactly ${expectedTop} sources`);
  }
  for (const [index, source] of input.bracket.top8From.entries()) {
    validateSource(source, precedingMatches, entrantIds, `bracket.top8From[${index}]`);
  }
  validateSource(input.bracket.championFrom, precedingMatches, entrantIds, "bracket.championFrom");
  return input;
}

const resolveSource = (source, results) => {
  if (source.playerId) return source.playerId;
  const result = results.get(source.winnerOf ?? source.loserOf);
  return source.winnerOf ? result?.winner ?? null : result?.loser ?? null;
};

const quantile = (sorted, probability) => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + fraction * ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]);
};

const roundProbability = (value) => Number(Math.max(0, Math.min(1, value)).toFixed(8));

const confidenceFor = ({ samples, seriesSamples, intervalWidth, usesSeries }) => {
  if (samples >= 40 && (!usesSeries || seriesSamples >= 10) && intervalWidth <= 0.2) return "high";
  if (samples >= 12 && (!usesSeries || seriesSamples >= 3) && intervalWidth <= 0.4) return "medium";
  return "low";
};

export function simulateBracket({ model, event, randomSeed }) {
  const random = makeRandom(randomSeed ?? `${event.id}:${event.dataCutoff}`);
  const entrantIds = event.entrants.map((row) => row.playerId);
  const titleCounts = new Map(entrantIds.map((id) => [id, 0]));
  const top8Counts = new Map(entrantIds.map((id) => [id, 0]));
  const titleDrawRates = new Map(entrantIds.map((id) => [id, []]));
  const drawCount = Math.min(250, Math.max(50, Math.floor(Math.sqrt(event.simulationCount))));
  const basePerDraw = Math.floor(event.simulationCount / drawCount);
  const remainder = event.simulationCount % drawCount;

  for (let draw = 0; draw < drawCount; draw++) {
    const simulationsThisDraw = basePerDraw + (draw < remainder ? 1 : 0);
    const scores = new Map();
    for (const playerId of entrantIds) {
      const rating = model.ratings.get(playerId) ?? { mean: 0, se: 1 / Math.sqrt(model.options.playerLambda) };
      const effectKey = event.seriesId ? keyForEffect(playerId, event.seriesId) : null;
      const series = effectKey
        ? model.seriesEffects.get(effectKey) ?? { mean: 0, se: 1 / Math.sqrt(model.options.seriesLambda) }
        : { mean: 0, se: 0 };
      scores.set(playerId,
        rating.mean + Math.min(1.25, rating.se) * normalRandom(random)
        + series.mean + Math.min(0.75, series.se) * normalRandom(random));
    }
    const drawTitles = new Map(entrantIds.map((id) => [id, 0]));
    for (let simulation = 0; simulation < simulationsThisDraw; simulation++) {
      const results = new Map();
      for (const match of event.bracket.matches) {
        const left = resolveSource(match.left, results);
        const right = resolveSource(match.right, results);
        let winner = null;
        let loser = null;
        let winnerSide = null;
        const condition = match.playIf;
        const shouldPlay = !condition || results.get(condition.matchId)?.winnerSide === condition.winnerSide;
        if (!shouldPlay) {
          winnerSide = condition.onFalse ?? "left";
          winner = winnerSide === "left" ? left : right;
          loser = winnerSide === "left" ? right : left;
        } else if (!left || !right) {
          winner = left ?? right;
          loser = null;
          winnerSide = left ? "left" : right ? "right" : null;
        } else {
          const probability = bestOfProbability(sigmoid(scores.get(left) - scores.get(right)), match.bestOf);
          winnerSide = random() < probability ? "left" : "right";
          winner = winnerSide === "left" ? left : right;
          loser = winnerSide === "left" ? right : left;
        }
        results.set(match.id, { winner, loser, winnerSide });
      }
      const champion = resolveSource(event.bracket.championFrom, results);
      if (!champion) throw new Error("championFrom did not resolve to a player");
      titleCounts.set(champion, titleCounts.get(champion) + 1);
      drawTitles.set(champion, drawTitles.get(champion) + 1);
      const top8 = new Set(event.bracket.top8From.map((source) => resolveSource(source, results)).filter(Boolean));
      if (top8.size !== Math.min(8, entrantIds.length)) {
        throw new Error(`top8From resolved to ${top8.size} unique players; expected ${Math.min(8, entrantIds.length)}`);
      }
      for (const playerId of top8) top8Counts.set(playerId, top8Counts.get(playerId) + 1);
    }
    for (const playerId of entrantIds) {
      titleDrawRates.get(playerId).push(drawTitles.get(playerId) / simulationsThisDraw);
    }
  }

  return event.entrants.map((entrant) => {
    const rates = titleDrawRates.get(entrant.playerId).sort((a, b) => a - b);
    const low = quantile(rates, 0.025);
    const high = quantile(rates, 0.975);
    const seriesSamples = event.seriesId
      ? model.seriesSampleCounts.get(keyForEffect(entrant.playerId, event.seriesId)) ?? 0
      : 0;
    return {
      playerId: entrant.playerId,
      seed: entrant.seed,
      titleProbability: roundProbability(titleCounts.get(entrant.playerId) / event.simulationCount),
      top8Probability: roundProbability(top8Counts.get(entrant.playerId) / event.simulationCount),
      intervalLow: roundProbability(low),
      intervalHigh: roundProbability(high),
      confidence: confidenceFor({
        samples: model.sampleCounts.get(entrant.playerId) ?? 0,
        seriesSamples,
        intervalWidth: high - low,
        usesSeries: Boolean(event.seriesId),
      }),
      trainingGames: model.sampleCounts.get(entrant.playerId) ?? 0,
      seriesGames: seriesSamples,
    };
  }).sort((left, right) => right.titleProbability - left.titleProbability || left.seed - right.seed);
}

export const forecastExample = {
  id: "example-open-2027",
  canonicalName: "Example Open 2027",
  seriesId: null,
  startDate: "2027-06-12",
  entrantSourceUrl: "https://www.start.gg/tournament/example-open-2027/attendees",
  bracketSourceUrl: "https://www.start.gg/tournament/example-open-2027/event/melee-singles/brackets",
  dataCutoff: "2027-06-10",
  simulationCount: 25000,
  randomSeed: "example-open-2027-v1",
  entrants: [
    { playerId: "replace-with-archive-player-1", seed: 1 },
    { playerId: "replace-with-archive-player-2", seed: 2 },
    { playerId: "replace-with-archive-player-3", seed: 3 },
    { playerId: "replace-with-archive-player-4", seed: 4 },
  ],
  bracket: {
    matches: [
      { id: "S1", left: { playerId: "replace-with-archive-player-1" }, right: { playerId: "replace-with-archive-player-4" }, bestOf: 5 },
      { id: "S2", left: { playerId: "replace-with-archive-player-2" }, right: { playerId: "replace-with-archive-player-3" }, bestOf: 5 },
      { id: "F", left: { winnerOf: "S1" }, right: { winnerOf: "S2" }, bestOf: 5 },
    ],
    top8From: [
      { playerId: "replace-with-archive-player-1" },
      { playerId: "replace-with-archive-player-2" },
      { playerId: "replace-with-archive-player-3" },
      { playerId: "replace-with-archive-player-4" },
    ],
    championFrom: { winnerOf: "F" },
  },
};
