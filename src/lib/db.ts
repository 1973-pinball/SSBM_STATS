import Dexie, { type Table } from "dexie";
import { CURRENT_STATS_VERSION, hasCurrentStats } from "./types";
import type { Account, GameRecord } from "./types";
import { dedupeRecords } from "./dedupe";
import type { ReplayFolder } from "./folders";

/**
 * Records live packed ~250 to a row: reading tens of thousands of individual
 * few-KB rows on startup is dominated by per-row IndexedDB overhead, and
 * packing makes the full-cache restore several times faster. Dedup stays
 * per-game via the id-only `seen` table (primary-key reads are cheap).
 */
export interface RecordPack {
  id?: number;
  records: GameRecord[];
}

/** Browser-local knowledge used to make cloud sync incremental after bootstrap. */
export interface StoredCloudSyncState {
  cloudFormatVersion: 2;
  statsVersion: number;
  /** Content-derived game keys acknowledged by the packed cloud mirror. */
  keys: string[];
  /** Greatest server-side game_record_packs.updated_at observed by this device. */
  cursor: string | null;
}

export const CLOUD_SYNC_FORMAT_VERSION = 2;

const PACK_SIZE = 250;

/**
 * Browser-local persistence. Nothing leaves the machine; this exists so a
 * repeat visit only parses files not seen before (keyed on path|size|mtime).
 */
