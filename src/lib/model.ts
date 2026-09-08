import type { ResolvedGame } from "./types";

/**
 * Client-side "what predicts my wins?" models. Everything here is plain
 * TypeScript because replay data never leaves the browser.
 *
 * The workhorse is L2-regularized logistic regression fit by IRLS (Newton).
 * Win/loss is binary, so logistic regression is the multivariate linear
 * model for this outcome: each coefficient is the change in log-odds of
 * winning per +1 SD of that metric, holding the other terms fixed.
 *
 * Two fits are reported side by side:
 *  - RAW: metrics only — "my wins look like this".
 *  - ADJUSTED: metrics + fixed effects for opponent, my character, stage,
 *    and a time trend — "within the same context, did more of this still
 *    come with more wins?". The gap between the two columns is confounding
 *    made visible.
 *
 * Cost is O(iterations · n · k²) and k can reach ~70 with controls — heavy
 * enough on a 30k-game library to jank the main thread. The fit is therefore
 * split in two: buildWinModelInput() turns games into plain structured-
 * cloneable data (cheap, main thread), and fitWinModelFromInput() does the
 * math — normally inside src/worker/model.worker.ts.
 */

export type FeatureGroup = "execution" | "outcome";

export interface FeatureDef {
  key: string;
  label: string;
  group: FeatureGroup;
  /** null = not measurable in this game (e.g. no aerials landed → no L-cancel rate). */
  value: (g: ResolvedGame) => number | null;
}

const perMin = (count: number, g: ResolvedGame): number | null => {
  const minutes = g.rec.durationFrames / 3600;
  return minutes > 0 ? count / minutes : null;
};

export const WIN_MODEL_FEATURES: FeatureDef[] = [
  // --- Execution / habits: things you can directly practice ---
  {
    key: "lCancelPct", label: "L-cancel %", group: "execution",
    value: (g) => {
      const att = g.me.lCancelSuccess + g.me.lCancelFail;
      return att > 0 ? (g.me.lCancelSuccess / att) * 100 : null;
    },
  },
  { key: "ipm", label: "Inputs / minute", group: "execution", value: (g) => g.me.inputsPerMinute },
  { key: "wavedashes", label: "Wavedashes / min", group: "execution", value: (g) => perMin(g.me.actions?.wavedashes ?? 0, g) },
  { key: "wavelands", label: "Wavelands / min", group: "execution", value: (g) => perMin(g.me.actions?.wavelands ?? 0, g) },
  { key: "dashDances", label: "Dash dances / min", group: "execution", value: (g) => perMin(g.me.actions?.dashDances ?? 0, g) },
  { key: "rolls", label: "Rolls / min", group: "execution", value: (g) => perMin(g.me.actions?.rolls ?? 0, g) },
  { key: "airDodges", label: "Air dodges / min", group: "execution", value: (g) => perMin(g.me.actions?.airDodges ?? 0, g) },
  { key: "spotDodges", label: "Spot dodges / min", group: "execution", value: (g) => perMin(g.me.actions?.spotDodges ?? 0, g) },
  { key: "ledgeGrabs", label: "Ledge grabs / min", group: "execution", value: (g) => perMin(g.me.actions?.ledgeGrabs ?? 0, g) },
  { key: "crouchCancels", label: "Crouch cancels / min", group: "execution", value: (g) => perMin(g.me.actions?.crouchCancels ?? 0, g) },
  { key: "grabs", label: "Grab attempts / min", group: "execution", value: (g) => perMin(g.me.actions?.grabs ?? 0, g) },
  // --- Outcome-linked: partly mechanical consequences of winning, not habits ---
  { key: "dpo", label: "Damage / opening", group: "outcome", value: (g) => g.me.damagePerOpening },
  { key: "opk", label: "Openings / kill", group: "outcome", value: (g) => g.me.openingsPerKill },
  {
    key: "neutralShare", label: "Neutral-win share", group: "outcome",
    value: (g) => {
      const total = g.me.neutralWins + g.opp.neutralWins;
      return total > 0 ? (g.me.neutralWins / total) * 100 : null;
    },
  },
  { key: "counterHits", label: "Counter hits / min", group: "outcome", value: (g) => perMin(g.me.counterHits, g) },
  { key: "trades", label: "Beneficial trades / min", group: "outcome", value: (g) => perMin(g.me.beneficialTrades, g) },
];

