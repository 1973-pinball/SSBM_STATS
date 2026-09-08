import { useMemo, type ReactNode } from "react";
import type { ResolvedGame, ResolvedTeamGame } from "../lib/types";
import { singlesRecords, statCardData, teamsRecords, type GameRef } from "../lib/stats";
import { duration, int, num, pct, shortDate } from "../lib/format";
import { charName } from "../lib/melee";
import { CardActions } from "./CardActions";
import { useCardExport } from "./useCardExport";

/**
 * "[icon] FALC#123, Mar 3, 26" — however much of that the record carries.
 *
 * The stock sprite replaces the character's name rather than sitting beside it,
 * so unlike the player card's icons this one carries the name as alt text: it
 * is the only thing naming the character.
 */
function refNode(r: GameRef): ReactNode {
  return (
    <>
      <img className="sc-stock sc-stock-sm" src={`/stock/${r.oppChar}.png`} alt={charName(r.oppChar)} />
      {r.oppCode ?? "vs"}
      {r.date ? `, ${shortDate(r.date)}` : ""}
    </>
  );
}

interface Cell {
  label: string;
  value: string;
  sub?: ReactNode;
}

/**
 * Same shape as the player card above it — four across, so twelve records land
 * as 4x3 with no filler. Must match .sc-grid, which the records card inherits
 * rather than overriding.
 */
const COLUMNS = 4;

/**
 * Personal bests as one shareable card.
 *
 * This was its own tab of loose panels. It is the other half of the story the
 * player card tells — that card is who you are, this one is your best day — so
 * it borrows the same frame and cell language and exports through the same
 * client-side PNG path, and now sits at the foot of Overview instead of behind
 * a tab nobody opened twice.
 */
export function RecordsCard({ games, teamGames }: { games: ResolvedGame[]; teamGames: ResolvedTeamGame[] }) {
  const r = useMemo(() => singlesRecords(games), [games]);
  const t = useMemo(() => teamsRecords(teamGames), [teamGames]);
  const d = useMemo(() => statCardData(games), [games]);
  const { cardRef, copied, download, copy } = useCardExport(
    `ssbm-records-${(d.code ?? "player").replace(/[^A-Za-z0-9#-]/g, "")}.png`,
  );

  // Nothing here may repeat the player card above it — the two sit on the same
  // tab, and a figure shown twice reads as two findings. `bestWinStreak` is
  // deliberately absent: that is the player card's "Longest heater".
  //
  // Nemesis (most-losses-to) is gone for the same reason even though it is not
  // literally the same figure: for anyone with a regular opponent it resolves
  // to the card's Sworn rival, and the same code on both cards reads as a
  // repeat rather than a second finding.
  //
  // The remaining near-misses stay, because they answer different questions and
  // do not collapse onto the card's answer:
  //   - Favourite victim is most-wins-against; Sworn rival is most-played.
  //   - Best L-cancel day is a single day's peak; the card's "The hands" is a
  //     rolling average over the shared rolling window.
  //   - Longest game is the maximum; the card's Average match is the mean.
  const cells: Cell[] = [];
  if (r.worstLossStreak) {
    cells.push({
      label: "Worst loss streak",
      value: `${r.worstLossStreak.length} losses`,
      sub: r.worstLossStreak.end ? `ended ${shortDate(r.worstLossStreak.end)}` : undefined,
    });
  }
  if (r.highestDamage) {
    cells.push({ label: "Most damage in a game", value: `${int(r.highestDamage.value)}%`, sub: refNode(r.highestDamage) });
  }
  if (r.fastestWin) {
    cells.push({ label: "Fastest win", value: duration(r.fastestWin.seconds), sub: refNode(r.fastestWin) });
  }
  cells.push({ label: "Perfect wins", value: int(r.perfectWins), sub: "won with 4 stocks left" });
  if (r.longestGame) {
    cells.push({ label: "Longest game", value: duration(r.longestGame.seconds), sub: refNode(r.longestGame) });
  }
  if (r.bestLCancelDay) {
    cells.push({
      label: "Best L-cancel day",
      value: pct(r.bestLCancelDay.rate),
      sub: `${r.bestLCancelDay.day} · ${r.bestLCancelDay.attempts.toLocaleString()} attempts`,
    });
  }
  if (r.busiestDay) {
    cells.push({ label: "Most games in a day", value: `${r.busiestDay.games} games`, sub: r.busiestDay.day });
  }
  if (r.longestSession) {
    cells.push({ label: "Longest session", value: `${r.longestSession.games} games`, sub: shortDate(r.longestSession.start) });
  }

  if (r.victim) {
    cells.push({ label: "Favourite victim", value: r.victim.code, sub: `${r.victim.wins}–${r.victim.losses} against them` });
  }
  // Doubles records share the card rather than splitting it — every label here
  // already says 2v2, and the point was to end up with one thing to share.
  if (t.bestWinStreak) {
    cells.push({
      label: "Best 2v2 win streak",
      value: `${t.bestWinStreak.length} wins`,
      sub: t.bestWinStreak.end ? `ended ${shortDate(t.bestWinStreak.end)}` : undefined,
    });
  }
  if (t.grudge) {
    cells.push({
      label: "Biggest 2v2 FF grudge",
      value: `${num(t.grudge.ffPerGame, 1)}%/game`,
      sub: `${t.grudge.code} → me · ${t.grudge.games} games`,
    });
  }
  if (t.myTarget) {
    cells.push({
      label: "My most-FF'd teammate",
      value: `${num(t.myTarget.ffPerGame, 1)}%/game`,
      sub: `${t.myTarget.code} · ${t.myTarget.games} games`,
    });
  }

  if (cells.length === 0) return null;

  // .sc-grid draws its rules as a 1px gap over a --line background, so a ragged
  // final row would render as a bare stripe. Pad it with empty cells.
  const filler = (COLUMNS - (cells.length % COLUMNS)) % COLUMNS;

  return (
    <div className="panel">
      <div className="sc-wrap">
        <div className="share-card records-card" ref={cardRef}>
          <div className="sc-head">
            <div>
              <div className="sc-tag">{d.name ?? d.code ?? "Melee player"}</div>
              {d.codes.length > 0 && <div className="sc-code">{d.codes.join(" · ")}</div>}
            </div>
            <div className="sc-head-right">
              <div className="sc-title">RECORDS</div>
              {d.firstDate && d.lastDate && (
                <div className="sc-range">{shortDate(d.firstDate)} — {shortDate(d.lastDate)}</div>
              )}
            </div>
          </div>

          <div className="sc-grid">
            {cells.map((c) => (
              <div className="sc-cell" key={c.label}>
                <div className="sc-label">{c.label}</div>
                <div className="sc-value">{c.value}</div>
                {c.sub && <div className="sc-sub">{c.sub}</div>}
              </div>
            ))}
            {Array.from({ length: filler }, (_, i) => (
              <div className="sc-cell" key={`filler-${i}`} aria-hidden="true" />
            ))}
          </div>

          <div className="sc-foot">
            <span>Personal bests</span>
            <span className="sc-url">ssbmstats.com</span>
          </div>
        </div>
      </div>

      <CardActions copied={copied} onDownload={download} onCopy={copy} />
      <div className="hint">
        Records respect the current filters — scope to a character, opponent, or time range for filtered bests. Best
        L-cancel day needs 100+ attempts that day; the friendly-fire records need 5+ games with that teammate.
      </div>
    </div>
  );
}
