import { useRef } from "react";
import { GoogleG } from "./GoogleG";

interface Props {
  onPickDirectory: () => void;
  onPickFiles: (files: FileList, fromFolder?: boolean) => void;
  onDemo: () => void;
  /** Opens the scene-history tab, which needs no replays at all. */
  onBrowseHistory: () => void;
  /** Opens aggregate Community Lab data without requiring a replay folder. */
  onBrowseCommunity: () => void;
  /** Opens public replay-derived tournament data without requiring a replay folder. */
  onBrowseTournaments: () => void;
  supportsFsAccess: boolean;
  /** Non-null when cloud sync is configured: "sign in to restore" entry point. */
  onCloudSignIn: (() => void) | null;
  /** Null while idle; otherwise the number of cloud games fetched so far. */
  cloudRestoring: number | null;
  online: boolean;
  /** Chromium install prompt; null on unsupported/already-installed browsers. */
  onInstall: (() => void) | null;
}

export function Landing({
  onPickDirectory,
  onPickFiles,
  onDemo,
  onBrowseHistory,
  onBrowseCommunity,
  onBrowseTournaments,
  supportsFsAccess,
  onCloudSignIn,
  cloudRestoring,
  online,
  onInstall,
}: Props) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="landing">
      <div className="landing-brand" aria-label="SSBM Stats">
        <img src="/favicon.svg" alt="" aria-hidden="true" />
        <span>SSBM Stats</span>
      </div>
      <h1>
        Slippi replay stats, <span className="accent">parsed in your browser</span>
      </h1>
      <p className="sub">
        Connect your Slippi replay folders and get a full statistical readout of your play: win rates by
        opponent, matchup, and stage, kill stats, and execution trends. Standard <span className="data">.slp</span> and
        compressed <span className="data">.slpz</span> files can be mixed together, and everything is parsed in your browser.
      </p>
      <div className="cta-row">
        {supportsFsAccess ? (
          <button className="primary" onClick={onPickDirectory} disabled={cloudRestoring !== null}>
            Select replay folder
          </button>
        ) : (
          <button className="primary" onClick={() => folderInputRef.current?.click()} disabled={cloudRestoring !== null}>
            Select replay folder
          </button>
        )}
        <button className="ghost" onClick={() => filesInputRef.current?.click()} disabled={cloudRestoring !== null}>
          Add replay files
        </button>
        <button className="ghost" onClick={onDemo} disabled={cloudRestoring !== null}>
          Explore with demo data
        </button>
        {onInstall && (
          <button className="ghost" onClick={onInstall}>
            Install app
          </button>
        )}
        {onCloudSignIn && (
          <button
            className="ghost"
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            onClick={onCloudSignIn}
            disabled={cloudRestoring !== null || !online}
          >
            <GoogleG size={15} />
            {cloudRestoring !== null
              ? cloudRestoring > 0
                ? `Restoring ${cloudRestoring.toLocaleString()} games…`
                : "Restoring your stats…"
              : online
                ? "Sign in with Google to restore"
                : "Cloud restore unavailable offline"}
          </button>
        )}
      </div>
      <p className="folder-scan-note">
        <b>Start with one replay folder, then use Add folder on your dashboard to include more.</b> All subfolders are
        included automatically, and games found in multiple folders count once.
        {!supportsFsAccess && " This browser requires selecting each folder again to import new replays."}
      </p>
      <input
        ref={folderInputRef}
        type="file"
        multiple
        accept=".slp,.slpz"
        style={{ display: "none" }}
        // Non-standard attribute; enables folder selection in Chromium/Firefox/Safari.
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(e) => {
          if (e.currentTarget.files) onPickFiles(e.currentTarget.files, true);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".slp,.slpz"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.currentTarget.files?.length) onPickFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      {/* Neither public tab touches replays, so they should not sit behind the
          folder picker or demo mode. */}
      <div className="landing-aside">
        No replays to hand? <button className="linky" onClick={onBrowseCommunity} disabled={cloudRestoring !== null}>Explore anonymous community benchmarks</button>
        {", "}<button className="linky" onClick={onBrowseHistory} disabled={cloudRestoring !== null}>browse Melee tournament history</button>
        {", or "}<button className="linky" onClick={onBrowseTournaments} disabled={cloudRestoring !== null}>explore replay-derived tournaments</button>. None needs
        access to your replay folder.
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        Slippi saves replays to <span style={{ fontFamily: "var(--font-data)" }}>Documents\Slippi</span> by default
        (<span style={{ fontFamily: "var(--font-data)" }}>~/Slippi</span> on Mac/Linux) — the picker opens in Documents
        to get you close.
      </div>
      {/* This is the claim the whole product rests on, and it was set in 12px
          --faint under a divider. Sized and split so it can actually be read
          at the moment someone is deciding whether to sign in. */}
      <div className="privacy">
        <p className="privacy-lead"><b>Your replays never leave your machine.</b></p>
        {onCloudSignIn ? (
          <ul className="privacy-points">
            <li>Signing in syncs <b>only parsed stats</b> — never replay files — to your own private account.</li>
            <li>
              <b>Community contribution is a separate opt-in, off by default.</b> Turn it on any time from the{" "}
              Community tab or My Account to add anonymised stats from both players in your games to the shared benchmarks.
            </li>
            <li>Your email is used only for sign-in — never sold, published, shared, or used for marketing or outreach.</li>
          </ul>
        ) : (
          // Deliberately not "no tracking": this branch renders whenever cloud
          // sync is unconfigured, but the analytics mount in main.tsx is
          // unconditional, so a Vercel deploy without Supabase would have been
          // asserting something untrue. Gating copy on the wrong feature is how
          // that happened.
          <p className="privacy-points">No uploads and no accounts. Aggregate, cookieless visit counting is the only thing recorded, and it never touches replay data.</p>
        )}
      </div>
      {/* Below the privacy panel on purpose: worth saying plainly, but it is
          not the claim someone is weighing when they decide to point this at
          their replay folder. */}
      <p className="landing-made-with">
        <b>Built with AI assistance.</b> AI coding tools were used throughout — and countless hours of hands-on
        refinement, testing, and design went in on top of them.
      </p>
      {!online && <div className="badge gold">Offline mode · demo, cached stats, and Melee history still work.</div>}
    </div>
  );
}
