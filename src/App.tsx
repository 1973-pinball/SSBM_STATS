import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Account, Filters, GameRecord, ParseProgress } from "./lib/types";
import { DEFAULT_FILTERS, hasFullStats, hasKnownCpu, needsStatsRepair } from "./lib/types";
import {
  discoverFromHandle,
  discoverFromFolders,
  discoverFromFileList,
  runParsePipeline,
  RecordSaveError,
  type DiscoveredFile,
} from "./lib/pool";
import { allRecords, clearAll, forgetCachedRecordIds, getMyAccounts, setMyAccounts, getReplayFolders, setReplayFolders, pruneDuplicates } from "./lib/db";
import { accessibleReplayFolders, addReplayFolder, type ReplayFolder } from "./lib/folders";
import { codeGameCounts, resolveGames, resolveTeamGames, applyFilters, applyTeamFilters } from "./lib/stats";
import { dedupeRecords, mergeCpuStatus } from "./lib/dedupe";
import { generateDemoRecords, DEMO_ACCOUNTS } from "./lib/demo";
import { Landing } from "./components/Landing";
import { ProgressBar, IdentityPicker } from "./components/ProgressAndIdentity";
import { FilterBar } from "./components/FilterBar";
import { CloudSync } from "./components/CloudSync";
import { CommunityConsent } from "./components/CommunityConsent";
import { cloudEnabled, currentSession, signInWithGoogle } from "./lib/supabase";
import { pullMyAccounts, restoreCloudRecords } from "./lib/cloudSync";
import { moveTabFocus } from "./lib/a11y";

// Dashboard views are lazy so the landing/parsing path doesn't pay for
// recharts — it's the biggest dependency in the app and none of it renders
// before the dashboard phase.
const Overview = lazy(() => import("./components/Overview").then((m) => ({ default: m.Overview })));
const Teams = lazy(() => import("./components/Teams").then((m) => ({ default: m.Teams })));
const MetricsGuide = lazy(() => import("./components/MetricsGuide").then((m) => ({ default: m.MetricsGuide })));
const Matchups = lazy(() => import("./components/Views").then((m) => ({ default: m.Matchups })));
const Stages = lazy(() => import("./components/Views").then((m) => ({ default: m.Stages })));
const Opponents = lazy(() => import("./components/Views").then((m) => ({ default: m.Opponents })));
const Execution = lazy(() => import("./components/Views").then((m) => ({ default: m.Execution })));

const Community = lazy(() => import("./components/Community").then((m) => ({ default: m.Community })));
const Insights = lazy(() => import("./components/Insights").then((m) => ({ default: m.Insights })));


const Liquipedia = lazy(() => import("./components/liquipedia/Liquipedia").then((m) => ({ default: m.Liquipedia })));
const TournamentArchive = lazy(() => import("./components/TournamentArchive").then((m) => ({ default: m.TournamentArchive })));
const AccountsEditor = lazy(() => import("./components/AccountsEditor").then((m) => ({ default: m.AccountsEditor })));
const PrivacyPromise = lazy(() => import("./components/PrivacyPromise").then((m) => ({ default: m.PrivacyPromise })));

/**
 * Last line of defense for lazy-chunk failures: main.tsx auto-reloads once on
 * vite:preloadError, but if the chunk is still missing (guard window, server
 * trouble) the thrown error would otherwise white-screen the whole app.
 */
class ViewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="error-note" role="alert">
        This view failed to load — the site probably updated while this tab was open.
        <button className="ghost" style={{ marginLeft: 10 }} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

type Phase = "landing" | "parsing" | "identity" | "dashboard";
// "sessions", "records" and "log" are gone: the fatigue and tilt tables render
// inside Insights, personal bests are a card at the foot of Overview, and the
// game log is a collapsed panel on Opponents. tabFromUrl validates against
// TABS, so an old ?view= link for any of them falls back to overview rather
// than rendering nothing.
type Tab = "overview" | "matchups" | "stages" | "opponents" | "execution" | "insights" | "community" | "liquipedia" | "tournaments";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "matchups", label: "Matchups" },
  { id: "stages", label: "Stages" },
  { id: "opponents", label: "Opponents" },

  { id: "execution", label: "Execution" },
  { id: "insights", label: "Insights" },


  { id: "community", label: "Community" },
  { id: "tournaments", label: "Tournament Predictions" },
  { id: "liquipedia", label: "Liquipedia" },
];

/**
 * Tabs whose numbers are computed from frames. A header preview carries the
 * result, the characters and the stage but no execution metrics at all (see
 * runParsePipeline), so while any survive these tabs would average over
 * whatever scattered fraction of the library the full pass had reached and
 * draw the answer as a trend line — something that looks like data and is not.
 * The rest of the tabs read only what a preview already knows, which is the
 * whole point of parsing headers first.
 */
const NEEDS_FULL_STATS: ReadonlySet<Tab> = new Set<Tab>(["execution", "insights"]);

/** Said on the tab itself and, for a deep link that landed on one, in its panel. */
const PENDING_TAB_HINT = "Loading — waiting on execution stats from the parse still running";

type Overlay = "guide" | "accounts" | "privacy" | null;
type PublicView = "community" | "liquipedia" | "tournaments" | null;
interface AppHistoryState { ssbm: true; tab: Tab; overlay: Overlay; publicView: PublicView }

const tabFromUrl = (): Tab => {
  if (typeof window === "undefined") return "overview";
  const value = new URL(window.location.href).searchParams.get("view");
  return TABS.some((t) => t.id === value) ? value as Tab : "overview";
};

const overlayFromUrl = (): Overlay => {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get("overlay");
  return value === "guide" || value === "accounts" || value === "privacy" ? value : null;
};

