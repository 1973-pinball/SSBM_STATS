import { useMemo, useState, type CSSProperties } from "react";
import { pct, shortDate } from "../lib/format";
import { TOURNAMENT_PREDICTIONS } from "../lib/tournamentPredictionData";
import { TOURNAMENT_PREDICTION_BACKTEST } from "../lib/tournamentPredictionBacktestData";
import type {
  TournamentPrediction,
  TournamentPredictionMatch,
  TournamentPredictionModelId,
  TournamentPredictionPlayer,
} from "../lib/tournamentPredictionData.types";
import type {
  TournamentPredictionBacktestEvidenceModeId,
  TournamentPredictionBacktestMetrics,
  TournamentPredictionBacktestModel,
  TournamentPredictionSelectedSetting,
} from "../lib/tournamentPredictionBacktestData.types";
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

type BacktestMetric = keyof TournamentPredictionBacktestMetrics;

const BACKTEST_METRICS: readonly {
  id: BacktestMetric;
  label: string;
  lowerIsBetter: boolean;
}[] = [
  { id: "logLoss", label: "Log loss", lowerIsBetter: true },
  { id: "brier", label: "Brier", lowerIsBetter: true },
  { id: "accuracy", label: "Accuracy", lowerIsBetter: false },
  { id: "auc", label: "AUC", lowerIsBetter: false },
];

function indexMatches(matches: readonly TournamentPredictionMatch[]) {
  return new Map(matches.map((match) => [match.id, match]));
}

function playerName(players: ReadonlyMap<string, TournamentPredictionPlayer>, id: string): string {
  return players.get(id)?.name ?? "Unknown player";
}

function formatBacktestMetric(metric: BacktestMetric, value: number): string {
  return metric === "accuracy" || metric === "auc" ? pct(value, 1) : value.toFixed(3);
}

function backtestBarValue(metric: BacktestMetric, value: number): number {
  const lift = metric === "logLoss"
    ? 1 - value / Math.log(2)
    : metric === "brier"
      ? 1 - value / 0.25
      : (value - 0.5) / 0.5;
  return Math.max(0, Math.min(1, lift));
}

