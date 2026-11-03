import type { ResolvedGame } from "./types";
import {
  actionImpact, byMode, byMyCharacter, byOppCharacter, byOpponent, byStage, computeSessions, computeSets,
  executionSummary, moveImpact, setsSummary, stageCharMatrix, tally, tiltStats, winRateBySessionPosition,
  type WL,
} from "./stats";
import { charName, stageName } from "./melee";

/**
 * Prescriptive coaching: turn the selectors the dashboard already computes into
 * a short ranked list of plain-English "do this" items. Every item is gated on
 * sample size and a z-score against the player's own baseline, so nothing here
 * is noise dressed up as advice — if the data doesn't clear the bar, we say
 * nothing rather than something.
 */

export interface Recommendation {
  kind:
    | "matchup" | "stage-ban" | "stage-pick" | "matchup-stage"
    | "tilt" | "fatigue" | "cold-start" | "time-of-day" | "sets"
    | "rival" | "mode" | "my-character"
    | "execution" | "move" | "action";
  headline: string;
  detail: string;
  /** Effect size × evidence; used only for ordering. */
  score: number;
}

export interface CoachMoveBenchmark {
  characterId: number;
  gameCount: number;
  sourceLabel?: string;
  /** Aggregate landed instances by the same grouped move keys used by moveImpact(). */
  landedByMove: Record<string, number>;
}

export interface RecommendationOptions {
  tournamentMoveBenchmarks?: CoachMoveBenchmark[];
}

export const COACH_MIN_DECIDED = 40;

const pctText = (p: number, digits = 0) => `${(p * 100).toFixed(digits)}%`;

/** One-sample z of p against baseline p0 over n decided games. */
const zScore = (p: number, p0: number, n: number) => (p - p0) / Math.sqrt((p0 * (1 - p0)) / n);

/**
 * ~98% one-sided. Raised from 1.6 when the detector count went from seven to
 * fifteen: at 1.6 (~5.5% per test) fifteen tests expect roughly one spurious
 * item per run, which is precisely the "noise dressed up as advice" this module
 * promises not to produce. At 2.0 that falls to about a third of an item.
 *
 * This is not a full multiple-comparisons correction and should not be read as
 * one. Several detectors report the most extreme of many candidates — the
 * matchup scan looks at every character, the rival scan at every opponent — so
 * their real false-positive rate is higher than a single test's. The scan
 * heaviest of them carries its own stricter gate below.
 */
const Z_GATE = 2.0;

/** For a detector picking the worst of a large grid — see the matchup×stage scan. */
const Z_GATE_SCAN = 2.5;

/**
 * Effect sizes are not all in the same unit, so ordering needs them on a common
 * scale before `|effect| × √n` compares across kinds. Most detectors report a
 * win-rate delta and weigh 1; the exceptions are declared here rather than
 * buried at their call sites, which is where they used to live.
 */
const KIND_WEIGHT: Record<Recommendation["kind"], number> = {
  matchup: 1,
  "stage-ban": 1,
  "stage-pick": 1,
  "matchup-stage": 1,
  tilt: 1,
  fatigue: 1,
  "cold-start": 1,
  "time-of-day": 1,
  sets: 1,
  rival: 1,
  mode: 1,
  "my-character": 1,
  // Percentage points of L-cancel passed as a fraction — scaled to rough parity
  // with win-rate effects so it ranks rather than dominates.
  execution: 2,
  // Median-split usage against win rate: correlational, and share-split effects
  // run hot, so both are halved against the direct win-rate comparisons.
  move: 0.5,
  action: 0.5,
};

/** Most negative z among rows clearing `minDecided`, or null if none reach the gate. */
function worstBy<T extends WL>(
  rows: T[],
  p0: number,
  minDecided: number,
  gate = Z_GATE,
): { row: T; z: number; rate: number } | null {
  let worst: { row: T; z: number; rate: number } | null = null;
  for (const row of rows) {
    if (row.decided < minDecided || row.winRate === null) continue;
    const z = zScore(row.winRate, p0, row.decided);
    if (z <= -gate && (!worst || z < worst.z)) worst = { row, z, rate: row.winRate };
  }
  return worst;
}

/** Local hours, because what matters is the player's night and not a timezone. */
const HOUR_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "after midnight", lo: 0, hi: 5 },
  { label: "before noon", lo: 6, hi: 11 },
  { label: "the afternoon", lo: 12, hi: 17 },
  { label: "the evening", lo: 18, hi: 23 },
];

