import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type {
  CommunityBenchmarkRow,
  CommunityCharacterRow,
  CommunityExecutionRow,
  CommunityMoveRow,
} from "../lib/community";
import { countNoun, pct, num, shortDate } from "../lib/format";
import { charName, moveGroup, moveGroupLabel } from "../lib/melee";
import {
  archiveRankingLabel,
  fetchArchiveCommunityBenchmarks,
  fetchArchiveCommunityProBenchmark,
  fetchArchiveCommunityProOptions,
  fetchArchiveProAggregateAtlasRows,
  fetchLatestArchiveDataset,
  type ArchiveCommunityBenchmarks,
  type ArchiveDataset,
  type ArchiveMoveMetrics,
  type ArchiveProOption,
  type ArchiveRollup,
} from "../lib/publicArchive";
import { actionAverages, executionSummary, moveTable } from "../lib/stats";
import type { ActionCounts, ResolvedGame } from "../lib/types";
import "./ArchiveCommunityBenchmark.css";

interface Props {
  games: ResolvedGame[];
  characterId: number | null;
  communityMoves: CommunityMoveRow[];
  communityBenchmark?: CommunityBenchmarkRow;
  communityExecution?: CommunityExecutionRow;
  communityCharacter?: CommunityCharacterRow;
  controls?: ReactNode;
  onCharacterChange?: (characterId: number) => void;
}

type MoveMetric = "attempts" | "landed" | "damage" | "kills" | "killPct";

interface GroupedArchiveMove extends ArchiveMoveMetrics {
  key: string;
  label: string;
}

interface ExecutionRow {
  key: string;
  label: string;
  sample: number | null;
  sampleLabel: string;
  winRate: number | null;
  lCancel: number | null;
  groundTech: number | null;
  wallTech: number | null;
  opk: number | null;
  dpo: number | null;
  ipm: number | null;
  balanceNote?: string;
}

type ExecutionComparisonMetric =
  | { key: string; label: string; format: "percent" | "rate"; field: "groundTech" | "wallTech" | "lCancel" | "ipm" }
  | { key: string; label: string; format: "rate"; action: keyof ActionCounts };

interface ExecutionComparisonSource {
  key: string;
  label: string;
  sampleNote: string;
  execution: ExecutionRow | null;
  actionRate: (key: keyof ActionCounts) => number | null;
}

const EXECUTION_COMPARISON_METRICS: ExecutionComparisonMetric[] = [
  { key: "ground-tech", label: "Ground tech success", format: "percent", field: "groundTech" },
  { key: "wall-tech", label: "Wall tech success", format: "percent", field: "wallTech" },
  { key: "l-cancel", label: "L-cancel success", format: "percent", field: "lCancel" },
  { key: "inputs", label: "Inputs / min", format: "rate", field: "ipm" },
  { key: "wavedashes", label: "Wavedashes / min", format: "rate", action: "wavedashes" },
  { key: "wavelands", label: "Wavelands / min", format: "rate", action: "wavelands" },
  { key: "dash-dances", label: "Dash dances / min", format: "rate", action: "dashDances" },
  { key: "rolls", label: "Rolls / min", format: "rate", action: "rolls" },
  { key: "spot-dodges", label: "Spot dodges / min", format: "rate", action: "spotDodges" },
  { key: "air-dodges", label: "Air dodges / min", format: "rate", action: "airDodges" },
  { key: "ledge-grabs", label: "Ledge grabs / min", format: "rate", action: "ledgeGrabs" },
  { key: "crouch-cancels", label: "Crouch cancels / min", format: "rate", action: "crouchCancels" },
  { key: "grabs", label: "Grabs / min", format: "rate", action: "grabs" },
];

