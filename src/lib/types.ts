export type GameType = "ranked" | "unranked" | "direct" | "offline" | "unknown";

/** Singles vs teams is a separate axis from GameType: a 2v2 is also ranked/direct/offline. */
export type Format = "singles" | "teams";

/** Movement/defensive action counts for one player in one game. */
export interface ActionCounts {
  rolls: number;
  airDodges: number;
  spotDodges: number;
  wavedashes: number;
  wavelands: number;
  dashDances: number;
  ledgeGrabs: number;
  crouchCancels: number;
  grabs: number; // attempts (landed + whiffed); slippi-js can't isolate shield grabs
}

export const ACTION_LABELS: { key: keyof ActionCounts; label: string }[] = [
  { key: "rolls", label: "Rolls" },
  { key: "airDodges", label: "Air dodges" },
  { key: "spotDodges", label: "Spot dodges" },
  { key: "wavedashes", label: "Wavedashes" },
  { key: "wavelands", label: "Wavelands" },
  { key: "dashDances", label: "Dash dances" },
  { key: "ledgeGrabs", label: "Ledge grabs" },
  { key: "crouchCancels", label: "Crouch cancels" },
  { key: "grabs", label: "Grabs" },
];

/** Tech outcome counts for one player in one game. */
export interface TechCounts {
  inPlace: number; // ground tech in place
  toward: number; // ground tech toward the opponent
  away: number; // ground tech away from the opponent
  missed: number; // missed ground techs
  wallSuccess: number;
  wallMissed: number;
}

/** Per-move landed-hit aggregates for one player in one game (from conversions). */
export interface MoveAgg {
  landed: number; // landed instances (a multi-hit move counts once per landing)
  damage: number;
  kills: number; // conversions this move ended with a kill
  killPctSum: number; // victim % at those kills (avg = /kills)
  openings: number; // conversions this move started
  openingDmg: number; // total damage of the conversions it started
  /** L-cancels on this aerial's landing lag, whiffs included. Aerials only; 0 elsewhere. */
  lcSuccess: number;
  lcFail: number;
  /** Times the move was initiated (from animation states), whiffs included.
   *  Tracked for grounded normals and aerials only; undefined = not tracked. */
  attempts?: number;
}

export interface PlayerSide {
  port: number;
  /** Optional header evidence: true = CPU, false = human; absent = unrecorded,
   * null = conflicting copies. Neither unknown state excludes a game. */
  isCpu?: boolean | null;
  connectCode: string | null;
  displayName: string | null;
  characterId: number;
  colorId: number;
  teamId: number | null; // null in singles
  stocksRemaining: number | null;
  kills: number; // enemy stocks taken; in teams, FF kills live in killMatrix
  totalDamage: number; // damage to enemies; in teams, FF lives in dmgMatrix
  openingsPerKill: number | null;
  damagePerOpening: number | null;
  inputsPerMinute: number | null;
  neutralWins: number;
  counterHits: number;
  beneficialTrades: number;
  lCancelSuccess: number;
  lCancelFail: number;
  grabSuccess: number; // landed grabs; actions.grabs is total attempts
  techs: TechCounts;
  actions: ActionCounts;
  /** Keyed by Melee move ID. Singles only (conversions no-op in teams). */
  moveStats?: Record<number, MoveAgg>;
}

/**
 * One row per parsed game. Players are stored neutrally (no self/opponent)
 * so identity can be chosen or changed after parsing without a re-parse.
 */
export interface GameRecord {
  /** Version of the full parsed-stat payload. Missing on older cached/cloud records. */
  statsVersion?: number;
  id: string; // path|size|mtime
  path: string;
  playedAt: string | null; // ISO
  durationFrames: number;
  stageId: number;
  gameType: GameType;
  isTeams: boolean;
  players: PlayerSide[]; // 2 for singles, 4 for 2v2
  winnerIndex: number | null; // singles: index into players; null = indeterminate
  winnerTeamId: number | null; // teams: winning teamId; null = indeterminate
  /**
   * Teams only: [attacker][victim] damage / stock captures in players[] order,
   * attributed via each victim's lastHitBy. The diagonal holds self-damage and
   * self-destructs. Null for singles and malformed 2v2s. Cross-team cells are
   * real damage/kills; same-team cells are friendly fire.
   */
  dmgMatrix?: number[][] | null;
  killMatrix?: number[][] | null;
  /**
   * Set only on a record from the fast header pass — everything the replay's
   * settings, metadata and game-end blocks can answer, and nothing that needs
   * the frames. Those records are transient: `pool.ts` streams them to the
   * dashboard as a preview while the real parse runs behind them, never caches
   * them, and `isSyncable` keeps them off the wire. So `undefined` is the only
   * value that ever reaches storage, and every cached or cloud row written
   * before this existed reads as full stats without a migration.
   */
  statsLevel?: "header";
  parseError?: string;
}