function settingOption(setting: TournamentPredictionSelectedSetting, key: string): number | null {
  const value = setting.options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function settingLabel(model: TournamentPredictionBacktestModel, setting: TournamentPredictionSelectedSetting): string {
  if (setting.isDefault) return "frozen default";
  if (model.id === "recency-elo") {
    return `K=${settingOption(setting, "k") ?? "?"} · ${settingOption(setting, "halfLifeDays") ?? "?"}d half-life`;
  }
  if (model.id === "glicko2") return `initial RD=${settingOption(setting, "initialRd") ?? "?"}`;
  if (model.id === "dynamic-bradley-terry") {
    return `${settingOption(setting, "halfLifeDays") ?? "?"}d half-life · ridge=${settingOption(setting, "ridge") ?? "?"}`;
  }
  if (setting.candidateId.includes("ability-l2")) return `ability L2=${settingOption(setting, "abilityL2") ?? "?"}`;
  if (setting.candidateId.includes("feature-l2")) return `feature L2=${settingOption(setting, "featureL2") ?? "?"}`;
  if (setting.candidateId.includes("form-half-life")) return `form half-life=${settingOption(setting, "formHalfLifeDays") ?? "?"}d`;
  return setting.candidateId;
}

function selectedSettingsLabel(model: TournamentPredictionBacktestModel): string {
  const tuned = model.tuning.selectedSettings.filter((setting) => !setting.isDefault);
  if (!tuned.length) return model.tuning.matureEvents > 0 ? "Default retained" : "Fixed baseline";
  return tuned.slice(0, 2)
    .map((setting) => `${settingLabel(model, setting)} · ${setting.count} folds`)
    .join(" / ");
}

function hasClearTuningGain(model: TournamentPredictionBacktestModel): boolean {
  const logLoss = model.tuning.versusDefault.logLoss.interval95;
  const brier = model.tuning.versusDefault.brier.interval95;
  return logLoss !== null && brier !== null && logLoss.upper < 0 && brier.upper < 0;
}

function BacktestComparison({
  evidenceModeId,
  selectedModelId,
  onEvidenceModeChange,
  onSelectModel,
}: {
  evidenceModeId: TournamentPredictionBacktestEvidenceModeId;
  selectedModelId: TournamentPredictionModelId;
  onEvidenceModeChange: (mode: TournamentPredictionBacktestEvidenceModeId) => void;
  onSelectModel: (model: TournamentPredictionModelId) => void;
}) {
  const [metric, setMetric] = useState<BacktestMetric>("logLoss");
  const evidenceMode = TOURNAMENT_PREDICTION_BACKTEST.modes.find((mode) => mode.id === evidenceModeId)
    ?? TOURNAMENT_PREDICTION_BACKTEST.modes[0]!;
  const metricConfig = BACKTEST_METRICS.find((option) => option.id === metric) ?? BACKTEST_METRICS[0]!;
  const models = [...evidenceMode.models].sort((a, b) => {
    const difference = a.eventMacro[metric] - b.eventMacro[metric];
    return (metricConfig.lowerIsBetter ? difference : -difference) || a.name.localeCompare(b.name);
  });

  return (
    <section className="tp-backtest" aria-labelledby="tp-backtest-title">
      <div className="tp-backtest-heading">
        <div>
          <div className="eyebrow">83-event out-of-sample test</div>
          <h3 id="tp-backtest-title">Six-model comparison</h3>
          <p>Whole tournaments are held out. Bar length shows improvement over neutral; select a model row to redraw the bracket.</p>
        </div>
        <div className="tp-backtest-modes" aria-label="Historical evidence mode">
          {TOURNAMENT_PREDICTION_BACKTEST.modes.map((mode) => (
            <button
              type="button"
              key={mode.id}
              className={`${mode.id === evidenceMode.id ? "active" : ""}${mode.id === "availability-assumed" ? " assumed" : ""}`}
              aria-pressed={mode.id === evidenceMode.id}
              title={mode.description}
              onClick={() => onEvidenceModeChange(mode.id)}
            >
              {mode.id === "strict-seeds" ? "Strict history" : "Seed sensitivity"}
            </button>
          ))}
        </div>
      </div>

      <div className="tp-backtest-toolbar">
        <div className="tp-backtest-metrics" aria-label="Comparison metric">
          {BACKTEST_METRICS.map((option) => (
            <button
              type="button"
              key={option.id}
              className={option.id === metric ? "active" : ""}
              aria-pressed={option.id === metric}
              onClick={() => setMetric(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span>{metricConfig.lowerIsBetter ? "Lower is better" : "Higher is better"}</span>
      </div>

      <div className="tp-backtest-chart" role="list" aria-label={`${metricConfig.label} ranking for all six models`}>
        {models.map((result, index) => {
          const selected = result.id === selectedModelId;
          const tuned = result.tuning.matureEvents > 0;
          const clearGain = hasClearTuningGain(result);
          const tuningStatus = !tuned ? "Fixed" : clearGain ? "Tuning gain" : "No clear gain";
          const settings = selectedSettingsLabel(result);
          const value = result.eventMacro[metric];
          return (
            <div className={`tp-backtest-row${selected ? " selected" : ""}`} role="listitem" key={result.id}>
              <button
                type="button"
                className="tp-backtest-model"
                aria-pressed={selected}
                onClick={() => onSelectModel(result.id)}
              >
                <span className="tp-backtest-rank">{index + 1}</span>
                <span><b>{result.name}</b><small>{settings}</small></span>
              </button>
              <div className="tp-backtest-bar" aria-hidden="true">
                <span style={{ width: `${backtestBarValue(metric, value) * 100}%` }} />
              </div>
              <strong>{formatBacktestMetric(metric, value)}</strong>
              <span className={`tp-tuning-status ${clearGain ? "gain" : tuned ? "unclear" : "fixed"}`}>{tuningStatus}</span>
              <small className="tp-backtest-coverage">
                {pct(result.pooledCoverage, 0)} coverage
                {result.tuning.fallbackEvents > 0 ? ` · ${result.tuning.fallbackEvents} neutral fallback${result.tuning.fallbackEvents === 1 ? "" : "s"}` : ""}
              </small>
            </div>
          );
        })}
      </div>

      <div className="tp-backtest-note" id="tp-backtest-note">
        <b>Retrospective, not snapshot-verified.</b> {evidenceMode.description}. These are set-level results conditional on realized matchups, not bracket, Top-8, or title-odds backtests. Hyperparameters are selected only from earlier inner folds; no model family is automatically selected.
      </div>
      <div className="tp-backtest-meta">
        <span>{TOURNAMENT_PREDICTION_BACKTEST.coverage.events} held-out events</span>
        <span>{TOURNAMENT_PREDICTION_BACKTEST.coverage.sets.toLocaleString()} held-out sets</span>
        <span>Event-macro scoring</span>
      </div>
    </section>
  );
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
  const [evidenceModeId, setEvidenceModeId] = useState<TournamentPredictionBacktestEvidenceModeId>("strict-seeds");
  const tournament = tournaments.find((item) => item.id === tournamentId) ?? initialTournament;
  const model = tournament?.models.find((item) => item.id === modelId)
    ?? tournament?.models.find((item) => item.id === tournament.defaultModelId)
    ?? tournament?.models[0];
  const evidenceMode = TOURNAMENT_PREDICTION_BACKTEST.modes.find((mode) => mode.id === evidenceModeId)
    ?? TOURNAMENT_PREDICTION_BACKTEST.modes[0]!;
  const modelEvidence = evidenceMode.models.find((item) => item.id === model?.id);
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
          <h2 id="tp-title">Tournament Predictions</h2>
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
        <div><b>{model.shortName}</b><span>{model.explanation} The scores follow the evidence mode selected in the comparison below.</span></div>
        <dl aria-label={`${evidenceMode.label} out-of-sample evaluation; lower Brier score and log loss are better`}>
          <div><dt>OOS Brier</dt><dd>{(modelEvidence?.eventMacro.brier ?? model.heldOut.brier).toFixed(3)}</dd></div>
          <div><dt>OOS log loss</dt><dd>{(modelEvidence?.eventMacro.logLoss ?? model.heldOut.logLoss).toFixed(3)}</dd></div>
          <div><dt>Test sets</dt><dd>{(modelEvidence?.outerSets ?? model.heldOut.predictions).toLocaleString()}</dd></div>
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

      <BacktestComparison
        evidenceModeId={evidenceMode.id}
        selectedModelId={model.id}
        onEvidenceModeChange={setEvidenceModeId}
        onSelectModel={setModelId}
      />
    </section>
  );
}
