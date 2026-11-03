import type { ChoiceOutcomes } from "./defensiveInteractions";
import type { RecoveryOutcomes, EdgeguardOutcomes } from "./recoveryInteractions";
import type { PunishOutcome } from "./punishContext";
import type { InteractionSummary } from "./interactionSummary";
import { INTERACTION_STATS_VERSION } from "./types";
import { decodeInteractionBenchmarks } from "./interactionBenchmarkCodec.mjs";

export const INTERACTION_COHORTS = ["venue", "tournament", "pro"] as const;
export type InteractionCohort = typeof INTERACTION_COHORTS[number];
export interface InteractionBenchmarkScope {
  characterId: number | null;
  opponentCharacterId: number | null;
  stageId: number | null;
}
export interface InteractionBenchmarkRow extends InteractionSummary {
  cohort: InteractionCohort;
  characterId: number;
  opponentCharacterId: number;
  stageId: number;
}
export interface InteractionBenchmarkData {
  schemaVersion: 1;
  statsVersion: number;
  generatedAt: string;
  sourceDataset: string;
  sourceUrl: string;
  method: string;
  sample: { bundles: number; games: number; availableGames: number; proPlayers: number };
  rows: InteractionBenchmarkRow[];
}
export type InteractionBenchmarkSelection = Record<InteractionCohort, InteractionSummary | null>;
export type InteractionFamily = "ledge" | "oos" | "shieldExits" | "recoveries" | "edgeguards" | "beforeOpening";
export type InteractionMeasure = "usageShare" | "caughtRate" | "landedRate" | "noHitRate"
  | "returnRate" | "deathRate" | "hitDuringRecoveryRate" | "stockLossRate" | "openingShare" | "damagePerOpening";
export interface InteractionMeasureOption { key: InteractionMeasure; label: string; format: "percent" | "number" }

const CHOICE_MEASURES: readonly InteractionMeasureOption[] = [
  { key: "usageShare", label: "Option share", format: "percent" },
  { key: "caughtRate", label: "Hit / grabbed", format: "percent" },
  { key: "landedRate", label: "Hit / grab landed", format: "percent" },
  { key: "noHitRate", label: "No damaging hit / grab", format: "percent" },
];
export const INTERACTION_MEASURES: Record<InteractionFamily, readonly InteractionMeasureOption[]> = {
  ledge: CHOICE_MEASURES, oos: CHOICE_MEASURES, shieldExits: CHOICE_MEASURES,
  recoveries: [
    { key: "usageShare", label: "Route share", format: "percent" },
    { key: "hitDuringRecoveryRate", label: "Hit during recovery", format: "percent" },
    { key: "returnRate", label: "Returned to stage", format: "percent" },
    { key: "deathRate", label: "Died during recovery", format: "percent" },
  ],
  edgeguards: [
    { key: "stockLossRate", label: "Stock loss during contest", format: "percent" },
    { key: "usageShare", label: "Tactic share", format: "percent" },
  ],
  beforeOpening: [
    { key: "openingShare", label: "Opening share", format: "percent" },
    { key: "damagePerOpening", label: "Damage / opening", format: "number" },
    { key: "deathRate", label: "Ended in attributed death", format: "percent" },
  ],
};

const FAMILIES = ["ledge", "oos", "shieldExits", "recoveries", "edgeguards", "beforeOpening"] as const;
const CHOICE_FIELDS = ["attempts", "punished", "hit", "traded", "noHit", "incomplete"] as const;
const RECOVERY_FIELDS = ["attempts", "reachedLedge", "hitDuringRecovery", "returned", "died", "incomplete"] as const;
const EDGEGUARD_FIELDS = ["opportunities", "contested", "completedContests", "stocksTaken", "opponentReturned", "uncontestedDeaths", "incomplete"] as const;
const PUNISH_FIELDS = ["openings", "damage", "kills", "incomplete"] as const;
const C_STICK_FIELDS = ["cStickInputs", "cStickSamples"] as const;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function countsValid(map: unknown, family: InteractionFamily): boolean {
  if (!isObject(map)) return false;
  const fields = family === "recoveries" ? RECOVERY_FIELDS : family === "edgeguards" ? EDGEGUARD_FIELDS
    : family === "beforeOpening" ? PUNISH_FIELDS : CHOICE_FIELDS;
  for (const [key, value] of Object.entries(map)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !isObject(value)) return false;
    if (!fields.every((field) => field === "damage"
      ? typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0
      : count(value[field]))) return false;
    const row = value as Record<string, number>;
    if (family === "recoveries") {
      if (row.attempts !== row.returned! + row.died! + row.incomplete!
        || row.reachedLedge! > row.attempts! || row.hitDuringRecovery! > row.attempts!) return false;
    } else if (family === "edgeguards") {
      if (row.opportunities !== row.stocksTaken! + row.opponentReturned! + row.uncontestedDeaths! + row.incomplete!
        || row.completedContests! > row.contested! || row.contested! > row.opportunities!
        || row.completedContests! > row.opportunities! - row.incomplete! || row.stocksTaken! > row.completedContests!) return false;
    } else if (family === "beforeOpening") {
      if (row.incomplete! > row.openings! || row.kills! > row.openings! - row.incomplete!) return false;
    } else if (row.attempts !== row.punished! + row.hit! + row.traded! + row.noHit! + row.incomplete!) return false;
    if ((family === "oos" || family === "shieldExits") && C_STICK_FIELDS.some(field => Object.hasOwn(row, field))
      && (!C_STICK_FIELDS.every(field => count(row[field])) || row.cStickInputs! > row.cStickSamples! || row.cStickSamples! > row.attempts!)) return false;
  }
  return true;
}

