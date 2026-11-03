import { useEffect, useMemo, useState } from "react";
import type { ResolvedGame } from "../lib/types";
import { WIN_MODEL_FEATURES, buildWinModelInput, quartileWinRates } from "../lib/model";
import type { CoefRow, FeatureDef, WinModel } from "../lib/model";
import type { ModelWorkerJob, ModelWorkerResult } from "../worker/model.worker";
import { COACH_MIN_DECIDED, recommendations, type CoachMoveBenchmark } from "../lib/coach";
import { num, pct, winRateColor } from "../lib/format";
import { moveGroup } from "../lib/melee";
import { fetchArchiveCommunityBenchmarks, fetchLatestArchiveDataset, type ArchiveRollup } from "../lib/publicArchive";
// Statically imported, not lazy: Sessions used to be its own tab and chunk, and
// now renders inside this one directly under the coach list.
import { Sessions } from "./Sessions";

/**
 * The IRLS fit is O(iterations · n · k²) — multi-hundred-ms on a big library —
 * so it runs in a Web Worker instead of blocking the main thread. A lazily
 * created singleton worker is enough: the cache below guarantees each
 * (games, feature-set) pair is fitted at most once, so there's never a queue
 * worth parallelizing.
 */
let modelWorker: Worker | null = null;
let nextJobId = 1;
const pendingJobs = new Map<number, { resolve: (m: WinModel | null) => void; reject: (e: Error) => void }>();

