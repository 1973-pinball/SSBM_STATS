import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account, GameRecord } from "../lib/types";
import { CURRENT_STATS_VERSION } from "../lib/types";
import { cloudEnabled, currentSession, onAuthChange, signInWithGoogle, signOut, type Session } from "../lib/supabase";
import { isSyncable, pushMyAccounts, syncRecords, type CloudSyncKnowledge } from "../lib/cloudSync";
import { CLOUD_SYNC_FORMAT_VERSION, getCloudSyncState, setCloudSyncState } from "../lib/db";
import { gameKey } from "../lib/dedupe";
import { GoogleG } from "./GoogleG";

interface Props {
  records: GameRecord[];
  accounts: Account[];
  isDemo: boolean;
  /** Cloud work waits until the replay worker/storage pipeline is idle. */
  isParsing: boolean;
  /** App's reset generation when this mounted — stale syncs identify themselves with it. */
  generation: number;
  /** Pulled records are already in the local cache; parent only updates state. */
  onPulled: (pulled: GameRecord[], generation: number) => void;
}

type SyncState = { kind: "idle" } | { kind: "busy" } | { kind: "done"; pushed: number; pulled: number } | { kind: "error" };

/**
 * Optional account layer: sign in with Google to mirror the local record cache
 * to Supabase (flattened stats only — never raw .slp or .slpz files). Renders nothing when
 * the Supabase env vars are absent, keeping the app local-only by default.
 */
