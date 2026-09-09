import { useMemo, useState, type CSSProperties } from "react";
import { pct, shortDate } from "../lib/format";
import { TOURNAMENT_PREDICTIONS } from "../lib/tournamentPredictionData";
import type {
  TournamentPrediction,
  TournamentPredictionMatch,
  TournamentPredictionPlayer,
} from "../lib/tournamentPredictionData.types";
import "./TournamentPredictions.css";

const TOP16_PATHS = [
  { upper: "A", lowerStart: "M", lowerFinish: "Q" },
  { upper: "B", lowerStart: "L", lowerFinish: "P" },
  { upper: "C", lowerStart: "K", lowerFinish: "O" },
  { upper: "D", lowerStart: "J", lowerFinish: "N" },
] as const;

const TOP8_MATCH_ORDER = [
  "WSF-A", "WSF-B", "LR1-A", "LR1-B", "WF", "LQF-A", "LQF-B", "LSF", "LF", "GF", "GF-RESET",
] as const;

const TOP8_POSITIONS: Record<string, CSSProperties> = {
  "WSF-A": { left: 10, top: 44 },
  "WSF-B": { left: 10, top: 164 },
  "LR1-A": { left: 10, top: 374 },
  "LR1-B": { left: 10, top: 494 },
  WF: { left: 240, top: 90 },
  "LQF-A": { left: 240, top: 344 },
  "LQF-B": { left: 240, top: 474 },
  LSF: { left: 470, top: 404 },
  LF: { left: 700, top: 220 },
  GF: { left: 930, top: 140 },
  "GF-RESET": { left: 930, top: 260 },
};

function indexMatches(matches: readonly TournamentPredictionMatch[]) {
  return new Map(matches.map((match) => [match.id, match]));
}

function playerName(players: ReadonlyMap<string, TournamentPredictionPlayer>, id: string): string {
  return players.get(id)?.name ?? "Unknown player";
}

function BracketMatch({
  match,
  players,
  compact = false,
  style,
}: {
  match: TournamentPredictionMatch;
  players: ReadonlyMap<string, TournamentPredictionPlayer>;
  compact?: boolean;
  style?: CSSProperties;
}) {
  const first = players.get(match.playerIds[0]);
  const second = players.get(match.playerIds[1]);
  if (!first || !second) return null;
  const rows = [
    { player: first, probability: match.probabilities[0] },
    { player: second, probability: match.probabilities[1] },
  ] as const;
  return (
    <article
      className={`tp-match${compact ? " compact" : ""}`}
      style={style}
      aria-label={`${match.label}: ${first.name} ${pct(match.probabilities[0], 1)}, ${second.name} ${pct(match.probabilities[1], 1)}. Pick: ${playerName(players, match.predictedWinnerId)}.`}
    >
      <div className="tp-match-label">{match.label}</div>
      {rows.map(({ player, probability }) => {
        const picked = player.id === match.predictedWinnerId;
        return (
          <div className={`tp-player${picked ? " picked" : ""}`} key={player.id}>
            <span className="tp-seed">{player.seed}</span>
            <span className="tp-player-name">{player.name}</span>
            {picked && <span className="tp-pick">PICK</span>}
            <b>{pct(probability, 1)}</b>
          </div>
        );
      })}
      {match.decision === "lower-seed-number" && <div className="tp-tiebreak">50/50 · seed display tie-break</div>}
    </article>
  );
}