/**
 * True when this record's execution metrics are measurements rather than the
 * zero placeholders a header-pass record carries.
 *
 * Any selector that averages kills, damage, L-cancels, action counts or the
 * neutral ratios must filter on this. Skipping it doesn't fail loudly — it
 * quietly drags the average toward zero for as long as the preview is on
 * screen, which is the same failure decision 3 avoids for schema changes.
 * The nullable metrics (openings/kill, damage/opening, IPM) are already
 * null on a preview record and their existing null guards handle them.
 */
export function hasFullStats(rec: GameRecord): boolean {
  return rec.statsLevel === undefined;
}

/**
 * Bump when a full replay parse gains fields that cannot be derived from an
 * older cached/cloud record. The marker lives inside the cloud JSON payload,
 * so no Supabase schema migration is needed.
 */
export const CURRENT_STATS_VERSION = 3;

/** Only positive CPU evidence excludes a game; old records remain eligible. */
export function hasKnownCpu(rec: GameRecord): boolean {
  return rec.players.some((p) => p.isCpu === true);
}

/** Older records can be full parses while still missing the newest execution fields. */
export function hasCurrentStats(rec: GameRecord): boolean {
  return (
    hasFullStats(rec) &&
    rec.statsVersion === CURRENT_STATS_VERSION &&
    Array.isArray(rec.players) &&
    rec.players.length > 0 &&
    rec.players.every((p) => p.techs != null && p.actions?.crouchCancels !== undefined)
  );
}

/**
 * Whether a successfully parsed record needs the current execution payload.
 *
 * Parse-failure tombstones deliberately have no players or execution fields,
 * so `hasCurrentStats()` is false for them too. They are not repairable schema
 * rows, though: retrying one only recreates the same tombstone and leaves the
 * refresh warning pinned forever. Keep that distinction explicit anywhere a
 * caller decides to forget a cached id and re-parse its file.
 */
export function needsStatsRepair(rec: GameRecord): boolean {
  return rec.parseError === undefined && hasFullStats(rec) && !hasCurrentStats(rec);
}

/**
 * One Slippi account belonging to the user. Several are normal — the same
 * person routinely keeps a main and an alt, and both sets of replays land in
 * the same folder. Identity stays a query-time concept (see decision 1 in
 * CLAUDE.md): these codes are matched against the neutrally-stored
 * `GameRecord.players[]`, never baked into a record.
 */
export interface Account {
  code: string; // normalized upper-case, e.g. ABCD#123
  label: string | null; // "Main", "Alt" — user-supplied, may be absent
}

/** How an account is named in dropdowns and tables: `Main (ABCD#123)`. */
export function accountLabel(a: Account): string {
  return a.label ? `${a.label} (${a.code})` : a.code;
}

/** Same, given only a code — falls back to the bare code for an unknown one. */
export function codeLabel(accounts: Account[], code: string): string {
  const hit = accounts.find((a) => a.code === code);
  return hit ? accountLabel(hit) : code;
}

/**
 * Compact form for dense tables, where a column header already says "Account"
 * and the full `Main (ABCD#123)` would blow the column out: the label alone,
 * or the bare code when there isn't one.
 */
export function codeShort(accounts: Account[], code: string): string {
  return accounts.find((a) => a.code === code)?.label ?? code;
}

/**
 * Slippi codes look like ABCD#123. Deliberately permissive on length: turning
 * away a code the user actually owns is a worse failure than accepting a typo,
 * which simply never matches a replay and shows up as "no games yet".
 */
const CODE_PATTERN = /^[A-Z0-9]{1,8}#\d{1,4}$/;

export const normalizeCode = (raw: string): string => raw.trim().toUpperCase();
export const isValidCode = (code: string): boolean => CODE_PATTERN.test(code);

/** First two rows get named for you — main/alt is the case by a mile. */
const DEFAULT_LABELS = ["Main", "Alt"];

