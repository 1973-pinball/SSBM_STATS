import type { Account, Filters, GameRecord, ParseProgress } from "./types";
import { hasFullStats, hasKnownCpu } from "./types";
import { gameKey } from "./dedupe";
import { applyFilters, applyTeamFilters, resolveGames, resolveTeamGames } from "./stats";

/** Local diagnostic for distinct games inspected during one explicit import. */
export interface ReplayImportReport {
  progress: ParseProgress;
  /** Successful distinct parses, including games already represented in the cache. */
  parsedGames: number;
  /** Distinct successful games inspected from fresh parses or selected cached rows. */
  inspectedGames: number;
  /** Inspected cached games not already observed as a fresh successful parse. */
  cachedGames: number;
  /** Games containing a saved account, before eligibility and display filters. */
  matchingGames: number;
  includedGames: number;
  /** Each excluded game contributes to its first applicable reason only. */
  exclusions: {
    noCode: number;
    account: number;
    unsupported: number;
    cpu: number;
    format: number;
    filters: number;
  };
  /** Latest valid recorded date across all inspected games, including cached rows. */
  latestParsedAt: string | null;
  latestMatchingAt: string | null;
  accountCodes: string[];
  format: Filters["format"];
}

/**
 * Observe authoritative successful parses and selected cached rows without
 * retaining their stats payloads. Fresh observations must precede cached ones
 * so a newly parsed game is attributed to this run, not its stored copy.
 * The caller supplies the format actually displayed by App, which can differ
 * from filters.format when the library contains no eligible teams games.
 *
 * These are import-time diagnostics, not a count of newly added library games:
 * a parsed copy of an existing game still counts once here. The caller can
 * inspect a selected file's exact cached record with observeCached; a seen
 * marker alone cannot establish which surviving game represents that file.
 */
export function createImportReport(accounts: Account[], filters: Filters, format: Filters["format"]) {
  const accountCodes = accounts.map((account) => account.code);
  const myCodes = new Set(accountCodes);
  const selectedFilters: Filters = {
    ...filters,
    gameTypes: filters.gameTypes === null ? null : [...filters.gameTypes],
  };
  const seen = new Set<string>();
  const exclusions: ReplayImportReport["exclusions"] = {
    noCode: 0, account: 0, unsupported: 0, cpu: 0, format: 0, filters: 0,
  };
  let parsedGames = 0;
  let inspectedGames = 0;
  let cachedGames = 0;
  let matchingGames = 0;
  let includedGames = 0;
  let latestParsed: number | null = null;
  let latestMatching: number | null = null;

  const observeRecord = (record: GameRecord, cached: boolean): void => {
    // Both sources must provide full successes; cached failure tombstones
    // and provisional previews cannot establish a game's display eligibility.
    if (!hasFullStats(record) || record.parseError !== undefined) return;
    const key = gameKey(record);
    if (seen.has(key)) return;
    seen.add(key);
    inspectedGames++;
    if (cached) cachedGames++;
    else parsedGames++;

    const parsedAt = record.playedAt === null ? NaN : Date.parse(record.playedAt);
    if (Number.isFinite(parsedAt)) latestParsed = Math.max(latestParsed ?? parsedAt, parsedAt);
    if (!record.players.some((player) => Boolean(player.connectCode))) {
      exclusions.noCode++;
      return;
    }
    if (!record.players.some((player) => player.connectCode && myCodes.has(player.connectCode))) {
      exclusions.account++;
      return;
    }
    matchingGames++;
    if (Number.isFinite(parsedAt)) latestMatching = Math.max(latestMatching ?? parsedAt, parsedAt);

    // Reuse the dashboard's stage, roster, identity and team-shape rules.
    // CPU inclusion here lets the report distinguish it from unsupported
    // games without inventing a second definition of replay eligibility.
    const singles = resolveGames([record], myCodes, true);
    const teams = resolveTeamGames([record], myCodes, true);
    if (singles.length === 0 && teams.length === 0) {
      exclusions.unsupported++;
      return;
    }
    if (!selectedFilters.includeCpuGames && hasKnownCpu(record)) {
      exclusions.cpu++;
      return;
    }
    if (format === "teams" ? teams.length === 0 : singles.length === 0) {
      exclusions.format++;
      return;
    }
    const included = format === "teams"
      ? applyTeamFilters(teams, selectedFilters).length > 0
      : applyFilters(singles, selectedFilters).length > 0;
    if (!included) {
      exclusions.filters++;
      return;
    }
    includedGames++;
  };

  return {
    observe(record: GameRecord): void {
      observeRecord(record, false);
    },
    observeCached(record: GameRecord): void {
      observeRecord(record, true);
    },
    finish(progress: ParseProgress): ReplayImportReport {
      return {
        progress: { ...progress },
        parsedGames,
        inspectedGames,
        cachedGames,
        matchingGames,
        includedGames,
        exclusions: { ...exclusions },
        latestParsedAt: latestParsed === null ? null : new Date(latestParsed).toISOString(),
        latestMatchingAt: latestMatching === null ? null : new Date(latestMatching).toISOString(),
        accountCodes: [...accountCodes],
        format,
      };
    },
  };
}