function getModelWorker(): Worker {
  if (modelWorker) return modelWorker;
  const w = new Worker(new URL("../worker/model.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<ModelWorkerResult>) => {
    const job = pendingJobs.get(e.data.id);
    if (!job) return;
    pendingJobs.delete(e.data.id);
    if (e.data.ok) job.resolve(e.data.model ?? null);
    else job.reject(new Error(e.data.error ?? "model fit failed"));
  };
  // Worker death — most commonly its script 404ing in a stale tab after a
  // redeploy (see pool.ts) — would otherwise leave fits pending forever. Fail
  // them and drop the worker so the next fit attempt starts a fresh one.
  w.onerror = () => {
    const jobs = [...pendingJobs.values()];
    pendingJobs.clear();
    w.terminate();
    if (modelWorker === w) modelWorker = null;
    for (const j of jobs) j.reject(new Error("model worker failed"));
  };
  modelWorker = w;
  return w;
}

function fitInWorker(games: ResolvedGame[], features: FeatureDef[]): Promise<WinModel | null> {
  // Feature extraction needs the FeatureDef closures, so it happens here on
  // the main thread (cheap); only plain cloneable data crosses to the worker.
  const input = buildWinModelInput(games, features);
  return new Promise((resolve, reject) => {
    const job: ModelWorkerJob = { id: nextJobId++, input };
    pendingJobs.set(job.id, { resolve, reject });
    getModelWorker().postMessage(job);
  });
}

interface FitEntry {
  status: "pending" | "done" | "error";
  /** Meaningful once status is "done"; null there means "too little data". */
  model: WinModel | null;
  /** Settles (never rejects) once status and model hold their final values. */
  settled: Promise<void>;
}

/**
 * Fits cached by games-array identity, then by feature set. The `games` prop
 * is a stable useMemo result upstream (it only changes when records or filters
 * change), so reference identity is the right key — and because App unmounts
 * this tab on every tab switch, the module-level cache is what keeps a return
 * visit with unchanged data from refitting.
 */
const fitCache = new WeakMap<readonly ResolvedGame[], Map<string, FitEntry>>();

function getOrStartFit(games: ResolvedGame[], features: FeatureDef[]): FitEntry {
  let bySig = fitCache.get(games);
  if (!bySig) {
    bySig = new Map();
    fitCache.set(games, bySig);
  }
  const sig = features.map((f) => f.key).join("|");
  const cached = bySig.get(sig);
  if (cached) return cached;
  const entry: FitEntry = { status: "pending", model: null, settled: Promise.resolve() };
  const inner = bySig;
  entry.settled = fitInWorker(games, features).then(
    (m) => {
      entry.status = "done";
      entry.model = m;
    },
    () => {
      entry.status = "error";
      // Forget failed fits so the next visit retries with a fresh worker
      // instead of pinning the error until the data changes.
      inner.delete(sig);
    },
  );
  bySig.set(sig, entry);
  return entry;
}

/** Async wrapper around the cache: re-renders once the fit settles. */
function useWinModel(
  games: ResolvedGame[],
  features: FeatureDef[],
): { status: FitEntry["status"]; model: WinModel | null } {
  // getOrStartFit is idempotent per (games, features), so calling it during
  // render is safe — repeat renders and StrictMode just hit the cache.
  const entry = useMemo(() => getOrStartFit(games, features), [games, features]);
  const [, setSettledTick] = useState(0);
  useEffect(() => {
    // Always subscribe — even when the status already looks settled. The fit
    // can settle between the render that painted "pending" and this effect
    // running; an early return on the new status would strand that stale
    // frame forever. An already-settled promise just fires one extra tick.
    let live = true;
    void entry.settled.then(() => {
      if (live) setSettledTick((t) => t + 1);
    });
    return () => {
      live = false;
    };
  }, [entry]);
  return { status: entry.status, model: entry.model };
}

/**
 * How many items show before the expander. The panel is "the short version",
 * so the rest stays behind a click rather than being dropped: with fifteen
 * detectors feeding one ranking, a finding that cleared a ~98% bar should not
 * vanish silently just because five louder ones landed above it.
 */
const COACH_VISIBLE = 5;

function coachMoveBenchmark(row: ArchiveRollup): CoachMoveBenchmark {
  const landedByMove: Record<string, number> = {};
  for (const [moveId, metrics] of Object.entries(row.metrics.moves ?? {})) {
    const key = moveGroup(Number(moveId)).key;
    landedByMove[key] = (landedByMove[key] ?? 0) + metrics.landed;
  }
  return { characterId: row.character_id!, gameCount: row.game_count, landedByMove };
}

function useTournamentMoveBenchmarks(games: ResolvedGame[]): CoachMoveBenchmark[] {
  const characterIds = useMemo(
    () => [...new Set(games.map((game) => game.me.characterId))].sort((a, b) => a - b),
    [games],
  );
  const [benchmarks, setBenchmarks] = useState<CoachMoveBenchmark[]>([]);
  useEffect(() => {
    let alive = true;
    void fetchLatestArchiveDataset()
      .then(async (dataset) => {
        if (!dataset) return [];
        const rows = await Promise.all(characterIds.map(async (characterId) => {
          const result = await fetchArchiveCommunityBenchmarks(dataset.id, characterId);
          return result.broad;
        }));
        return rows.filter((row): row is ArchiveRollup => row !== null).map(coachMoveBenchmark);
      })
      .then((next) => { if (alive) setBenchmarks(next); })
      .catch(() => { if (alive) setBenchmarks([]); });
    return () => { alive = false; };
  }, [characterIds]);
  return benchmarks;
}

/** Ranked plain-English "do this" list — the tab's front door for non-stats readers. */
function CoachPanel({ games, tournamentMoveBenchmarks }: { games: ResolvedGame[]; tournamentMoveBenchmarks: CoachMoveBenchmark[] }) {
  const recs = useMemo(
    () => recommendations(games, Infinity, { tournamentMoveBenchmarks }),
    [games, tournamentMoveBenchmarks],
  );
  const [expanded, setExpanded] = useState(false);
  const hidden = recs.length - COACH_VISIBLE;
  const shown = expanded ? recs : recs.slice(0, COACH_VISIBLE);
  return (
    <div className="panel">
      <h2>The short version — what to change</h2>
      {recs.length === 0 ? (
        <div className="empty-note">
          Nothing stands out yet — either there aren't ~{COACH_MIN_DECIDED}+ decided games in this filter, or your
          losses spread evenly across matchups, stages, and session length. That second one is a compliment.
        </div>
      ) : (
        <>
          <ol className="coach-list">
            {shown.map((r) => (
              <li key={r.kind + r.headline}>
                <div className="coach-headline">{r.headline}</div>
                <div className="coach-detail">{r.detail}</div>
              </li>
            ))}
          </ol>
          {hidden > 0 && (
            <button className="ghost coach-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show fewer" : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
      <div className="hint">
        Ranked by effect size × evidence, each against your own overall win rate — the top {COACH_VISIBLE} show by
        default. Anything that doesn't clear a significance bar is left out entirely. The models below show the full
        picture behind these. Move-habit advice also checks the matching character's tournament benchmark when available.
      </div>
    </div>
  );
}

/**
 * "What predicts my wins?" — logistic regression in two flavors (raw
 * association vs adjusted for opponent/character/stage/time) plus a
 * model-free quartile cross-check. Interpretation-first: standardized
 * coefficients, plain-language effect sizes, and loud caveats.
 */

const evidence = (p: number): { label: string; dim: boolean } => {
  if (p < 0.01) return { label: "strong", dim: false };
  if (p < 0.05) return { label: "moderate", dim: false };
  if (p < 0.1) return { label: "weak", dim: true };
  return { label: "—", dim: true };
};

/** Divide-by-4 rule: max change in win probability per +1 SD, in points. */
const probPoints = (coef: number): number => (coef / 4) * 100;

const ppText = (coef: number): string => `${coef >= 0 ? "+" : ""}${num(probPoints(coef), 1)} pp`;

function CoefBar({ coef, max }: { coef: number; max: number }) {
  const frac = Math.min(1, Math.abs(coef) / max);
  const color = coef >= 0 ? "#3fcf8e" : "#f0564f";
  return (
    <div style={{ display: "flex", alignItems: "center", height: 14 }}>
      <div style={{ width: "50%", display: "flex", justifyContent: "flex-end" }}>
        {coef < 0 && <div style={{ width: `${frac * 100}%`, height: 8, background: color, borderRadius: 2, opacity: 0.85 }} />}
      </div>
      <div style={{ width: 1, alignSelf: "stretch", background: "#34305a" }} />
      <div style={{ width: "50%" }}>
        {coef >= 0 && <div style={{ width: `${frac * 100}%`, height: 8, background: color, borderRadius: 2, opacity: 0.85 }} />}
      </div>
    </div>
  );
}

export function Insights({ games }: { games: ResolvedGame[] }) {
  const [includeOutcome, setIncludeOutcome] = useState(false);
  const tournamentMoveBenchmarks = useTournamentMoveBenchmarks(games);

  const features = useMemo(
    () => WIN_MODEL_FEATURES.filter((f) => f.group === "execution" || includeOutcome),
    [includeOutcome],
  );
  const fit = useWinModel(games, features);
  const model = fit.model;
  const quartiles = useMemo(() => quartileWinRates(games, features), [games, features]);

  // The adjusted fit is the headline when available; raw rides along for contrast.
  const primary = model?.adjusted ?? model?.raw ?? null;
  const hasAdjusted = Boolean(model?.adjusted);
  const rawByKey = useMemo(() => {
    const m = new Map<string, CoefRow>();
    for (const c of model?.raw.coefs ?? []) m.set(c.key, c);
    return m;
  }, [model]);

  const sorted = useMemo(
    () => (primary ? [...primary.coefs].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)) : []),
    [primary],
  );
  const maxCoef = useMemo(
    () => Math.max(0.1, ...sorted.map((c) => Math.abs(c.coef)), ...(model?.raw.coefs.map((c) => Math.abs(c.coef)) ?? [])),
    [sorted, model],
  );

  const toggle = (
    <div className="chip-row" style={{ marginBottom: 12 }}>
      <button
        className={`chip ${!includeOutcome ? "on" : ""}`}
        aria-pressed={!includeOutcome}
        style={!includeOutcome ? { borderColor: "var(--accent)" } : undefined}
        onClick={() => setIncludeOutcome(false)}
      >
        <span className="dot" style={{ background: "var(--accent)", opacity: !includeOutcome ? 1 : 0.35 }} />
        Habits only
      </button>
      <button
        className={`chip ${includeOutcome ? "on" : ""}`}
        aria-pressed={includeOutcome}
        style={includeOutcome ? { borderColor: "#e8b54d" } : undefined}
        onClick={() => setIncludeOutcome(true)}
      >
        <span className="dot" style={{ background: "#e8b54d", opacity: includeOutcome ? 1 : 0.35 }} />
        + outcome-linked stats
      </button>
    </div>
  );

  // Model-free and cheap, so it renders immediately in every state — including
  // while the worker is still fitting the regression.
  const quartilePanel = quartiles.length > 0 && (
    <div className="panel">
      <h2>Win rate by quartile — no model, just buckets</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th className="data">Q1 (low)</th>
            <th className="data">Q2</th>
            <th className="data">Q3</th>
            <th className="data">Q4 (high)</th>
            <th className="data">Q4 − Q1</th>
          </tr>
        </thead>
        <tbody>
          {quartiles.map((q) => (
            <tr key={q.key}>
              <td>{q.label}</td>
              {q.quartiles.map((b, i) => (
                <td key={i} className="data" style={{ color: winRateColor(b.winRate) }} title={`${num(b.lo, 1)}–${num(b.hi, 1)} · ${b.n} games`}>
                  {pct(b.winRate, 0)}
                </td>
              ))}
              <td className="data" style={{ color: q.spread >= 0 ? "#3fcf8e" : "#f0564f" }}>
                {q.spread >= 0 ? "+" : ""}{num(q.spread * 100, 0)} pp
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint">
        Games sorted by each metric and cut into four equal buckets; each cell is the win rate in that bucket (hover
        for the value range). This is the raw association with nothing controlled — compare it against the adjusted
        column above to see how much of it is context.
      </div>
    </div>
  );

  if (!model || !primary) {
    return (
      <>
        <CoachPanel games={games} tournamentMoveBenchmarks={tournamentMoveBenchmarks} />

        <div className="panel">
          <h2>What predicts your wins</h2>
          {toggle}
          {fit.status === "pending" ? (
            <div className="empty-note">Fitting the win model in the background — everything else here is live.</div>
          ) : fit.status === "error" ? (
            <div className="empty-note">
              The win model couldn't be computed — its background worker failed (often a stale tab after a site
              update). The rest of this tab is unaffected; switch tabs and back, or reload, to retry.
            </div>
          ) : (
            <div className="empty-note">
              Not enough decided games in the current filter to fit a model — need at least 40 games with every metric
              measurable and 10+ wins and losses.
            </div>
          )}
        </div>
        {quartilePanel}
        <Sessions games={games} />
      </>
    );
  }

  return (
    <>
      <CoachPanel games={games} tournamentMoveBenchmarks={tournamentMoveBenchmarks} />

      <div className="panel">
        <h2>What would help you win — logistic regression</h2>
        {toggle}
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th style={{ width: "20%" }}>Pull on win odds{hasAdjusted ? " (adjusted)" : ""}</th>
              <th className="data">Odds × per +1 SD</th>
              <th className="data">Raw shift</th>
              {hasAdjusted && <th className="data">Adjusted shift</th>}
              <th className="data">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const ev = evidence(c.p);
              const raw = rawByKey.get(c.key);
              return (
                <tr key={c.key} style={ev.dim ? { opacity: 0.55 } : undefined}>
                  <td>
                    {c.label}
                    {c.group === "outcome" && (
                      <span className="tag" style={{ marginLeft: 6 }}>outcome-linked</span>
                    )}
                  </td>
                  <td><CoefBar coef={c.coef} max={maxCoef} /></td>
                  <td className="data">{num(c.oddsPerSd, 2)}×</td>
                  <td className="data" style={{ color: raw && raw.coef >= 0 ? "#3fcf8e" : "#f0564f", opacity: hasAdjusted ? 0.6 : 1 }}>
                    {raw ? ppText(raw.coef) : "—"}
                  </td>
                  {hasAdjusted && (
                    <td className="data" style={{ color: c.coef >= 0 ? "#3fcf8e" : "#f0564f" }}>{ppText(c.coef)}</td>
                  )}
                  <td className="data">{ev.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="hint">
          Fit on {model.n.toLocaleString()} decided games (win rate {pct(model.baseRate, 0)})
          {hasAdjusted && model.controls.length > 0 && <> · adjusted for {model.controls.join(", ")}</>}
          {" "}· pseudo-R² {num(primary.mcfaddenR2, 2)} · AUC {num(primary.auc, 2)}
          {model.dropped.length > 0 && <> · dropped (no variance): {model.dropped.join(", ")}</>}
          <br />
          {hasAdjusted ? (
            <>
              <b>Raw shift</b> is the simple association; <b>adjusted shift</b> re-asks the question within the same
              opponent, character, stage, and stretch of time — the closest replay data gets to "would doing more of
              this help?". A raw effect that collapses after adjustment was riding along with context (e.g. you moved
              better in eras or matchups you were already winning). Effects are in win-probability points per +1 SD of
              the metric, near an even game. Faded rows are indistinguishable from noise.
            </>
          ) : (
            <>
              Not enough repeated context (opponents, characters, stages) in this filter to fit the adjusted model —
              showing raw associations only.
            </>
          )}
        </div>
      </div>

      {quartilePanel}

      <div className="panel">
        <h2>Reading this honestly</h2>
        <div className="hint" style={{ fontSize: 13, lineHeight: 1.6 }}>
          <b>Adjustment helps, but it isn't an experiment.</b> The adjusted model compares your games within the same
          opponent, character, stage, and period, which removes the biggest confounds — but it still can't see things
          like how warmed up you were or an opponent having an off day. Treat "adjusted + strong evidence + agrees with
          the quartile table" as a solid practice lead, not a guarantee.
          {includeOutcome && (
            <>
              <br />
              <b>Outcome-linked stats are partly the win itself.</b> Openings/kill, neutral-win share, damage/opening
              move mechanically with winning — they'll dominate the table without telling you what to practice. That's
              why the default view is habits only. Openings/kill is also only defined in games where you took a stock,
              which skews its sample toward wins.
            </>
          )}
          {model.collinear.length > 0 && (
            <>
              <br />
              <b>Correlated metrics split credit:</b>{" "}
              {model.collinear.map((c, i) => (
                <span key={i}>
                  {i > 0 && "; "}
                  {c.a} ↔ {c.b} (r = {num(c.r, 2)})
                </span>
              ))}
              . The regression divides one shared effect between them — read them as a bundle, and trust the quartile
              table for each one alone.
            </>
          )}
          {!primary.converged && (
            <>
              <br />
              <b>Note:</b> the fit stopped before full convergence — treat coefficients as approximate.
            </>
          )}
        </div>
      </div>
      {/* Fatigue and tilt come last: the model panels are what the coach list
          at the top is drawn from, and "Reading this honestly" is the caveat
          for them, so those three stay adjacent. */}
      <Sessions games={games} />
    </>
  );
}