export interface CoefRow {
  key: string;
  label: string;
  group: FeatureGroup;
  /** Log-odds change per +1 SD of the metric, other terms held fixed. */
  coef: number;
  se: number;
  z: number;
  p: number;
  /** exp(coef): multiplicative odds change per +1 SD. */
  oddsPerSd: number;
}

export interface FitStats {
  coefs: CoefRow[]; // one per surviving feature, model order
  mcfaddenR2: number;
  auc: number;
  converged: boolean;
}

export interface WinModel {
  n: number;
  wins: number;
  baseRate: number;
  raw: FitStats;
  /** null when no control column had variance (e.g. one opponent, one char, few games). */
  adjusted: FitStats | null;
  /** Human-readable list of what the adjusted fit controls for. */
  controls: string[];
  /** Feature pairs with |r| > 0.7 — coefficients split credit between these. */
  collinear: { a: string; b: string; r: number }[];
  dropped: string[]; // zero-variance features excluded from the fit
}

/** Gauss-Jordan inverse; returns null if singular. Fine for k ≤ ~60. */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    if (piv !== col) [M[piv], M[col]] = [M[col]!, M[piv]!];
    const pivRow = M[col]!;
    const d = pivRow[col]!;
    for (let c = 0; c < 2 * n; c++) pivRow[c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = M[r]!;
      const f = row[col]!;
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) row[c]! -= f * pivRow[c]!;
    }
  }
  return M.map((row) => row.slice(n));
}

/** Standard normal upper-tail probability (Abramowitz & Stegun 26.2.17). */
function upperTail(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804 * Math.exp((-z * z) / 2);
  return d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
}

const twoSidedP = (z: number): number => Math.min(1, 2 * upperTail(Math.abs(z)));

/** Mann-Whitney AUC with average ranks for ties. */
function computeAuc(scores: number[], y: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const ranks = new Array<number>(scores.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]!] === scores[idx[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]!] = avg;
    i = j + 1;
  }
  let posRankSum = 0, nPos = 0;
  for (let r = 0; r < y.length; r++) {
    if (y[r] === 1) { posRankSum += ranks[r]!; nPos++; }
  }
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (posRankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

const clampExp = (xb: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, xb))));

interface CoreFit {
  beta: number[];
  Hinv: number[][];
  converged: boolean;
  ll: number;
  auc: number;
}

/** IRLS on a pre-built design matrix (column 0 = intercept). */
function fitCore(X: number[][], y: number[], lambdas: number[]): CoreFit | null {
  const n = X.length;
  const k = X[0]!.length;
  let beta = new Array<number>(k).fill(0);
  let converged = false;
  let Hinv: number[][] | null = null;
  for (let iter = 0; iter < 60; iter++) {
    const p = X.map((row) => clampExp(row.reduce((s, v, j) => s + v * beta[j]!, 0)));
    const grad = new Array<number>(k).fill(0);
    const H: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let r = 0; r < n; r++) {
      const pr = p[r]!;
      const w = Math.max(1e-9, pr * (1 - pr));
      const resid = y[r]! - pr;
      const row = X[r]!;
      for (let j = 0; j < k; j++) {
        const rowj = row[j]!;
        grad[j]! += rowj * resid;
        const rw = rowj * w;
        const Hj = H[j]!;
        for (let l = j; l < k; l++) Hj[l]! += rw * row[l]!;
      }
    }
    for (let j = 0; j < k; j++) for (let l = 0; l < j; l++) H[j]![l] = H[l]![j]!;
    for (let j = 1; j < k; j++) {
      grad[j]! -= lambdas[j]! * beta[j]!;
      H[j]![j]! += lambdas[j]!;
    }
    Hinv = invert(H);
    if (!Hinv) return null;
    const step = Hinv.map((row) => row.reduce((s, v, j) => s + v * grad[j]!, 0));
    beta = beta.map((b, j) => b + step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) { converged = true; break; }
  }
  if (!Hinv) return null;
  const scores = X.map((row) => row.reduce((s, v, j) => s + v * beta[j]!, 0));
  let ll = 0;
  for (let r = 0; r < n; r++) {
    const p = clampExp(scores[r]!);
    ll += y[r] === 1 ? Math.log(Math.max(1e-12, p)) : Math.log(Math.max(1e-12, 1 - p));
  }
  return { beta, Hinv, converged, ll, auc: computeAuc(scores, y) };
}

