import type { GameRecord } from "./types";
import { hasCurrentStats, hasFullStats } from "./types";

/**
 * `GameRecord.id` is `path|size|mtime`. It answers "have I already parsed this
 * file?", which is what makes a folder rescan cheap — and it is the right key
 * for that job. It does not answer "is this the same game?", and the two
 * diverge as soon as a replay folder is shared or moved:
 *
 *  - copying the folder to a second machine changes every path;
 *  - Dropbox / Drive / SMB shares routinely rewrite mtimes;
 *  - re-organizing replays into per-month subfolders changes both.
 *
 * Each of those produces a second record for a game already in the cache,
 * which would inflate game counts, hours played, and win-rate denominators.
 *
 * So game identity comes from inside the replay instead. Two games cannot start
 * in the same second, on the same stage, between the same players.
 */
export function gameKey(rec: GameRecord): string {
  // No start timestamp — pre-metadata replays, and the parse-failure tombstones
  // pool.ts writes. There is nothing stable to match on, so fall back to the
  // file key: such a record dedups against a rescan of that same file and
  // nothing else, which is the honest answer rather than a risky guess.
  if (!rec.playedAt) return rec.id;
  // A connect code identifies a netplay side across copies. Offline sides have
  // none, so port + character stands in. Sorted because port order is not
  // guaranteed identical between the two records we are trying to match.
  const sides = rec.players
    .map((p) => p.connectCode ?? `p${p.port}:${p.characterId}`)
    .sort()
    .join("+");
  return `${rec.playedAt}|${rec.stageId}|${sides}`;
}

/** True when `a` should survive dedup over `b`. */
function preferred(a: GameRecord, b: GameRecord): boolean {
  const aTombstone = a.parseError !== undefined;
  const bTombstone = b.parseError !== undefined;
  // A real record beats a tombstone. This does not fire today — pool.ts writes
  // tombstones with playedAt null, so they key on their file id and can never
  // collide with anything. It is here so that a tombstone which one day does
  // carry a timestamp (header read, stats failed) loses to the copy of that
  // game which parsed cleanly on another machine, rather than winning on id.
  if (aTombstone !== bTombstone) return bTombstone;
  // A full parse beats the header preview standing in for it. Those two collide
  // on the *same id* — one file, read once by each pass — so the id comparison
  // below cannot separate them and would keep whichever landed first, which is
  // always the preview. The library would then sit on zeroed execution metrics
  // until the next reload rebuilt state from the cache.
  const aFull = hasFullStats(a);
  const bFull = hasFullStats(b);
  if (aFull !== bFull) return aFull;
  // A replay reparsed with the current stat payload beats its pre-tech cloud
  // copy, including when a moved folder gave the two records different ids.
  const aCurrent = hasCurrentStats(a);
  const bCurrent = hasCurrentStats(b);
  if (aCurrent !== bCurrent) return aCurrent;
  // Optional contextual analysis upgrades v6 to v7 without invalidating the
  // baseline. Prefer the analyzed copy even when a cloud response arrives late.
  if ((a.statsVersion ?? 0) !== (b.statsVersion ?? 0)) return (a.statsVersion ?? 0) > (b.statsVersion ?? 0);
  return a.id < b.id;
}

export function mergeGameRecords(a: GameRecord, b: GameRecord): GameRecord {
  return preferred(a, b) ? mergeCpuStatus(a, b) : mergeCpuStatus(b, a);
}

/** Preserve optional header evidence without replacing the chosen stats.
 * A late old cloud copy must not erase a known CPU, and conflicting evidence
 * stays included. An explicit null preserves that conflict across later merges. */
export function mergeCpuStatus(keep: GameRecord, other: GameRecord): GameRecord {
  let changed = false;
  const players = keep.players.map((player) => {
    const match = other.players.find((p) => p.port === player.port
      && p.characterId === player.characterId && p.connectCode === player.connectCode);
    if (!match) return player;
    const current = player.isCpu;
    const incoming = match.isCpu;
    const conflict = current === null || incoming === null
      || (typeof current === "boolean" && typeof incoming === "boolean" && current !== incoming);
    const next = conflict ? null : current === undefined ? incoming : current;
    if (next === current) return player;
    changed = true;
    return { ...player, isCpu: next };
  });
  return changed ? { ...keep, players } : keep;
}

/**
 * Drop the residue of a replay that was read while Slippi was still writing it.
 *
 * Such a read has no metadata block and therefore no `playedAt`, and it was
 * cached under `path|partialSize|partialMtime`; the finished game then parsed
 * under a different id off the same file. gameKey() falls back to the file id
 * when playedAt is null, so the two never collapse — the fragment survives as a
 * dateless phantom inflating game counts, and no rescan can dislodge it because
 * its id is still in `seen`.
 *
 * The path ties them together: one file on disk has one current state, so a
 * null-playedAt record for a path that also has a timestamped one is a stale
 * read of it (a stale tombstone for that path is stale for the same reason).
 * Records for paths with no timestamped read at all are left alone — that's the
 * genuine pre-metadata replay of decision 8, not a fragment.
 *
 * pool.ts no longer creates these, but caches written before that fix carry them.
 */
function dropStalePartials(records: GameRecord[]): GameRecord[] {
  let anyNull = false;
  const timestamped = new Set<string>();
  for (const rec of records) {
    if (rec.playedAt) timestamped.add(rec.path);
    else anyNull = true;
  }
  if (!anyNull || timestamped.size === 0) return records;
  const kept = records.filter((rec) => rec.playedAt !== null || !timestamped.has(rec.path));
  return kept.length === records.length ? records : kept;
}

/**
 * Collapse records describing the same game down to one apiece.
 *
 * The survivor is chosen deterministically — real record over tombstone, then
 * lowest id — rather than first-wins, because the cache restore, the folder
 * scan and a cloud pull all race to deliver records. Order-dependent survivors
 * would mean a different React key for the same game between two loads.
 *
 * Returns the input array untouched when there is nothing to collapse, so the
 * common case doesn't invalidate every downstream memo.
 */
export function dedupeRecords(records: GameRecord[]): GameRecord[] {
  const live = dropStalePartials(records);
  const best = new Map<string, GameRecord>();
  for (const rec of live) {
    const key = gameKey(rec);
    const cur = best.get(key);
    if (cur === undefined) best.set(key, rec);
    else best.set(key, preferred(rec, cur) ? mergeCpuStatus(rec, cur) : mergeCpuStatus(cur, rec));
  }
  return best.size === live.length ? live : [...best.values()];
}