class SsbmDb extends Dexie {
  /** Legacy per-record table; empty since v8. Kept declared so Dexie retains the store. */
  games!: Table<GameRecord, string>;
  packs!: Table<RecordPack, number>;
  seen!: Table<{ id: string }, string>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    // Storage identity predates the public SSBM Stats name. Keep it stable so
    // existing installs retain their parsed replay cache across the rebrand.
    super("ssbm-dashboard");
    this.version(1).stores({
      games: "id, playedAt, stageId, gameType",
      kv: "key",
    });
    // v2 added teams support. Rows parsed by v1 have no teamId/winnerTeamId —
    // they carry no usable 2v2 result, so drop them and let a rescan re-parse.
    this.version(2)
      .stores({
        games: "id, playedAt, stageId, gameType",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx
          .table<GameRecord>("games")
          .toCollection()
          .filter((r) => r.isTeams === true)
          .delete();
      });
    // v3 added per-player action counts, which every older row is missing, so
    // averaging over a mixed cache would silently understate them. Drop all
    // rows; the folder rescan re-parses the library once.
    this.version(3)
      .stores({
        games: "id, playedAt, stageId, gameType",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("games").clear();
      });
    // v4 added counter hits + beneficial trades; same missing-field reasoning.
    this.version(4)
      .stores({
        games: "id, playedAt, stageId, gameType",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("games").clear();
      });
    // v5 added grab counts; same missing-field reasoning.
    this.version(5)
      .stores({
        games: "id, playedAt, stageId, gameType",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("games").clear();
      });
    // v6 fixed quit-out results: LRAS games could credit a win from stale
    // placement data. Cached rows don't record the end method, so the bad
    // ones can't be picked out — drop all rows and let the rescan re-parse.
    this.version(6)
      .stores({
        games: "id, playedAt, stageId, gameType",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("games").clear();
      });
    // v7 added damage/kill matrices and real per-player doubles stats
    // (slippi-js computes nothing for 4-player games, so old teams rows are
    // all zeros). Same missing-field reasoning — full re-parse.
    this.version(7)
      .stores({
        games: "id, playedAt, stageId, gameType",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("games").clear();
      });
    // v8 repacks records into ~250-game rows (see RecordPack). Pure storage
    // reshaping — existing rows are migrated in place, NO re-parse.
    this.version(8)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        const rows = (await tx.table<GameRecord>("games").toArray()) as GameRecord[];
        if (rows.length) {
          await tx.table("seen").bulkPut(rows.map((r) => ({ id: r.id })));
          const packs: RecordPack[] = [];
          for (let i = 0; i < rows.length; i += PACK_SIZE) {
            packs.push({ records: rows.slice(i, i + PACK_SIZE) });
          }
          await tx.table("packs").bulkAdd(packs);
        }
        await tx.table("games").clear();
      });
    // v9 added per-move aggregates (PlayerSide.moveStats) computed from
    // conversions at parse time; same missing-field reasoning as v3–v7 —
    // clear and let the rescan re-parse. Records live in packs since v8,
    // so clear packs + seen rather than the legacy games table.
    this.version(9)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("packs").clear();
        await tx.table("seen").clear();
      });
    // v10 added per-aerial L-cancel counts to MoveAgg; v9 rows lack the
    // fields and would silently understate rates. Clear and re-parse.
    this.version(10)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("packs").clear();
        await tx.table("seen").clear();
      });
    // v11 added per-move attempt counts to MoveAgg (normals + aerials).
    this.version(11)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("packs").clear();
        await tx.table("seen").clear();
      });
    // v12 changes no field, so it is deliberately NOT a full re-parse.
    //
    // `computeTeamsStats` used to throw on a 2v2 frame whose predecessor was
    // missing a player, which failed the parse and wrote a tombstone for the
    // whole game — 13 of 85 doubles replays in one real library. Fixing the
    // parser is not enough on its own: a tombstone's id goes into `seen` like any
    // other record, so `cachedIds()` filters that file out of every future scan
    // and the game stays lost forever.
    //
    // Dropping the tombstones and forgetting their ids re-parses exactly those
    // files and nothing else, which is why this is surgical rather than the
    // clear-everything template of v9–v11: there is no schema skew here, only a
    // set of files whose verdict was wrong. Genuinely corrupt replays simply
    // fail again on the next scan and are tombstoned afresh.
    this.version(12)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        const packs = tx.table<RecordPack>("packs");
        const rows = await packs.toArray();
        const deadIds: string[] = [];
        // Only the packs that actually lose a record get rewritten. Collected
        // here rather than re-derived below, because "did this pack change" is
        // known exactly once — at the moment the filter shortens it.
        const dirty: RecordPack[] = [];
        for (const pack of rows) {
          const kept = pack.records.filter((r) => {
            if (r.parseError === undefined) return true;
            deadIds.push(r.id);
            return false;
          });
          if (kept.length !== pack.records.length) {
            pack.records = kept;
            dirty.push(pack);
          }
        }
        if (deadIds.length === 0) return;
        // This runs inside the blocking versionchange transaction, so the write
        // count is what the user waits through on first load after the deploy.
        // Tombstones cluster in the handful of packs written while the parser
        // was broken, so on a 30k-game library this is a few writes rather than
        // the ~120 that rewriting every row would cost. Packs are storage
        // buckets, not an ordering: survivors stay in slightly under-full rows,
        // and putRecords tops the trailing one up on the next flush.
        for (const pack of dirty) {
          if (pack.id !== undefined) await packs.put(pack);
        }
        await tx.table("seen").bulkDelete(deadIds);
      });
    // v13 added PlayerSide.techs from slippi-js's ground/wall tech counts.
    // Older packed records lack the field and would read as zero tech attempts,
    // so clear and let the folder rescan fill the real counters.
    this.version(13)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("packs").clear();
        await tx.table("seen").clear();
      });
    // v13 correctly invalidated the local cache, but a signed-in cloud restore
    // could immediately persist pre-tech rows again and put their ids back in
    // `seen`. v14 removes only those stale rows, preserving any replay already
    // reparsed by v13, and backfills the lightweight cloud payload version.
    this.version(14)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        const packs = tx.table<RecordPack>("packs");
        const rows = await packs.toArray();
        const staleIds: string[] = [];
        for (const pack of rows) {
          let dirty = false;
          const kept: GameRecord[] = [];
          for (const rec of pack.records) {
            if (!hasCurrentStats(rec)) {
              staleIds.push(rec.id);
              dirty = true;
              continue;
            }
            if (rec.statsVersion !== CURRENT_STATS_VERSION) {
              kept.push({ ...rec, statsVersion: CURRENT_STATS_VERSION });
              dirty = true;
            } else {
              kept.push(rec);
            }
          }
          if (!dirty || pack.id === undefined) continue;
          if (kept.length > 0) await packs.put({ ...pack, records: kept });
          else await packs.delete(pack.id);
        }
        if (staleIds.length > 0) await tx.table("seen").bulkDelete(staleIds);
      });
    // Keep the database version already opened by the CPU-filter release.
    // Rolling it back to v14 would prevent those browsers from opening their
    // cache. This rollback deliberately performs no further cache clearing.
    this.version(15).stores({
      games: "id, playedAt, stageId, gameType",
      packs: "++id",
      seen: "id",
      kv: "key",
    });
    // v16 added actions.crouchCancels, detected from frame-level hit events.
    // Older rows cannot derive it from aggregate Slippi action counts, so clear
    // cached payloads and let remembered folders re-parse with statsVersion 3.
    this.version(16)
      .stores({
        games: "id, playedAt, stageId, gameType",
        packs: "++id",
        seen: "id",
        kv: "key",
      })
      .upgrade(async (tx) => {
        await tx.table("packs").clear();
        await tx.table("seen").clear();
      });
  }
}

export const db = new SsbmDb();

export async function cachedIds(): Promise<Set<string>> {
  const keys = await db.seen.toCollection().primaryKeys();
  return new Set(keys);
}

/**
 * Make specific cached file versions eligible for one explicit repair pass.
 *
 * Only the id-only `seen` marker is removed here. Keeping the old packed row
 * visible avoids making the dashboard lose historical headline stats while
 * the replay is being reparsed; the current replacement wins dedup immediately
 * and the next startup's prune repacks the duplicate away.
 */
export async function forgetCachedRecordIds(ids: Iterable<string>): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length > 0) await db.seen.bulkDelete(unique);
}

export async function putRecords(records: GameRecord[]): Promise<void> {
  if (!records.length) return;
  await db.transaction("rw", db.packs, db.seen, async () => {
    await db.seen.bulkPut(records.map((r) => ({ id: r.id })));
    const queue = [...records];
    // Top up the trailing partial pack before opening new ones.
    const last = await db.packs.orderBy(":id").last();
    if (last && last.records.length < PACK_SIZE) {
      last.records.push(...queue.splice(0, PACK_SIZE - last.records.length));
      await db.packs.put(last);
    }
    while (queue.length) {
      await db.packs.add({ records: queue.splice(0, PACK_SIZE) });
    }
  });
}