function Top16Paths({
  tournament,
  matches,
  players,
}: {
  tournament: TournamentPrediction;
  matches: ReadonlyMap<string, TournamentPredictionMatch>;
  players: ReadonlyMap<string, TournamentPredictionPlayer>;
}) {
  return (
    <section className="tp-top16" aria-labelledby="tp-top16-title">
      <div className="tp-subheading">
        <div><h3 id="tp-top16-title">Projected Top 16 paths</h3><p>Upper winner qualifies; upper loser meets the lower-opening winner.</p></div>
        <span>{tournament.scenario.label}</span>
      </div>
      <div className="tp-path-head" aria-hidden="true">
        <span>Upper matchup</span><span>Lower opening</span><span>Lower qualifier</span><span>Projected Top 8</span>
      </div>
      <div className="tp-paths">
        {TOP16_PATHS.map((path) => {
          const upper = matches.get(path.upper);
          const lowerStart = matches.get(path.lowerStart);
          const lowerFinish = matches.get(path.lowerFinish);
          if (!upper || !lowerStart || !lowerFinish) return null;
          return (
            <div className="tp-path" key={path.upper}>
              <BracketMatch match={upper} players={players} compact />
              <span className="tp-path-arrow" aria-hidden="true">＋</span>
              <BracketMatch match={lowerStart} players={players} compact />
              <span className="tp-path-arrow" aria-hidden="true">→</span>
              <BracketMatch match={lowerFinish} players={players} compact />
              <div className="tp-qualifiers">
                <small>TOP 8</small>
                <b><span>W</span>{playerName(players, upper.predictedWinnerId)}</b>
                <b><span>L</span>{playerName(players, lowerFinish.predictedWinnerId)}</b>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Top8Bracket({
  matches,
  players,
  champion,
}: {
  matches: ReadonlyMap<string, TournamentPredictionMatch>;
  players: ReadonlyMap<string, TournamentPredictionPlayer>;
  champion: TournamentPredictionPlayer;
}) {
  const hasReset = matches.has("GF-RESET");
  return (
    <section className="tp-top8" aria-labelledby="tp-top8-title">
      <div className="tp-subheading">
        <div><h3 id="tp-top8-title">Projected Top 8 bracket</h3><p>Solid line advances a winner; dashed line drops an upper-bracket loser.</p></div>
        <div className="tp-line-key" aria-hidden="true"><span className="winner" /> winner <span className="loser" /> upper loss</div>
      </div>
      <p className="tp-screen-reader">
        Winners-semifinal winners meet in winners final. Their losers enter lower quarterfinals against the lower-round-one winners.
        Lower-quarterfinal winners meet in lower semifinal, whose winner plays the winners-final loser in lower final.
        The winners-final winner then plays the lower-final winner in grand final; a reset occurs only if the lower-side entrant wins that first grand final.
      </p>
      <div className="tp-bracket-scroll" role="region" aria-label="Projected Top 8 bracket">
        <div className="tp-bracket-canvas">
          <div className="tp-round-label" style={{ left: 10 }}>Opening</div>
          <div className="tp-round-label" style={{ left: 240 }}>Advance</div>
          <div className="tp-round-label" style={{ left: 470 }}>Lower semifinal</div>
          <div className="tp-round-label" style={{ left: 700 }}>Lower final</div>
          <div className="tp-round-label" style={{ left: 930 }}>Grand final</div>
          <svg className="tp-connectors" viewBox="0 0 1130 610" aria-hidden="true">
            <defs>
              <marker id="tp-arrow-win" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" /></marker>
              <marker id="tp-arrow-loss" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" /></marker>
            </defs>
            <g className="tp-win-lines">
              <path d="M200 88H220V133H240" /><path d="M200 208H220V133H240" />
              <path d="M200 418H220V387H240" /><path d="M200 538H220V517H240" />
              <path d="M430 387H450V447H470" /><path d="M430 517H450V447H470" />
              <path d="M660 447H680V263H700" /><path d="M430 133H850V183H930" />
              <path d="M890 263H910V183H930" />
              {hasReset
                ? <><path d="M1025 228V260" /><path d="M1025 348V414" /></>
                : <path d="M1025 228V260" />}
            </g>
            <g className="tp-loss-lines">
              <path d="M200 88H228V517H240" /><path d="M200 208H232V387H240" />
              <path d="M430 133H565V263H700" />
            </g>
          </svg>
          {TOP8_MATCH_ORDER.map((id) => {
            const match = matches.get(id);
            return match ? <BracketMatch key={id} match={match} players={players} style={TOP8_POSITIONS[id]} /> : null;
          })}
          <div className="tp-champion-node" style={{ top: hasReset ? 414 : 260 }} aria-live="polite">
            <small>PROJECTED WINNER</small>
            <span>#{champion.seed}</span>
            <strong>{champion.name}</strong>
            <em>Path pick · not title odds</em>
          </div>
        </div>
      </div>
    </section>
  );
}

export function TournamentPredictions() {
  const tournaments = TOURNAMENT_PREDICTIONS.tournaments;
  const initialTournament = tournaments[0];
  const [tournamentId, setTournamentId] = useState(initialTournament?.id ?? "");
  const [modelId, setModelId] = useState(initialTournament?.defaultModelId ?? "");
  const tournament = tournaments.find((item) => item.id === tournamentId) ?? initialTournament;
  const model = tournament?.models.find((item) => item.id === modelId)
    ?? tournament?.models.find((item) => item.id === tournament.defaultModelId)
    ?? tournament?.models[0];
  const players = useMemo(() => new Map((tournament?.players ?? []).map((player) => [player.id, player])), [tournament]);
  const matches = useMemo(() => indexMatches(model?.matches ?? []), [model]);
  if (!tournament || !model) return null;
  const champion = players.get(model.championId);
  if (!champion) return null;
  const final = matches.get("GF-RESET") ?? matches.get("GF");
  const finalOpponent = final?.playerIds.find((id) => id !== champion.id);

  return (
    <section className="panel ta-forecast tp-predictions" aria-labelledby="tp-title">
      <div className="tp-heading">
        <div>
          <div className="eyebrow">Experimental · public tournament data</div>
          <h2 id="tp-title">Predictions</h2>
          <p>Choose a tournament and model to redraw the projected matchup path.</p>
        </div>
        <div className="tp-controls">
          <label htmlFor="prediction-tournament">Tournament
            <select
              id="prediction-tournament"
              value={tournament.id}
              onChange={(event) => {
                const next = tournaments.find((item) => item.id === event.target.value);
                setTournamentId(event.target.value);
                if (next) setModelId(next.defaultModelId);
              }}
            >
              {tournaments.map((item) => <option key={item.id} value={item.id}>{item.name} · {shortDate(item.startDate)}</option>)}
            </select>
          </label>
          <label htmlFor="prediction-model">Model
            <select id="prediction-model" value={model.id} aria-describedby="tp-model-explanation tp-caveat" onChange={(event) => setModelId(event.target.value)}>
              {tournament.models.map((item) => <option key={item.id} value={item.id}>{item.shortName}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="tp-model-strip" id="tp-model-explanation">
        <div><b>{model.shortName}</b><span>{model.explanation} Held-out scores below use unseen events; lower is better.</span></div>
        <dl aria-label="Held-out evaluation; lower Brier score and log loss are better">
          <div><dt>Held-out Brier</dt><dd>{model.heldOut.brier.toFixed(3)}</dd></div>
          <div><dt>Log loss</dt><dd>{model.heldOut.logLoss.toFixed(3)}</dd></div>
          <div><dt>Test sets</dt><dd>{model.heldOut.predictions.toLocaleString()}</dd></div>
        </dl>
      </div>

      <div className="tp-winner">
        <div><small>PROJECTED WINNER</small><strong>{champion.name}</strong><span>Seed {champion.seed}</span></div>
        <p>
          {finalOpponent ? `Projected final: ${champion.name} over ${playerName(players, finalOpponent)}` : "Projected final unavailable"}
          {final ? ` · ${pct(final.probabilities[final.playerIds[0] === champion.id ? 0 : 1], 1)} raw set estimate` : ""}
          {final?.decision === "lower-seed-number" ? " · display tie-break only" : ""}
        </p>
      </div>

      <Top16Paths tournament={tournament} matches={matches} players={players} />
      <Top8Bracket matches={matches} players={players} champion={champion} />

      <div className="tp-caveat" id="tp-caveat">
        <b>{tournament.scenario.label}.</b> {tournament.scenario.explanation} This is an experimental path, not a confirmed later-round bracket, full-field simulation, title probability, or confidence interval. Entrants and routing can change while the event is {tournament.snapshot.state}.
        {tournament.scenario.missingPoolNames.length > 0 && <> The snapshot has no set rows for {tournament.scenario.missingPoolNames.join(", ")} ({tournament.scenario.missingEntrantCount} entrants), so the complete upstream field cannot yet be simulated.</>}
      </div>
      <div className="tp-meta">
        <span>Snapshot {shortDate(tournament.snapshot.fetchedAt)}</span>
        <span>{tournament.snapshot.entrantCount.toLocaleString()} entrants</span>
        <span>{tournament.training.events} training events · {tournament.training.sets.toLocaleString()} sets</span>
        <a href={tournament.sourceUrl} target="_blank" rel="noreferrer">Start.gg source</a>
      </div>
    </section>
  );
}
