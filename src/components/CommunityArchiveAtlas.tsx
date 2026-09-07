import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type {
  CommunityBenchmarkRow,
  CommunityCharacterStageRow,
  CommunityExecutionRow,
  CommunityMatchupRow,
  CommunityMoveRow,
} from "../lib/community";
import { COMMUNITY_MIN_GAMES, COMMUNITY_MIN_PLAYERS } from "../lib/community";
import { INCLUDED_STAGE_IDS } from "../lib/config";
import { countNoun, num, pct, shortDate, winRateColor } from "../lib/format";
import { charName, moveGroup, moveGroupLabel, stageName } from "../lib/melee";
import {
  archiveRankingLabel,
  fetchArchiveCommunityAtlasRows,
  fetchArchiveCommunityProOptions,
  fetchArchiveProAggregateAtlasRows,
  fetchArchivePlayerAtlasRows,
  fetchLatestArchiveDataset,
  type ArchiveDataset,
  type ArchiveMoveMetrics,
  type ArchiveProOption,
  type ArchiveRollup,
} from "../lib/publicArchive";
import { actionAverages, executionSummary, moveTable } from "../lib/stats";
import { ACTION_LABELS, type ActionCounts, type ResolvedGame } from "../lib/types";
import "./ArchiveCommunityBenchmark.css";

interface ArchiveAtlasState {
  dataset: ArchiveDataset | null;
  pros: ArchiveProOption[];
  fieldRows: ArchiveRollup[];
  proAggregateRows: ArchiveRollup[];
  proRows: ArchiveRollup[];
  characterPros: ArchiveProOption[];
  selectedPro: ArchiveProOption | null;
  playerId: string | null;
  setPlayerId: (value: string | null) => void;
  loading: boolean;
  error: string | null;
}

function useArchiveAtlas(characterId: number): ArchiveAtlasState {
  const [dataset, setDataset] = useState<ArchiveDataset | null>(null);
  const [pros, setPros] = useState<ArchiveProOption[]>([]);
  const [fieldRows, setFieldRows] = useState<ArchiveRollup[]>([]);
  const [proAggregateRows, setProAggregateRows] = useState<ArchiveRollup[]>([]);
  const [proRows, setProRows] = useState<ArchiveRollup[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true);
    void fetchLatestArchiveDataset()
      .then(async (nextDataset) => {
        if (!alive) return;
        setDataset(nextDataset);
        if (!nextDataset) {
          setError("No historical tournament archive is published yet.");
          return;
        }
        const nextPros = await fetchArchiveCommunityProOptions(nextDataset.id);
        if (alive) setPros(nextPros);
      })
      .catch(() => { if (alive) setError("Historical tournament comparisons are temporarily unavailable."); })
      .finally(() => { if (alive) setCatalogLoading(false); });
    return () => { alive = false; };
  }, []);

  const characterPros = useMemo(
    () => pros.filter((player) => player.observed_character_ids.includes(characterId)),
    [characterId, pros],
  );

  useEffect(() => {
    if (playerId && !characterPros.some((player) => player.id === playerId)) setPlayerId(null);
  }, [characterPros, playerId]);

  useEffect(() => {
    if (!dataset || characterId < 0) {
      setFieldRows([]);
      setProAggregateRows([]);
      return;
    }
    let alive = true;
    setRowsLoading(true);
    void Promise.all([
      fetchArchiveCommunityAtlasRows(dataset.id, characterId),
      fetchArchiveProAggregateAtlasRows(dataset.id, characterId),
    ])
      .then(([rows, proAggregate]) => { if (alive) { setFieldRows(rows); setProAggregateRows(proAggregate); setError(null); } })
      .catch(() => { if (alive) { setFieldRows([]); setProAggregateRows([]); setError("Historical tournament comparisons are temporarily unavailable."); } })
      .finally(() => { if (alive) setRowsLoading(false); });
    return () => { alive = false; };
  }, [characterId, dataset]);

  useEffect(() => {
    if (!dataset || characterId < 0 || !playerId) {
      setProRows([]);
      return;
    }
    let alive = true;
    void fetchArchivePlayerAtlasRows(dataset.id, playerId, characterId)
      .then((rows) => { if (alive) setProRows(rows); })
      .catch(() => { if (alive) setProRows([]); });
    return () => { alive = false; };
  }, [characterId, dataset, playerId]);

  return {
    dataset,
    pros,
    fieldRows,
    proAggregateRows,
    proRows,
    characterPros,
    selectedPro: characterPros.find((player) => player.id === playerId) ?? null,
    playerId,
    setPlayerId,
    loading: catalogLoading || rowsLoading,
    error,
  };
}

const recentGames = (games: ResolvedGame[], count: number): ResolvedGame[] => games.slice(-count);