const navUrl = (tab: Tab, overlay: Overlay = null) => {
  const url = new URL(window.location.href);
  url.searchParams.set("view", tab);
  if (overlay) url.searchParams.set("overlay", overlay);
  else url.searchParams.delete("overlay");
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * The three ways a scan can leave a file unparsed. Two are retryable and one
 * is not, which is the whole point of keeping them apart.
 */
type SkipTally = Pick<ParseProgress, "failed" | "unreadable" | "deferred">;

/**
 * Why the last refresh left files unparsed, in the user's terms.
 *
 * The retryable and the permanent are described in separate sentences and never
 * summed. They used to share one counter under one sentence promising a refresh
 * would pick everything up, which is false for a replay that parsed and failed:
 * that one is tombstoned and its id is in `seen`, so no refresh will revisit it.
 */
function skippedDetail({ failed, unreadable, deferred }: SkipTally): string {
  const retryable: string[] = [];
  if (deferred > 0) {
    retryable.push(`${deferred.toLocaleString()} replay${deferred === 1 ? " was" : "s were"} still being written`);
  }
  if (unreadable > 0) retryable.push(`${unreadable.toLocaleString()} couldn't be opened`);

  const sentences: string[] = [];
  if (retryable.length > 0) {
    sentences.push(`${retryable.join(", ")}. Nothing was cached for them — refresh once Slippi has finished writing and they'll be picked up.`);
  }
  if (failed > 0) {
    sentences.push(
      `${failed.toLocaleString()} couldn't be parsed and ${failed === 1 ? "was" : "were"} set aside — ${failed === 1 ? "it" : "they"} won't be retried, so refreshing won't change this.`,
    );
  }
  return sentences.join(" ");
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("landing");
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  const [records, setRecords] = useState<GameRecord[]>([]);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [accounts, setAccountsState] = useState<Account[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [isDemo, setIsDemo] = useState(false);
  const [showGuide, setShowGuide] = useState(() => overlayFromUrl() === "guide");
  const [showAccounts, setShowAccounts] = useState(() => overlayFromUrl() === "accounts");
  const [showPrivacy, setShowPrivacy] = useState(() => overlayFromUrl() === "privacy");
  // Public aggregate/history views need no replays, so both are reachable
  // straight from the landing page as well as from dashboard tabs.
  const [publicView, setPublicView] = useState<PublicView>(() => {
    const initial = tabFromUrl();
    return initial === "community" || initial === "liquipedia" || initial === "tournaments" ? initial : null;
  });
  const [folders, setFolders] = useState<ReplayFolder[]>([]);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folderIssues, setFolderIssues] = useState<string[]>([]);
  const pickerBusy = useRef(false);
  const [syncing, setSyncing] = useState<ParseProgress | null>(null);
  // What the last refresh chose not to parse. Nothing is cached for these, so
  // they are genuinely pending rather than lost — but a silent skip is exactly
  // what makes "my new games didn't show up" impossible to diagnose.
  const [syncSkipped, setSyncSkipped] = useState<SkipTally | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  // Null means idle; a number is the count streamed down so a first visit on a
  // new origin never looks frozen while a large cloud library is restoring.
  const [cloudRestoring, setCloudRestoring] = useState<number | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [folderPermission, setFolderPermission] = useState<PermissionState | "unknown">("unknown");
  const [lastScanned, setLastScanned] = useState<string | null>(() => localStorage.getItem("ssbm-last-scanned"));
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateApplied, setUpdateApplied] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const autoSyncDone = useRef(false);
  // Four callers now walk the folder — the load auto-sync, the Refresh click,
  // a folder connect, and the re-focus rescan. Two overlapping runs would
  // stomp each other's abort controller and re-parse what the first was still
  // streaming in, so they take turns.
  const scanBusy = useRef(false);
  // When the last walk finished; throttles the re-focus rescan.
  const lastFolderSyncAt = useRef(0);
  // Browsers without the File System Access API can never remember a folder,
  // so the topbar keeps a directory input for re-picks. A separate ordinary
  // multi-file input lets every browser add a one-off selection.
  const topbarFolderPickRef = useRef<HTMLInputElement>(null);
  const topbarFilesPickRef = useRef<HTMLInputElement>(null);
  // Bumped by reset(); async work captures the value at start and drops its
  // results if a reset happened in between, so an abandoned scan or cloud sync
  // can't write stale records into a wiped session.
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const supportsFsAccess = typeof window !== "undefined" && "showDirectoryPicker" in window;

  const markScanned = useCallback(() => {
    const now = new Date().toISOString();
    localStorage.setItem("ssbm-last-scanned", now);
    setLastScanned(now);
  }, []);

  const selectTab = useCallback((next: Tab, replace = false) => {
    setTab(next);
    setPublicView(null);
    const state: AppHistoryState = { ssbm: true, tab: next, overlay: null, publicView: null };
    window.history[replace ? "replaceState" : "pushState"](state, "", navUrl(next));
  }, []);

  const browsePublic = useCallback((next: Exclude<PublicView, null>) => {
    setPublicView(next);
    setTab(next);
    const state: AppHistoryState = { ssbm: true, tab: next, overlay: null, publicView: next };
    window.history.pushState(state, "", navUrl(next));
  }, []);

  const leavePublic = useCallback(() => {
    const state = window.history.state as AppHistoryState | null;
    if (state?.ssbm && state.publicView) window.history.back();
    else selectTab(phase === "dashboard" ? tab : "overview", true);
  }, [phase, selectTab, tab]);

  const openOverlay = useCallback((overlay: Exclude<Overlay, null>) => {
    if (overlay === "guide") setShowGuide(true);
    else if (overlay === "accounts") setShowAccounts(true);
    else setShowPrivacy(true);
    const state: AppHistoryState = { ssbm: true, tab, overlay, publicView };
    window.history.pushState(state, "", navUrl(tab, overlay));
  }, [publicView, tab]);

  const closeOverlay = useCallback((overlay: Exclude<Overlay, null>) => {
    const state = window.history.state as AppHistoryState | null;
    if (state?.ssbm && state.overlay === overlay) window.history.back();
    else if (overlay === "guide") setShowGuide(false);
    else if (overlay === "accounts") setShowAccounts(false);
    else setShowPrivacy(false);
  }, []);

  useEffect(() => {
    const initialTab = tabFromUrl();
    const initialPublic = initialTab === "community" || initialTab === "liquipedia" || initialTab === "tournaments"
      ? initialTab
      : null;
    const initialOverlay = overlayFromUrl();
    const state: AppHistoryState = { ssbm: true, tab: initialTab, overlay: initialOverlay, publicView: initialPublic };
    window.history.replaceState(state, "", navUrl(initialTab, initialOverlay));
    const onPop = (event: PopStateEvent) => {
      const next = event.state as AppHistoryState | null;
      const nextTab = next?.ssbm ? next.tab : tabFromUrl();
      setTab(nextTab);
      setPublicView(next?.ssbm ? next.publicView : null);
      setShowGuide(Boolean(next?.ssbm && next.overlay === "guide"));
      setShowAccounts(Boolean(next?.ssbm && next.overlay === "accounts"));
      setShowPrivacy(Boolean(next?.ssbm && next.overlay === "privacy"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onInstall = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onUpdateApplied = () => {
      setUpdateReady(true);
      setUpdateApplied(true);
    };
    const onOfflineReady = () => setOfflineReady(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("beforeinstallprompt", onInstall);
    window.addEventListener("ssbm:update-applied", onUpdateApplied);
    window.addEventListener("ssbm:offline-ready", onOfflineReady);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("beforeinstallprompt", onInstall);
      window.removeEventListener("ssbm:update-applied", onUpdateApplied);
      window.removeEventListener("ssbm:offline-ready", onOfflineReady);
    };
  }, []);

  useEffect(() => {
    if (!offlineReady) return;
    const id = window.setTimeout(() => setOfflineReady(false), 6000);
    return () => window.clearTimeout(id);
  }, [offlineReady]);

  const installApp = useCallback(() => {
    if (!installPrompt) return;
    void installPrompt.prompt().then(() => installPrompt.userChoice).finally(() => setInstallPrompt(null));
  }, [installPrompt]);

  /**
   * Append records to state, deduped by id. Both the folder scan and a cloud
   * pull can race on dashboard entry and hand us the same game (ids are
   * machine-independent path|size|mtime), so blind appends double-count.
   */
  /**
   * Merge streamed records into state by id. Replacement matters here as much
   * as insertion: on a large import the pipeline delivers a header-only preview
   * of every game first and the full parse of the same file second, under the
   * same id. This used to skip any id already present, which would drop every
   * real record and strand the dashboard on preview numbers.
   */
  const appendRecords = useCallback((incoming: GameRecord[]) => {
    if (!incoming.length) return;
    setRecords((prev) => {
      const byId = new Map(prev.map((r) => [r.id, r]));
      let changed = false;
      for (const rec of incoming) {
        const cur = byId.get(rec.id);
        if (cur === rec) continue;
        // Never let a preview overwrite the full record it was standing in for:
        // a late-delivered header batch can arrive after the full pass has
        // already replaced that game.
        const next = cur
          ? hasFullStats(cur) && !hasFullStats(rec) ? mergeCpuStatus(cur, rec) : mergeCpuStatus(rec, cur)
          : rec;
        if (next === cur) continue;
        byId.set(rec.id, next);
        changed = true;
      }
      // Map preserves insertion order, so a replaced record keeps its position.
      return changed ? [...byId.values()] : prev;
    });
  }, []);

  /**
   * The user's accounts: local cache first, then the cloud.
   *
   * Identity lives in `user_codes`, so a signed-in user arriving here without a
   * local copy has already told us who they are — on a new device, or on the
   * same one after "Change folder" cleared kv along with the replay cache.
   * Prompting them again is asking them to re-type something we hold, and it is
   * the one step between picking a folder and seeing a dashboard.
   *
   * Best-effort by design: offline, cloud sync not configured, or a failed
   * query all fall through to the identity prompt, which is exactly where the
   * user would have been anyway. A successful pull is written to kv so the next
   * load resolves locally and never waits on the network.
   */
  const accountsForSession = useCallback(async (): Promise<Account[]> => {
    const local = await getMyAccounts();
    if (local.length > 0 || !cloudEnabled) return local;
    try {
      if (!(await currentSession())) return local;
      const remote = await pullMyAccounts();
      if (!remote?.length) return local;
      await setMyAccounts(remote);
      return remote;
    } catch (err) {
      console.error(err);
      return local;
    }
  }, []);

  // Restore cache on load: if records + identity exist, go straight to
  // dashboard. With an empty cache but a live cloud session (e.g. first visit
  // on a new device, or returning from the OAuth redirect), restore from the
  // cloud instead — that's the whole point of signing in.
  useEffect(() => {
    const restoreController = new AbortController();
    void (async () => {
      try {
        const [raw, accts, savedFolders] = await Promise.all([allRecords(), getMyAccounts(), getReplayFolders()]);
        if (restoreController.signal.aborted) return;
        setFolders(savedFolders);
        // A copied or re-organized replay folder leaves the same game cached
        // under several file keys; collapse them once here so the cache doesn't
        // carry the duplicates forward (see lib/dedupe.ts).
        const cached = await pruneDuplicates(raw);
        if (cached.length > 0) {
          setRecords(cached);
          // kv was already read above; only reach for the cloud if it's empty.
          const known = accts.length > 0 ? accts : await accountsForSession();
          if (restoreController.signal.aborted) return;
          if (known.length > 0) {
            setAccountsState(known);
            setPhase("dashboard");
          } else {
            setPhase("identity");
          }
        } else if (cloudEnabled && (await currentSession())) {
          const gen = generation.current;
          let timedOut = false;
          setCloudRestoring(0);
          const timeout = window.setTimeout(() => {
            timedOut = true;
            restoreController.abort();
          }, 120_000);
          try {
            // A new origin has no IndexedDB cache at all, so fetch full rows
            // directly. Running the account query alongside it also avoids an
            // extra serial wait after a large library finishes.
            const [pulled, cloudAccountsResult] = await Promise.all([
              restoreCloudRecords((loaded) => {
                if (generation.current === gen) setCloudRestoring(loaded);
              }, restoreController.signal),
              pullMyAccounts(restoreController.signal),
            ]);
            const cloudAccounts = cloudAccountsResult ?? [];
            if (generation.current !== gen) return;
            if (pulled.length > 0) setRecords(pulled);
            const known = cloudAccounts.length > 0 ? cloudAccounts : accts;
            if (known.length > 0 && (pulled.length > 0 || savedFolders.length > 0)) {
              setAccountsState(known);
              if (cloudAccounts.length > 0) void setMyAccounts(cloudAccounts);
              setPhase("dashboard");
            } else if (pulled.length > 0) {
              setPhase("identity");
            }
          } catch (err) {
            if (restoreController.signal.aborted && !timedOut) return;
            console.error(err);
            setPipelineError(
              timedOut
                ? "Cloud restore timed out. Reload to retry, or select your replay folder — your cloud data is unchanged."
                : "Couldn't restore your cloud stats. Reload to retry, or select your replay folder.",
            );
          } finally {
            window.clearTimeout(timeout);
            if (generation.current === gen) setCloudRestoring(null);
          }
        } else if (savedFolders.length > 0 && accts.length > 0) {
          // A stats-schema migration may leave no cached rows, but the stored
          // handle can rebuild them without making the user pick the folder
          // again. Dashboard entry lets the auto-sync effect do that in place.
          setAccountsState(accts);
          setPhase("dashboard");
        }
      } catch (err) {
        console.error(err);
        setPipelineError("Couldn't read the local replay cache — your browser may be blocking storage.");
      }
    })();
    return () => restoreController.abort();
    // accountsForSession is stable ([] deps), so this still runs once on mount.
  }, [accountsForSession]);

  const startPipeline = useCallback(
    async (discover: () => Promise<DiscoveredFile[]>) => {
      setPhase("parsing");
      setPipelineError(null);
      setSyncSkipped(null);
      const gen = generation.current;
      const controller = new AbortController();
      abortRef.current = controller;
      /**
       * The preview pass only earns its second walk of the library if what it
       * finds is on screen while the slow authoritative pass runs behind it.
       * So the moment the pipeline flips to the full pass, hand the user over
       * to the dashboard (or the identity prompt) and let the rest report
       * through the topbar button, exactly as a folder Refresh does. Waiting
       * for the whole pipeline meant the previews were parsed, streamed into
       * state and never rendered: one bar filling fast, then a second one
       * crawling, with nothing to show for the first.
       */
      let sawPreview = false;
      let handedOff = false;
      let onDashboard = false;
      // Held on an object rather than a plain `let` for the same reason
      // syncFolders does: the tally arrives through the callback and is read
      // after the await.
      const tally: { last: ParseProgress | null } = { last: null };
      // A full pass running behind the dashboard keeps the folder busy: the
      // re-focus rescan goes live at the hand-off, and would otherwise start a
      // second walk of the folder this run is still parsing.
      scanBusy.current = true;
      try {
        const files = await discover();
        if (files.length === 0) {
          if (generation.current === gen) {
            setPipelineError("No .slp or .slpz replays were found in that folder. Select a folder containing replays; subfolders are included.");
            setPhase("landing");
          }
          return;
        }
        await runParsePipeline(
          files,
          (p, newRecords) => {
            if (generation.current !== gen) return;
            tally.last = p;
            appendRecords(newRecords);
            if (p.pass === "header") sawPreview = true;
            else if (sawPreview && !handedOff) {
              handedOff = true;
              void (async () => {
                let accts: Account[] = [];
                try {
                  // The pipeline only streams the files it actually parses, so
                  // a pick over a warm cache would hand over a dashboard with
                  // everything already cached missing from it. Merge that in
                  // first — appendRecords keeps a full record over the preview
                  // standing in for it.
                  const [known, alreadyCached] = await Promise.all([accountsForSession(), allRecords()]);
                  accts = known;
                  appendRecords(alreadyCached);
                } catch (err) {
                  console.error(err); // a dead local cache just means "ask them"
                }
                if (generation.current !== gen) return;
                if (accts.length > 0) {
                  setAccountsState(accts);
                  setPhase("dashboard");
                } else {
                  setPhase("identity");
                }
                onDashboard = true;
                setProgress(null);
              })();
            }
            if (handedOff) setSyncing(p);
            // The bar stays live until the phase actually flips: the account
            // lookup behind the hand-off can cost a cloud roundtrip, and a bar
            // frozen for that long reads as a stall.
            if (!onDashboard) setProgress(p);
          },
          controller.signal,
        );
        if (generation.current !== gen) return;
        markScanned();
        const all = await allRecords();
        if (generation.current !== gen) return;
        setRecords(all);
        // What the progress panel used to report on its last frame. After the
        // hand-off nobody is looking at it, so the tally moves to the topbar
        // tag a refresh already uses.
        const done = tally.last;
        setSyncSkipped(
          done && done.failed + done.unreadable + done.deferred > 0
            ? { failed: done.failed, unreadable: done.unreadable, deferred: done.deferred }
            : null,
        );
        // Phase was already resolved at the hand-off. Re-running it here would
        // re-read accounts that an identity confirmation may have written back
        // moments ago, and a lost race would throw the user back onto the
        // prompt they just finished with.
        if (handedOff) return;
        // A fresh folder pick on a signed-in device lands here with empty kv:
        // ask the cloud who they are before falling back to the prompt.
        const accts = await accountsForSession();
        if (generation.current !== gen) return; // reset while the cloud answered
        if (accts.length > 0) {
          setAccountsState(accts);
          setPhase("dashboard");
        } else {
          setPhase("identity");
        }
      } catch (err) {
        console.error(err);
        if (generation.current !== gen) return; // reset mid-run: nothing to report
        if (err instanceof RecordSaveError) {
          setPipelineError(err.message);
        } else if (!(err instanceof DOMException && err.name === "AbortError")) {
          // AbortError is the user cancelling the folder picker — not a failure.
          setPipelineError("Parsing failed to start. Reload the page and try again — this usually happens when the site updated while this tab was open.");
        }
        // Past the hand-off the user is on a working dashboard holding most of
        // their library, and the error note says what went wrong. Dropping them
        // back to the landing page would throw all of it away.
        if (!handedOff) setPhase("landing");
      } finally {
        // The re-focus throttle should run from the end of the parse, not from
        // whenever this tab last happened to walk the folder.
        if (generation.current === gen) {
          scanBusy.current = false;
          lastFolderSyncAt.current = Date.now();
          setProgress(null);
          setSyncing(null);
        }
      }
    },
    [appendRecords, markScanned, accountsForSession],
  );

  /**
   * Incremental rescan of remembered folders. Unlike startPipeline this leaves
   * the dashboard on screen — the cache dedups on path|size|mtime, so only replays
   * added since the last scan actually parse.
   */
  const syncFolders = useCallback(
    async (selected: readonly ReplayFolder[], repairIds: readonly string[] = [], requestAccess = false) => {
      if (scanBusy.current) return;
      scanBusy.current = true;
      lastFolderSyncAt.current = Date.now();
      setSyncing({ pass: "full", total: 0, done: 0, skippedCached: 0, failed: 0, unreadable: 0, deferred: 0 });
      setSyncSkipped(null);
      setPipelineError(null);
      const gen = generation.current;
      const controller = new AbortController();
      abortRef.current = controller;
      // Held on an object rather than a plain `let`: the pipeline reports the
      // final tally through the callback, and we need it after the await.
      const tally: { last: ParseProgress | null } = { last: null };
      try {
        const access = await accessibleReplayFolders(selected, requestAccess);
        if (generation.current !== gen) return;
        setFolderPermission(access.unavailable.length === 0 ? "granted" : "prompt");
        setFolderIssues(access.unavailable.map((folder) => folder.handle.name));
        if (access.granted.length === 0) return;
        const discovered = await discoverFromFolders(access.granted, controller.signal);
        if (generation.current !== gen) return;
        const unavailable = [...access.unavailable, ...discovered.unavailable];
        setFolderIssues(unavailable.map((folder) => folder.handle.name));
        if (unavailable.length > 0) setFolderPermission("prompt");
        if (discovered.unavailable.length === access.granted.length) return;
        const files = discovered.files;
        // "Refresh execution stats" is a forced schema repair, not an ordinary
        // new-file scan. A stale row can still have an id in `seen` (for
        // example when a cloud restore raced an earlier migration); forgetting
        // that marker first prevents the scanner from instantly skipping the
        // very replay the button promised to update.
        if (repairIds.length > 0) {
          const foundIds = new Set(files.map((file) => file.id));
          await forgetCachedRecordIds(repairIds.filter((id) => foundIds.has(id)));
        }
        await runParsePipeline(
          files,
          (p, newRecords) => {
            if (generation.current !== gen) return;
            tally.last = p;
            setSyncing(p);
            appendRecords(newRecords);
          },
          controller.signal,
        );
        if (generation.current !== gen) return;
        markScanned();
        const done = tally.last;
        if (generation.current === gen) {
          setSyncSkipped(
            done && done.failed + done.unreadable + done.deferred > 0
              ? { failed: done.failed, unreadable: done.unreadable, deferred: done.deferred }
              : null,
          );
          // Unlike startPipeline, a refresh builds its record state from
          // streamed callbacks. A schema repair can also leave stale cloud/cache
          // copies in memory under a different file id, so replace state from
          // the pruned cache once the repair lands. A page refresh already did
          // this on startup; doing it here keeps the warning from sticking
          // around until the user reloads.
          if (done && done.done > 0) {
            const cached = await pruneDuplicates(await allRecords());
            if (generation.current === gen) setRecords(cached);
          }
        }
      } catch (err) {
        console.error(err);
        if (generation.current !== gen) return;
        setPipelineError(
          err instanceof RecordSaveError
            ? err.message
            : "Refresh failed mid-scan. Reload the page and try again — this usually happens when the site updated while this tab was open.",
        );
      } finally {
        // Stamped again on the way out: the throttle window should run from
        // the end of a long parse, not from the moment it started.
        if (generation.current === gen) {
          scanBusy.current = false;
          lastFolderSyncAt.current = Date.now();
          setSyncing(null);
        }
      }
    },
    [appendRecords, markScanned],
  );

  /** Add an explicit file selection without replacing or disconnecting the folder. */
  const syncPickedFiles = useCallback(
    async (files: DiscoveredFile[]) => {
      if (files.length === 0 || scanBusy.current) return;
      scanBusy.current = true;
      setSyncing({ pass: "full", total: 0, done: 0, skippedCached: 0, failed: 0, unreadable: 0, deferred: 0 });
      setSyncSkipped(null);
      setPipelineError(null);
      const gen = generation.current;
      const controller = new AbortController();
      abortRef.current = controller;
      const tally: { last: ParseProgress | null } = { last: null };
      try {
        await runParsePipeline(
          files,
          (p, newRecords) => {
            if (generation.current !== gen) return;
            tally.last = p;
            setSyncing(p);
            appendRecords(newRecords);
          },
          controller.signal,
        );
        const done = tally.last;
        if (generation.current === gen) {
          setSyncSkipped(
            done && done.failed + done.unreadable + done.deferred > 0
              ? { failed: done.failed, unreadable: done.unreadable, deferred: done.deferred }
              : null,
          );
          if (done && done.done > 0) {
            const cached = await pruneDuplicates(await allRecords());
            if (generation.current === gen) setRecords(cached);
          }
        }
      } catch (err) {
        console.error(err);
        if (generation.current !== gen) return;
        setPipelineError(
          err instanceof RecordSaveError
            ? err.message
            : "Adding replay files failed. Reload the page and try again — this usually happens when the site updated while this tab was open.",
        );
      } finally {
        if (generation.current === gen) {
          scanBusy.current = false;
          lastFolderSyncAt.current = Date.now();
          setSyncing(null);
        }
      }
    },
    [appendRecords],
  );

  // Warm the lazy view chunks once the dashboard is idle so the first click
  // on each tab renders instantly instead of showing the Suspense fallback.
  useEffect(() => {
    if (phase !== "dashboard") return;
    const warm = () => {
      void import("./components/Overview");
      void import("./components/Views");
      void import("./components/Teams");
      void import("./components/Insights");


      void import("./components/MetricsGuide");
      void import("./components/AccountsEditor");
      void import("./components/liquipedia/Liquipedia");
      void import("./components/TournamentArchive");
    };
    // Optional-chained: Safari didn't ship requestIdleCallback until late.
    const ric = window.requestIdleCallback?.bind(window);
    if (ric) {
      const id = ric(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(id);
  }, [phase]);

  // A background scan queries permissions only; reconnect prompts need a click.
  useEffect(() => {
    if (phase !== "dashboard" || isDemo || folders.length === 0 || autoSyncDone.current) return;
    if (pickerBusy.current || scanBusy.current) return;
    autoSyncDone.current = true;
    void syncFolders(folders);
  }, [phase, isDemo, folders, syncFolders]);

  // Both events matter: switching from Dolphin may focus a tab without hiding it.
  useEffect(() => {
    if (phase !== "dashboard" || isDemo || folders.length === 0) return;
    const maybeSync = () => {
      if (document.visibilityState !== "visible" || pickerBusy.current || scanBusy.current) return;
      if (Date.now() - lastFolderSyncAt.current < 60_000) return;
      void syncFolders(folders);
    };
    document.addEventListener("visibilitychange", maybeSync);
    window.addEventListener("focus", maybeSync);
    return () => {
      document.removeEventListener("visibilitychange", maybeSync);
      window.removeEventListener("focus", maybeSync);
    };
  }, [phase, isDemo, folders, syncFolders]);

  const onRefresh = useCallback(() => {
    const repairIds = records.filter(needsStatsRepair).map((rec) => rec.id);
    void syncFolders(folders, repairIds, true);
  }, [folders, records, syncFolders]);

  const onPickDirectory = useCallback(() => {
    void navigator.storage?.persist?.().catch(() => false);
    const gen = generation.current;
    void startPipeline(async () => {
      const dir = await window.showDirectoryPicker({ id: "slippi-replays", mode: "read", startIn: "documents" });
      const added = await addReplayFolder(folders, dir);
      if (generation.current !== gen) return [];
      setFolders(added.folders);
      setFolderPermission("granted");
      const saved = await setReplayFolders(added.folders);
      if (generation.current !== gen) return [];
      if (!saved) setPipelineError("These folders work for this visit, but couldn't be remembered. Add them again next time.");
      autoSyncDone.current = true;
      const prefix = added.folder.id ? `${added.folder.id}/${dir.name}` : "";
      return discoverFromHandle(dir, prefix, abortRef.current?.signal);
    });
  }, [folders, startPipeline]);

  const onPickFiles = useCallback(
    (list: FileList, fromFolder = false) => {
      pickerBusy.current = false;
      setPickingFolder(false);
      lastFolderSyncAt.current = Date.now();
      void navigator.storage?.persist?.().catch(() => false);
      // A fallback input cannot distinguish two same-named roots. Give each
      // selection its own namespace; content dedup still collapses repeat games.
      // Materialize before resetting the input because FileList can be live.
      const files = discoverFromFileList(list, fromFolder ? `folder-${crypto.randomUUID()}` : "");
      if (files.length === 0) {
        setPipelineError(fromFolder
          ? "No .slp or .slpz replays were found in that folder. Select a folder containing replays; subfolders are included."
          : "No .slp or .slpz replay files were selected.");
        return;
      }
      if (phase === "dashboard") void syncPickedFiles(files);
      else void startPipeline(async () => files);
    },
    [phase, startPipeline, syncPickedFiles],
  );

  const onAddReplayFiles = useCallback(() => {
    lastFolderSyncAt.current = Date.now();
    topbarFilesPickRef.current?.click();
  }, []);

  /** Add a root in place. Cancelling never disconnects folders or clears stats. */
  const onConnectFolder = useCallback(() => {
    if (scanBusy.current || pickerBusy.current) return;
    lastFolderSyncAt.current = Date.now();
    void navigator.storage?.persist?.().catch(() => false);
    if (!supportsFsAccess) {
      // File inputs have no picker promise, and some browsers never emit cancel.
      // Do not lock the dashboard waiting for a selection that may never arrive.
      topbarFolderPickRef.current?.click();
      return;
    }
    pickerBusy.current = true;
    setPickingFolder(true);
    const gen = generation.current;
    void (async () => {
      try {
        const dir = await window.showDirectoryPicker({ id: "slippi-replays", mode: "read", startIn: "documents" });
        const added = await addReplayFolder(folders, dir);
        if (generation.current !== gen) return;
        setFolders(added.folders);
        const saved = await setReplayFolders(added.folders);
        if (generation.current !== gen) return;
        autoSyncDone.current = true;
        pickerBusy.current = false;
        setPickingFolder(false);
        const repairIds = records.filter(needsStatsRepair).map((rec) => rec.id);
        await syncFolders(added.folders, repairIds);
        if (!saved && generation.current === gen) {
          setPipelineError("These folders work for this visit, but couldn't be remembered. Add them again next time.");
        }
      } catch (err) {
        if (generation.current !== gen || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error(err);
        setPipelineError("Couldn't open that replay folder — use Add folder to try again.");
      } finally {
        if (generation.current === gen) {
          pickerBusy.current = false;
          setPickingFolder(false);
          lastFolderSyncAt.current = Date.now();
        }
      }
    })();
  }, [supportsFsAccess, folders, records, syncFolders]);

  const onDemo = useCallback(() => {
    setIsDemo(true);
    setRecords(generateDemoRecords());
    setAccountsState(DEMO_ACCOUNTS);
    setPhase("dashboard");
  }, []);

  const confirmIdentity = useCallback((accts: Account[]) => {
    setAccountsState(accts);
    void setMyAccounts(accts);
    setPhase("dashboard");
  }, []);

  /**
   * Identity is resolved at query time, so changing accounts costs a recompute
   * and nothing else — no re-parse, no cache clear. Filters are reset because
   * an accountCode (or an opponent) scoped to a removed account would leave the
   * dashboard empty with no visible cause.
   */
  const saveAccounts = useCallback((accts: Account[]) => {
    setAccountsState(accts);
    if (!isDemo) void setMyAccounts(accts);
    setFilters((f) => ({ ...DEFAULT_FILTERS, format: f.format, range: f.range }));
    closeOverlay("accounts");
  }, [closeOverlay, isDemo]);

  // Cloud pulls land in the Dexie cache before this fires; state just catches
  // up. `gen` is captured by the sync when it starts — a pull that raced a
  // reset is stale and must not resurrect records into the new session.
  const onCloudPulled = useCallback(
    (pulled: GameRecord[], gen: number) => {
      if (gen !== generation.current) return;
      appendRecords(pulled);
    },
    [appendRecords],
  );

  const reset = useCallback(() => {
    generation.current++; // invalidate in-flight scans and cloud syncs
    abortRef.current?.abort();
    abortRef.current = null;
    if (!isDemo) void clearAll(); // also drops all remembered folders
    // clearAll only reaches IndexedDB; the scan timestamp is localStorage.
    // Left behind, it makes the next session — a cloud restore, say — report a
    // "Scanned <time>" produced by a folder that session never had, which
    // reads as "checked, nothing new" when nothing was ever checked.
    localStorage.removeItem("ssbm-last-scanned");
    setLastScanned(null);
    setRecords([]);
    setAccountsState([]);
    setFilters(DEFAULT_FILTERS);
    setIsDemo(false);
    setFolders([]);
    setFolderIssues([]);
    pickerBusy.current = false;
    setPickingFolder(false);
    scanBusy.current = false;
    setFolderPermission("unknown");
    setProgress(null);
    setSyncing(null);
    setPipelineError(null);
    setSyncSkipped(null);
    autoSyncDone.current = false;
    setPhase("landing");
    selectTab("overview", true);
  }, [isDemo, selectTab]);

  const onCloudSignIn = useCallback(() => {
    void signInWithGoogle().catch((err) => {
      console.error(err);
      setPipelineError("Couldn't start Google sign-in — check your network and try again.");
    });
  }, []);

  // Records reach state from three racing sources — the cache restore, the
  // folder scan and a cloud pull — and a shared or copied replay folder means
  // the same game can arrive under different file keys. Collapse before
  // resolving so no aggregate ever counts a game twice.
  const deduped = useMemo(() => dedupeRecords(records), [records]);
  const myCodes = useMemo(() => new Set(accounts.map((a) => a.code)), [accounts]);
  const shouldResolveDashboard = phase === "dashboard";
  const allResolved = useMemo(
    () => shouldResolveDashboard ? resolveGames(deduped, myCodes, true) : [],
    [deduped, myCodes, shouldResolveDashboard],
  );
  const allResolvedTeams = useMemo(
    () => shouldResolveDashboard ? resolveTeamGames(deduped, myCodes, true) : [],
    [deduped, myCodes, shouldResolveDashboard],
  );
  const withoutCpu = useMemo(() => allResolved.filter((g) => !hasKnownCpu(g.rec)), [allResolved]);
  const teamsWithoutCpu = useMemo(() => allResolvedTeams.filter((g) => !hasKnownCpu(g.rec)), [allResolvedTeams]);
  const resolved = filters.includeCpuGames ? allResolved : withoutCpu;
  const resolvedTeams = filters.includeCpuGames ? allResolvedTeams : teamsWithoutCpu;
  const filtered = useMemo(() => applyFilters(resolved, filters), [resolved, filters]);
  const filteredTeams = useMemo(() => applyTeamFilters(resolvedTeams, filters), [resolvedTeams, filters]);
  // Confirms a typed code actually occurs in the library — the identity step
  // and the editor both show it next to the code. Nothing is inferred from it.
  const gameCounts = useMemo(
    () => (phase === "identity" || showAccounts ? codeGameCounts(deduped) : new Map<string, number>()),
    [phase, showAccounts, deduped],
  );

  // A preview is replaced by id the moment its full parse lands, so this goes
  // false on its own as the second pass drains — no separate "is a parse
  // running" flag to keep in step. An incremental refresh never sets it: below
  // HEADER_PASS_MIN the pipeline skips the preview pass entirely.
  const hasPreviews = useMemo(() => shouldResolveDashboard && deduped.some((r) => !hasFullStats(r)), [deduped, shouldResolveDashboard]);
  const needsStatsRefresh = useMemo(() => shouldResolveDashboard && deduped.some(needsStatsRepair), [deduped, shouldResolveDashboard]);
  const isTabPending = (id: Tab) => hasPreviews && NEEDS_FULL_STATS.has(id);

  // Never strand the user in a teams view they have no games for.
  const hasTeamGames = allResolvedTeams.length > 0;
  const showTeams = hasTeamGames && filters.format === "teams";
  const activePending = isTabPending(tab);
  const busy = phase === "parsing" || syncing !== null;
  const reloadForUpdate = useCallback(() => {
    const last = Number(sessionStorage.getItem("ssbm-update-reload-at") ?? 0);
    if (Date.now() - last < 30_000) {
      setUpdateReady(false);
      setUpdateApplied(false);
      return;
    }
    sessionStorage.setItem("ssbm-update-reload-at", String(Date.now()));
    window.location.reload();
  }, []);
  useEffect(() => {
    if (!updateApplied || busy) return;
    reloadForUpdate();
  }, [busy, reloadForUpdate, updateApplied]);
  const lastScanLabel = lastScanned
    ? new Date(lastScanned).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  // A dashboard can hold a full library with no folder behind it. Demo data
  // has none by design, and browsers without the File System Access API can
  // never keep one, so neither counts as a problem — but a Chromium session
  // that lost its handle will never see another replay, and saying "Scanned
  // <time>" at it is the difference between a two-second fix and a bug report.
  const needsFolder = !isDemo && folders.length === 0 && supportsFsAccess;

  return (
    <div className="shell">
      {(publicView || phase !== "landing") && (
        <div className="topbar">
          <div className="brand">
            <img src="/favicon.svg" alt="" aria-hidden="true" />
            <h1>SSBM Stats</h1>
            {isDemo && <span className="tag">demo data</span>}
          </div>
          {publicView && (
            <div className="identity">
              <button className="ghost" onClick={leavePublic}>
                {phase === "dashboard" ? "Back to my stats" : "Back"}
              </button>
            </div>
          )}
          {!publicView && phase === "dashboard" && (
            <div className="identity">
              <span className="identity-summary">
                <b>{accounts.map((a) => a.code).join(", ") || "—"}</b>
                {accounts.length > 1 && <span className="tag">{accounts.length} accounts</span>}
                <span>
                  · {(showTeams ? resolvedTeams.length : resolved.length).toLocaleString()}{" "}
                  {showTeams ? "2v2 games" : "games"}
                </span>
              </span>
              <span
                className={`app-state ${!online ? "offline" : needsFolder || needsStatsRefresh || folderIssues.length > 0 ? "warn" : ""}`}
                title={
                  !online
                    ? "Offline — local stats still work"
                    : needsStatsRefresh
                      ? "Some cached or cloud records predate tech stats. Refresh the replay folder to update them in place."
                    : needsFolder
                      ? "These stats came from the cache or the cloud. Connect your replay folder to pick up games played from now on."
                    : folderIssues.length > 0
                      ? `Could not scan: ${folderIssues.join(", ")}`
                      : "Local features are ready"
                }
              >
                {!online
                  ? "Offline · local stats available"
                  : needsStatsRefresh
                    ? "Execution stats need refresh"
                  : needsFolder
                    ? "No folder connected"
                  : folderIssues.length > 0
                    ? `${folderIssues.length} folder${folderIssues.length === 1 ? " needs" : "s need"} access`
                    : lastScanLabel
                      ? `Scanned ${lastScanLabel}`
                      : "Local"}
              </span>
              {!isDemo && (folders.length > 0 || supportsFsAccess) && (
                <button
                  className={needsFolder || needsStatsRefresh || folderIssues.length > 0 ? "ghost attn" : "ghost"}
                  onClick={folders.length > 0 ? onRefresh : onConnectFolder}
                  disabled={syncing !== null || pickingFolder}
                >
                  {syncing
                    ? syncing.total === 0
                      ? "Scanning…"
                      : `${syncing.pass === "header" ? "Reading" : "Parsing"} ${syncing.done.toLocaleString()}/${syncing.total.toLocaleString()}`
                    : pickingFolder
                      ? "Choosing folder…"
                    : folders.length === 0
                      ? "Connect replay folder"
                      : folderPermission === "granted"
                        ? needsStatsRefresh ? "Refresh execution stats" : "Refresh"
                        : needsStatsRefresh ? "Reconnect to refresh" : folders.length > 1 ? "Reconnect folders" : "Reconnect folder"}
                </button>
              )}
              {!isDemo && folders.length > 0 && (
                <span className="tag" title={folders.map((folder) => folder.handle.name).join("\n")}>
                  {folders.length} folder{folders.length === 1 ? "" : "s"}
                </span>
              )}
              {!isDemo && (folders.length > 0 || !supportsFsAccess) && (
                <button className="ghost" onClick={onConnectFolder} disabled={syncing !== null || pickingFolder}>
                  {pickingFolder ? "Choosing folder…" : "Add folder"}
                </button>
              )}
              <input
                ref={topbarFolderPickRef}
                type="file"
                multiple
                accept=".slp,.slpz"
                style={{ display: "none" }}
                {...({ webkitdirectory: "" } as Record<string, string>)}
                onChange={(e) => {
                  if (e.currentTarget.files) onPickFiles(e.currentTarget.files, true);
                  e.currentTarget.value = "";
                }}
              />
              {!isDemo && (
                <button className="ghost" onClick={onAddReplayFiles} disabled={syncing !== null || pickingFolder}>
                  Add replay files
                </button>
              )}
              <input
                ref={topbarFilesPickRef}
                type="file"
                multiple
                accept=".slp,.slpz"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.currentTarget.files?.length) onPickFiles(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
              {!isDemo && !syncing && syncSkipped && (
                <span className="tag" title={skippedDetail(syncSkipped)}>
                  {(syncSkipped.failed + syncSkipped.unreadable + syncSkipped.deferred).toLocaleString()} skipped
                </span>
              )}
              <CloudSync
                records={records}
                accounts={accounts}
                isDemo={isDemo}
                isParsing={busy}
                generation={generation.current}
                onPulled={onCloudPulled}
              />
              {installPrompt && (
                <button className="ghost" onClick={installApp}>Install app</button>
              )}
              <button className="ghost" onClick={() => openOverlay("accounts")}>
                My account
              </button>
              <button className="ghost" onClick={() => openOverlay("guide")}>
                Metrics guide
              </button>
              <button className="ghost" onClick={reset} disabled={pickingFolder}>
                {isDemo ? "Exit demo" : folders.length > 1 ? "Change folders" : "Change folder"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Under the topbar, not above the brand: the opt-in has to be seen to
          work, but it is not the masthead. Renders nothing in demo or a
          local-only build. */}
      {phase === "dashboard" && (
        <CommunityConsent isDemo={isDemo} variant="bar" onOpenCommunity={() => selectTab("community")} />
      )}

      {pipelineError && (
        <div className="error-note" role="alert">
          {pipelineError}
          <button className="ghost" style={{ marginLeft: 10 }} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}

      {!isDemo && !publicView && phase === "dashboard" && folderIssues.length > 0 && (
        <div className="empty-note" role="status">
          Couldn’t scan {folderIssues.join(", ")}. Reconnect folders to retry, or use Add folder to select them again.
          Your saved stats are still available; accessible folders continue to update.
        </div>
      )}

      {publicView === "liquipedia" && (
        <ViewErrorBoundary>
          <Suspense fallback={<div className="empty-note">Loading…</div>}>
            <Liquipedia />
          </Suspense>
        </ViewErrorBoundary>
      )}

      {publicView === "community" && (
        <ViewErrorBoundary>
          <Suspense fallback={<div className="empty-note">Loading…</div>}>
            <Community
              games={resolved}
              isDemo={false}
              onOpenAccount={() => phase === "dashboard" ? openOverlay("accounts") : void signInWithGoogle()}
            />
          </Suspense>
        </ViewErrorBoundary>
      )}

      {publicView === "tournaments" && (
        <ViewErrorBoundary>
          <Suspense fallback={<div className="empty-note">Loading…</div>}>
            <TournamentArchive />
          </Suspense>
        </ViewErrorBoundary>
      )}

      {!publicView && phase === "landing" && (
        <Landing
          onPickDirectory={onPickDirectory}
          onPickFiles={onPickFiles}
          onDemo={onDemo}
          onBrowseHistory={() => browsePublic("liquipedia")}
          onBrowseCommunity={() => browsePublic("community")}
          onBrowseTournaments={() => browsePublic("tournaments")}
          supportsFsAccess={supportsFsAccess}
          onCloudSignIn={cloudEnabled ? onCloudSignIn : null}
          cloudRestoring={cloudRestoring}
          online={online}
          onInstall={installPrompt ? installApp : null}
        />
      )}

      {!publicView && phase === "parsing" && progress && <ProgressBar p={progress} />}

      {!publicView && phase === "identity" && (
        <IdentityPicker gameCounts={gameCounts} parsing={syncing} onConfirm={confirmIdentity} />
      )}

      {!publicView && phase === "dashboard" && (
        <>
          <FilterBar
            filters={filters}
            setFilters={setFilters}
            games={resolved}
            teamGames={resolvedTeams}
            hasTeamGames={hasTeamGames}
            accounts={accounts}
            cpuGameCount={filters.format === "teams"
              ? allResolvedTeams.length - teamsWithoutCpu.length
              : allResolved.length - withoutCpu.length}
          />
          {/* 2v2 has no 1v1 matchup matrix or single opponent, so it gets one
              consolidated view rather than the singles tab set. */}
          {/* Deliberately outside the Suspense boundary below: a tab whose chunk
              was still in flight used to take the whole strip down with it, so
              the one control that could end the wait was the thing that
              disappeared for the length of it. */}
          {!showTeams && (
            <div className="tabs" role="tablist">
              {TABS.map((t) => {
                const pending = isTabPending(t.id);
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-label={t.label}
                    tabIndex={tab === t.id ? 0 : -1}
                    aria-selected={tab === t.id}
                    // aria-disabled rather than the disabled attribute: Chrome
                    // swallows hover on a disabled button, so the title saying
                    // why the tab will not open would never be read.
                    aria-disabled={pending || undefined}
                    title={pending ? PENDING_TAB_HINT : undefined}
                    className={`${tab === t.id ? "active" : ""}${t.id === "tournaments" ? " tab-label-wrap" : ""}`}
                    onKeyDown={moveTabFocus}
                    onClick={() => { if (!pending) selectTab(t.id); }}
                  >
                    {t.id === "tournaments"
                      ? <span aria-hidden="true">Tournament<br />Predictions</span>
                      : t.label}
                  </button>
                );
              })}
            </div>
          )}
          <ViewErrorBoundary>
          <Suspense fallback={<div className="empty-note">Loading…</div>}>
          {showTeams ? (
            <Teams games={filteredTeams} onSelectTeammate={(code) => setFilters({ ...filters, teammateCode: code })} />
          ) : activePending ? (
            // Reachable without a click: a ?view=execution link, or a tab left
            // selected while a fresh import replaced the library under it.
            <div className="empty-note">
              {PENDING_TAB_HINT}
              {syncing ? ` — ${syncing.done.toLocaleString()} of ${syncing.total.toLocaleString()} replays so far` : ""}.
              <br />
              The tab opens on its own when the parse finishes.
            </div>
          ) : (
        <>

          {tab === "overview" && (
            <Overview
              games={filtered}
              allGames={resolved}
              teamGames={filteredTeams}
              filters={filters}
              accounts={accounts}
              onSelectMyCharacter={(id) => setFilters({ ...filters, myCharacter: id })}
              onSelectMode={(modes) => setFilters({ ...filters, gameTypes: modes })}
              onSelectAccount={(code) => setFilters({ ...filters, accountCode: code })}
            />
          )}
          {tab === "matchups" && (
            <Matchups
              games={filtered}
              onSelect={(my, opp) => {
                setFilters({ ...filters, myCharacter: my, oppCharacter: opp });
                selectTab("overview");
              }}
            />
          )}
          {tab === "stages" && (
            <Stages
              games={filtered}
              onSelect={(stageId, charId, side) => {
                setFilters({ ...filters, stageId, ...(side === "opp" ? { oppCharacter: charId } : { myCharacter: charId }) });
                selectTab("overview");
              }}
            />
          )}
          {tab === "opponents" && (
            <Opponents
              games={filtered}
              accounts={accounts}
              onSelect={(code) => {
                setFilters({ ...filters, opponentCode: code });
                selectTab("overview");
              }}
            />
          )}

          {tab === "execution" && (
            <Execution
              games={filtered}
              isDemo={isDemo}
              selectedCharacterId={filters.myCharacter}
              selectedOpponentCharacterId={filters.oppCharacter}
            />
          )}
          {tab === "insights" && <Insights games={filtered} />}


          {tab === "community" && <Community games={resolved} isDemo={isDemo} onOpenAccount={() => openOverlay("accounts")} />}
          {tab === "liquipedia" && <Liquipedia />}
          {tab === "tournaments" && <TournamentArchive />}
        </>
          )}
          </Suspense>
          </ViewErrorBoundary>
        </>
      )}

      {showGuide && (
        <Suspense fallback={null}>
          <MetricsGuide onClose={() => closeOverlay("guide")} />
        </Suspense>
      )}

      {showAccounts && (
        <Suspense fallback={null}>
          <AccountsEditor
            accounts={accounts}
            gameCounts={gameCounts}
            onSave={saveAccounts}
            onClose={() => closeOverlay("accounts")}
            isDemo={isDemo}
          />
        </Suspense>
      )}

      {showPrivacy && (
        <Suspense fallback={null}>
          <PrivacyPromise onClose={() => closeOverlay("privacy")} />
        </Suspense>
      )}

      {/* The build id is no longer printed, but it stays in the DOM as a data
          attribute so a deploy can still be verified — read it with
          document.querySelector(".site-footer").dataset.build, or grep the
          served bundle for the commit. */}
      <footer className="site-footer" data-build={__BUILD_ID__}>
        <span>Brought to you by Studio Pinball · © 2026</span>
        <a href="https://ssbmstats.com/">ssbmstats.com</a>
        <a href="/about">About</a>
        <a href="/metrics">Metrics</a>
        <a href="/melee-majors">Melee majors</a>
        <a href="https://github.com/1973-pinball/SSBM_STATS">GitHub Repo</a>
        <a href="mailto:info.studio.pinball@gmail.com">info.studio.pinball@gmail.com</a>
        <button className="footer-link" onClick={() => openOverlay("privacy")}>Privacy promise</button>
      </footer>

      {updateReady && (
        <div className="pwa-toast" role="status">
          <span><b>Update ready.</b> {busy ? "It will reload when local parsing finishes." : "Reloading now."}</span>
          {!busy && <button className="primary" onClick={reloadForUpdate}>Reload</button>}
        </div>
      )}
      {!updateReady && offlineReady && (
        <div className="pwa-toast" role="status">
          <span><b>Ready offline.</b> SSBM Stats is available on this device.</span>
          <button className="ghost" aria-label="Dismiss" onClick={() => setOfflineReady(false)}>×</button>
        </div>
      )}
    </div>
  );
}