export function recommendations(games: ResolvedGame[], max = 5, options: RecommendationOptions = {}): Recommendation[] {
  const base = tally(games);
  if (base.decided < COACH_MIN_DECIDED || base.winRate === null) return [];
  const p0 = base.winRate;
  if (p0 <= 0 || p0 >= 1) return [];
  const out: Recommendation[] = [];
  const push = (kind: Recommendation["kind"], headline: string, detail: string, effect: number, n: number) =>
    out.push({ kind, headline, detail, score: Math.abs(effect) * KIND_WEIGHT[kind] * Math.sqrt(n) });

  // Worst matchup by opponent character, with an in-matchup stage tip when one stands out.
  const oppCharRows = byOppCharacter(games);
  let worstMu: { char: number; rate: number; decided: number; z: number } | null = null;
  for (const row of oppCharRows) {
    if (row.decided < 20 || row.winRate === null) continue;
    const z = zScore(row.winRate, p0, row.decided);
    if (z <= -Z_GATE && (!worstMu || z < worstMu.z)) worstMu = { char: row.characterId, rate: row.winRate, decided: row.decided, z };
  }
  if (worstMu) {
    const mu = worstMu;
    const inMatchup = games.filter((g) => g.opp.characterId === mu.char);
    let stageTip = "";
    let bestStage: { id: number; rate: number; decided: number } | null = null;
    for (const s of byStage(inMatchup)) {
      if (s.decided < 8 || s.winRate === null) continue;
      if (s.winRate >= mu.rate + 0.12 && (!bestStage || s.winRate > bestStage.rate)) {
        bestStage = { id: s.stageId, rate: s.winRate, decided: s.decided };
      }
    }
    if (bestStage) {
      stageTip = ` One lever already works: you win ${pctText(bestStage.rate)} of this matchup on ${stageName(bestStage.id)} (${bestStage.decided} games) — take them there.`;
    }
    push(
      "matchup",
      `Drill the ${charName(mu.char)} matchup`,
      `You win ${pctText(mu.rate)} of ${mu.decided} decided games against ${charName(mu.char)}, versus ${pctText(p0)} overall — your worst common matchup.${stageTip}`,
      mu.rate - p0,
      mu.decided,
    );
  }

  // Stage to ban / stage to take, independent of matchup.
  let ban: { id: number; rate: number; decided: number; z: number } | null = null;
  let pick: { id: number; rate: number; decided: number; z: number } | null = null;
  for (const s of byStage(games)) {
    if (s.decided < 30 || s.winRate === null) continue;
    const z = zScore(s.winRate, p0, s.decided);
    if (z <= -Z_GATE && (!ban || z < ban.z)) ban = { id: s.stageId, rate: s.winRate, decided: s.decided, z };
    if (z >= Z_GATE && (!pick || z > pick.z)) pick = { id: s.stageId, rate: s.winRate, decided: s.decided, z };
  }
  if (ban) {
    push(
      "stage-ban",
      `Ban ${stageName(ban.id)}`,
      `You win ${pctText(ban.rate)} of ${ban.decided} decided games there, versus ${pctText(p0)} overall. Until that gap closes, spend your ban on it every time.`,
      ban.rate - p0,
      ban.decided,
    );
  }
  if (pick) {
    push(
      "stage-pick",
      `Counterpick ${stageName(pick.id)}`,
      `${pctText(pick.rate)} over ${pick.decided} decided games, versus ${pctText(p0)} overall — your best stage by a real margin. Take opponents there when you get the choice.`,
      pick.rate - p0,
      pick.decided,
    );
  }

  // Matchup × stage: a cell worse than the character alone explains. The grid
  // runs to ~100 cells and this reports its worst, so it carries the stricter
  // gate; requiring 12 points below the character's own rate is what makes it
  // an interaction claim rather than the matchup tip said twice.
  const charRate = new Map<number, number>();
  for (const row of oppCharRows) if (row.winRate !== null) charRate.set(row.characterId, row.winRate);
  let worstCell: { stage: number; char: number; rate: number; decided: number; charRate: number; z: number } | null = null;
  for (const cell of stageCharMatrix(games, "opp").cells.values()) {
    if (cell.decided < 15 || cell.winRate === null) continue;
    const overall = charRate.get(cell.charId);
    if (overall === undefined || cell.winRate > overall - 0.12) continue;
    const z = zScore(cell.winRate, p0, cell.decided);
    if (z <= -Z_GATE_SCAN && (!worstCell || z < worstCell.z)) {
      worstCell = { stage: cell.stageId, char: cell.charId, rate: cell.winRate, decided: cell.decided, charRate: overall, z };
    }
  }
  if (worstCell) {
    const c = worstCell;
    push(
      "matchup-stage",
      `Ban ${stageName(c.stage)} against ${charName(c.char)}`,
      `You win ${pctText(c.rate)} of ${c.decided} decided games in that matchup on that stage, against ${pctText(c.charRate)} in the matchup as a whole. The character isn't the problem here — the stage is.`,
      c.rate - c.charRate,
      c.decided,
    );
  }

  // Tilt: performance right after consecutive losses, within a session.
  const sessions = computeSessions(games);
  const tilt = tiltStats(sessions);
  let tiltWins = 0, tiltDecided = 0;
  for (const row of tilt) {
    if (row.label === "After 2 losses" || row.label === "After 3+ losses") {
      tiltWins += row.wins;
      tiltDecided += row.decided;
    }
  }
  if (tiltDecided >= 25) {
    const rate = tiltWins / tiltDecided;
    if (zScore(rate, p0, tiltDecided) <= -Z_GATE) {
      push(
        "tilt",
        "Walk away after two straight losses",
        `Down two or more in a session, you win just ${pctText(rate)} of the next games (${tiltDecided} of them), versus ${pctText(p0)} overall. A five-minute break is worth more than a runback.`,
        rate - p0,
        tiltDecided,
      );
    }
  }

  // Cold start: the first game of a session, before the hands are warm. The
  // opener bucket already exists for the tilt breakdown.
  const opener = tilt.find((row) => row.label === "Session opener");
  if (opener && opener.decided >= 25 && opener.winRate !== null && zScore(opener.winRate, p0, opener.decided) <= -Z_GATE) {
    push(
      "cold-start",
      "Warm up before the first one counts",
      `You win ${pctText(opener.winRate)} of session openers (${opener.decided} of them), versus ${pctText(p0)} overall. Whatever the first game teaches your hands, it is currently costing a game to learn it.`,
      opener.winRate - p0,
      opener.decided,
    );
  }

  // Fatigue: late-session games underperforming.
  const pos = winRateBySessionPosition(sessions);
  let lateWins = 0, lateDecided = 0;
  for (const row of pos) {
    if (row.label === "Games 16–20" || row.label === "Games 21+") {
      lateWins += row.wins;
      lateDecided += row.decided;
    }
  }
  if (lateDecided >= 25) {
    const rate = lateWins / lateDecided;
    if (zScore(rate, p0, lateDecided) <= -Z_GATE) {
      push(
        "fatigue",
        "Cap your sessions around 15 games",
        `Past game 15 of a session your win rate drops to ${pctText(rate)} (${lateDecided} decided games), versus ${pctText(p0)} overall. The long sets are donating wins.`,
        rate - p0,
        lateDecided,
      );
    }
  }

  // Time of day, in the player's own local hours — a different lever from
  // fatigue, which is position within a session rather than where that session
  // sits in the day.
  const hourAgg = HOUR_BUCKETS.map((b) => ({ label: b.label, games: 0, wins: 0, losses: 0, decided: 0, winRate: null as number | null }));
  for (const g of games) {
    if (g.isWin === null || !g.date) continue;
    const hour = g.date.getHours();
    const bi = HOUR_BUCKETS.findIndex((b) => hour >= b.lo && hour <= b.hi);
    if (bi < 0) continue;
    const a = hourAgg[bi]!; // hourAgg is index-aligned with HOUR_BUCKETS
    a.games++;
    a.decided++;
    if (g.isWin) a.wins++;
    else a.losses++;
  }
  for (const a of hourAgg) a.winRate = a.decided ? a.wins / a.decided : null;
  const worstHour = worstBy(hourAgg, p0, 30);
  if (worstHour) {
    push(
      "time-of-day",
      `Your worst hours are ${worstHour.row.label}`,
      `${pctText(worstHour.rate)} over ${worstHour.row.decided} decided games played ${worstHour.row.label}, versus ${pctText(p0)} across the rest of the day. Moving those sessions is cheaper than out-playing the deficit.`,
      worstHour.rate - p0,
      worstHour.row.decided,
    );
  }

  // Set closing: the third game of a 2–1 set. Both players are 1–1 going into
  // it, which is why this tests against 50% rather than the overall win rate.
  // Conditioning on a split set already equalises the two sides, so p0 would be
  // the wrong bar — it would fire this for anyone with a winning record.
  const setStats = setsSummary(computeSets(games));
  if (setStats.deciders.total >= 25) {
    const rate = setStats.deciders.wins / setStats.deciders.total;
    if (zScore(rate, 0.5, setStats.deciders.total) <= -Z_GATE) {
      push(
        "sets",
        "You're losing the games that decide sets",
        `In sets that reached a third game you take the decider ${pctText(rate)} of the time (${setStats.deciders.total} sets). Both players are 1–1 at that point, so this should sit near 50% — a gap here is nerves or a failure to adjust, not the matchup.`,
        rate - 0.5,
        setStats.deciders.total,
      );
    }
  }

  // A specific opponent, which is not the same finding as their character:
  // being fine against Fox and losing to one Fox is a scouting problem. When
  // they mostly play the character the matchup tip already named, stay quiet
  // rather than say it twice.
  const rival = worstBy(byOpponent(games), p0, 20);
  if (rival && rival.row.topCharacter !== worstMu?.char) {
    const name = rival.row.displayName ?? rival.row.code;
    push(
      "rival",
      `${name} has your number`,
      `You win ${pctText(rival.rate)} of ${rival.row.decided} decided games against ${name}, versus ${pctText(p0)} overall. One opponent this far below your baseline is usually a habit they've read — change something before the next set, not during it.`,
      rival.rate - p0,
      rival.row.decided,
    );
  }

  // Mode. This compares a mode against the all-mode baseline it is itself part
  // of, so a mode that dominates the library drags p0 toward itself and can
  // only ever look average. Conservative, not wrong.
  const modeRows = byMode(games).filter((row) => row.mode !== "overall" && row.mode !== "unknown");
  const worstMode = worstBy(modeRows, p0, 30);
  if (worstMode) {
    push(
      "mode",
      `Your ${worstMode.row.mode} games are the weak spot`,
      `${pctText(worstMode.rate)} over ${worstMode.row.decided} decided ${worstMode.row.mode} games, versus ${pctText(p0)} across every mode. Same hands, different result — look at what changes when the queue does.`,
      worstMode.rate - p0,
      worstMode.row.decided,
    );
  }

  // Secondary character. Pointless with a single character: "your Falco is
  // below your average" would just be restating the average back at you.
  const charRows = byMyCharacter(games);
  if (charRows.filter((row) => row.decided >= 30).length >= 2) {
    const worstChar = worstBy(charRows, p0, 30);
    if (worstChar) {
      push(
        "my-character",
        `${charName(worstChar.row.characterId)} is costing you games`,
        `You win ${pctText(worstChar.rate)} of ${worstChar.row.decided} decided games on ${charName(worstChar.row.characterId)}, versus ${pctText(p0)} across your characters. Either it gets practice time or it stops coming out in games you want to win.`,
        worstChar.rate - p0,
        worstChar.row.decided,
      );
    }
  }

  // Move habit: a move that's a real part of the kit whose heavy-usage games
  // are losses. Two-proportion z between the heavy and light halves.
  type MoveCandidate = {
    label: string;
    delta: number;
    high: number;
    low: number;
    n: number;
    share: number;
    z: number;
    characterId?: number;
    tournamentShare?: number;
    tournamentGames?: number;
    benchmarkLabel?: string;
  };
  const negativeMoveCandidate = (
    rows: ReturnType<typeof moveImpact>,
    benchmark?: CoachMoveBenchmark,
  ): MoveCandidate | null => {
    let candidate: MoveCandidate | null = null;
    const tournamentLanded = benchmark
      ? Object.values(benchmark.landedByMove).reduce((sum, count) => sum + count, 0)
      : 0;
    for (const row of rows) {
      const tournamentShare = benchmark && tournamentLanded > 0
        ? (benchmark.landedByMove[row.key] ?? 0) / tournamentLanded
        : undefined;
      if (benchmark) {
        if (benchmark.gameCount < 100 || tournamentShare === undefined) continue;
        const overuseGap = row.avgShare - tournamentShare;
        if (overuseGap < Math.max(0.04, tournamentShare * 0.5)) continue;
      }
      if (row.avgShare < 0.05 || row.delta === null || row.winRateHigh === null || row.winRateLow === null) continue;
      if (row.highN + row.lowN < 60) continue;
      const pooled = (row.highWins + row.lowWins) / (row.highN + row.lowN);
      if (pooled <= 0 || pooled >= 1) continue;
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / row.highN + 1 / row.lowN));
      const z = (row.winRateHigh - row.winRateLow) / se;
      if (z <= -Z_GATE && row.delta <= -0.08 && (!candidate || z < candidate.z)) {
        candidate = {
          label: row.label,
          delta: row.delta,
          high: row.winRateHigh,
          low: row.winRateLow,
          n: row.highN + row.lowN,
          share: row.avgShare,
          z,
          characterId: benchmark?.characterId,
          tournamentShare,
          tournamentGames: benchmark?.gameCount,
          benchmarkLabel: benchmark?.sourceLabel,
        };
      }
    }
    return candidate;
  };

  let worstMove: MoveCandidate | null = null;
  for (const benchmark of options.tournamentMoveBenchmarks ?? []) {
    const characterGames = games.filter((game) => game.me.characterId === benchmark.characterId);
    const candidate = negativeMoveCandidate(moveImpact(characterGames), benchmark);
    if (candidate && (!worstMove || candidate.z < worstMove.z)) worstMove = candidate;
  }
  // Preserve the local-only detector when the archive is unavailable or no
  // move is unusually common versus its character benchmark.
  if (!worstMove) worstMove = negativeMoveCandidate(moveImpact(games));
  if (worstMove) {
    const benchmarkDetail = worstMove.tournamentShare !== undefined && worstMove.tournamentGames !== undefined && worstMove.characterId !== undefined
      ? `${worstMove.label} is ${pctText(worstMove.share)} of your landed hits, versus ${pctText(worstMove.tournamentShare)} across ${worstMove.tournamentGames.toLocaleString()} ${worstMove.benchmarkLabel ?? "Tournament"} ${charName(worstMove.characterId)} player-games. `
      : `${worstMove.label} averages ${pctText(worstMove.share)} of your landed hits. `;
    push(
      "move",
      `Rethink the ${worstMove.label.toLowerCase()} habit`,
      `${benchmarkDetail}In games where you lean on it hardest you win ${pctText(worstMove.high)}, versus ${pctText(worstMove.low)} when you use it least (${worstMove.n} games). That is an association, not proof the move causes losses—check the situations where you reach for it.`,
      worstMove.delta,
      worstMove.n,
    );
  }

  // The same median split over defensive and movement options. Usage here is a
  // rate per minute rather than a share of landed hits, and rates are not
  // compositional the way shares are: a losing game produces more panic rolls,
  // so the arrow runs both ways. Worded as something to look at, not a cause.
  let worstAction: { label: string; delta: number; high: number; low: number; n: number; rate: number; z: number } | null = null;
  for (const row of actionImpact(games)) {
    if (row.avgShare < 0.5 || row.delta === null || row.winRateHigh === null || row.winRateLow === null) continue;
    if (row.highN + row.lowN < 60) continue;
    const pooled = (row.highWins + row.lowWins) / (row.highN + row.lowN);
    if (pooled <= 0 || pooled >= 1) continue;
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / row.highN + 1 / row.lowN));
    const z = (row.winRateHigh - row.winRateLow) / se;
    if (z <= -Z_GATE && row.delta <= -0.08 && (!worstAction || z < worstAction.z)) {
      worstAction = { label: row.label, delta: row.delta, high: row.winRateHigh, low: row.winRateLow, n: row.highN + row.lowN, rate: row.avgShare, z };
    }
  }
  if (worstAction) {
    const a = worstAction;
    push(
      "action",
      `Watch the ${a.label.toLowerCase()} rate`,
      `You average ${a.rate.toFixed(1)} ${a.label.toLowerCase()} per minute, and in your highest-rate games you win ${pctText(a.high)} versus ${pctText(a.low)} in your lowest (${a.n} games). This one runs both ways — being behind invites the option too — so treat it as something to check on video rather than a number to drive down.`,
      a.delta,
      a.n,
    );
  }

  // Execution drift: recent L-cancel vs career.
  const career = executionSummary(games, games.length);
  const recent = executionSummary(games, 50);
  if (games.length >= 150 && career.lCancel !== null && recent.lCancel !== null) {
    const diff = recent.lCancel - career.lCancel;
    if (Math.abs(diff) >= 2) {
      const up = diff > 0;
      push(
        "execution",
        up ? "Your hands are heating up — keep the routine" : "L-cancels are slipping",
        `${recent.lCancel.toFixed(1)}% L-cancel over your last 50 games, versus ${career.lCancel.toFixed(1)}% career${up ? ". Whatever you changed recently, keep doing it." : " — worth a warm-up routine before queueing."}`,
        diff / 100,
        50,
      );
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