function ProControl({ archive, onCharacterChange }: { archive: ArchiveAtlasState; onCharacterChange?: (characterId: number) => void }) {
  return (
    <label>
      Named ranked player
      <select
        value={archive.playerId ?? "none"}
        disabled={archive.pros.length === 0}
        onChange={(event) => {
          const nextId = event.target.value === "none" ? null : event.target.value;
          archive.setPlayerId(nextId);
          const player = archive.pros.find((option) => option.id === nextId);
          if (player) onCharacterChange?.(player.primary_character_id);
        }}
      >
        <option value="none">No pro comparison</option>
        {archive.pros.map((player) => (
          <option key={player.id} value={player.id}>
            {player.display_name} · {charName(player.primary_character_id)} · {archiveRankingLabel(player.latest_ranking)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ArchiveFrame({
  archive,
  eyebrow,
  title,
  controls,
  onCharacterChange,
  children,
}: {
  archive: ArchiveAtlasState;
  eyebrow: string;
  title: string;
  controls?: ReactNode;
  onCharacterChange?: (characterId: number) => void;
  children: ReactNode;
}) {
  return (
    <section className="panel acb-panel community-atlas-archive">
      <div className="panel-heading-row acb-heading">
        <div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>
        <div className="community-controls">
          {controls}
          <ProControl archive={archive} onCharacterChange={onCharacterChange} />
        </div>
      </div>
      {archive.loading && archive.fieldRows.length === 0 ? <div className="empty-note">Loading historical tournament comparisons…</div> : archive.error ? <div className="acb-error" role="status">{archive.error}</div> : children}
      <div className="acb-separation-note">
        “SSBM Stats” is the opt-in user cohort. Each published cell needs at least {COMMUNITY_MIN_PLAYERS} unique players
        and {COMMUNITY_MIN_GAMES} distinct games for that breakdown, including opponents. Duplicate uploads count once.
        {" "}“Venue archive” includes usable event-associated games;
        “Tournament archive” includes only conservatively curated tournament games. Pro rows use only externally
        resolved publicly ranked identities. Your values are computed locally and are not uploaded by this view.
      </div>
      {archive.dataset && <div className="hint">
        Sources: <a href={archive.dataset.source_url} target="_blank" rel="noreferrer">{archive.dataset.source_label}</a> · derived snapshot {shortDate(archive.dataset.data_as_of)};
        {" "}<a href="https://liquipedia.net/smash/SSBMRank" target="_blank" rel="noreferrer">Liquipedia SSBMRank history</a> for player names and rankings
        {" "}(<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noreferrer">CC BY-SA 3.0</a>).
      </div>}
    </section>
  );
}

interface RateSummary {
  wins: number;
  decided: number;
  games: number;
  contributors?: number;
  players?: number;
}

type MatchupSortKey = "opponent" | "games" | "you" | "community" | "venue" | "tournament" | "proAggregate" | "pro";
type StageSortKey = "stage" | "you" | "community" | "venue" | "tournament" | "proAggregate" | "pro";
type SortDirection = "asc" | "desc";

const rateSummary = (row: ArchiveRollup | undefined): RateSummary | null => row ? {
  wins: row.wins,
  decided: row.win_rate_game_count,
  games: row.game_count,
} : null;

function RateCell({ value, showSample = true }: { value: RateSummary | null | undefined; showSample?: boolean }) {
  if (!value || value.decided === 0) return <td className="data atlas-rate-cell">—</td>;
  const rate = value.wins / value.decided;
  return (
    <td className={`data atlas-rate-cell ${value.games < 10 ? "atlas-low-sample" : ""}`}>
      <b style={{ color: winRateColor(rate) }}>{pct(rate)}</b>
      {showSample && <span className="sample-note">{value.games.toLocaleString()} games</span>}
    </td>
  );
}

function rateColumnSample(
  values: (RateSummary | null | undefined)[],
  source: string,
): string {
  const available = values.filter((value): value is RateSummary => value !== null && value !== undefined);
  if (available.length === 0 && source !== "you") return "No published sample";
  const games = available.reduce((total, value) => total + value.decided, 0);
  return `${games.toLocaleString()} ${source === "you" ? "games" : "player-games"}`;
}

function archiveRateMap(rows: ArchiveRollup[], population: "broad" | "conservative", stageId: number | null) {
  return new Map(rows
    .filter((row) => row.population === population && row.opponent_character_id !== null && row.stage_id === stageId)
    .map((row) => [row.opponent_character_id!, rateSummary(row)!]));
}

export function ArchiveMatchupAtlasComparison({
  games,
  characterId,
  stageId,
  gameType,
  lookbackGames,
  communityRows,
  controls,
  onCharacterChange,
}: {
  games: ResolvedGame[];
  characterId: number;
  stageId: number;
  gameType: string;
  lookbackGames: number;
  communityRows: CommunityMatchupRow[];
  controls?: ReactNode;
  onCharacterChange?: (characterId: number) => void;
}) {
  const archive = useArchiveAtlas(characterId);
  const [sort, setSort] = useState<{ key: MatchupSortKey | null; direction: SortDirection }>({ key: "games", direction: "desc" });
  useEffect(() => {
    if (!archive.selectedPro && sort.key === "pro") setSort({ key: "games", direction: "desc" });
  }, [archive.selectedPro, sort.key]);
  const local = useMemo(() => {
    const rows = new Map<number, RateSummary>();
    const matching = games.filter((game) => game.me.characterId === characterId
      && (stageId === 0 || game.rec.stageId === stageId)
      && (gameType === "all" || game.rec.gameType === gameType));
    for (const game of recentGames(matching, lookbackGames)) {
      const row = rows.get(game.opp.characterId) ?? { wins: 0, decided: 0, games: 0 };
      row.games++;
      if (game.isWin !== null) { row.decided++; if (game.isWin) row.wins++; }
      rows.set(game.opp.characterId, row);
    }
    return rows;
  }, [characterId, gameType, games, lookbackGames, stageId]);
  const community = new Map(communityRows.map((row) => [row.opponentCharacterId, {
    wins: row.wins,
    decided: row.games,
    games: row.games,
    contributors: row.contributors,
    players: row.players,
  }]));
  const archiveStage = stageId === 0 ? null : stageId;
  const broad = archiveRateMap(archive.fieldRows, "broad", archiveStage);
  const conservative = archiveRateMap(archive.fieldRows, "conservative", archiveStage);
  const proAggregate = archiveRateMap(archive.proAggregateRows, "conservative", archiveStage);
  const pro = archiveRateMap(archive.proRows, "conservative", archiveStage);
  const sourceFor = (key: MatchupSortKey, opponentId: number): RateSummary | null | undefined => {
    if (key === "you") return local.get(opponentId);
    if (key === "community") return community.get(opponentId);
    if (key === "venue") return broad.get(opponentId);
    if (key === "tournament") return conservative.get(opponentId);
    if (key === "proAggregate") return proAggregate.get(opponentId);
    if (key === "pro") return pro.get(opponentId);
    return null;
  };
  const publishedOpponents = [...new Set([...community.keys(), ...broad.keys(), ...conservative.keys(), ...proAggregate.keys(), ...pro.keys()])];
  const opponents = (games.length > 0 ? [...local.keys()] : publishedOpponents)
    .sort((a, b) => {
      if (sort.key === null) {
        return Math.max(conservative.get(b)?.games ?? 0, community.get(b)?.games ?? 0)
          - Math.max(conservative.get(a)?.games ?? 0, community.get(a)?.games ?? 0)
          || charName(a).localeCompare(charName(b));
      }
      if (sort.key === "opponent") {
        const order = charName(a).localeCompare(charName(b));
        return sort.direction === "asc" ? order : -order;
      }
      if (sort.key === "games") {
        const leftGames = local.get(a)?.games ?? null;
        const rightGames = local.get(b)?.games ?? null;
        if (leftGames === null && rightGames === null) return charName(a).localeCompare(charName(b));
        if (leftGames === null) return 1;
        if (rightGames === null) return -1;
        const direction = sort.direction === "asc" ? 1 : -1;
        return direction * (leftGames - rightGames) || charName(a).localeCompare(charName(b));
      }
      const left = sourceFor(sort.key, a);
      const right = sourceFor(sort.key, b);
      const leftRate = left && left.decided > 0 ? left.wins / left.decided : null;
      const rightRate = right && right.decided > 0 ? right.wins / right.decided : null;
      if (leftRate === null && rightRate === null) return charName(a).localeCompare(charName(b));
      if (leftRate === null) return 1;
      if (rightRate === null) return -1;
      const direction = sort.direction === "asc" ? 1 : -1;
      return direction * (leftRate - rightRate)
        || direction * ((left?.games ?? 0) - (right?.games ?? 0))
        || charName(a).localeCompare(charName(b));
    });
  const sortableHeader = (key: MatchupSortKey, label: string, data = false) => {
    const active = sort.key === key;
    const sample = key === "opponent" ? null : key === "games"
      ? `${[...local.values()].reduce((total, value) => total + value.games, 0).toLocaleString()} games`
      : rateColumnSample(opponents.map((id) => sourceFor(key, id)), key);
    return <th className={`atlas-sortable${data ? " data" : ""}${active ? " active" : ""}`} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => setSort((previous) => previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "opponent" ? "asc" : "desc" })}>
        {label}<span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
      {sample && <span className="sample-note">{sample}</span>}
    </th>;
  };

  return (
    <ArchiveFrame archive={archive} eyebrow="Matchup Atlas" title={`Your ${charName(characterId)} matchups across the full field`} controls={controls} onCharacterChange={onCharacterChange}>
      {opponents.length ? <div className="table-scroll"><table><thead><tr>{sortableHeader("opponent", "Opponent")}{sortableHeader("games", "Games", true)}{sortableHeader("you", "You", true)}{sortableHeader("community", "SSBM Stats", true)}{sortableHeader("venue", "Venue archive", true)}{sortableHeader("tournament", "Tournament archive", true)}{sortableHeader("proAggregate", "Pro tournament archive", true)}{archive.selectedPro && sortableHeader("pro", archive.selectedPro.display_name, true)}</tr></thead><tbody>
        {opponents.map((opponentId) => <tr key={opponentId}><td>{charName(opponentId)}</td><td className="data">{local.get(opponentId)?.games.toLocaleString() ?? "—"}</td><RateCell value={local.get(opponentId)} showSample={false} /><RateCell value={community.get(opponentId)} /><RateCell value={broad.get(opponentId)} /><RateCell value={conservative.get(opponentId)} /><RateCell value={proAggregate.get(opponentId)} />{archive.selectedPro && <RateCell value={pro.get(opponentId)} />}</tr>)}
      </tbody></table></div> : <div className="empty-note">{games.length > 0 ? `No opponents appear in your latest ${lookbackGames.toLocaleString()} matching games.` : "No matching matchup samples are available."}</div>}
      <div className="hint">Header samples count decided results in the displayed matchups; unknown outcomes are excluded from win-rate columns. SSBM Stats counts are approximate. My games lookback scopes only your most recent matching games; benchmark columns retain their full published samples.</div>
      {gameType !== "all" && <div className="hint">Your and SSBM Stats columns use the selected mode. Historical archive columns are offline event games.</div>}
    </ArchiveFrame>
  );
}

function archiveStageMap(rows: ArchiveRollup[], population: "broad" | "conservative", opponentId: number | null) {
  return new Map(rows
    .filter((row) => row.population === population && row.opponent_character_id === opponentId && row.stage_id !== null)
    .map((row) => [row.stage_id!, rateSummary(row)!]));
}

function communityStageMap(rows: CommunityCharacterStageRow[]): Map<number, RateSummary> {
  return new Map(rows.map((row) => [row.stageId, {
    // Use the published rate; the separate wins and games counts are rounded.
    wins: row.winRate * row.games,
    decided: row.games,
    games: row.games,
    contributors: row.contributors,
    players: row.players,
  }]));
}

export function ArchiveStageAtlasComparison({
  games,
  characterId,
  opponentId,
  lookbackGames,
  communityRows,
  communityCharacterStages,
  controls,
  onCharacterChange,
}: {
  games: ResolvedGame[];
  characterId: number;
  opponentId: number | null;
  lookbackGames: number;
  communityRows: CommunityMatchupRow[];
  communityCharacterStages: CommunityCharacterStageRow[];
  controls?: ReactNode;
  onCharacterChange?: (characterId: number) => void;
}) {
  const archive = useArchiveAtlas(characterId);
  const [sort, setSort] = useState<{ key: StageSortKey | null; direction: SortDirection }>({ key: null, direction: "desc" });
  useEffect(() => {
    if (!archive.selectedPro && sort.key === "pro") setSort({ key: null, direction: "desc" });
  }, [archive.selectedPro, sort.key]);
  const local = useMemo(() => {
    const rows = new Map<number, RateSummary>();
    const matching = games.filter((game) => game.me.characterId === characterId
      && (opponentId === null || game.opp.characterId === opponentId));
    for (const game of recentGames(matching, lookbackGames)) {
      const row = rows.get(game.rec.stageId) ?? { wins: 0, decided: 0, games: 0 };
      row.games++;
      if (game.isWin !== null) { row.decided++; if (game.isWin) row.wins++; }
      rows.set(game.rec.stageId, row);
    }
    return rows;
  }, [characterId, games, lookbackGames, opponentId]);
  // All-opponent totals are published independently, before matchup suppression.
  const community = communityStageMap(opponentId === null
    ? communityCharacterStages
    : communityRows.filter((row) => row.opponentCharacterId === opponentId));
  const broad = archiveStageMap(archive.fieldRows, "broad", opponentId);
  const conservative = archiveStageMap(archive.fieldRows, "conservative", opponentId);
  const proAggregate = archiveStageMap(archive.proAggregateRows, "conservative", opponentId);
  const pro = archiveStageMap(archive.proRows, "conservative", opponentId);
  const sourceFor = (key: StageSortKey, stageId: number): RateSummary | null | undefined => {
    if (key === "you") return local.get(stageId);
    if (key === "community") return community.get(stageId);
    if (key === "venue") return broad.get(stageId);
    if (key === "tournament") return conservative.get(stageId);
    if (key === "proAggregate") return proAggregate.get(stageId);
    if (key === "pro") return pro.get(stageId);
    return null;
  };
  const stages = INCLUDED_STAGE_IDS
    .filter((id) => local.has(id) || community.has(id) || broad.has(id) || conservative.has(id) || proAggregate.has(id) || pro.has(id))
    .sort((a, b) => {
      if (sort.key === null) return INCLUDED_STAGE_IDS.indexOf(a) - INCLUDED_STAGE_IDS.indexOf(b);
      if (sort.key === "stage") {
        const order = stageName(a).localeCompare(stageName(b));
        return sort.direction === "asc" ? order : -order;
      }
      const left = sourceFor(sort.key, a);
      const right = sourceFor(sort.key, b);
      const leftRate = left && left.decided > 0 ? left.wins / left.decided : null;
      const rightRate = right && right.decided > 0 ? right.wins / right.decided : null;
      if (leftRate === null && rightRate === null) return stageName(a).localeCompare(stageName(b));
      if (leftRate === null) return 1;
      if (rightRate === null) return -1;
      const direction = sort.direction === "asc" ? 1 : -1;
      return direction * (leftRate - rightRate)
        || direction * ((left?.games ?? 0) - (right?.games ?? 0))
        || stageName(a).localeCompare(stageName(b));
    });
  const sortableHeader = (key: StageSortKey, label: string, data = false) => {
    const active = sort.key === key;
    const sample = key === "stage" ? null : rateColumnSample(stages.map((id) => sourceFor(key, id)), key);
    return <th className={`atlas-sortable${data ? " data" : ""}${active ? " active" : ""}`} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => setSort((previous) => previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "stage" ? "asc" : "desc" })}>
        {label}<span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
      {sample && <span className="sample-note">{sample}</span>}
    </th>;
  };

  return (
    <ArchiveFrame archive={archive} eyebrow="Stage Atlas" title={`${charName(characterId)} vs ${opponentId === null ? "all opponents" : charName(opponentId)} across the full field`} controls={controls} onCharacterChange={onCharacterChange}>
      {stages.length ? <div className="table-scroll"><table><thead><tr>{sortableHeader("stage", "Stage")}{sortableHeader("you", "You", true)}{sortableHeader("community", "SSBM Stats", true)}{sortableHeader("venue", "Venue archive", true)}{sortableHeader("tournament", "Tournament archive", true)}{sortableHeader("proAggregate", "Pro tournament archive", true)}{archive.selectedPro && sortableHeader("pro", archive.selectedPro.display_name, true)}</tr></thead><tbody>
        {stages.map((id) => <tr key={id}><td>{stageName(id)}</td><RateCell value={local.get(id)} /><RateCell value={community.get(id)} /><RateCell value={broad.get(id)} /><RateCell value={conservative.get(id)} /><RateCell value={proAggregate.get(id)} />{archive.selectedPro && <RateCell value={pro.get(id)} />}</tr>)}
      </tbody></table></div> : <div className="empty-note">No stage-specific sample is available for this matchup.</div>}
      <div className="hint">Header samples count decided results in the displayed stages; unknown outcomes are excluded. SSBM Stats counts are approximate. My games lookback scopes only your most recent matching games; benchmark columns retain their full published samples.</div>
    </ArchiveFrame>
  );
}

interface GroupedArchiveMove extends ArchiveMoveMetrics {
  key: string;
  label: string;
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

type MoveMetric = "attempts" | "landed" | "damage" | "kills" | "killPct";
type MoveSortKey = "move" | "you" | "community" | "venue" | "tournament" | "proAggregate" | "pro";

function localMoveValue(move: ReturnType<typeof moveTable>["rows"][number] | undefined, metric: MoveMetric, games: number) {
  return formatMoveMetric(localMoveMetric(move, metric, games), metric);
}

function communityMoveValue(move: CommunityMoveRow | undefined, metric: MoveMetric, totalDamage: number) {
  return formatMoveMetric(communityMoveMetric(move, metric, totalDamage), metric);
}

function archiveMoveValue(move: GroupedArchiveMove | undefined, metric: MoveMetric, row: ArchiveRollup | null) {
  return formatMoveMetric(archiveMoveMetric(move, metric, row), metric);
}

function localMoveMetric(move: ReturnType<typeof moveTable>["rows"][number] | undefined, metric: MoveMetric, games: number): number | null {
  if (!move) return null;
  if (metric === "attempts") return move.attemptsPerGame;
  if (metric === "landed") return move.landedPerGame;
  if (metric === "damage") return move.dmgShare;
  if (metric === "kills") return games > 0 ? move.kills / games : null;
  return move.avgKillPct;
}

function communityMoveMetric(move: CommunityMoveRow | undefined, metric: MoveMetric, totalDamage: number): number | null {
  if (!move || move.characterGames === 0) return null;
  if (metric === "attempts") return move.attempts === null ? null : move.attempts / move.characterGames;
  if (metric === "landed") return move.landed / move.characterGames;
  if (metric === "damage") return totalDamage > 0 ? move.damage / totalDamage : null;
  if (metric === "kills") return move.kills / move.characterGames;
  return move.kills > 0 ? move.killPctSum / move.kills : null;
}

function archiveMoveMetric(move: GroupedArchiveMove | undefined, metric: MoveMetric, row: ArchiveRollup | null): number | null {
  if (!move || !row || row.game_count === 0) return null;
  if (metric === "attempts") return move.attempts === 0 && move.landed > 0 ? null : move.attempts / row.game_count;
  if (metric === "landed") return move.landed / row.game_count;
  if (metric === "damage") return row.metrics.damageTotal > 0 ? move.damage / row.metrics.damageTotal : null;
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

const ratio = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;

function archiveActionPerGame(row: ArchiveRollup | null, key: keyof ActionCounts): number | null {
  if (!row || row.game_count <= 0) return null;
  const value = row.metrics.actions?.[key];
  return value === undefined ? null : value / row.game_count;
}

function communityActionPerGame(row: CommunityExecutionRow | undefined, key: keyof ActionCounts): number | null {
  if (!row || row.games <= 0 || !row.actionCounts) return null;
  return row.actionCounts[key] / row.games;
}

type ExecutionProfileField = "lCancel" | "groundTech" | "wallTech" | "ipm";

interface ExecutionProfileSource {
  key: string;
  label: string;
  sampleNote: string;
  fields: Record<ExecutionProfileField, number | null>;
  actionPerGame: (key: keyof ActionCounts) => number | null;
  approximateActions?: boolean;
}

const EXECUTION_PROFILE_ROWS: { key: ExecutionProfileField; label: string; percent: boolean }[] = [
  { key: "lCancel", label: "L-cancel success", percent: true },
  { key: "groundTech", label: "Ground tech success", percent: true },
  { key: "wallTech", label: "Wall tech success", percent: true },
  { key: "ipm", label: "Inputs / min", percent: false },
];

function archiveExecutionFields(row: ArchiveRollup | null): Record<ExecutionProfileField, number | null> {
  if (!row) return { lCancel: null, groundTech: null, wallTech: null, ipm: null };
  const metrics = row.metrics;
  const groundSuccess = metrics.techInPlace + metrics.techToward + metrics.techAway;
  return {
    lCancel: ratio(metrics.lCancelSuccess, metrics.lCancelSuccess + metrics.lCancelFail),
    groundTech: ratio(groundSuccess, groundSuccess + metrics.techMissed),
    wallTech: ratio(metrics.wallTechSuccess, metrics.wallTechSuccess + metrics.wallTechMissed),
    ipm: ratio(metrics.inputsPerMinuteSum, metrics.inputsPerMinuteSamples),
  };
}

function normalizedMinimum(input: string): number {
  const value = Number(input);
  return input.trim() !== "" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 1;
}

export function ArchiveMoveAtlasComparison({
  games,
  characterId,
  lookbackGames,
  communityRows,
  communityExecution,
  communityBenchmark,
  controls,
  onCharacterChange,
}: {
  games: ResolvedGame[];
  characterId: number;
  lookbackGames: number;
  communityRows: CommunityMoveRow[];
  communityExecution?: CommunityExecutionRow;
  communityBenchmark?: CommunityBenchmarkRow;
  controls?: ReactNode;
  onCharacterChange?: (characterId: number) => void;
}) {
  const archive = useArchiveAtlas(characterId);
  const [metric, setMetric] = useState<MoveMetric>("attempts");
  const [sort, setSort] = useState<{ key: MoveSortKey; direction: SortDirection }>({ key: "you", direction: "desc" });
  const [minAttemptsInput, setMinAttemptsInput] = useState("1");
  const [minActionsInput, setMinActionsInput] = useState("1");
  const minAttempts = normalizedMinimum(minAttemptsInput);
  const minActions = normalizedMinimum(minActionsInput);
  const localGames = useMemo(
    () => recentGames(games.filter((game) => game.me.characterId === characterId), lookbackGames),
    [characterId, games, lookbackGames],
  );
  const localMoves = useMemo(() => moveTable(localGames), [localGames]);
  const localActions = useMemo(() => actionAverages(localGames), [localGames]);
  const localExecution = useMemo(() => executionSummary(localGames, Number.MAX_SAFE_INTEGER), [localGames]);
  const localByKey = new Map(localMoves.rows.map((row) => [row.key, row]));
  const communityByKey = new Map(communityRows.map((row) => [row.moveKey, row]));
  const broadRow = archive.fieldRows.find((row) => row.population === "broad" && row.opponent_character_id === null && row.stage_id === null) ?? null;
  const conservativeRow = archive.fieldRows.find((row) => row.population === "conservative" && row.opponent_character_id === null && row.stage_id === null) ?? null;
  const proAggregateRow = archive.proAggregateRows.find((row) => row.opponent_character_id === null && row.stage_id === null) ?? null;
  const proRow = archive.proRows.find((row) => row.opponent_character_id === null && row.stage_id === null) ?? null;
  const broadMoves = groupArchiveMoves(broadRow);
  const conservativeMoves = groupArchiveMoves(conservativeRow);
  const proAggregateMoves = groupArchiveMoves(proAggregateRow);
  const proMoves = groupArchiveMoves(proRow);
  useEffect(() => {
    if (!archive.selectedPro && sort.key === "pro") setSort({ key: "you", direction: "desc" });
  }, [archive.selectedPro, sort.key]);
  const communityDamage = communityRows.reduce((sum, row) => sum + row.damage, 0);
  const sortValue = (key: string, source: MoveSortKey): number | null => {
    if (source === "you") return localMoveMetric(localByKey.get(key), metric, localMoves.covered);
    if (source === "community") return communityMoveMetric(communityByKey.get(key), metric, communityDamage);
    if (source === "venue") return archiveMoveMetric(broadMoves.get(key), metric, broadRow);
    if (source === "tournament") return archiveMoveMetric(conservativeMoves.get(key), metric, conservativeRow);
    if (source === "proAggregate") return archiveMoveMetric(proAggregateMoves.get(key), metric, proAggregateRow);
    if (source === "pro") return archiveMoveMetric(proMoves.get(key), metric, proRow);
    return null;
  };
  const moveKeys = [...new Set([...localByKey.keys(), ...communityByKey.keys(), ...broadMoves.keys(), ...conservativeMoves.keys(), ...proAggregateMoves.keys(), ...proMoves.keys()])]
    .filter((key) => {
      const myAttempts = localMoveMetric(localByKey.get(key), "attempts", localMoves.covered);
      return myAttempts !== null && myAttempts >= minAttempts;
    })
    .sort((a, b) => {
      const aLabel = localByKey.get(a)?.label ?? moveGroupLabel(a);
      const bLabel = localByKey.get(b)?.label ?? moveGroupLabel(b);
      if (sort.key === "move") {
        const order = aLabel.localeCompare(bLabel);
        return sort.direction === "asc" ? order : -order;
      }
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);
      if (left === null && right === null) return aLabel.localeCompare(bLabel);
      if (left === null) return 1;
      if (right === null) return -1;
      const direction = sort.direction === "asc" ? 1 : -1;
      return direction * (left - right) || aLabel.localeCompare(bLabel);
    });
  const communityGames = communityRows.length
    ? Math.max(...communityRows.map((row) => row.characterGames))
    : null;
  const localActionByKey = new Map(localActions.rows.map((row) => [row.key, row.perGame]));
  const archiveFields = {
    broad: archiveExecutionFields(broadRow),
    conservative: {
      ...archiveExecutionFields(conservativeRow),
      lCancel: conservativeRow?.metrics.playerBalanced?.lCancel.equalWeightMean
        ?? archiveExecutionFields(conservativeRow).lCancel,
    },
    proAggregate: archiveExecutionFields(proAggregateRow),
    pro: archiveExecutionFields(proRow),
  };
  const executionSources: ExecutionProfileSource[] = [
    {
      key: "you",
      label: "You",
      sampleNote: `${localActions.covered.toLocaleString()} measured games`,
      fields: {
        lCancel: localExecution.lCancel === null ? null : localExecution.lCancel / 100,
        groundTech: localExecution.groundTechSuccess === null ? null : localExecution.groundTechSuccess / 100,
        wallTech: localExecution.wallTechSuccess === null ? null : localExecution.wallTechSuccess / 100,
        ipm: localExecution.ipm,
      },
      actionPerGame: (key) => localActionByKey.get(key) ?? null,
    },
    {
      key: "community",
      label: "SSBM Stats",
      sampleNote: communityExecution ? `${communityExecution.games.toLocaleString()} player-games` : "sample not yet publishable",
      fields: {
        lCancel: communityBenchmark?.lCancel?.p50 === null || communityBenchmark?.lCancel?.p50 === undefined
          ? communityExecution?.lCancelSuccess === null || communityExecution?.lCancelSuccess === undefined
            ? null
            : communityExecution.lCancelSuccess / 100
          : communityBenchmark.lCancel.p50 / 100,
        groundTech: communityExecution?.groundTechSuccess === null || communityExecution?.groundTechSuccess === undefined ? null : communityExecution.groundTechSuccess / 100,
        wallTech: null,
        ipm: communityBenchmark?.inputsPerMinute?.p50 ?? null,
      },
      actionPerGame: (key) => communityActionPerGame(communityExecution, key),
      approximateActions: true,
    },
    {
      key: "venue",
      label: "Venue archive",
      sampleNote: `${broadRow?.game_count.toLocaleString() ?? "—"} player-games`,
      fields: archiveFields.broad,
      actionPerGame: (key) => archiveActionPerGame(broadRow, key),
    },
    {
      key: "tournament",
      label: "Tournament archive",
      sampleNote: `${conservativeRow?.game_count.toLocaleString() ?? "—"} player-games`,
      fields: archiveFields.conservative,
      actionPerGame: (key) => archiveActionPerGame(conservativeRow, key),
    },
    {
      key: "pro-aggregate",
      label: "Pro tournament archive",
      sampleNote: `${proAggregateRow?.game_count.toLocaleString() ?? "—"} player-games · ${countNoun(proAggregateRow?.identified_player_count, "pro")}`,
      fields: archiveFields.proAggregate,
      actionPerGame: (key) => archiveActionPerGame(proAggregateRow, key),
    },
  ];
  if (archive.selectedPro) executionSources.push({
    key: `pro:${archive.selectedPro.id}`,
    label: archive.selectedPro.display_name,
    sampleNote: `${proRow?.game_count.toLocaleString() ?? "—"} games`,
    fields: archiveFields.pro,
    actionPerGame: (key) => archiveActionPerGame(proRow, key),
  });
  const visibleActions = ACTION_LABELS.filter(({ key }) => executionSources
    .filter((source) => !source.approximateActions && !source.key.startsWith("pro:"))
    .some((source) => (source.actionPerGame(key) ?? -Infinity) >= minActions));
  const sortableMoveHeader = (key: MoveSortKey, label: string, sampleNote?: string) => {
    const active = sort.key === key;
    return <th className={`atlas-sortable${key === "move" ? "" : " data"}${active ? " active" : ""}`} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => setSort((previous) => previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "move" ? "asc" : "desc" })}>
        {label}<span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
      {sampleNote && <span className="sample-note">{sampleNote}</span>}
    </th>;
  };

  return (
    <ArchiveFrame archive={archive} eyebrow="Move Atlas" title={`Your ${charName(characterId)} move profile across the full field`} controls={controls} onCharacterChange={onCharacterChange}>
      <div className="acb-move-heading">
        <h3>Move profile</h3>
        <div className="acb-profile-controls">
          <label>Minimum attempts / game<span className="number-suffix unitless"><input type="number" min="0" max="100" step="1" inputMode="numeric" value={minAttemptsInput} onChange={(event) => setMinAttemptsInput(event.target.value)} onBlur={() => setMinAttemptsInput(String(minAttempts))} /></span></label>
          <label>Measure<select value={metric} onChange={(event) => setMetric(event.target.value as MoveMetric)}><option value="attempts">Attempts / game</option><option value="landed">Landed / game</option><option value="damage">Damage share</option><option value="kills">Kills / game</option><option value="killPct">Average kill %</option></select></label>
        </div>
      </div>
      {moveKeys.length ? <div className="table-scroll"><table><thead><tr>{sortableMoveHeader("move", "Move")}{sortableMoveHeader("you", "You", `${localMoves.covered.toLocaleString()} games`)}{sortableMoveHeader("community", "SSBM Stats", communityGames === null ? "sample not yet publishable" : `${communityGames.toLocaleString()} player-games`)}{sortableMoveHeader("venue", "Venue archive", `${broadRow?.game_count.toLocaleString() ?? "—"} player-games`)}{sortableMoveHeader("tournament", "Tournament archive", `${conservativeRow?.game_count.toLocaleString() ?? "—"} player-games`)}{sortableMoveHeader("proAggregate", "Pro tournament archive", `${proAggregateRow?.game_count.toLocaleString() ?? "—"} player-games · ${countNoun(proAggregateRow?.identified_player_count, "pro")}`)}{archive.selectedPro && sortableMoveHeader("pro", archive.selectedPro.display_name, `${proRow?.game_count.toLocaleString() ?? "—"} games`)}</tr></thead><tbody>
        {moveKeys.map((key) => {
          const mine = localMoveMetric(localByKey.get(key), metric, localMoves.covered);
          const tournamentField = archiveMoveMetric(conservativeMoves.get(key), metric, conservativeRow);
          const venueField = archiveMoveMetric(broadMoves.get(key), metric, broadRow);
          const field = tournamentField ?? venueField;
          const comparisonGames = tournamentField !== null ? conservativeRow?.game_count ?? 0 : broadRow?.game_count ?? 0;
          const difference = moveDifference(mine, field, metric, localMoves.covered, comparisonGames);
          const localValue = localMoveValue(localByKey.get(key), metric, localMoves.covered);
          const comparisonLabel = tournamentField !== null ? "tournament" : "venue";
          return <tr key={key}><td>{localByKey.get(key)?.label ?? moveGroupLabel(key)}</td><td className={`data ${difference ? `community-diff-${difference.direction}` : ""}`} style={differenceStyle(difference)} title={difference ? `${difference.direction === "above" ? "Higher than" : "Lower than"} the ${comparisonLabel} archive benchmark; highlight intensity reflects the size of the difference` : undefined} aria-label={difference ? `${localValue}, ${difference.direction === "above" ? "higher" : "lower"} than the ${comparisonLabel} archive benchmark` : undefined}>{localValue}{difference && <span className="community-diff-cue" aria-hidden="true">{difference.direction === "above" ? "▲" : "▼"}</span>}</td><td className="data">{communityMoveValue(communityByKey.get(key), metric, communityDamage)}</td><td className="data">{archiveMoveValue(broadMoves.get(key), metric, broadRow)}</td><td className="data">{archiveMoveValue(conservativeMoves.get(key), metric, conservativeRow)}</td><td className="data">{archiveMoveValue(proAggregateMoves.get(key), metric, proAggregateRow)}</td>{archive.selectedPro && <td className="data">{archiveMoveValue(proMoves.get(key), metric, proRow)}</td>}</tr>;
        })}
      </tbody></table></div> : <div className="empty-note">No locally tracked move clears the current attempts-per-game minimum. Lower it to see more.</div>}

      <div className="acb-move-heading acb-action-heading">
        <h3>Execution &amp; actions</h3>
        <div className="acb-profile-controls">
          <label>Minimum actions / game<span className="number-suffix unitless"><input type="number" min="0" max="100" step="1" inputMode="numeric" value={minActionsInput} onChange={(event) => setMinActionsInput(event.target.value)} onBlur={() => setMinActionsInput(String(minActions))} /></span></label>
        </div>
      </div>
      <div className="table-scroll acb-execution-comparison">
        <table>
          <thead><tr><th>Metric</th>{executionSources.map((source) => <th className="data" key={source.key}>{source.label}<span className="sample-note">{source.sampleNote}</span></th>)}</tr></thead>
          <tbody>
            {EXECUTION_PROFILE_ROWS.map((row) => <tr key={row.key}><td>{row.label}</td>{executionSources.map((source) => <td className="data" key={source.key}>{row.percent ? pct(source.fields[row.key]) : num(source.fields[row.key], 1)}</td>)}</tr>)}
            {visibleActions.map(({ key, label }) => {
              const mine = executionSources[0]!.actionPerGame(key);
              const tournamentField = archiveActionPerGame(conservativeRow, key);
              const venueField = archiveActionPerGame(broadRow, key);
              const field = tournamentField ?? venueField;
              const comparisonGames = tournamentField !== null ? conservativeRow?.game_count ?? 0 : broadRow?.game_count ?? 0;
              const difference = moveDifference(mine, field, "attempts", localActions.covered, comparisonGames);
              const comparisonLabel = tournamentField !== null ? "tournament" : "venue";
              return <tr key={key}><td>{key === "grabs" ? "Grab attempts" : label} / game</td>{executionSources.map((source, index) => {
                const value = source.actionPerGame(key);
                const formatted = num(value, 2);
                return <td
                  className={`data ${index === 0 && difference ? `community-diff-${difference.direction}` : ""}`}
                  style={index === 0 ? differenceStyle(difference) : undefined}
                  title={index === 0 && difference ? `${difference.direction === "above" ? "Higher than" : "Lower than"} the ${comparisonLabel} archive benchmark; highlight intensity reflects the size of the difference` : undefined}
                  aria-label={index === 0 && difference ? `${formatted}, ${difference.direction === "above" ? "higher" : "lower"} than the ${comparisonLabel} archive benchmark` : undefined}
                  key={source.key}
                >{formatted}{index === 0 && difference && <span className="community-diff-cue" aria-hidden="true">{difference.direction === "above" ? "▲" : "▼"}</span>}</td>;
              })}</tr>;
            })}
          </tbody>
        </table>
      </div>
      <div className="hint acb-execution-comparison-note">
        Action rows are per game so every published source can be compared directly. SSBM Stats action rates are
        approximate because its public game denominator is privacy-rounded; its per-game move rates are approximate
        for the same reason, and its damage/kill shares cover published move rows. These values do not decide which
        rows clear the minimum. The move minimum applies to the You column, so lower rates and unavailable attempt counts are hidden. Both minimums default to 1,
        and selecting a named pro does not change which rows appear. The You action cells compare with Tournament, or
        Venue when Tournament is unavailable, and brighter red or blue means a larger difference. My games lookback
        scopes only the You column; every benchmark column retains its full published sample.
      </div>
    </ArchiveFrame>
  );
}
