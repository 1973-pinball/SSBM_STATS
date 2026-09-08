import type { Account, GameRecord } from "./types";
import { CURRENT_STATS_VERSION, hasCurrentStats, hasFullStats } from "./types";
import { pruneDuplicates, putRecords } from "./db";
import { dedupeRecords, gameKey } from "./dedupe";
import { supabase } from "./supabase";

/**
 * Sync strategy: the cloud holds the same flattened GameRecords as IndexedDB,
 * but content-keyed inside compressed JSONB packs. One PostgreSQL row per game
 * made a 264k-game project exceed its storage quota mostly through row/index
 * overhead; 256 deterministic buckets per user let TOAST compress the repeated
 * record shape while keeping concurrent writes atomic through an RPC.
 *
 * The first sync bootstraps a compact key/version index. Later syncs persist
 * those keys locally and inspect only packs past an updated_at cursor. Raw
 * replay files (.slp and .slpz) never leave the machine.
 */

/** Keep requests around 2–3 MB without splitting an ordinary hash bucket. */
const PUSH_MAX_RECORDS = 500;
/** Buckets fit in a short .in() query and bound each decompressed response. */
const DATA_PACK_PAGE = 12;
/** A user owns at most 256 rows, so one metadata request is complete. */
const METADATA_PACK_PAGE = 256;
const EMPTY_REMOTE_CURSOR = "1970-01-01T00:00:00.000Z";
const UTF8_ENCODER = new TextEncoder();

const stampCurrentVersion = (rec: GameRecord): GameRecord =>
  rec.statsVersion === CURRENT_STATS_VERSION ? rec : { ...rec, statsVersion: CURRENT_STATS_VERSION };

const compatibleStatsVersion = (version: number | string | undefined): boolean =>
  Number(version) === CURRENT_STATS_VERSION;

export interface SyncResult {
  pushed: number;
  pulled: GameRecord[];
  knowledge: CloudSyncKnowledge;
}

/** Persisted by the caller so repeat syncs can ask only for remote deltas. */
export interface CloudSyncKnowledge {
  /** Current content-derived game keys acknowledged by the cloud. */
  keys: Set<string>;
  /** Greatest server-side pack updated_at observed; null means bootstrap once. */
  cursor: string | null;
}

/** FNV-1a's low byte; mirrors public.game_record_bucket(text) in schema.sql. */
export function gameRecordBucket(key: string): number {
  let hashByte = 197;
  for (const byte of UTF8_ENCODER.encode(key)) hashByte = Math.imul(hashByte ^ byte, 147) & 0xff;
  return hashByte;
}

interface CloudPack {
  bucket: number;
  records: Record<string, GameRecord>;
  versions: Record<string, number | string>;
  updated_at: string;
}

/**
 * Fast path for an empty local cache (new browser/device/custom domain).
 * Fetch packed records in stable bucket order, report progress per response,
 * then persist current payloads. Stale rows remain in memory so headline stats
 * do not vanish while a connected replay folder repairs their execution data.
 */