/** Standardize a column in place; returns false (drop it) when variance is ~0. */
function standardize(col: number[]): boolean {
  const n = col.length;
  const mean = col.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(col.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  if (sd < 1e-9) return false;
  for (let i = 0; i < n; i++) col[i] = (col[i]! - mean) / sd;
  return true;
}

/** Only contexts seen ≥ this many times get their own fixed effect. */
const MIN_CONTEXT_GAMES = 15;
const MAX_OPPONENT_DUMMIES = 25;

/** Feature metadata without the value closure — safe to structured-clone. */
export interface WinModelFeatureMeta {
  key: string;
  label: string;
  group: FeatureGroup;
}

/** One usable game: feature values (order matches `features`) + context ids. */
export interface WinModelRow {
  f: number[];
  opp: string;
  char: number;
  stage: number;
}

/** Plain-data fit input, structured-cloneable so it can cross a worker boundary. */
export interface WinModelInput {
  features: WinModelFeatureMeta[];
  rows: WinModelRow[];
  y: number[];
}

/**
 * Extract the fit input from resolved games (listwise deletion: a game is
 * kept only when the outcome and every requested feature are measurable).
 * Cheap — O(n · k) — so it can run on the main thread; the expensive IRLS
 * consumes the result, normally in the model worker.
 */
export function buildWinModelInput(games: ResolvedGame[], features: FeatureDef[]): WinModelInput {
  const rows: WinModelRow[] = [];
  const y: number[] = [];
  for (const g of games) {
    if (g.isWin === null) continue;
    const f: number[] = [];
    let ok = true;
    for (const def of features) {
      const v = def.value(g);
      if (v === null || !Number.isFinite(v)) { ok = false; break; }
      f.push(v);
    }
    if (!ok) continue;
    rows.push({ f, opp: g.opp.connectCode ?? `port:${g.opp.port}`, char: g.me.characterId, stage: g.rec.stageId });
    y.push(g.isWin ? 1 : 0);
  }
  return { features: features.map(({ key, label, group }) => ({ key, label, group })), rows, y };
}

/**
 * Fit the raw and context-adjusted win models on a pre-extracted input.
 * Returns null when there's too little data to say anything (n < 40 or < 10
 * of either class). Pure math on plain data — this is what the model worker
 * runs.
 */
export function fitWinModelFromInput(input: WinModelInput): WinModel | null {
  const { features, rows, y } = input;

  const n = rows.length;
  const wins = y.reduce((s, v) => s + v, 0);
  if (n < 40 || wins < 10 || n - wins < 10) return null;

  // --- Feature columns (standardized; zero-variance dropped) ---
  const kept: number[] = [];
  const dropped: string[] = [];
  const featCols: number[][] = [];
  features.forEach((def, j) => {
    const col = rows.map((r) => r.f[j]!);
    if (standardize(col)) { kept.push(j); featCols.push(col); }
    else dropped.push(def.label);
  });
  if (kept.length === 0) return null;

  // Collinearity report on the standardized features.
  const collinear: { a: string; b: string; r: number }[] = [];
  for (let a = 0; a < kept.length; a++) {
    const colA = featCols[a]!;
    for (let b = a + 1; b < kept.length; b++) {
      const colB = featCols[b]!;
      let s = 0;
      for (let i = 0; i < n; i++) s += colA[i]! * colB[i]!;
      const r = s / n;
      if (Math.abs(r) > 0.7) collinear.push({ a: features[kept[a]!]!.label, b: features[kept[b]!]!.label, r });
    }
  }

  // --- Control columns: opponent / my character / stage dummies + time trend ---
  const countBy = <T>(pick: (r: WinModelRow) => T): Map<T, number> => {
    const m = new Map<T, number>();
    for (const r of rows) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1);
    return m;
  };
  const dummySet = <T>(counts: Map<T, number>, cap: number): T[] => {
    const eligible = [...counts.entries()]
      .filter(([, c]) => c >= MIN_CONTEXT_GAMES)
      .sort((a, b) => b[1] - a[1]);
    // The most common level is the reference category — everything is measured against it.
    return eligible.slice(1, cap + 1).map(([v]) => v);
  };

  const controlCols: number[][] = [];
  const controls: string[] = [];
  const addDummies = <T>(levels: T[], pick: (r: WinModelRow) => T, label: string) => {
    let added = 0;
    for (const level of levels) {
      const col = rows.map((r) => (pick(r) === level ? 1 : 0));
      if (standardize(col)) { controlCols.push(col); added++; }
    }
    if (added > 0) controls.push(`${label} (${added})`);
  };
  addDummies(dummySet(countBy((r) => r.opp), MAX_OPPONENT_DUMMIES), (r) => r.opp, "opponent");
  addDummies(dummySet(countBy((r) => r.char), 30), (r) => r.char, "my character");
  addDummies(dummySet(countBy((r) => r.stage), 30), (r) => r.stage, "stage");
  {
    // Games arrive date-sorted, so the row index is the improvement-over-time axis.
    const col = rows.map((_, i) => i);
    if (standardize(col)) { controlCols.push(col); controls.push("time trend"); }
  }

  // --- Fit both models on the identical sample ---
  const buildStats = (fit: CoreFit): FitStats => {
    const base = wins / n;
    const ll0 = wins * Math.log(base) + (n - wins) * Math.log(1 - base);
    const coefs = kept.map((j, idx) => {
      const def = features[j]!;
      const coef = fit.beta[idx + 1]!;
      const se = Math.sqrt(Math.max(0, fit.Hinv[idx + 1]![idx + 1]!));
      const z = se > 0 ? coef / se : 0;
      return {
        key: def.key,
        label: def.label,
        group: def.group,
        coef, se, z,
        p: twoSidedP(z),
        oddsPerSd: Math.exp(coef),
      };
    });
    return { coefs, mcfaddenR2: ll0 < 0 ? 1 - fit.ll / ll0 : 0, auc: fit.auc, converged: fit.converged };
  };

  const Xraw = Array.from({ length: n }, (_, i) => [1, ...featCols.map((c) => c[i]!)]);
  const rawFit = fitCore(Xraw, y, [0, ...featCols.map(() => 0.01)]);
  if (!rawFit) return null;
  const raw = buildStats(rawFit);

  let adjusted: FitStats | null = null;
  if (controlCols.length > 0) {
    const Xadj = Array.from({ length: n }, (_, i) => [
      1,
      ...featCols.map((c) => c[i]!),
      ...controlCols.map((c) => c[i]!),
    ]);
    // Slightly stronger ridge on the dummies: a regular you've never beaten
    // would otherwise push its fixed effect toward ±infinity.
    const lambdas = [0, ...featCols.map(() => 0.01), ...controlCols.map(() => 0.1)];
    const adjFit = fitCore(Xadj, y, lambdas);
    if (adjFit) adjusted = buildStats(adjFit);
  }

  return {
    n,
    wins,
    baseRate: wins / n,
    raw,
    adjusted,
    controls,
    collinear,
    dropped,
  };
}