export async function allRecords(): Promise<GameRecord[]> {
  const packs = await db.packs.toArray();
  return packs.flatMap((p) => p.records);
}

export async function clearAll(): Promise<void> {
  await db.games.clear();
  await db.packs.clear();
  await db.seen.clear();
  await db.kv.clear();
}

/**
 * Drop cached records duplicating a game already held under a different file
 * key — the residue of a copied, moved, or cloud-synced replay folder (see
 * dedupe.ts). Hands back the survivors, repacking only when there is something
 * to remove, so a clean cache pays one length comparison and no write at all.
 *
 * The caller's array is a hint, used only for that cheap check. The rewrite
 * re-reads inside the transaction, because rebuilding every pack from a
 * snapshot taken before an await is a lost update: a scan flush or a cloud pull
 * landing in that window would be erased while its ids stayed in `seen`, which
 * is the one combination that makes a game unrecoverable — parsed, discarded,
 * and never re-parsed because the cache insists it has seen the file.
 */
export async function pruneDuplicates(all: GameRecord[]): Promise<GameRecord[]> {
  if (dedupeRecords(all).length === all.length) return all;
  let kept = all;
  await db.transaction("rw", db.packs, async () => {
    const current = (await db.packs.toArray()).flatMap((p) => p.records);
    kept = dedupeRecords(current);
    if (kept.length === current.length) return;
    await db.packs.clear();
    const rows: RecordPack[] = [];
    for (let i = 0; i < kept.length; i += PACK_SIZE) rows.push({ records: kept.slice(i, i + PACK_SIZE) });
    if (rows.length) await db.packs.bulkAdd(rows);
  });
  // `seen` deliberately keeps the dropped ids. Those files are still on disk,
  // and it is a "have I read this file" index, not a record index — forgetting
  // them would re-parse the copies on the next scan and recreate exactly the
  // duplicates just removed. The cost is that deleting the surviving copy from
  // disk strands the game until "Change folder" resets the cache.
  return kept;
}

export async function getMyAccounts(): Promise<Account[]> {
  const row = await db.kv.get("myAccounts");
  const stored = row?.value as Account[] | undefined;
  if (stored?.length) return stored;
  // Cache written before multi-account: a bare string[] under the old key.
  // This read stays — unlike the cloud, nothing backfilled anyone's IndexedDB,
  // so it is what migrates an existing user on their first load of this bundle.
  // Drop it only once every user has loaded a build that writes "myAccounts";
  // without it they land back on the identity prompt with their cache intact.
  const legacy = await db.kv.get("myCodes");
  const codes = (legacy?.value as string[] | undefined) ?? [];
  return codes.map((code) => ({ code, label: null }));
}

export async function setMyAccounts(accounts: Account[]): Promise<void> {
  await db.kv.put({ key: "myAccounts", value: accounts });
}

const cloudSyncStateKey = (userId: string) => `cloudSyncState:${userId}`;

export async function getCloudSyncState(userId: string): Promise<StoredCloudSyncState | null> {
  const row = await db.kv.get(cloudSyncStateKey(userId));
  const value = row?.value as Partial<StoredCloudSyncState> | undefined;
  if (
    value?.cloudFormatVersion !== CLOUD_SYNC_FORMAT_VERSION ||
    typeof value?.statsVersion !== "number" ||
    !Array.isArray(value.keys) ||
    !value.keys.every((key) => typeof key === "string") ||
    (value.cursor !== null && typeof value.cursor !== "string")
  ) return null;
  return value as StoredCloudSyncState;
}

export async function setCloudSyncState(userId: string, state: StoredCloudSyncState): Promise<void> {
  await db.kv.put({ key: cloudSyncStateKey(userId), value: state });
}

/**
 * Directory handles are structured-cloneable, so the picked replay folder can be
 * stored and re-walked on a later visit without re-prompting — this is what makes
 * "refresh" a single click instead of a re-pick. Chromium only; other browsers use
 * the <input webkitdirectory> path, which cannot persist a handle.
 */
export async function getReplayFolders(): Promise<ReplayFolder[]> {
  try {
    const folders = await db.kv.get("replayFolders");
    if (folders) return folders.value as ReplayFolder[];
    // Keep the old root's unprefixed file keys: adding folders must not force
    // an existing library to re-parse or strand future stats repairs.
    const row = await db.kv.get("dirHandle");
    return row?.value ? [{ id: "", handle: row.value as FileSystemDirectoryHandle }] : [];
  } catch {
    return [];
  }
}

export async function setReplayFolders(folders: readonly ReplayFolder[]): Promise<boolean> {
  try {
    await db.kv.put({ key: "replayFolders", value: [...folders] });
    return true;
  } catch {
    // The current session can still scan; tell the user a re-pick is needed later.
    return false;
  }
}