/** Fail closed for old detector versions, malformed denominators, or duplicated exact cells. */
export function parseInteractionBenchmarkData(raw: unknown): InteractionBenchmarkData | null {
  if (!isObject(raw) || raw.schemaVersion !== 1 || raw.statsVersion !== INTERACTION_STATS_VERSION
    || typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))
    || typeof raw.sourceDataset !== "string" || typeof raw.sourceUrl !== "string"
    || !/^https?:\/\//.test(raw.sourceUrl) || typeof raw.method !== "string" || !isObject(raw.sample)
    || !Array.isArray(raw.rows)) return null;
  const sample = raw.sample;
  if (!["bundles", "games", "availableGames", "proPlayers"].every((key) => count(sample[key]))) return null;
  const seen = new Set<string>();
  for (const row of raw.rows) {
    if (!isObject(row) || !INTERACTION_COHORTS.includes(row.cohort as InteractionCohort)
      || !["characterId", "opponentCharacterId", "stageId", "games", "defenseGames", "recoveryGames", "punishGames"].every((key) => count(row[key]))
      || row.defenseGames! > row.games! || row.recoveryGames! > row.games! || row.punishGames! > row.games!
      || !FAMILIES.every((family) => countsValid(row[family], family))) return null;
    const key = `${row.cohort}|${row.characterId}|${row.opponentCharacterId}|${row.stageId}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return raw as unknown as InteractionBenchmarkData;
}

let loadPromise: Promise<InteractionBenchmarkData> | null = null;
/** Bundled and lazy: no account data or replay files are transmitted to obtain these estimates. */
export function loadInteractionBenchmarks(): Promise<InteractionBenchmarkData> {
  loadPromise ??= import("../data/interaction-benchmarks.json?raw").then(({ default: source }) => {
    const data = parseInteractionBenchmarkData(decodeInteractionBenchmarks(JSON.parse(source) as unknown));
    if (!data) throw new Error("Interaction benchmark sample is incompatible with this analysis version.");
    return data;
  }).catch((error: unknown) => { loadPromise = null; throw error; });
  return loadPromise;
}

function emptySummary(): InteractionSummary {
  return { games: 0, defenseGames: 0, recoveryGames: 0, punishGames: 0,
    ledge: {}, oos: {}, shieldExits: {}, recoveries: {}, edgeguards: {}, beforeOpening: {} };
}
function mergeSummary(target: InteractionSummary, source: InteractionSummary): void {
  for (const key of ["games", "defenseGames", "recoveryGames", "punishGames"] as const) target[key] += source[key];
  for (const family of FAMILIES) {
    const targetMap = target[family] as unknown as Record<string, Record<string, number>>;
    const sourceMap = source[family] as unknown as Record<string, Record<string, number>>;
    for (const [key, counts] of Object.entries(sourceMap)) {
      const out = targetMap[key];
      if (!out) { targetMap[key] = { ...counts }; continue; }
      const unknownHits = family === "recoveries"
        && ((out.attempts! > 0 && !count(out.hitDuringRecovery)) || (counts.attempts! > 0 && !count(counts.hitDuringRecovery)));
      for (const [field, value] of Object.entries(counts)) {
        if (field === "hitDuringRecovery" && (unknownHits || !count(value))) continue;
        out[field] = (out[field] ?? 0) + value;
      }
      if (unknownHits) delete out.hitDuringRecovery;
    }
  }
}

/** Exact dimensions only. Null means aggregate that dimension, never substitute a broader matchup. */
export function selectInteractionBenchmarks(data: InteractionBenchmarkData, scope: InteractionBenchmarkScope): InteractionBenchmarkSelection {
  const result: InteractionBenchmarkSelection = { venue: null, tournament: null, pro: null };
  if (data.schemaVersion !== 1 || data.statsVersion !== INTERACTION_STATS_VERSION) return result;
  for (const row of data.rows) {
    if (scope.characterId !== null && row.characterId !== scope.characterId) continue;
    if (scope.opponentCharacterId !== null && row.opponentCharacterId !== scope.opponentCharacterId) continue;
    if (scope.stageId !== null && row.stageId !== scope.stageId) continue;
    const summary = result[row.cohort] ??= emptySummary();
    mergeSummary(summary, row);
  }
  return result;
}

export function interactionFamilyCoverage(summary: InteractionSummary | null, family: InteractionFamily): number {
  return summary === null ? 0 : family === "recoveries" || family === "edgeguards" ? summary.recoveryGames
    : family === "beforeOpening" ? summary.punishGames : summary.defenseGames;
}
export interface InteractionBenchmarkValue {
  value: number | null;
  numerator: number;
  denominator: number;
  measuredGames: number;
}

/** All sources use the identical numerator/denominator. A zero share is known; a missing rate is not. */
export function interactionBenchmarkValue(summary: InteractionSummary | null, family: InteractionFamily, key: string, measure: InteractionMeasure): InteractionBenchmarkValue {
  const measuredGames = interactionFamilyCoverage(summary, family);
  const unavailable = { value: null, numerator: 0, denominator: 0, measuredGames };
  if (!summary || !measuredGames || !INTERACTION_MEASURES[family].some((option) => option.key === measure)) return unavailable;
  let numerator = 0, denominator = 0;
  if (family === "ledge" || family === "oos" || family === "shieldExits") {
    const row: ChoiceOutcomes | undefined = summary[family][key];
    if (measure === "usageShare") {
      numerator = row?.attempts ?? 0;
      denominator = Object.values(summary[family]).reduce((sum, value) => sum + value.attempts, 0);
    } else if (row) {
      denominator = row.attempts - row.incomplete;
      numerator = measure === "caughtRate" ? row.punished + row.traded
        : measure === "landedRate" ? row.hit + row.traded : row.noHit;
    }
  } else if (family === "recoveries") {
    const row: RecoveryOutcomes | undefined = summary.recoveries[key];
    if (measure === "usageShare") {
      numerator = row?.attempts ?? 0;
      denominator = Object.values(summary.recoveries).reduce((sum, value) => sum + value.attempts, 0);
    } else if (measure === "hitDuringRecoveryRate") {
      // Observed hits are known even when the attempt ends unresolved. Older
      // local analyses without this counter cannot be interpreted as no hits.
      if (!row || !count(row.hitDuringRecovery) || row.hitDuringRecovery > row.attempts) return unavailable;
      numerator = row.hitDuringRecovery;
      denominator = row.attempts;
    } else if (row) {
      denominator = row.attempts - row.incomplete;
      numerator = measure === "returnRate" ? row.returned : row.died;
    }
  } else if (family === "edgeguards") {
    const row: EdgeguardOutcomes | undefined = summary.edgeguards[key];
    if (measure === "usageShare") {
      numerator = row?.opportunities ?? 0;
      denominator = Object.values(summary.edgeguards).reduce((sum, value) => sum + value.opportunities, 0);
    } else if (row) { numerator = row.stocksTaken; denominator = row.completedContests; }
  } else {
    const row: PunishOutcome | undefined = summary.beforeOpening[key];
    if (measure === "openingShare") {
      numerator = row?.openings ?? 0;
      denominator = Object.values(summary.beforeOpening).reduce((sum, value) => sum + value.openings, 0);
    } else if (row) {
      denominator = row.openings - row.incomplete;
      numerator = measure === "damagePerOpening" ? row.damage : row.kills;
    }
  }
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator, measuredGames };
}

export function interactionComparisonKeys(local: InteractionSummary, benchmarks: InteractionBenchmarkSelection, family: InteractionFamily): string[] {
  const keys = new Set(Object.keys(local[family]));
  for (const cohort of INTERACTION_COHORTS) for (const key of Object.keys(benchmarks[cohort]?.[family] ?? {})) keys.add(key);
  const countFor = (key: string) => {
    const row = local[family][key];
    return row ? "attempts" in row ? row.attempts : "opportunities" in row ? row.opportunities : row.openings : 0;
  };
  return [...keys].sort((a, b) => countFor(b) - countFor(a) || a.localeCompare(b));
}