function ssbmStatsExecution(
  benchmark: CommunityBenchmarkRow | undefined,
  execution: CommunityExecutionRow | undefined,
  character: CommunityCharacterRow | undefined,
): ExecutionRow {
  const sample = Math.max(benchmark?.games ?? 0, execution?.games ?? 0, character?.playerGames ?? 0) || null;
  const contributors = Math.max(benchmark?.contributors ?? 0, execution?.contributors ?? 0, character?.contributors ?? 0);
  return {
    key: "ssbm-stats",
    label: "SSBM Stats",
    sample,
    sampleLabel: "player-games",
    winRate: character?.winRate ?? null,
    lCancel: benchmark?.lCancel ? benchmark.lCancel.p50 / 100 : null,
    groundTech: execution?.groundTechSuccess === null || execution?.groundTechSuccess === undefined
      ? null
      : execution.groundTechSuccess / 100,
    wallTech: null,
    opk: benchmark?.openingsPerKill?.p50 ?? null,
    dpo: benchmark?.damagePerOpening?.p50 ?? null,
    ipm: benchmark?.inputsPerMinute?.p50 ?? null,
    balanceNote: sample === null
      ? "Character sample not yet publishable"
      : `Player-balanced headline medians · ${contributors.toLocaleString()} contributors`,
  };
}

const EMPTY_BENCHMARKS: ArchiveCommunityBenchmarks = { broad: null, conservative: null };
const ratio = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;

function archiveActionRate(row: ArchiveRollup | null, key: keyof ActionCounts): number | null {
  if (!row || row.metrics.durationFrames <= 0) return null;
  const count = row.metrics.actions?.[key];
  return count === undefined ? null : count / (row.metrics.durationFrames / 3_600);
}

function executionComparisonValue(
  source: ExecutionComparisonSource,
  metric: ExecutionComparisonMetric,
): number | null {
  if ("action" in metric) return source.actionRate(metric.action);
  return source.execution?.[metric.field] ?? null;
}

function formatExecutionComparison(value: number | null, metric: ExecutionComparisonMetric): string {
  return metric.format === "percent" ? pct(value) : num(value, 1);
}

function groupArchiveMoves(row: ArchiveRollup | null): Map<string, GroupedArchiveMove> {
  const grouped = new Map<string, GroupedArchiveMove>();
  for (const [moveId, move] of Object.entries(row?.metrics.moves ?? {})) {
    const group = moveGroup(Number(moveId));
    const value = grouped.get(group.key) ?? {
      key: group.key,
      label: moveGroupLabel(group.key),
      attempts: 0,
      landed: 0,
      damage: 0,
      kills: 0,
      killPctSum: 0,
      openings: 0,
      openingDmg: 0,
      lCancelSuccess: 0,
      lCancelFail: 0,
    };
    value.attempts += move.attempts;
    value.landed += move.landed;
    value.damage += move.damage;
    value.kills += move.kills;
    value.killPctSum += move.killPctSum;
    value.openings += move.openings;
    value.openingDmg += move.openingDmg;
    value.lCancelSuccess += move.lCancelSuccess;
    value.lCancelFail += move.lCancelFail;
    grouped.set(group.key, value);
  }
  return grouped;
}

function archiveExecution(
  row: ArchiveRollup,
  label: string,
  usePlayerBalance: boolean,
  sampleLabel = "player-games",
): ExecutionRow {
  const metrics = row.metrics;
  const groundSuccess = metrics.techInPlace + metrics.techToward + metrics.techAway;
  const playerBalanced = usePlayerBalance ? metrics.playerBalanced : null;
  const lCancel = playerBalanced?.lCancel.equalWeightMean ?? ratio(metrics.lCancelSuccess, metrics.lCancelSuccess + metrics.lCancelFail);
  const groundTech = ratio(groundSuccess, groundSuccess + metrics.techMissed);
  const balancedSamples = playerBalanced?.lCancel.qualifiedPlayers ?? 0;
  return {
    key: `${row.population}:${label}`,
    label,
    sample: row.game_count,
    sampleLabel,
    winRate: ratio(row.wins, row.win_rate_game_count),
    lCancel,
    groundTech,
    wallTech: ratio(metrics.wallTechSuccess ?? 0, (metrics.wallTechSuccess ?? 0) + (metrics.wallTechMissed ?? 0)),
    opk: ratio(metrics.openingsPerKillSum, metrics.openingsPerKillSamples),
    dpo: ratio(metrics.damagePerOpeningSum, metrics.damagePerOpeningSamples),
    ipm: ratio(metrics.inputsPerMinuteSum, metrics.inputsPerMinuteSamples),
    balanceNote: balancedSamples > 0 ? `L-cancel equally weights ${balancedSamples.toLocaleString()} qualified players` : undefined,
  };
}