export function CloudSync({ records, accounts, isDemo, isParsing, generation, onPulled }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [sync, setSync] = useState<SyncState>({ kind: "idle" });
  // Content keys acknowledged by the cloud as of the last successful sync.
  // Unlike file ids they survive a folder move, so copied local paths never
  // look like thousands of new games. Null until knowledge is restored/synced.
  const [syncedVersions, setSyncedVersions] = useState<Map<string, number> | null>(null);
  const autoSynced = useRef(false);
  const knowledge = useRef<CloudSyncKnowledge | null>(null);
  const knowledgeOwner = useRef<string | null>(null);
  const [knowledgeReady, setKnowledgeReady] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const parsingRef = useRef(isParsing);
  parsingRef.current = isParsing;

  // Latest props for the auto-sync effect without re-triggering it per change.
  const latest = useRef({ records, accounts, generation });
  latest.current = { records, accounts, generation };

  useEffect(() => {
    if (!cloudEnabled) return;
    void currentSession().then(setSession);
    return onAuthChange(setSession);
  }, []);

  // A successful sync leaves enough browser-local knowledge to query only
  // packs changed since its server cursor. Scope it by auth user: two people
  // sharing a browser must never reuse one another's private content-key set.
  useEffect(() => {
    autoSynced.current = false;
    knowledge.current = null;
    knowledgeOwner.current = null;
    setSyncedVersions(null);
    setKnowledgeReady(false);
    const userId = session?.user.id;
    if (!userId) {
      setKnowledgeReady(true);
      return;
    }
    let active = true;
    void getCloudSyncState(userId)
      .then((stored) => {
        if (!active) return;
        if (stored?.cloudFormatVersion === CLOUD_SYNC_FORMAT_VERSION && stored.statsVersion === CURRENT_STATS_VERSION) {
          const restored = { keys: new Set(stored.keys), versions: new Map(Object.entries(stored.versions)), cursor: stored.cursor };
          knowledge.current = restored;
          setSyncedVersions(new Map(restored.versions));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) {
          knowledgeOwner.current = userId;
          setKnowledgeReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [session?.user.id]);

  const busyRef = useRef(false);
  const lastSyncAt = useRef(0);

  const runSync = useCallback(async () => {
    if (busyRef.current || parsingRef.current) return; // auto-triggers can race parsing or the manual button
    busyRef.current = true;
    setSync({ kind: "busy" });
    try {
      const { records: recs, accounts: accts, generation: gen } = latest.current;
      const codes = new Set(accts.map((a) => a.code));
      const userId = sessionRef.current?.user.id;
      const result = await syncRecords(recs, codes, knowledge.current ?? undefined);
      if (result.pulled.length) onPulled(result.pulled, gen);
      knowledge.current = result.knowledge;
      setSyncedVersions(new Map(result.knowledge.versions));
      if (userId) {
        // Losing this optimization state is safe: the next visit performs one
        // metadata bootstrap. It must not turn an otherwise successful cloud
        // backup into a visible sync failure when local storage is tight.
        await setCloudSyncState(userId, {
          cloudFormatVersion: CLOUD_SYNC_FORMAT_VERSION,
          statsVersion: CURRENT_STATS_VERSION,
          keys: [...result.knowledge.keys],
          versions: Object.fromEntries(result.knowledge.versions),
          cursor: result.knowledge.cursor,
        }).catch(console.error);
      }
      // The dashboard always has accounts (identity is confirmed before entry);
      // fresh-device adoption of cloud accounts happens in App's landing restore.
      if (accts.length) await pushMyAccounts(accts);
      setSync({ kind: "done", pushed: result.pushed, pulled: result.pulled.length });
    } catch (err) {
      console.error(err);
      setSync({ kind: "error" });
    } finally {
      busyRef.current = false;
      lastSyncAt.current = Date.now();
    }
  }, [onPulled]);

  // One automatic reconcile per visit once signed in — manual after that.
  useEffect(() => {
    if (
      !session ||
      !knowledgeReady ||
      knowledgeOwner.current !== session.user.id ||
      isDemo ||
      isParsing ||
      autoSynced.current
    ) return;
    autoSynced.current = true;
    void runSync();
  }, [session, knowledgeReady, isDemo, isParsing, runSync]);

  // Games of the user's own parsed since the last sync (e.g. a folder Refresh
  // mid-session). Adding an account makes its games newly syncable, so they
  // show up here and the auto-push picks them up without a rescan.
  const pending = useMemo(() => {
    if (!syncedVersions) return 0;
    const codes = new Set(accounts.map((a) => a.code));
    let n = 0;
    const counted = new Set<string>();
    for (const r of records) {
      if (!isSyncable(r, codes)) continue;
      const key = gameKey(r);
      if ((syncedVersions.get(key) ?? -1) < r.statsVersion! && !counted.has(key)) {
        counted.add(key);
        n++;
      }
    }
    return n;
  }, [records, syncedVersions, accounts]);

  // Auto-push: newly parsed games sync on their own once the parse stream goes
  // quiet (record appends arrive ~1/s, so 2.5s of quiet ≈ done). One attempt
  // per pending count — a failure (offline) leaves the gold manual button
  // rather than a retry loop, and any further parsing re-arms the attempt.
  const autoPushTried = useRef<number | null>(null);
  useEffect(() => {
    if (pending === 0) {
      autoPushTried.current = null;
      return;
    }
    if (!session || isParsing || sync.kind === "busy" || autoPushTried.current === pending) return;
    const t = window.setTimeout(() => {
      autoPushTried.current = pending;
      void runSync();
    }, 2500);
    return () => window.clearTimeout(t);
  }, [pending, session, isParsing, sync.kind, runSync]);

  // Auto-pull: returning to the tab periodically re-syncs so games pushed from
  // another device appear without a manual sync or reload. Fifteen minutes
  // keeps convergence automatic without turning normal tab switching into a
  // database request; the old one-minute interval repeatedly listed 20k ids.
  useEffect(() => {
    if (!session || isDemo || isParsing) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastSyncAt.current < 15 * 60_000) return;
      void runSync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [session, isDemo, isParsing, runSync]);

  if (!cloudEnabled || isDemo) return null;

  if (!session) {
    return (
      <button className="ghost" onClick={() => void signInWithGoogle().catch(console.error)}>
        <span className="btn-icon">
          <GoogleG size={14} />
          Sign in with Google
        </span>
      </button>
    );
  }

  // Pending games outrank the "done" receipt: after a folder Refresh the
  // button flips gold to say new games still need a push.
  const hasPending = sync.kind !== "busy" && pending > 0;
  const label =
    sync.kind === "busy"
      ? "Syncing…"
      : hasPending
        ? `Sync ${pending.toLocaleString()} game update${pending === 1 ? "" : "s"}`
        : sync.kind === "done"
          ? "Synced ✓"
          : sync.kind === "error"
            ? "Sync failed — retry"
            : "Sync to cloud";

  return (
    <>
      <button
        className={hasPending ? "ghost attn" : "ghost"}
        title={
          isParsing
            ? "Cloud sync will be available when replay parsing finishes"
            : sync.kind === "done"
            ? `Last sync: ${sync.pushed.toLocaleString()} pushed, ${sync.pulled.toLocaleString()} pulled`
            : undefined
        }
        onClick={() => void runSync()}
        disabled={isParsing || sync.kind === "busy"}
      >
        {label}
      </button>
      <button
        className="ghost"
        title={session.user.email ?? undefined}
        onClick={() =>
          void signOut().then(() => {
            setSync({ kind: "idle" });
            setSyncedVersions(null);
            knowledge.current = null;
            knowledgeOwner.current = null;
          })
        }
      >
        Sign out
      </button>
    </>
  );
}
