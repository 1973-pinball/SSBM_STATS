import { useEffect, useId, useMemo, useState } from "react";
import type { ResolvedGame } from "../lib/types";
import { needsInteractionAnalysis } from "../lib/types";
import {
  DEFENSIVE_OUTCOME_WINDOW_FRAMES, LEDGE_SEQUENCE_WINDOW_FRAMES, DEFENSIVE_SEQUENCE_WINDOW_FRAMES, LEDGE_OPTION_LABELS, OOS_OPTION_LABELS,
  type ChoiceOutcomes,
} from "../lib/defensiveInteractions";
import {
  EDGEGUARD_TACTIC_LABELS, RECOVERY_ROUTE_LABELS,
  type EdgeguardOutcomes, type RecoveryOutcomes,
} from "../lib/recoveryInteractions";
import { PUNISH_ACTION_LABELS, type PunishOutcome } from "../lib/punishContext";
import { interactionRate, interactionSummary } from "../lib/interactionSummary";
import type { InteractionSummary } from "../lib/interactionSummary";
import {
  INTERACTION_COHORTS, INTERACTION_MEASURES, interactionBenchmarkValue, interactionComparisonKeys,
  interactionFamilyCoverage, loadInteractionBenchmarks, selectInteractionBenchmarks,
  type InteractionBenchmarkData, type InteractionBenchmarkScope, type InteractionBenchmarkValue,
  type InteractionFamily, type InteractionMeasure,
} from "../lib/interactionBenchmarks";
import { int, num, pct } from "../lib/format";
import { charName, stageName } from "../lib/melee";
import "./Interactions.css";

const SECTIONS = [
  { key: "ledge", label: "Ledge" },
  { key: "oos", label: "Out of shield" },
  { key: "recoveries", label: "Recoveries" },
  { key: "edgeguards", label: "Edgeguards" },
  { key: "punish", label: "Before openings taken" },
] as const;
type Section = typeof SECTIONS[number]["key"];
const SMALL_SAMPLE = 20;

function Samples({ count, resolved = count }: { count: number; resolved?: number }) {
  return <>{int(count)}{resolved < SMALL_SAMPLE && <span className="sample-note" title={`Fewer than ${SMALL_SAMPLE} resolved observations; rates can change substantially with a few more examples.`}>Small sample</span>}</>;
}

function RateCell({ count, total }: { count: number; total: number }) {
  return <td className="data" title={total ? `${int(count)} of ${int(total)} resolved observations` : "No resolved observations"}>
    {pct(interactionRate(count, total))}
    {total > 0 && <span className="sample-note">{int(count)} / {int(total)}</span>}
  </td>;
}

function Missing({ covered, kind }: { covered: number; kind: string }) {
  return <p className="interaction-empty">{covered === 0
    ? `No measured ${kind} data in these games yet. Older replays need re-analysis; unsupported or incomplete recordings remain unavailable.`
    : `No qualifying ${kind} were observed in the measured games.`}</p>;
}