/** An empty row for the account entry form, pre-labelled by position. */
export const blankAccount = (index: number): Account => ({
  code: "",
  label: DEFAULT_LABELS[index] ?? null,
});

/**
 * Normalize codes, trim labels, drop rows left blank — what the picker and the
 * editor both save. Blank rows are dropped rather than rejected: an empty row
 * is someone who clicked "add another" and changed their mind.
 */
export function cleanAccounts(accounts: Account[]): Account[] {
  return accounts
    .filter((a) => a.code.trim() !== "")
    .map((a) => ({ code: normalizeCode(a.code), label: a.label?.trim() ? a.label.trim() : null }));
}

/**
 * The first problem with a draft account list, or null when it can be saved.
 * Codes compare normalized, so `abcd#1` and `ABCD#1` collide as they should.
 */
export function accountsError(accounts: Account[]): string | null {
  const filled = accounts.filter((a) => a.code.trim() !== "");
  if (filled.length === 0) return "Enter at least one connect code.";
  const seen = new Set<string>();
  for (const a of filled) {
    const code = normalizeCode(a.code);
    if (!isValidCode(code)) return `“${a.code.trim()}” doesn’t look like a connect code — they’re like ABCD#123.`;
    if (seen.has(code)) return `${code} is listed twice.`;
    seen.add(code);
  }
  return null;
}

export interface Filters {
  includeCpuGames: boolean;
  format: Format;
  range: "all" | "7d" | "14d" | "30d" | "90d" | "1y";
  day: string | null; // local YYYY-MM-DD; overrides range when set
  accountCode: string | null; // which of my accounts; null = all of them
  myCharacter: number | null;
  oppCharacter: number | null;
  stageId: number | null;
  opponentCode: string | null;
  teammateCode: string | null; // teams only
  gameTypes: GameType[] | null; // null = all modes
}

export const DEFAULT_FILTERS: Filters = {
  includeCpuGames: false,
  format: "singles",
  range: "all",
  day: null,
  accountCode: null,
  myCharacter: null,
  oppCharacter: null,
  stageId: null,
  opponentCode: null,
  teammateCode: null,
  gameTypes: null,
};

/** A singles game resolved against the chosen identity. */
export interface ResolvedGame {
  rec: GameRecord;
  me: PlayerSide;
  opp: PlayerSide;
  isWin: boolean | null;
  date: Date | null;
  /**
   * Two of the user's own accounts met in this game — rare, but possible once
   * an alt exists and gets lent out. "You" won and lost it simultaneously, so
   * it carries no result: `isWin` is forced null and the game is kept out of
   * opponent breakdowns. It still appears in the game log.
   */
  selfMatch: boolean;
}

/** A 2v2 game resolved against the chosen identity. Win/loss is team-level. */
export interface ResolvedTeamGame {
  rec: GameRecord;
  me: PlayerSide;
  teammate: PlayerSide;
  opps: [PlayerSide, PlayerSide];
  isWin: boolean | null;
  date: Date | null;
  /** See ResolvedGame.selfMatch — here it also covers an alt as the teammate. */
  selfMatch: boolean;
}

/**
 * Which pass of the pipeline is running. "header" is the fast preview over a
 * large library; "full" is the authoritative parse whose records get cached.
 */
export type ParsePassMode = "header" | "full";

export interface ParseProgress {
  /** Counts restart between passes, so read them against `pass`. */
  pass: ParsePassMode;
  /** Files this pass must actually process; cached files are excluded. */
  total: number;
  /** Files attempted in this pass, including failures and retryable skips. */
  done: number;
  /** Files omitted before this pass because their exact version is cached. */
  skippedCached: number;
  /**
   * Parsed and failed. A tombstone was cached and its id is in `seen`, so these
   * files are skipped by every future scan — a refresh will never pick them up.
   * Kept apart from `unreadable` and `deferred` for exactly that reason: the
   * three used to share one counter, and the UI told the user to refresh over
   * the sum of them, which is false for this one.
   */
  failed: number;
  /**
   * Could not be opened or read this time — locked, or gone since discovery.
   * Nothing was cached, so the next scan comes back for them.
   */
  unreadable: number;
  /**
   * Left unparsed on purpose this run: a replay Slippi was still writing, or one
   * that changed under the scan. Nothing is cached for them — not even a
   * tombstone — so the next scan picks them up once the game has finished.
   */
  deferred: number;
}