export async function restoreCloudRecords(
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<GameRecord[]> {
  if (!supabase) return [];
  const records: GameRecord[] = [];
  for (let from = 0; ; from += DATA_PACK_PAGE) {
    let query = supabase
      .from("game_record_packs")
      .select("bucket, records, versions, updated_at")
      .order("bucket", { ascending: true })
      .range(from, from + DATA_PACK_PAGE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data ?? [];
    const currentPage: GameRecord[] = [];
    for (const raw of rows) {
      const pack = raw as CloudPack;
      for (const [key, rec] of Object.entries(pack.records ?? {})) {
        records.push(rec);
        if (compatibleStatsVersion(pack.versions?.[key]) && hasCurrentStats(rec)) {
          currentPage.push(stampCurrentVersion(rec));
        }
      }
    }
    // Persist one response at a time. Handing a 20k-record array to one
    // IndexedDB transaction makes the browser structured-clone the whole
    // library while the network and React copies are still live.
    if (currentPage.length) await putRecords(currentPage);
    onProgress?.(records.length);
    if (rows.length < DATA_PACK_PAGE) break;
  }
  const restored = dedupeRecords(records);
  if (restored.length !== records.length) {
    // Page-wise persistence may temporarily admit two current rows for one
    // legacy game_key. Repack only when the restore actually found duplicates;
    // stale rows were never persisted and need no cleanup.
    const current = records.filter(hasCurrentStats);
    if (dedupeRecords(current).length !== current.length) await pruneDuplicates(current);
  }
  // Stale rows remain available in memory so the rest of the dashboard does
  // not vanish during migration, but they must not enter `seen`: the remembered
  // replay folder needs to regard those files as unparsed and replace them.
  return restored;
}

/**
 * Whether a record may leave the machine: a game one of the user's own accounts
 * actually played, and not a parse-failure tombstone (those carry no stats and
 * can't be re-derived elsewhere).
 *
 * A shared replay folder holds other people's games — a housemate's, a friend's
 * on the same setup. Those still parse and cache locally, because identity is a
 * query-time concept and adding an account later has to be able to reach back
 * and claim them (decision 1). But uploading someone else's stats to the user's
 * private project isn't the user's call to make, so the network boundary is
 * where participation starts to matter.
 *
 * The same predicate has to gate CloudSync's pending count. Filtering the push
 * alone would leave every foreign game permanently unsynced, pinning the button
 * gold and re-arming the auto-push on each change.
 */
export function isSyncable(rec: GameRecord, myCodes: Set<string>): boolean {
  if (rec.parseError) return false;
  // Header previews are transient and carry zeroed execution metrics. A push
  // would replace the full value another device already holds under the same
  // content key — and because the preview is never written to the local cache,
  // nothing here would ever correct it back.
  if (!hasFullStats(rec)) return false;
  // A stale cloud row must never overwrite the current copy on another
  // device. It becomes syncable only after that device reparses the replay.
  if (!hasCurrentStats(rec)) return false;
  return rec.players.some((p) => p.connectCode !== null && myCodes.has(p.connectCode));
}

interface RemoteIndex {
  currentKeys: Set<string>;
  observedKeys: Set<string>;
  bucketByKey: Map<string, number>;
  latestUpdatedAt: string | null;
}

interface RemotePackIndexRow {
  bucket: number;
  versions: Record<string, number | string>;
  updated_at: string;
}

const emptyRemoteIndex = (keys: Iterable<string> = []): RemoteIndex => ({
  currentKeys: new Set(keys),
  observedKeys: new Set(),
  bucketByKey: new Map(),
  latestUpdatedAt: null,
});

const addRemotePack = (index: RemoteIndex, row: RemotePackIndexRow): void => {
  for (const [key, version] of Object.entries(row.versions ?? {})) {
    index.observedKeys.add(key);
    index.bucketByKey.set(key, row.bucket);
    if (compatibleStatsVersion(version)) index.currentKeys.add(key);
    else index.currentKeys.delete(key);
  }
  if (!index.latestUpdatedAt || row.updated_at > index.latestUpdatedAt) index.latestUpdatedAt = row.updated_at;
};

async function remoteIndex(): Promise<RemoteIndex> {
  const index = emptyRemoteIndex();
  if (!supabase) return index;
  const { data, error } = await supabase
    .from("game_record_packs")
    .select("bucket, versions, updated_at")
    .order("bucket", { ascending: true })
    .range(0, METADATA_PACK_PAGE - 1);
  if (error) throw error;
  for (const raw of data) addRemotePack(index, raw as RemotePackIndexRow);
  return index;
}

/** Fetch only metadata changed after the last observed server timestamp. */
async function remoteChangesSince(cursor: string): Promise<RemoteIndex> {
  const index = emptyRemoteIndex();
  if (!supabase) return index;
  const { data, error } = await supabase
    .from("game_record_packs")
    .select("bucket, versions, updated_at")
    .gt("updated_at", cursor)
    .order("updated_at", { ascending: true })
    .order("bucket", { ascending: true })
    .range(0, METADATA_PACK_PAGE - 1);
  if (error) throw error;
  for (const raw of data) addRemotePack(index, raw as RemotePackIndexRow);
  return index;
}

const mergeRemoteIndex = (target: RemoteIndex, source: RemoteIndex): void => {
  for (const key of source.observedKeys) {
    if (!source.currentKeys.has(key)) target.currentKeys.delete(key);
  }
  for (const key of source.currentKeys) target.currentKeys.add(key);
  for (const [key, bucket] of source.bucketByKey) target.bucketByKey.set(key, bucket);
  if (source.latestUpdatedAt) target.latestUpdatedAt = source.latestUpdatedAt;
};

interface PushEntry {
  game_key: string;
  data: GameRecord;
  stats_version: number;
}

async function pushMissing(local: GameRecord[], remote: RemoteIndex, myCodes: Set<string>): Promise<number> {
  if (!supabase) return 0;
  const byBucket = new Map<number, PushEntry[]>();
  const queuedKeys = new Set(remote.currentKeys);
  for (const rec of local) {
    if (!isSyncable(rec, myCodes)) continue;
    const key = gameKey(rec);
    if (queuedKeys.has(key)) continue;
    queuedKeys.add(key);
    const bucket = gameRecordBucket(key);
    const entries = byBucket.get(bucket) ?? [];
    entries.push({ game_key: key, data: stampCurrentVersion(rec), stats_version: CURRENT_STATS_VERSION });
    byBucket.set(bucket, entries);
  }

  // Keep a bucket intact wherever possible. Splitting random records into 500s
  // would touch most buckets in every request and repeatedly rewrite each
  // growing TOAST value during a large first sync.
  const batches: PushEntry[][] = [];
  let batch: PushEntry[] = [];
  for (const [, entries] of [...byBucket].sort(([a], [b]) => a - b)) {
    if (batch.length > 0 && batch.length + entries.length > PUSH_MAX_RECORDS) {
      batches.push(batch);
      batch = [];
    }
    if (entries.length > PUSH_MAX_RECORDS) {
      if (batch.length > 0) batches.push(batch);
      batch = [];
      for (let i = 0; i < entries.length; i += PUSH_MAX_RECORDS) batches.push(entries.slice(i, i + PUSH_MAX_RECORDS));
    } else {
      batch.push(...entries);
    }
  }
  if (batch.length > 0) batches.push(batch);

  let pushed = 0;
  for (const entries of batches) {
    const { error } = await supabase.rpc("merge_game_record_entries", { entries });
    if (error) throw error;
    for (const entry of entries) {
      remote.currentKeys.add(entry.game_key);
      remote.bucketByKey.set(entry.game_key, gameRecordBucket(entry.game_key));
    }
    pushed += entries.length;
  }
  return pushed;
}

async function pullMissing(local: GameRecord[], remote: RemoteIndex): Promise<GameRecord[]> {
  if (!supabase) return [];
  const haveKeys = new Set(local.map(gameKey));
  const missing = new Set([...remote.currentKeys].filter((key) => !haveKeys.has(key)));
  const buckets = [...new Set([...missing].map((key) => remote.bucketByKey.get(key)).filter((v): v is number => v !== undefined))];
  const pulled: GameRecord[] = [];
  for (let i = 0; i < buckets.length; i += DATA_PACK_PAGE) {
    const { data, error } = await supabase
      .from("game_record_packs")
      .select("bucket, records, versions, updated_at")
      .in("bucket", buckets.slice(i, i + DATA_PACK_PAGE));
    if (error) throw error;
    const accepted: GameRecord[] = [];
    for (const raw of data) {
      const pack = raw as CloudPack;
      for (const [key, rec] of Object.entries(pack.records ?? {})) {
        if (!missing.has(key) || haveKeys.has(key) || !compatibleStatsVersion(pack.versions?.[key])) continue;
        haveKeys.add(key);
        missing.delete(key);
        pulled.push(rec);
        accepted.push(rec);
      }
    }
    if (accepted.length) await putRecords(accepted);
  }
  return pulled;
}

/**
 * Two-way reconcile. Caller passes the full local record list (it already has
 * it in memory) and gets back what was pushed/pulled; pulled records are
 * already persisted locally, so the caller only needs to update React state.
 */
export async function syncRecords(
  local: GameRecord[],
  myCodes: Set<string>,
  known?: CloudSyncKnowledge,
): Promise<SyncResult> {
  if (!supabase) return { pushed: 0, pulled: [], knowledge: { keys: new Set(), cursor: null } };

  // First run on this packed format pays for the complete key/version index.
  // Every successful run after that asks only for changed pack metadata.
  if (!known?.cursor) {
    const remote = await remoteIndex();
    const pushed = await pushMissing(local, remote, myCodes);
    // The pull stays unfiltered: RLS means everything up there is already this
    // user's, and anything a pre-participation-filter release left behind is
    // dropped at resolve time anyway. Filtering here would also break the
    // fresh-device restore, which syncs before it knows what the accounts are.
    const pulled = await pullMissing(local, remote);
    return {
      pushed,
      pulled,
      // An empty remote has no timestamp yet. Keep an epoch cursor rather than
      // bootstrapping again; the next delta observes our pushes and closes the
      // query-then-push race with another device.
      knowledge: { keys: new Set(remote.currentKeys), cursor: remote.latestUpdatedAt ?? EMPTY_REMOTE_CURSOR },
    };
  }

  const remote = emptyRemoteIndex(known.keys);
  const changes = await remoteChangesSince(known.cursor);
  mergeRemoteIndex(remote, changes);
  const pulled = await pullMissing(local, changes);
  const pushed = await pushMissing(local, remote, myCodes);
  return {
    pushed,
    pulled,
    // Deliberately do not advance the cursor from our own pushes. The next
    // delta observes those packs and any concurrent device write together.
    knowledge: { keys: new Set(remote.currentKeys), cursor: changes.latestUpdatedAt ?? known.cursor },
  };
}

/**
 * Cloud copy of the user's accounts; last write wins, which matches the UX.
 * Array position becomes sort_order, so the editor's ordering survives a
 * restore — the first account is the one that titles the player card.
 */
export async function pushMyAccounts(accounts: Account[]): Promise<void> {
  if (!supabase) return;
  if (accounts.length) {
    // user_id comes from the column default (auth.uid()), same as record packs.
    const rows = accounts.map((a, i) => ({ code: a.code, label: a.label, sort_order: i }));
    const { error } = await supabase.from("user_codes").upsert(rows, { onConflict: "user_id,code" });
    if (error) throw error;
  }
  // An account removed in the editor has to actually disappear — upsert alone
  // would leave it behind. Diffing against what's up there beats deleting the
  // lot first, which would strand the user with no identity if the write failed.
  const { data, error } = await supabase.from("user_codes").select("code");
  if (error) throw error;
  const keep = new Set(accounts.map((a) => a.code));
  const stale = data.map((r) => r.code as string).filter((c) => !keep.has(c));
  if (stale.length) {
    const { error: delError } = await supabase.from("user_codes").delete().in("code", stale);
    if (delError) throw delError;
  }
}

export async function pullMyAccounts(signal?: AbortSignal): Promise<Account[] | null> {
  if (!supabase) return null;
  let query = supabase
    .from("user_codes")
    .select("code, label, sort_order")
    .order("sort_order", { ascending: true });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  // No user_settings fallback: the schema's backfill copied every pre-existing
  // my_codes array into user_codes, so a user who had an identity before the
  // migration already has rows here. Empty genuinely means "never set one".
  return data.length
    ? data.map((r) => ({ code: r.code as string, label: (r.label as string | null) ?? null }))
    : null;
}