function ChoiceTable({ rows, labels, covered, kind }: {
  rows: Record<string, ChoiceOutcomes>;
  labels: readonly { key: string; label: string }[];
  covered: number;
  kind: string;
}) {
  const ordered = Object.entries(rows).filter(([, row]) => row.attempts > 0)
    .sort((a, b) => b[1].attempts - a[1].attempts || a[0].localeCompare(b[0]));
  const total = ordered.reduce((sum, [, row]) => sum + row.attempts, 0);
  if (!total) return <Missing covered={covered} kind={kind} />;
  return <>
    <div className="interaction-table-scroll" tabIndex={0} role="region" aria-label={`${kind} outcomes table`}>
      <table className="interaction-table">
        <thead><tr><th scope="col">Option</th><th scope="col" className="data">Uses</th><th scope="col" className="data">Share</th>
          <th scope="col" className="data">Hit / grabbed</th><th scope="col" className="data">Hit / grab landed</th>
          <th scope="col" className="data">No hit / grab</th><th scope="col" className="data">Unresolved</th></tr></thead>
        <tbody>{ordered.map(([key, row]) => {
          const resolved = row.attempts - row.incomplete;
          return <tr key={key}>
            <th scope="row">{labels.find((label) => label.key === key)?.label ?? "Other / unknown"}</th>
            <td className="data"><Samples count={row.attempts} resolved={resolved} /></td>
            <td className="data">{pct(interactionRate(row.attempts, total))}</td>
            <RateCell count={row.punished + row.traded} total={resolved} />
            <RateCell count={row.hit + row.traded} total={resolved} />
            <RateCell count={row.noHit} total={resolved} />
            <td className="data">{int(row.incomplete)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="hint">First damaging hit or grab within {DEFENSIVE_OUTCOME_WINDOW_FRAMES} frames (0.5 seconds) of leaving ledge or shield. Same-frame trades count in both contact columns. Outcome rates exclude unresolved uses; no damaging hit or grab does not guarantee a safe option.</p>
  </>;
}

function RecoveryTable({ rows, covered }: { rows: Record<string, RecoveryOutcomes>; covered: number }) {
  const ordered = Object.entries(rows).filter(([, row]) => row.attempts > 0)
    .sort((a, b) => b[1].attempts - a[1].attempts || a[0].localeCompare(b[0]));
  if (!ordered.length) return <Missing covered={covered} kind="recoveries" />;
  const labels: Record<string, string> = RECOVERY_ROUTE_LABELS;
  return <>
    <div className="interaction-table-scroll" tabIndex={0} role="region" aria-label="Recovery outcomes table">
      <table className="interaction-table"><thead><tr>
        <th scope="col">Route</th><th scope="col" className="data">Attempts</th><th scope="col" className="data">Reached ledge</th>
        <th scope="col" className="data">Returned to stage</th><th scope="col" className="data">Died</th><th scope="col" className="data">Unresolved</th>
      </tr></thead><tbody>{ordered.map(([key, row]) => {
        const resolved = row.attempts - row.incomplete;
        return <tr key={key}><th scope="row">{labels[key] ?? "Unknown"}</th>
          <td className="data"><Samples count={row.attempts} resolved={resolved} /></td>
          <td className="data">{int(row.reachedLedge)}</td>
          <RateCell count={row.returned} total={resolved} /><RateCell count={row.died} total={resolved} />
          <td className="data">{int(row.incomplete)}</td></tr>;
      })}</tbody></table>
    </div>
    <p className="hint">Reaching ledge is a milestone: the same recovery can later return to stage or end in death. Return/death rates exclude unresolved attempts.</p>
  </>;
}

function EdgeguardTable({ rows, covered }: { rows: Record<string, EdgeguardOutcomes>; covered: number }) {
  const ordered = Object.entries(rows).filter(([, row]) => row.opportunities > 0)
    .sort((a, b) => b[1].opportunities - a[1].opportunities || a[0].localeCompare(b[0]));
  if (!ordered.length) return <Missing covered={covered} kind="edgeguard opportunities" />;
  const labels: Record<string, string> = EDGEGUARD_TACTIC_LABELS;
  return <>
    <div className="interaction-table-scroll" tabIndex={0} role="region" aria-label="Edgeguard outcomes table">
      <table className="interaction-table"><thead><tr>
        <th scope="col">Observed tactic</th><th scope="col" className="data">Opportunities</th><th scope="col" className="data">Contested</th>
        <th scope="col" className="data">Stock loss during contest</th><th scope="col" className="data">Opponent returned</th>
        <th scope="col" className="data">Uncontested deaths</th><th scope="col" className="data">Unresolved</th>
      </tr></thead><tbody>{ordered.map(([key, row]) => <tr key={key}>
        <th scope="row">{labels[key] ?? "Unknown"}</th>
        <td className="data"><Samples count={row.opportunities} resolved={row.completedContests} /></td>
        <td className="data">{int(row.contested)}</td>
        <RateCell count={row.stocksTaken} total={row.completedContests} />
        <td className="data">{int(row.opponentReturned)}</td><td className="data">{int(row.uncontestedDeaths)}</td>
        <td className="data">{int(row.incomplete)}</td>
      </tr>)}</tbody></table>
    </div>
    <p className="hint">Stock-loss rate uses completed, contested recoveries. It describes what happened while you contested the recovery; it does not prove which action caused the death. Uncontested deaths are shown separately.</p>
  </>;
}

function PunishTable({ rows, covered }: { rows: Record<string, PunishOutcome>; covered: number }) {
  const ordered = Object.entries(rows).filter(([, row]) => row.openings > 0)
    .sort((a, b) => b[1].openings - a[1].openings || a[0].localeCompare(b[0]));
  if (!ordered.length) return <Missing covered={covered} kind="opening contexts" />;
  const total = ordered.reduce((sum, [, row]) => sum + row.openings, 0);
  const labels: Record<string, string> = PUNISH_ACTION_LABELS;
  return <>
    <div className="interaction-table-scroll" tabIndex={0} role="region" aria-label="Actions before openings taken table">
      <table className="interaction-table"><thead><tr>
        <th scope="col">Preceding action</th><th scope="col" className="data">Openings taken</th><th scope="col" className="data">Share</th>
        <th scope="col" className="data">Damage / opening</th><th scope="col" className="data">Ended in death</th><th scope="col" className="data">Unresolved</th>
      </tr></thead><tbody>{ordered.map(([key, row]) => {
        const resolved = row.openings - row.incomplete;
        return <tr key={key}><th scope="row">{labels[key] ?? "Unknown"}</th>
          <td className="data"><Samples count={row.openings} resolved={resolved} /></td>
          <td className="data">{pct(interactionRate(row.openings, total))}</td>
          <td className="data">{num(interactionRate(row.damage, resolved))}<span className="sample-note">{int(resolved)} resolved</span></td>
          <RateCell count={row.kills} total={resolved} /><td className="data">{int(row.incomplete)}</td></tr>;
      })}</tbody></table>
    </div>
    <p className="hint">These are actions before an opening taken, not verified whiffs or unavoidable punishes. Share describes your openings taken, not the chance of being punished each time you use that action. Damage and death rates use resolved episodes.</p>
  </>;
}

const ALL_BENCHMARK_SCOPE: InteractionBenchmarkScope = { characterId: null, opponentCharacterId: null, stageId: null };
const COHORT_LABELS = { venue: "Venue", tournament: "Tournament", pro: "Pro" } as const;

function ComparisonCell({ result, format }: { result: InteractionBenchmarkValue; format: "percent" | "number" }) {
  if (result.value === null) return <td className="data" title={result.measuredGames ? "No qualifying denominator for this option" : "No measured games for these filters"}>—</td>;
  return <td className="data">
    {format === "percent" ? pct(result.value) : num(result.value)}
    <span className="sample-note">{format === "number" ? num(result.numerator, 1) : int(result.numerator)} / {int(result.denominator)}</span>
    {result.denominator < SMALL_SAMPLE && <span className="sample-note interaction-small">Small sample</span>}
  </td>;
}

function comparisonLabel(family: InteractionFamily, key: string): string {
  if (family === "ledge") return LEDGE_OPTION_LABELS.find((option) => option.key === key)?.label ?? "Other / unknown";
  if (family === "oos" || family === "shieldExits") return OOS_OPTION_LABELS.find((option) => option.key === key)?.label ?? "Other / unknown";
  const labels: Record<string, string> = family === "recoveries" ? RECOVERY_ROUTE_LABELS
    : family === "edgeguards" ? EDGEGUARD_TACTIC_LABELS : PUNISH_ACTION_LABELS;
  return labels[key] ?? "Other / unknown";
}

/** A separate table keeps experimental sampled references distinct from the user's measured outcomes. */
function InteractionBenchmarkComparison({ local, family, scope, data, isDemo = false }: {
  local: InteractionSummary;
  family: InteractionFamily;
  scope: InteractionBenchmarkScope;
  data: InteractionBenchmarkData;
  isDemo?: boolean;
}) {
  const [measures, setMeasures] = useState<Partial<Record<InteractionFamily, InteractionMeasure>>>({});
  const options = INTERACTION_MEASURES[family];
  const measure = measures[family] ?? options[0]!.key;
  const selected = options.find((option) => option.key === measure)!;
  const { characterId, opponentCharacterId, stageId } = scope;
  const benchmarks = useMemo(() => selectInteractionBenchmarks(data, { characterId, opponentCharacterId, stageId }), [data, characterId, opponentCharacterId, stageId]);
  const keys = interactionComparisonKeys(local, benchmarks, family);
  const scopeLabel = `${scope.characterId === null ? "All characters" : charName(scope.characterId)} vs ${scope.opponentCharacterId === null ? "all opponents" : charName(scope.opponentCharacterId)} · ${scope.stageId === null ? "all stages" : stageName(scope.stageId)}`;
  return <div className="interaction-benchmarks">
    <div className="interaction-benchmark-heading">
      <h3>Archive estimates <span className="badge">Sampled · experimental</span></h3>
      <label>Compare <select value={measure} onChange={(event) => setMeasures((current) => ({ ...current, [family]: event.target.value as InteractionMeasure }))}>
        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select></label>
    </div>
    <p className="interaction-benchmark-scope">{scopeLabel}</p>
    {keys.length === 0 ? <p className="interaction-empty">No qualifying observations in your games or the matching archive sample.</p>
      : <div className="interaction-table-scroll" tabIndex={0} role="region" aria-label="Experimental archive interaction comparison">
        <table className="interaction-table interaction-comparison-table"><thead><tr>
          <th scope="col">{family === "beforeOpening" ? "Preceding action" : family === "recoveries" ? "Route" : family === "edgeguards" ? "Observed tactic" : "Option"}</th>
          <th scope="col" className="data">{isDemo ? "Demo" : "You"}<span className="sample-note">{int(interactionFamilyCoverage(local, family))} / {int(local.games)} measured games</span></th>
          {INTERACTION_COHORTS.map((cohort) => <th scope="col" className="data" key={cohort}>{COHORT_LABELS[cohort]}<span className="sample-note">{benchmarks[cohort] ? `${int(interactionFamilyCoverage(benchmarks[cohort], family))} / ${int(benchmarks[cohort].games)} measured player-games` : "No matching sample"}</span></th>)}
        </tr></thead><tbody>{keys.map((key) => <tr key={key}>
          <th scope="row">{comparisonLabel(family, key)}</th>
          <ComparisonCell result={interactionBenchmarkValue(local, family, key, measure)} format={selected.format} />
          {INTERACTION_COHORTS.map((cohort) => <ComparisonCell key={cohort} result={interactionBenchmarkValue(benchmarks[cohort], family, key, measure)} format={selected.format} />)}
        </tr>)}</tbody></table>
      </div>}
    <p className="hint">Each cell shows {selected.format === "number" ? "damage / resolved openings" : "observations / qualifying opportunities"}. A dash means no qualifying sample. Outcome rates exclude unresolved events; stock-loss rate uses completed contests. Empty matchups stay unavailable without a broader fallback.</p>
    <p className="hint">Your column uses the current game window and filters. Archive estimates follow Me / Vs / Stage across their full sampled history, ignoring date, mode, account, and named-opponent filters. The cohorts can overlap and are not balanced by player or character. The full Pro sample covers {int(data.sample.proPlayers)} mapped players; it is not a general professional average.</p>
    <details className="interaction-benchmark-method">
      <summary>Sample and limitations</summary>
      <p>{int(data.sample.games)} replay games in {int(data.sample.bundles)} selected bundles, drawn from an available archive population of {int(data.sample.availableGames)} games; {int(data.sample.proPlayers)} mapped pro players. Updated {new Date(data.generatedAt).toLocaleDateString()}.</p>
      <p>{data.method}</p>
      <p>Venue samples usable archive games. Tournament independently samples conservative tournament games. Pro includes vetted mapped-player appearances in conservative games from the selected bundles.</p>
      <p>These are estimates from available replay files, not population statistics. Event coverage, repeated players, matchup mix, and uncertain classifications can bias the comparison. Small samples can change sharply with a few more observations.</p>
      <p>Source: <a href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceDataset}</a>. Counts under archive headings are player-games; they must not be added across overlapping cohorts.</p>
    </details>
  </div>;
}

function ArchiveEstimates({ local, family, scope, isDemo }: {
  local: InteractionSummary; family: InteractionFamily; scope: InteractionBenchmarkScope; isDemo: boolean;
}) {
  const [data, setData] = useState<InteractionBenchmarkData | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void loadInteractionBenchmarks().then((sample) => { if (active) { setData(sample); setError(false); } })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [retry]);
  if (error) return <div className="interaction-benchmarks"><p className="hint">Archive interaction estimates could not be loaded.</p><button type="button" onClick={() => { setError(false); setRetry((value) => value + 1); }}>Retry estimates</button></div>;
  if (!data) return <div className="interaction-benchmarks"><p className="hint" role="status">Loading sampled archive estimates…</p></div>;
  if (!data.rows.length) return <div className="interaction-benchmarks"><p className="hint">No analyzed archive sample has been bundled for these metrics yet.</p></div>;
  return <InteractionBenchmarkComparison local={local} family={family} scope={scope} data={data} isDemo={isDemo} />;
}

export function Interactions({ games, onAnalyze, onSelectReplayFiles, analyzing = false, isDemo = false, benchmarkScope = ALL_BENCHMARK_SCOPE }: {
  games: ResolvedGame[];
  onAnalyze?: () => void;
  onSelectReplayFiles?: () => void;
  analyzing?: boolean;
  isDemo?: boolean;
  benchmarkScope?: InteractionBenchmarkScope;
}) {
  const [section, setSection] = useState<Section>("ledge");
  const [shieldMode, setShieldMode] = useState<"oos" | "shieldExits">("oos");
  const id = useId();
  const summary = useMemo(() => interactionSummary(games), [games]);
  const coverage = section === "ledge" || section === "oos" ? summary.defenseGames
    : section === "punish" ? summary.punishGames : summary.recoveryGames;
  const missing = summary.defenseGames < summary.games || summary.recoveryGames < summary.games || summary.punishGames < summary.games;
  const needsAnalysis = games.some((game) => needsInteractionAnalysis(game.rec));
  const family: InteractionFamily = section === "oos" ? shieldMode : section === "punish" ? "beforeOpening" : section;
  return <section className="panel interactions" aria-labelledby={`${id}-heading`}>
    <div className="interaction-heading">
      <h2 id={`${id}-heading`}>Interactions <span className="badge">Experimental</span></h2>
      {!isDemo && needsAnalysis && <div className="interaction-analysis-actions">
        {onAnalyze && <button type="button" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? "Analyzing replays…" : "Analyze these games"}
        </button>}
        {onSelectReplayFiles && <button type="button" className="ghost" onClick={onSelectReplayFiles} disabled={analyzing}>Select replay files</button>}
      </div>}
    </div>
    <p className="interaction-intro">Your choices and what followed, across the most recent {int(summary.games)} {summary.games === 1 ? "game" : "games"} in this filter.{isDemo && " Demo figures are synthetic."}</p>
    <div className="interaction-tabs" role="group" aria-label="Interaction statistic">
      {SECTIONS.map((item) => <button type="button" key={item.key} aria-pressed={section === item.key} aria-controls={`${id}-content`} onClick={() => setSection(item.key)}>{item.label}</button>)}
    </div>
    <div id={`${id}-content`}>
      <div className="interaction-coverage">
        <span>{int(coverage)} / {int(summary.games)} {summary.games === 1 ? "game" : "games"} measured</span>
        {section === "oos" && <label>Shield situation <select value={shieldMode} onChange={(event) => setShieldMode(event.target.value as "oos" | "shieldExits")}>
          <option value="oos">After shield contact</option><option value="shieldExits">Other shield exits</option>
        </select></label>}
      </div>
      {section === "ledge" && <ChoiceTable rows={summary.ledge} labels={LEDGE_OPTION_LABELS} covered={coverage} kind="ledge options" />}
      {section === "oos" && <ChoiceTable rows={summary[shieldMode]} labels={OOS_OPTION_LABELS} covered={coverage} kind={shieldMode === "oos" ? "out-of-shield responses" : "other shield exits"} />}
      {section === "recoveries" && <RecoveryTable rows={summary.recoveries} covered={coverage} />}
      {section === "edgeguards" && <EdgeguardTable rows={summary.edgeguards} covered={coverage} />}
      {section === "punish" && <PunishTable rows={summary.beforeOpening} covered={coverage} />}
    </div>
    <ArchiveEstimates local={summary} family={family} scope={benchmarkScope} isDemo={isDemo} />
    <details className="interaction-method">
      <summary>How this is measured</summary>
      {section === "ledge" && <p>Ledge actions are classified from the sequence after a ledge hold, including drop → jump → air dodge for ledgedashes. The sequence can develop for up to {LEDGE_SEQUENCE_WINDOW_FRAMES} frames and stops at the first hit or grab. Unresolved uses include interrupted observation windows, stock loss, a new defensive episode, or the replay ending.</p>}
      {section === "oos" && <p>After shield contact requires recorded shield stun within 30 frames before leaving shield. Other shield exits have no confirmed recent shield contact. The first {DEFENSIVE_SEQUENCE_WINDOW_FRAMES} frames can distinguish jump → aerial and wavedash from an ordinary jump. Unrecognized special actions remain other / unknown. Getting hit or grabbed soon afterward is an observed outcome, not proof that the choice was punishable.</p>}
      {section === "recoveries" && <p>Recovery attempts start after being knocked offstage and require an offstage frame outside damage, capture, knockdown, and tech states, or a ledge grab. Intentional trips offstage and direct launch knockouts still in uninterrupted hitstun are excluded. High and low describe observed recovery movement near the stage edge relative to stage height; routes using both are mixed. A return requires landing inside the stage bounds and then 30 consecutive frames outside disabled states without damage or a grab. Supported stage geometry is required; unsupported stages remain unavailable.</p>}
      {section === "edgeguards" && <p>Each qualifying opponent recovery creates an opportunity. Tactics describe your observed position and actions during that recovery; multiple tactics can produce a mixed classification. Holding ledge can contest a recovery without landing a hit. Opponent returns and deaths are observed outcomes, including unsuccessful contests.</p>}
      {section === "punish" && <p>The preceding meaningful action is taken from the 30 frames before an incoming opening hit or grab. Follow-up hits stay in the same episode until a stock loss or 45 consecutive frames outside damage, capture, knockdown, and tech states. This view does not distinguish a whiff from shield contact, interrupted startup, or a trade.</p>}
      <p>Only measured games contribute. Missing data is unavailable, never a zero; fewer than {SMALL_SAMPLE} resolved observations are marked as a small sample. These experimental rules need comparison with reviewed replays before drawing firm coaching conclusions.</p>
    </details>
    {!isDemo && needsAnalysis && <p className="hint">Re-read matching replays from connected folders, or select their replay files. Analysis stays on this device; only summaries are saved.</p>}
    {!isDemo && missing && !needsAnalysis && <p className="hint">Unsupported or incomplete recordings remain unavailable after analysis.</p>}
  </section>;
}