/** Synchronous convenience wrapper: extract + fit in one call, on the caller's thread. */
export function fitWinModel(games: ResolvedGame[], features: FeatureDef[]): WinModel | null {
  return fitWinModelFromInput(buildWinModelInput(games, features));
}

export interface QuartileRow {
  key: string;
  label: string;
  group: FeatureGroup;
  n: number;
  /** Win rate + value range per quartile, Q1 (lowest values) → Q4 (highest). */
  quartiles: { winRate: number; n: number; lo: number; hi: number }[];
  /** Q4 win rate − Q1 win rate: the headline "does more of this come with more wins?" */
  spread: number;
}

/**
 * Model-free view of the same question: sort games by each metric, cut into
 * quartiles, report the win rate in each. No assumptions, no other-metric
 * adjustment — the cross-check for the regression table.
 */
export function quartileWinRates(games: ResolvedGame[], features: FeatureDef[]): QuartileRow[] {
  const out: QuartileRow[] = [];
  for (const f of features) {
    const pts: { v: number; win: number }[] = [];
    for (const g of games) {
      if (g.isWin === null) continue;
      const v = f.value(g);
      if (v === null || !Number.isFinite(v)) continue;
      pts.push({ v, win: g.isWin ? 1 : 0 });
    }
    if (pts.length < 40) continue;
    pts.sort((a, b) => a.v - b.v);
    const quartiles = Array.from({ length: 4 }, (_, q) => {
      const lo = Math.floor((q * pts.length) / 4);
      const hi = Math.floor(((q + 1) * pts.length) / 4);
      const slice = pts.slice(lo, hi);
      const winSum = slice.reduce((s, p) => s + p.win, 0);
      return { winRate: winSum / slice.length, n: slice.length, lo: slice[0]!.v, hi: slice[slice.length - 1]!.v };
    });
    out.push({
      key: f.key,
      label: f.label,
      group: f.group,
      n: pts.length,
      quartiles,
      spread: quartiles[3]!.winRate - quartiles[0]!.winRate,
    });
  }
  out.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
  return out;
}
