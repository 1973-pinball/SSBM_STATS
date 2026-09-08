import { useMemo } from "react";
import type { ResolvedGame, ResolvedTeamGame } from "../lib/types";
import { executionSummary, ROLLING_WINDOW, statCardData } from "../lib/stats";
import { duration, hoursLabel, int, num, pct, shortDate } from "../lib/format";
import { charName, stageName } from "../lib/melee";
import { CardActions } from "./CardActions";
import { useCardExport } from "./useCardExport";

/**
 * Shareable player card: a fun one-glance summary of who you play, who you
 * fight, where, and how much. Exported as a PNG entirely client-side
 * (html-to-image) — sharing is the user's choice, nothing is uploaded.
 */
export function ShareCard({ games, teamGames }: { games: ResolvedGame[]; teamGames: ResolvedTeamGame[] }) {
  const d = useMemo(() => statCardData(games), [games]);
  const hands = useMemo(() => executionSummary(games, ROLLING_WINDOW), [games]);
  // Time on the sticks spans both formats, matching the Overview "Hours played"
  // KPI — every other figure on this card is singles-only, so the sub-line names
  // the doubles games rather than folding them into the games count.
  const teamHours = useMemo(() => {
    let frames = 0;
    for (const g of teamGames) frames += g.rec.durationFrames;
    return frames / 60 / 3600;
  }, [teamGames]);
  const hours = d.hours + teamHours;

  const { cardRef, copied, download, copy } = useCardExport(
    `ssbm-card-${(d.code ?? "player").replace(/[^A-Za-z0-9#-]/g, "")}.png`,
  );

  if (d.games === 0) return null;

  // charIcon is a Melee external character ID → bundled stock-counter sprite.
  const cell = (label: string, value: string, sub?: string, charIcon?: number) => (
    <div className="sc-cell">
      <div className="sc-label">{label}</div>
      <div className="sc-value">
        {charIcon !== undefined && <img className="sc-stock" src={`/stock/${charIcon}.png`} alt="" />}
        {value}
      </div>
      {sub && <div className="sc-sub">{sub}</div>}
    </div>
  );

  return (
    <div className="panel">
      <div className="sc-wrap">
        <div className="share-card" ref={cardRef}>
          <div className="sc-head">
            <div>
              <div className="sc-tag">{d.name ?? d.code ?? "Melee player"}</div>
              {/* Every account these numbers cover, not just the main: the card
                  pools them, so naming one would misrepresent the totals. Under
                  the account filter there is only one to list. */}
              {d.codes.length > 0 && <div className="sc-code">{d.codes.join(" · ")}</div>}
            </div>
            <div className="sc-head-right">
              <div className="sc-title">PLAYER CARD</div>
              {d.firstDate && d.lastDate && (
                <div className="sc-range">{shortDate(d.firstDate)} — {shortDate(d.lastDate)}</div>
              )}
            </div>
          </div>

          <div className="sc-grid">
            {cell(
              "Main",
              d.mainChar ? charName(d.mainChar.id) : "—",
              d.mainChar ? `${int(d.mainChar.games)} games logged` : undefined,
              d.mainChar?.id,
            )}
            {cell(
              "Record",
              `${int(d.wins)}–${int(d.losses)}`,
              d.winRate !== null ? `${pct(d.winRate)} win rate` : undefined,
            )}
            {cell(
              "Hours on the sticks",
              `${hoursLabel(hours)}h`,
              teamGames.length > 0
                ? `${int(d.games)} singles · ${int(teamGames.length)} doubles`
                : `${int(d.games)} games, zero regrets`,
            )}
            {cell(
              "Average match",
              duration(d.avgSeconds),
              d.avgSeconds !== null ? "per game, start to finish" : undefined,
            )}
            {cell(
              "Sworn rival",
              d.rival ? d.rival.code : "—",
              // Set record leads: "2–3 in five runbacks" reads as a losing
              // record when those five games were two sets you split.
              d.rival
                ? `${d.rival.setWins}–${d.rival.setLosses} in sets · ${int(d.rival.games)} games`
                : undefined,
            )}
            {cell(
              "Most common foe",
              d.topOppChar ? charName(d.topOppChar.id) : "—",
              d.topOppChar ? `${int(d.topOppChar.games)} encounters` : undefined,
              d.topOppChar?.id,
            )}
            {cell(
              "Best matchup",
              d.bestMatchup ? charName(d.bestMatchup.id) : "—",
              d.bestMatchup
                ? `${d.bestMatchup.wins}–${d.bestMatchup.losses} · ${pct(d.bestMatchup.winRate, 0)} win rate`
                : "not enough games yet",
              d.bestMatchup?.id,
            )}
            {cell(
              "Worst matchup",
              d.worstMatchup ? charName(d.worstMatchup.id) : "—",
              d.worstMatchup
                ? `${d.worstMatchup.wins}–${d.worstMatchup.losses} · ${pct(d.worstMatchup.winRate, 0)} win rate`
                : "not enough games yet",
              d.worstMatchup?.id,
            )}
            {cell(
              "Home turf",
              d.favStage ? stageName(d.favStage.id) : "—",
              d.favStage && d.favStage.winRate !== null
                ? `won ${pct(d.favStage.winRate, 0)} of ${int(d.favStage.games)} there`
                : undefined,
            )}
            {cell(
              "Counterpick gutpunch",
              d.worstStage ? stageName(d.worstStage.id) : "—",
              d.worstStage && d.worstStage.winRate !== null
                ? `only ${pct(d.worstStage.winRate, 0)} of ${int(d.worstStage.games)} there`
                : "not enough games yet",
            )}
            {cell(
              // The rolling window is applied *after* the dashboard filters, so under a
              // character filter this may cover the character's whole
              // history for a secondary. Report the real count or the cell reads as a
              // like-for-like comparison it isn't.
              `The hands (past ${hands.games.toLocaleString()} games)`,
              hands.lCancel !== null ? `${num(hands.lCancel, 1)}% L-cancel` : "—",
              hands.ipm !== null ? `${int(hands.ipm)} inputs/min` : undefined,
            )}
            {cell(
              "Longest heater",
              d.bestWinStreak ? `${d.bestWinStreak} wins` : "—",
              d.bestWinStreak ? "in a row, no brakes" : undefined,
            )}

          </div>

          <div className="sc-foot">
            <span>{int(d.distinctOpponents)} opponents faced</span>
            <span className="sc-url">ssbmstats.com</span>
          </div>
        </div>
      </div>

      <CardActions copied={copied} onDownload={download} onCopy={copy} />
    </div>
  );
}