export function ArchiveCommunityBenchmark({
  games,
  characterId,
  communityMoves,
  communityBenchmark,
  communityExecution,
  communityCharacter,
  controls,
  onCharacterChange,
}: Props) {
  const [dataset, setDataset] = useState<ArchiveDataset | null>(null);
  const [benchmarks, setBenchmarks] = useState<ArchiveCommunityBenchmarks>(EMPTY_BENCHMARKS);
  const [pros, setPros] = useState<ArchiveProOption[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [proAggregateBenchmark, setProAggregateBenchmark] = useState<ArchiveRollup | null>(null);
  const [proBenchmark, setProBenchmark] = useState<ArchiveRollup | null>(null);
  const [moveMetric, setMoveMetric] = useState<MoveMetric>("attempts");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchLatestArchiveDataset()
      .then(async (nextDataset) => {
        if (!alive) return;
        setDataset(nextDataset);
        if (!nextDataset) {
          setError("No public tournament archive snapshot has been published yet.");
          return;
        }
        const nextPros = await fetchArchiveCommunityProOptions(nextDataset.id);
        if (alive) setPros(nextPros);
      })
      .catch(() => { if (alive) setError("The public tournament archive is not available right now."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const characterPros = useMemo(() => characterId === null
    ? []
    : pros.filter((player) => player.observed_character_ids.includes(characterId)), [characterId, pros]);

  useEffect(() => {
    if (playerId && !characterPros.some((player) => player.id === playerId)) setPlayerId(null);
  }, [characterPros, playerId]);

  useEffect(() => {
    if (!dataset || characterId === null) {
      setBenchmarks(EMPTY_BENCHMARKS);
      setProAggregateBenchmark(null);
      return;
    }
    let alive = true;
    setLoading(true);
    void Promise.all([
      fetchArchiveCommunityBenchmarks(dataset.id, characterId),
      fetchArchiveProAggregateAtlasRows(dataset.id, characterId),
    ])
      .then(([next, proRows]) => { if (alive) { setBenchmarks(next); setProAggregateBenchmark(proRows.find((row) => row.opponent_character_id === null && row.stage_id === null) ?? null); setError(null); } })
      .catch(() => { if (alive) { setBenchmarks(EMPTY_BENCHMARKS); setProAggregateBenchmark(null); setError("Archive benchmarks are temporarily unavailable."); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [characterId, dataset]);

  useEffect(() => {
    if (!dataset || characterId === null || !playerId) {
      setProBenchmark(null);
      return;
    }
    let alive = true;
    void fetchArchiveCommunityProBenchmark(dataset.id, playerId, characterId)
      .then((next) => { if (alive) setProBenchmark(next); })
      .catch(() => { if (alive) setProBenchmark(null); });
    return () => { alive = false; };
  }, [characterId, dataset, playerId]);

  const ownExecution = useMemo(() => executionSummary(games, Number.MAX_SAFE_INTEGER), [games]);
  const ownActions = useMemo(() => actionAverages(games), [games]);
  const ownMoves = useMemo(() => moveTable(games), [games]);
  const selectedPro = characterPros.find((player) => player.id === playerId) ?? null;

  if (characterId === null) return (
    <section className="panel acb-panel">
      <div className="panel-heading-row acb-heading">
        <div><div className="eyebrow">Full-field comparison</div><h2>Compare your character across every benchmark</h2></div>
        <div className="community-controls">{controls}</div>
      </div>
      <div className="empty-note">Choose a character above to compare against venue, tournament, and published pro samples.</div>
    </section>
  );

  if (loading && !benchmarks.broad && !benchmarks.conservative) return <section className="panel acb-panel"><div className="empty-note">Loading tournament archive benchmarks…</div></section>;

  const ownWins = games.reduce((count, game) => count + (game.isWin === true ? 1 : 0), 0);
  const ownDecided = games.reduce((count, game) => count + (game.isWin !== null ? 1 : 0), 0);
  const ownExecutionRow: ExecutionRow = {
    key: "you",
    label: "You",
    sample: ownExecution.games,
    sampleLabel: "games",
    winRate: ratio(ownWins, ownDecided),
    lCancel: ownExecution.lCancel === null ? null : ownExecution.lCancel / 100,
    groundTech: ownExecution.groundTechSuccess === null ? null : ownExecution.groundTechSuccess / 100,
    wallTech: ownExecution.wallTechSuccess === null ? null : ownExecution.wallTechSuccess / 100,
    opk: ownExecution.opk,
    dpo: ownExecution.dpo,
    ipm: ownExecution.ipm,
  };
  const ssbmStatsExecutionRow = ssbmStatsExecution(communityBenchmark, communityExecution, communityCharacter);
  const venueExecutionRow = benchmarks.broad ? archiveExecution(benchmarks.broad, "Venue archive", false) : null;
  const tournamentExecutionRow = benchmarks.conservative ? archiveExecution(benchmarks.conservative, "Tournament archive", true) : null;
  const proAggregateExecutionRow = proAggregateBenchmark ? archiveExecution(proAggregateBenchmark, "Pro tournament archive", false) : null;
  const selectedProExecutionRow = proBenchmark && selectedPro
    ? archiveExecution(proBenchmark, selectedPro.display_name, false, "games")
    : null;
  const executionRows: ExecutionRow[] = [ownExecutionRow, ssbmStatsExecutionRow];
  if (venueExecutionRow) executionRows.push(venueExecutionRow);
  if (tournamentExecutionRow) executionRows.push(tournamentExecutionRow);
  if (proAggregateExecutionRow) executionRows.push(proAggregateExecutionRow);
  if (selectedProExecutionRow) executionRows.push(selectedProExecutionRow);

  const ownActionRates = new Map(ownActions.rows.map((row) => [row.key, row.perMinute]));
  const executionComparisonSources: ExecutionComparisonSource[] = [
    {
      key: "you",
      label: "You",
      sampleNote: `${ownActions.covered.toLocaleString()} measured games`,
      execution: ownExecutionRow,
      actionRate: (key) => ownActionRates.get(key) ?? null,
    },
    {
      key: "ssbm-stats",
      label: "SSBM Stats",
      sampleNote: ssbmStatsExecutionRow.sample === null
        ? "sample not yet publishable"
        : `${ssbmStatsExecutionRow.sample.toLocaleString()} player-games`,
      execution: ssbmStatsExecutionRow,
      // This snapshot publishes aggregate action counts but no duration denominator.
      actionRate: () => null,
    },
    {
      key: "venue",
      label: "Venue archive",
      sampleNote: `${benchmarks.broad?.game_count.toLocaleString() ?? "—"} player-games`,
      execution: venueExecutionRow,
      actionRate: (key) => archiveActionRate(benchmarks.broad, key),
    },
    {
      key: "tournament",
      label: "Tournament archive",
      sampleNote: `${benchmarks.conservative?.game_count.toLocaleString() ?? "—"} player-games`,
      execution: tournamentExecutionRow,
      actionRate: (key) => archiveActionRate(benchmarks.conservative, key),
    },
    {
      key: "pro-aggregate",
      label: "Pro tournament archive",
      sampleNote: `${proAggregateBenchmark?.game_count.toLocaleString() ?? "—"} player-games · ${countNoun(proAggregateBenchmark?.identified_player_count, "pro")}`,
      execution: proAggregateExecutionRow,
      actionRate: (key) => archiveActionRate(proAggregateBenchmark, key),
    },
  ];
  if (selectedPro) executionComparisonSources.push({
    key: `pro:${selectedPro.id}`,
    label: selectedPro.display_name,
    sampleNote: `${proBenchmark?.game_count.toLocaleString() ?? "—"} games`,
    execution: selectedProExecutionRow,
    actionRate: (key) => archiveActionRate(proBenchmark, key),
  });

  const moveSources = {
    broad: groupArchiveMoves(benchmarks.broad),
    conservative: groupArchiveMoves(benchmarks.conservative),
    proAggregate: groupArchiveMoves(proAggregateBenchmark),
    pro: groupArchiveMoves(proBenchmark),
  };
  const comparisonRow = benchmarks.conservative ?? benchmarks.broad;
  const comparisonMoves = benchmarks.conservative ? moveSources.conservative : moveSources.broad;
  const communityMoveByKey = new Map(communityMoves.map((move) => [move.moveKey, move]));
  const communityDamage = communityMoves.reduce((sum, move) => sum + move.damage, 0);
  const communityGames = communityMoves.length
    ? Math.max(...communityMoves.map((move) => move.characterGames))
    : null;
  const ownMoveByKey = new Map(ownMoves.rows.map((move) => [move.key, move]));
  const moveKeys = [...new Set([
    ...ownMoveByKey.keys(),
    ...communityMoveByKey.keys(),
    ...moveSources.broad.keys(),
    ...moveSources.conservative.keys(),
    ...moveSources.proAggregate.keys(),
    ...moveSources.pro.keys(),
  ])].sort((a, b) => {
    const damage = (key: string) => Math.max(
      ownMoveByKey.get(key)?.dmgShare ?? 0,
      ratio(communityMoveByKey.get(key)?.damage ?? 0, communityDamage) ?? 0,
      ratio(moveSources.broad.get(key)?.damage ?? 0, benchmarks.broad?.metrics.damageTotal ?? 0) ?? 0,
      ratio(moveSources.conservative.get(key)?.damage ?? 0, benchmarks.conservative?.metrics.damageTotal ?? 0) ?? 0,
      ratio(moveSources.proAggregate.get(key)?.damage ?? 0, proAggregateBenchmark?.metrics.damageTotal ?? 0) ?? 0,
      ratio(moveSources.pro.get(key)?.damage ?? 0, proBenchmark?.metrics.damageTotal ?? 0) ?? 0,
    );
    return damage(b) - damage(a);
  });

  return (
    <section className="panel acb-panel">
      <div className="panel-heading-row acb-heading">
        <div>
          <div className="eyebrow">Full-field comparison</div>
          <h2>Your {charName(characterId)} across every benchmark</h2>
        </div>
        <div className="community-controls">
          {controls}
          <label>
            Named ranked player
            <select value={playerId ?? "none"} disabled={pros.length === 0} onChange={(event) => {
              const nextId = event.target.value === "none" ? null : event.target.value;
              setPlayerId(nextId);
              const player = pros.find((option) => option.id === nextId);
              if (player) onCharacterChange?.(player.primary_character_id);
            }}>
              <option value="none">No pro comparison</option>
              {pros.map((player) => <option key={player.id} value={player.id}>{player.display_name} · {charName(player.primary_character_id)} · {archiveRankingLabel(player.latest_ranking)}</option>)}
            </select>
          </label>
        </div>
      </div>

      {error ? <div className="acb-error" role="status">{error} Archive comparisons are temporarily unavailable.</div> : (
        <>
          <h3 className="table-subhead community-table-subhead">Headline execution</h3>
          <div className="table-scroll acb-execution"><table><thead><tr><th>Sample</th><th className="data">Win rate</th><th className="data">L-cancel</th><th className="data">Ground tech</th><th className="data">Wall tech</th><th className="data">Openings / kill</th><th className="data">Damage / opening</th><th className="data">Inputs / min</th><th className="data">Sample size</th></tr></thead><tbody>{executionRows.map((row) => <tr key={row.key}><td>{row.label}{row.balanceNote && <span className="sample-note">{row.balanceNote}</span>}</td><td className="data">{pct(row.winRate)}</td><td className="data">{pct(row.lCancel)}</td><td className="data">{pct(row.groundTech)}</td><td className="data">{pct(row.wallTech)}</td><td className="data">{num(row.opk, 2)}</td><td className="data">{num(row.dpo, 1)}</td><td className="data">{num(row.ipm, 1)}</td><td className="data">{row.sample === null ? "—" : row.sample.toLocaleString()}<span className="sample-note">{row.sampleLabel}</span></td></tr>)}</tbody></table></div>

          <div className="acb-move-heading">
            <h3>Move profile</h3>
            <label>Measure<select value={moveMetric} onChange={(event) => setMoveMetric(event.target.value as MoveMetric)}><option value="attempts">Attempts / game</option><option value="landed">Landed / game</option><option value="damage">Damage share</option><option value="kills">Kills / game</option><option value="killPct">Average kill %</option></select></label>
          </div>
          {moveKeys.length ? <div className="table-scroll"><table><thead><tr><th>Move</th><th className="data">You</th><th className="data">SSBM Stats<span className="sample-note">{communityGames === null ? "sample not yet publishable" : `${communityGames.toLocaleString()} player-games`}</span></th><th className="data">Venue archive<span className="sample-note">{benchmarks.broad?.game_count.toLocaleString() ?? "—"} player-games</span></th><th className="data">Tournament archive<span className="sample-note">{benchmarks.conservative?.game_count.toLocaleString() ?? "—"} player-games</span></th><th className="data">Pro tournament archive<span className="sample-note">{proAggregateBenchmark?.game_count.toLocaleString() ?? "—"} player-games · {countNoun(proAggregateBenchmark?.identified_player_count, "pro")}</span></th>{selectedPro && <th className="data">{selectedPro.display_name}<span className="sample-note">{proBenchmark?.game_count.toLocaleString() ?? "—"} games</span></th>}</tr></thead><tbody>{moveKeys.map((key) => {
            const ownMove = ownMoveByKey.get(key);
            const mine = localMoveMetric(ownMove, moveMetric, ownMoves.covered);
            const field = archiveMoveMetric(comparisonMoves.get(key), moveMetric, comparisonRow);
            const difference = moveDifference(mine, field, moveMetric, ownMoves.covered, comparisonRow?.game_count ?? 0);
            const localValue = formatLocalMove(ownMove, moveMetric, ownMoves.covered);
            const comparisonLabel = benchmarks.conservative ? "tournament" : "venue";
            return <tr key={key}><td>{ownMove?.label ?? moveGroupLabel(key)}</td><td className={`data ${difference ? `community-diff-${difference.direction}` : ""}`} style={differenceStyle(difference)} title={difference ? `${difference.direction === "above" ? "Higher than" : "Lower than"} the ${comparisonLabel} archive benchmark; highlight intensity reflects the size of the difference` : undefined} aria-label={difference ? `${localValue}, ${difference.direction === "above" ? "higher" : "lower"} than the ${comparisonLabel} archive benchmark` : undefined}>{localValue}{difference && <span className="community-diff-cue" aria-hidden="true">{difference.direction === "above" ? "▲" : "▼"}</span>}</td><td className="data">{formatCommunityMove(communityMoveByKey.get(key), moveMetric, communityDamage)}</td><td className="data">{formatArchiveMove(moveSources.broad.get(key), moveMetric, benchmarks.broad)}</td><td className="data">{formatArchiveMove(moveSources.conservative.get(key), moveMetric, benchmarks.conservative)}</td><td className="data">{formatArchiveMove(moveSources.proAggregate.get(key), moveMetric, proAggregateBenchmark)}</td>{selectedPro && <td className="data">{formatArchiveMove(moveSources.pro.get(key), moveMetric, proBenchmark)}</td>}</tr>;
          })}</tbody></table></div> : <div className="empty-note">No move data is published for this character yet.</div>}

          <h3 className="table-subhead acb-execution-comparison-heading">Full execution comparison</h3>
          <div className="table-scroll acb-execution-comparison">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  {executionComparisonSources.map((source) => <th className="data" key={source.key}>{source.label}<span className="sample-note">{source.sampleNote}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {EXECUTION_COMPARISON_METRICS.map((metric) => <tr key={metric.key}>
                  <td>{metric.label}</td>
                  {executionComparisonSources.map((source) => <td className="data" key={source.key}>{formatExecutionComparison(executionComparisonValue(source, metric), metric)}</td>)}
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className="hint acb-execution-comparison-note">
            Action rates use total measured actions divided by total measured game minutes. SSBM Stats does not publish
            that duration denominator, so its action-rate cells show dashes rather than estimates.
          </div>
        </>
      )}

      <div className="acb-separation-note">
        These archive columns are separate event-derived averages—not additional members of the opt-in SSBM Stats cohort,
        and not merged into its player-balanced quartiles. “Venue archive” includes usable event-associated games;
        “Tournament archive” uses conservatively curated tournament games. Named rows appear only for published,
        externally resolved publicly ranked identities.
      </div>
      {dataset && <div className="hint">
        Sources: <a href={dataset.source_url} target="_blank" rel="noreferrer">{dataset.source_label}</a> · derived snapshot {shortDate(dataset.data_as_of)};
        {" "}<a href="https://liquipedia.net/smash/SSBMRank" target="_blank" rel="noreferrer">Liquipedia rankings and player pages</a> for the player roster and rankings
        {" "}(<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noreferrer">CC BY-SA 3.0</a>).
        Raw replay files and private identifiers are not part of the public dataset.
      </div>}
    </section>
  );
}

function formatLocalMove(move: ReturnType<typeof moveTable>["rows"][number] | undefined, metric: MoveMetric, covered: number): string {
  return formatMoveMetric(localMoveMetric(move, metric, covered), metric);
}

function formatArchiveMove(move: GroupedArchiveMove | undefined, metric: MoveMetric, row: ArchiveRollup | null): string {
  return formatMoveMetric(archiveMoveMetric(move, metric, row), metric);
}

function formatCommunityMove(move: CommunityMoveRow | undefined, metric: MoveMetric, totalDamage: number): string {
  if (!move || move.characterGames === 0) return "—";
  if (metric === "attempts") return formatMoveMetric(move.attempts === null ? null : move.attempts / move.characterGames, metric);
  if (metric === "landed") return formatMoveMetric(move.landed / move.characterGames, metric);
  if (metric === "damage") return formatMoveMetric(ratio(move.damage, totalDamage), metric);
  if (metric === "kills") return formatMoveMetric(move.kills / move.characterGames, metric);
  return formatMoveMetric(move.kills > 0 ? move.killPctSum / move.kills : null, metric);
}

function localMoveMetric(move: ReturnType<typeof moveTable>["rows"][number] | undefined, metric: MoveMetric, covered: number): number | null {
  if (!move) return null;
  if (metric === "attempts") return move.attemptsPerGame;
  if (metric === "landed") return move.landedPerGame;
  if (metric === "damage") return move.dmgShare;
  if (metric === "kills") return covered > 0 ? move.kills / covered : null;
  return move.avgKillPct;
}

function archiveMoveMetric(move: GroupedArchiveMove | undefined, metric: MoveMetric, row: ArchiveRollup | null): number | null {
  if (!move || !row || row.game_count === 0) return null;
  if (metric === "attempts") return move.attempts === 0 && move.landed > 0 ? null : move.attempts / row.game_count;
  if (metric === "landed") return move.landed / row.game_count;
  if (metric === "damage") return ratio(move.damage, row.metrics.damageTotal);
  if (metric === "kills") return move.kills / row.game_count;
  return move.kills > 0 ? move.killPctSum / move.kills : null;
}

function formatMoveMetric(value: number | null, metric: MoveMetric): string {
  if (value === null) return "—";
  if (metric === "damage") return pct(value);
  if (metric === "killPct") return `${num(value, 0)}%`;
  return num(value, metric === "kills" ? 3 : 2);
}

function moveDifference(
  mine: number | null,
  field: number | null,
  metric: MoveMetric,
  localGames: number,
  fieldGames: number,
): { direction: "above" | "below"; strength: number } | null {
  if (mine === null || field === null || localGames < 10 || fieldGames < 25) return null;
  const absoluteMinimum = metric === "damage" ? 0.05 : metric === "killPct" ? 10 : metric === "kills" ? 0.05 : metric === "landed" ? 0.25 : 0.5;
  const gap = mine - field;
  const threshold = Math.max(absoluteMinimum, Math.abs(field) * 0.35);
  if (Math.abs(gap) < threshold) return null;
  const strength = Math.min(1, 0.15 + Math.max(0, Math.abs(gap) / threshold - 1) * 0.425);
  return { direction: gap > 0 ? "above" : "below", strength };
}

function differenceStyle(difference: ReturnType<typeof moveDifference>): CSSProperties | undefined {
  if (!difference) return undefined;
  return {
    "--diff-bg": String(0.06 + difference.strength * 0.28),
    "--diff-border": String(0.18 + difference.strength * 0.42),
  } as CSSProperties;
}
