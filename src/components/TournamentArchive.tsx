import { useCallback, useEffect, useMemo, useState } from "react";
import { INCLUDED_STAGE_IDS } from "../lib/config";
import { hoursLabel, int, num, pct, shortDate, winRateColor } from "../lib/format";
import { charName, moveGroup, moveGroupLabel, stageName } from "../lib/melee";
import {
  archiveRankingLabel,
  fetchArchiveCatalog,
  fetchArchiveCommunityProOptions,
  fetchArchivePlayerEventAvailability,
  fetchArchiveRollups,
  fetchPublishedForecasts,
  type ArchiveCatalog,
  type ArchiveForecast,
  type ArchiveFormat,
  type ArchiveMetrics,
  type ArchiveMoveMetrics,
  type ArchivePopulation,
  type ArchivePlayerEventAvailability,
  type ArchiveProOption,
  type ArchiveRollup,
  type ArchiveTarget,
  type ArchiveTournament,
} from "../lib/publicArchive";
import { Kpi } from "./Kpi";
import "./TournamentArchive.css";

type ExplorerMode = "series" | "event";

const EMPTY_CATALOG: ArchiveCatalog = { dataset: null, series: [], tournaments: [] };

interface MoveRow extends ArchiveMoveMetrics {
  key: string;
  label: string;
}

const sameDimension = (actual: number | null, selected: number | null): boolean => actual === selected;

function findRollup(
  rows: ArchiveRollup[],
  characterId: number | null,
  opponentCharacterId: number | null,
  stageId: number | null,
): ArchiveRollup | null {
  return rows.find((row) =>
    sameDimension(row.character_id, characterId)
    && sameDimension(row.opponent_character_id, opponentCharacterId)
    && sameDimension(row.stage_id, stageId)
  ) ?? null;
}

const rate = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;

function groupedMoves(metrics: ArchiveMetrics | null, gameCount: number): MoveRow[] {
  const grouped = new Map<string, MoveRow>();
  for (const [moveId, move] of Object.entries(metrics?.moves ?? {})) {
    const group = moveGroup(Number(moveId));
    const row = grouped.get(group.key) ?? {
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
    row.attempts += move.attempts;
    row.landed += move.landed;
    row.damage += move.damage;
    row.kills += move.kills;
    row.killPctSum += move.killPctSum;
    row.openings += move.openings;
    row.openingDmg += move.openingDmg;
    row.lCancelSuccess += move.lCancelSuccess;
    row.lCancelFail += move.lCancelFail;
    grouped.set(group.key, row);
  }
  return [...grouped.values()]
    .filter((row) => row.attempts > 0 || row.landed > 0 || row.kills > 0)
    .sort((a, b) => b.attempts / Math.max(1, gameCount) - a.attempts / Math.max(1, gameCount));
}

const tournamentLabel = (tournament: ArchiveTournament): string =>
  tournament.year === null ? tournament.canonical_name : `${tournament.canonical_name} (${tournament.year})`;

export function TournamentArchive() {
  const [catalog, setCatalog] = useState<ArchiveCatalog>(EMPTY_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [mode, setMode] = useState<ExplorerMode>("series");
  const [seriesId, setSeriesId] = useState("");
  const [eventId, setEventId] = useState("");
  const [editionId, setEditionId] = useState("");
  const [population, setPopulation] = useState<ArchivePopulation>("conservative");
  const [format, setFormat] = useState<ArchiveFormat>("singles");
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [opponentCharacterId, setOpponentCharacterId] = useState<number | null>(null);
  const [stageId, setStageId] = useState<number | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [rollups, setRollups] = useState<ArchiveRollup[]>([]);
  const [pros, setPros] = useState<ArchiveProOption[]>([]);
  const [playerAvailability, setPlayerAvailability] = useState<{ playerId: string; rows: ArchivePlayerEventAvailability[] } | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [forecasts, setForecasts] = useState<ArchiveForecast[]>([]);
  const [forecastId, setForecastId] = useState("");

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true);
    void fetchArchiveCatalog()
      .then((nextCatalog) => {
        if (!alive) return;
        setCatalog(nextCatalog);
        const editionCounts = new Map<string, number>();
        for (const tournament of nextCatalog.tournaments) {
          if (tournament.series_id) editionCounts.set(tournament.series_id, (editionCounts.get(tournament.series_id) ?? 0) + 1);
        }
        const firstSeries = nextCatalog.series.find((series) => (editionCounts.get(series.id) ?? 0) > 1) ?? nextCatalog.series[0];
        setSeriesId(firstSeries?.id ?? "");
        setEventId(nextCatalog.tournaments[0]?.id ?? "");
        setCatalogError(null);
      })
      .catch((error: unknown) => {
        if (alive) setCatalogError(error instanceof Error ? error.message : "Tournament data is temporarily unavailable.");
      })
      .finally(() => { if (alive) setCatalogLoading(false); });
    void fetchPublishedForecasts()
      .then((nextForecasts) => {
        if (!alive) return;
        setForecasts(nextForecasts);
        setForecastId(nextForecasts[0]?.id ?? "");
      })
      .catch(() => { if (alive) setForecasts([]); });
    return () => { alive = false; };
  }, []);

  const seriesEditions = useMemo(() => catalog.tournaments
    .filter((tournament) => tournament.series_id === seriesId)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.canonical_name.localeCompare(b.canonical_name)), [catalog.tournaments, seriesId]);

  useEffect(() => {
    if (editionId && !seriesEditions.some((tournament) => tournament.id === editionId)) setEditionId("");
  }, [editionId, seriesEditions]);

  const target = useMemo<ArchiveTarget | null>(() => {
    if (mode === "event") return eventId ? { kind: "event", id: eventId } : null;
    if (editionId) return { kind: "event", id: editionId };
    return seriesId ? { kind: "series", id: seriesId } : null;
  }, [editionId, eventId, mode, seriesId]);

  useEffect(() => {
    if (!catalog.dataset) {
      setPros([]);
      return;
    }
    let alive = true;
    void fetchArchiveCommunityProOptions(catalog.dataset.id, format)
      .then((next) => { if (alive) setPros(next); })
      .catch(() => { if (alive) setPros([]); });
    return () => { alive = false; };
  }, [catalog.dataset, format]);

  useEffect(() => {
    setPlayerAvailability(null);
    if (!catalog.dataset || !playerId) return;
    let alive = true;
    void fetchArchivePlayerEventAvailability(catalog.dataset.id, playerId, format)
      .then((rows) => { if (alive) setPlayerAvailability({ playerId, rows }); })
      .catch(() => { if (alive) setPlayerAvailability({ playerId, rows: [] }); });
    return () => { alive = false; };
  }, [catalog.dataset, format, playerId]);

  useEffect(() => {
    if (!catalog.dataset || !target) {
      setRollups([]);
      return;
    }
    let alive = true;
    setDataLoading(true);
    setDataError(null);
    void fetchArchiveRollups({
      datasetId: catalog.dataset.id,
      target,
      population,
      format,
      playerId,
    })
      .then((next) => { if (alive) setRollups(next); })
      .catch((error: unknown) => {
        if (!alive) return;
        setRollups([]);
        setDataError(error instanceof Error ? error.message : "Tournament statistics are temporarily unavailable.");
      })
      .finally(() => { if (alive) setDataLoading(false); });
    return () => { alive = false; };
  }, [catalog.dataset, format, playerId, population, target]);

  const availableCharacters = useMemo(() => rollups
    .filter((row) => row.character_id !== null && row.opponent_character_id === null && row.stage_id === null)
    .sort((a, b) => b.game_count - a.game_count)
    .map((row) => row.character_id!), [rollups]);

  useEffect(() => {
    if (!playerId && characterId !== null && !availableCharacters.includes(characterId)) {
      setCharacterId(null);
      setOpponentCharacterId(null);
      setStageId(null);
    }
  }, [availableCharacters, characterId, playerId]);

  useEffect(() => {
    if (playerId && !pros.some((player) => player.id === playerId)) setPlayerId(null);
  }, [playerId, pros]);

  const availableEvents = useMemo(() => {
    if (playerId && playerAvailability?.playerId !== playerId) return [];
    const rows = playerId ? playerAvailability?.rows ?? [] : null;
    const ids = rows ? new Set(rows.map((row) => row.tournament_id)) : null;
    return catalog.tournaments
      .filter((tournament) => ids === null || ids.has(tournament.id))
      .sort((a, b) => tournamentLabel(a).localeCompare(tournamentLabel(b)));
  }, [catalog.tournaments, playerAvailability, playerId]);

  const primaryCharacterForEvent = useCallback((tournamentId: string): number | null => {
    if (!playerId || playerAvailability?.playerId !== playerId) return null;
    const counts = new Map<number, number>();
    for (const row of playerAvailability.rows) {
      if (row.tournament_id !== tournamentId) continue;
      counts.set(row.character_id, (counts.get(row.character_id) ?? 0) + row.game_count);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  }, [playerAvailability, playerId]);

  useEffect(() => {
    if (!playerId || playerAvailability?.playerId !== playerId || eventId) return;
    const first = availableEvents[0];
    if (!first) return;
    setEventId(first.id);
    setCharacterId(primaryCharacterForEvent(first.id));
    setOpponentCharacterId(null);
    setStageId(null);
  }, [availableEvents, eventId, playerAvailability, playerId, primaryCharacterForEvent]);

  useEffect(() => {
    if (format === "doubles") setOpponentCharacterId(null);
  }, [format]);

  const availableOpponents = useMemo(() => characterId === null ? [] : rollups
    .filter((row) => row.character_id === characterId && row.opponent_character_id !== null && row.stage_id === null)
    .sort((a, b) => b.game_count - a.game_count)
    .map((row) => row.opponent_character_id!), [characterId, rollups]);

  const selected = findRollup(rollups, characterId, opponentCharacterId, stageId);
  const selectedMoveRow = characterId === null ? null : findRollup(rollups, characterId, null, null);
  const selectedPlayer = pros.find((player) => player.id === playerId) ?? null;
  const selectedEvent = catalog.tournaments.find((tournament) => tournament.id === (mode === "event" ? eventId : editionId)) ?? null;
  const selectedSeries = catalog.series.find((series) => series.id === (mode === "event" ? selectedEvent?.series_id : seriesId)) ?? null;
  const scopeTitle = selectedEvent
    ? tournamentLabel(selectedEvent)
    : selectedSeries?.canonical_name ?? "Tournament archive";

  if (catalogLoading) return <div className="empty-note">Loading public tournament archive…</div>;
  if (catalogError) return <ArchiveUnavailable message={catalogError} />;
  if (!catalog.dataset || catalog.tournaments.length === 0) {
    return <ArchiveUnavailable message="No public tournament dataset has been published yet." />;
  }

  const lCancelAttempts = (selected?.metrics.lCancelSuccess ?? 0) + (selected?.metrics.lCancelFail ?? 0);
  const durationHours = (selected?.metrics.durationFrames ?? 0) / 60 / 60 / 60;

  return (
    <>
      <section className="panel ta-hero">
        <div>
          <div className="eyebrow">Public replay archive</div>
          <h2>{scopeTitle}</h2>
          <p>
            Explore tournament and recurring-series results, execution, stages, and move choices. Named profiles appear
            only where a publicly ranked player can be linked to public tournament evidence.
          </p>
        </div>
        <div className="ta-mode" role="tablist" aria-label="Tournament archive scope">
          <button className={mode === "series" ? "active" : ""} role="tab" aria-selected={mode === "series"} onClick={() => { setMode("series"); setPlayerId(null); }}>Series</button>
          <button className={mode === "event" ? "active" : ""} role="tab" aria-selected={mode === "event"} onClick={() => { setMode("event"); setPlayerId(null); }}>Event</button>
        </div>
      </section>

      <section className="panel ta-filters" aria-label="Tournament archive filters">
        {mode === "series" ? (
          <>
            <label>Series<select value={seriesId} onChange={(event) => { setSeriesId(event.target.value); setEditionId(""); setPlayerId(null); }}>{catalog.series.map((series) => <option key={series.id} value={series.id}>{series.canonical_name}</option>)}</select></label>
            <label>Edition<select value={editionId} onChange={(event) => { setEditionId(event.target.value); setPlayerId(null); }}><option value="">All editions</option>{seriesEditions.map((tournament) => <option key={tournament.id} value={tournament.id}>{tournamentLabel(tournament)}</option>)}</select></label>
          </>
        ) : (
          <label>Event<select value={eventId} disabled={playerId !== null && playerAvailability?.playerId !== playerId} onChange={(event) => { const nextEvent = event.target.value; setEventId(nextEvent); if (playerId) setCharacterId(primaryCharacterForEvent(nextEvent)); setOpponentCharacterId(null); setStageId(null); }}>{availableEvents.map((tournament) => <option key={tournament.id} value={tournament.id}>{tournamentLabel(tournament)}</option>)}</select></label>
        )}
        <label>Sample<select value={population} disabled={playerId !== null} onChange={(event) => setPopulation(event.target.value as ArchivePopulation)}><option value="conservative">Tournament benchmark</option><option value="broad">Venue benchmark</option></select></label>
        <label>Format<select value={format} onChange={(event) => { setFormat(event.target.value as ArchiveFormat); setPlayerId(null); }}><option value="singles">Singles</option><option value="doubles">Doubles</option></select></label>
        <label>Character<select value={characterId ?? "all"} onChange={(event) => { const value = event.target.value; setCharacterId(value === "all" ? null : Number(value)); setOpponentCharacterId(null); setStageId(null); }}><option value="all">All characters</option>{availableCharacters.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
        <label>Opponent<select value={opponentCharacterId ?? "all"} disabled={characterId === null || format === "doubles"} onChange={(event) => { setOpponentCharacterId(event.target.value === "all" ? null : Number(event.target.value)); setStageId(null); }}><option value="all">All opponents</option>{availableOpponents.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
        <label>Stage<select value={stageId ?? "all"} disabled={characterId === null} onChange={(event) => setStageId(event.target.value === "all" ? null : Number(event.target.value))}><option value="all">All legal stages</option>{INCLUDED_STAGE_IDS.map((id) => <option key={id} value={id}>{stageName(id)}</option>)}</select></label>
        <label>Ranked player<select value={playerId ?? "field"} disabled={pros.length === 0} onChange={(event) => { const next = event.target.value === "field" ? null : event.target.value; setPlayerId(next); setOpponentCharacterId(null); setStageId(null); if (next) { const player = pros.find((option) => option.id === next); setMode("event"); setEventId(""); setCharacterId(player?.primary_character_id ?? null); setPopulation("conservative"); } }}><option value="field">Tournament field</option>{pros.map((player) => <option key={player.id} value={player.id}>{player.display_name} · {charName(player.primary_character_id)} · {archiveRankingLabel(player.latest_ranking)}</option>)}</select></label>
        <div className="ta-filter-note">
          {playerId
            ? "Named-player views use conservatively curated games. Event lists show only events with published evidence-backed mappings for that pro; choosing an event selects their most-played character there."
            : population === "broad"
              ? "Venue benchmark includes technically usable event-associated games, including games not tied to a bracket set."
              : "Tournament benchmark includes only verified or probable tournament-set games. Choose a named pro to narrow Events and Character automatically."}
        </div>
      </section>

      {dataLoading ? <div className="empty-note">Loading tournament statistics…</div> : dataError ? <ArchiveUnavailable message={dataError} /> : !selected ? (
        <div className="empty-note">No published data matches this combination of filters.</div>
      ) : (
        <>
          <div className="ta-selection-note">
            <b>{selectedPlayer?.display_name ?? "Tournament field"}</b>
            {characterId !== null && <> · {charName(characterId)}</>}
            {opponentCharacterId !== null && <> vs {charName(opponentCharacterId)}</>}
            {stageId !== null && <> · {stageName(stageId)}</>}
          </div>
          <div className="kpi-strip ta-kpis">
            <Kpi label={playerId ? "Games" : "Player-games"} value={int(selected.game_count)} delta={`${int(selected.win_rate_game_count)} with a result`} />
            <Kpi
              label="Win rate"
              value={!playerId && characterId === null ? "—" : pct(rate(selected.wins, selected.win_rate_game_count))}
              delta={!playerId && characterId === null ? "Choose a character" : selected.win_rate_game_count < 20 ? "Small sample" : `${int(selected.wins)} wins`}
            />
            <Kpi label="Player-hours" value={`${hoursLabel(durationHours)}h`} />
            <Kpi label="L-cancel" value={pct(rate(selected.metrics.lCancelSuccess, lCancelAttempts))} delta={`${int(lCancelAttempts)} attempts`} />
            <TournamentTechKpi row={selected} />
            <Kpi label="Inputs / min" value={num(rate(selected.metrics.inputsPerMinuteSum, selected.metrics.inputsPerMinuteSamples), 1)} delta={`${int(selected.metrics.inputsPerMinuteSamples)} games sampled`} />
          </div>

          <div className="grid-2">
            <ExecutionPanel row={selected} moveRow={selectedMoveRow} />
            <StagePanel rows={rollups} characterId={characterId} opponentCharacterId={opponentCharacterId} selectedStageId={stageId} />
          </div>
          <MatchupPanel rows={rollups} characterId={characterId} selectedOpponentId={opponentCharacterId} selectedStageId={stageId} format={format} />
          <MovePanel row={selected} />
        </>
      )}

      <ForecastPanel forecasts={forecasts} selectedId={forecastId} onSelect={setForecastId} />
      <SourcesPanel catalog={catalog} selectedEvent={selectedEvent} selectedSeries={selectedSeries} seriesEditions={seriesEditions} population={population} />
    </>
  );
}

function ArchiveUnavailable({ message }: { message: string }) {
  return (
    <div className="panel ta-unavailable" role="status">
      <h2>Tournament archive</h2>
      <p>{message}</p>
      <div className="hint">Your local replay dashboard is unaffected; this public view requires a published archive snapshot.</div>
    </div>
  );
}

function TournamentTechKpi({ row }: { row: ArchiveRollup }) {
  const metrics = row.metrics;
  const successful = metrics.techInPlace + metrics.techToward + metrics.techAway;
  const attempts = successful + metrics.techMissed;
  const split = [metrics.techInPlace, metrics.techToward, metrics.techAway]
    .map((value) => pct(rate(value, successful), 0))
    .join(" / ");
  return (
    <div className="kpi tech-kpi">
      <div className="label">Ground tech success</div>
      <div className="value">{pct(rate(successful, attempts))}</div>
      <div className="tech-kpi-split" title="Share of successful ground techs: in-place / in / away">
        In-place / in / away: {split}
      </div>
      <div className="delta">{int(attempts)} opportunities</div>
    </div>
  );
}

function ExecutionPanel({ row, moveRow }: { row: ArchiveRollup; moveRow: ArchiveRollup | null }) {
  const metrics = row.metrics;
  const moveDamageTotal = moveRow?.metrics.damageTotal ?? metrics.damageTotal;
  const topDamageMoves = (moveRow ? groupedMoves(moveRow.metrics, moveRow.game_count) : [])
    .filter((move) => move.damage > 0)
    .sort((a, b) => b.damage - a.damage || a.label.localeCompare(b.label))
    .slice(0, 4);
  return (
    <section className="panel">
      <h2>Execution</h2>
      <dl className="ta-stat-list">
        <div><dt>Openings / kill</dt><dd>{num(rate(metrics.openingsPerKillSum, metrics.openingsPerKillSamples), 2)}</dd></div>
        <div><dt>Damage / opening</dt><dd>{num(rate(metrics.damagePerOpeningSum, metrics.damagePerOpeningSamples), 1)}</dd></div>
        <div><dt>Damage / game</dt><dd>{num(rate(metrics.damageTotal, row.game_count), 1)}</dd></div>
        <div><dt>Neutral wins / game</dt><dd>{num(rate(metrics.neutralWins, row.game_count), 2)}</dd></div>
        <div><dt>Wall-tech success</dt><dd>{pct(rate(metrics.wallTechSuccess ?? 0, (metrics.wallTechSuccess ?? 0) + (metrics.wallTechMissed ?? 0)))}</dd></div>
      </dl>
      <h3 className="ta-mini-heading">Top moves by damage share</h3>
      {topDamageMoves.length ? <div className="ta-damage-moves" aria-label="Top four moves by damage share">
        {topDamageMoves.map((move, index) => {
          const share = rate(move.damage, moveDamageTotal);
          return <div key={move.key}>
            <span>{index + 1}. {move.label}</span>
            <div><i style={{ width: `${(share ?? 0) * 100}%` }} /></div>
            <b>{pct(share, 1)}</b>
          </div>
        })}
      </div> : <div className="ta-panel-empty">Choose a character to rank moves by damage share.</div>}
      <div className="hint">
        Damage share is each move group's portion of recorded damage
        {moveRow && (row.opponent_character_id !== null || row.stage_id !== null)
          ? " for this character across all opponents and legal stages; fine-grained archive rows do not retain move tables."
          : " in the selected character sample."}
      </div>
    </section>
  );
}

function StagePanel({ rows, characterId, opponentCharacterId, selectedStageId }: {
  rows: ArchiveRollup[];
  characterId: number | null;
  opponentCharacterId: number | null;
  selectedStageId: number | null;
}) {
  const stages = characterId === null ? [] : rows
    .filter((row) => row.character_id === characterId && row.opponent_character_id === opponentCharacterId && row.stage_id !== null)
    .sort((a, b) => b.game_count - a.game_count);
  return (
    <section className="panel">
      <h2>Stages</h2>
      {stages.length ? <div className="ta-rate-list">{stages.map((row) => {
        const winRate = rate(row.wins, row.win_rate_game_count);
        return <div key={row.stage_id} className={row.stage_id === selectedStageId ? "selected" : ""}><span>{stageName(row.stage_id!)}</span><div><i style={{ width: `${(winRate ?? 0) * 100}%`, background: winRateColor(winRate) }} /></div><b>{pct(winRate)}</b><small>{int(row.win_rate_game_count)} games</small></div>;
      })}</div> : <div className="ta-panel-empty">Select a character to compare legal stages.</div>}
    </section>
  );
}

function MatchupPanel({ rows, characterId, selectedOpponentId, selectedStageId, format }: {
  rows: ArchiveRollup[];
  characterId: number | null;
  selectedOpponentId: number | null;
  selectedStageId: number | null;
  format: ArchiveFormat;
}) {
  type SortKey = "character" | "games" | "winRate";
  type SortDirection = "asc" | "desc";
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "games", direction: "desc" });
  const matchups = useMemo(() => {
    const filtered = characterId === null || format === "doubles" ? [] : rows
      .filter((row) => row.character_id === characterId && row.opponent_character_id !== null && row.stage_id === selectedStageId)
      .filter((row) => selectedOpponentId === null || row.opponent_character_id === selectedOpponentId);
    const direction = sort.direction === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      let comparison: number;
      if (sort.key === "character") comparison = charName(a.opponent_character_id!).localeCompare(charName(b.opponent_character_id!));
      else if (sort.key === "winRate") comparison = (rate(a.wins, a.win_rate_game_count) ?? -1) - (rate(b.wins, b.win_rate_game_count) ?? -1);
      else comparison = a.game_count - b.game_count;
      return comparison !== 0
        ? direction * comparison
        : b.game_count - a.game_count || charName(a.opponent_character_id!).localeCompare(charName(b.opponent_character_id!));
    });
  }, [characterId, format, rows, selectedOpponentId, selectedStageId, sort]);
  const sortableHeader = (key: SortKey, label: string, data = false) => {
    const active = sort.key === key;
    return <th className={`ta-sortable${data ? " data" : ""}${active ? " active" : ""}`} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => setSort((previous) => previous.key === key ? { key, direction: previous.direction === "asc" ? "desc" : "asc" } : { key, direction: key === "character" ? "asc" : "desc" })}>{label}<span aria-hidden="true">{active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}</span></button></th>;
  };
  return (
    <section className="panel">
      <h2>Matchups</h2>
      {matchups.length ? <div className="table-scroll"><table><thead><tr>{sortableHeader("character", "Opponent")}{sortableHeader("games", "Games", true)}<th className="data">Record</th>{sortableHeader("winRate", "Win rate", true)}<th className="data">Damage / game</th><th className="data">L-cancel</th></tr></thead><tbody>{matchups.map((row) => {
        const decided = row.win_rate_game_count;
        const winRate = rate(row.wins, decided);
        const attempts = row.metrics.lCancelSuccess + row.metrics.lCancelFail;
        return <tr key={row.rollup_key} className={decided < 20 ? "ta-low-sample" : ""}><td>{charName(row.opponent_character_id!)}</td><td className="data">{int(row.game_count)}</td><td className="data">{row.wins}–{Math.max(0, decided - row.wins)}</td><td className="data"><span className="ta-winrate" style={{ color: winRateColor(winRate) }}>{pct(winRate)}</span>{decided < 20 && <span className="sample-note">small sample</span>}</td><td className="data">{num(rate(row.metrics.damageTotal, row.game_count), 1)}</td><td className="data">{pct(rate(row.metrics.lCancelSuccess, attempts))}</td></tr>;
      })}</tbody></table></div> : <div className="ta-panel-empty">{format === "doubles" ? "Character head-to-head rows are available for singles only." : "Select a character to explore its matchups."}</div>}
    </section>
  );
}

function MovePanel({ row }: { row: ArchiveRollup }) {
  const moves = groupedMoves(row.metrics, row.game_count);
  const attempts = moves.reduce((sum, move) => sum + move.attempts, 0);
  return (
    <section className="panel">
      <h2>Move usage</h2>
      {moves.length ? <div className="table-scroll"><table><thead><tr><th>Move</th><th className="data">Uses / game</th><th className="data">Usage share</th><th className="data">Hit rate</th><th className="data">Damage share</th><th className="data">Kills</th><th className="data">Avg kill %</th></tr></thead><tbody>{moves.map((move) => <tr key={move.key}><td>{move.label}</td><td className="data">{num(rate(move.attempts, row.game_count), 2)}</td><td className="data">{pct(rate(move.attempts, attempts))}</td><td className="data">{pct(rate(move.landed, move.attempts))}</td><td className="data">{pct(rate(move.damage, row.metrics.damageTotal))}</td><td className="data">{int(move.kills)}</td><td className="data">{move.kills ? `${num(move.killPctSum / move.kills, 0)}%` : "—"}</td></tr>)}</tbody></table></div> : <div className="ta-panel-empty">Choose a specific character to inspect its move distribution.</div>}
      <div className="hint">Usage share is each move group's portion of recorded attack attempts, not its share of time.</div>
    </section>
  );
}

function ForecastPanel({ forecasts, selectedId, onSelect }: { forecasts: ArchiveForecast[]; selectedId: string; onSelect: (id: string) => void }) {
  if (!forecasts.length) return (
    <section className="panel ta-forecast">
      <h2>Predictions</h2>
      <div className="ta-panel-empty">No tournament forecast is currently published.</div>
      <div className="hint">Predictions will appear only after an entrant list and bracket have been reviewed.</div>
    </section>
  );
  const forecast = forecasts.find((item) => item.id === selectedId) ?? forecasts[0]!;
  return (
    <section className="panel ta-forecast">
      <div className="panel-heading-row"><div><h2>Predictions</h2><p>Experimental estimates from historical tournament results.</p></div>{forecasts.length > 1 && <label>Event<select value={forecast.id} onChange={(event) => onSelect(event.target.value)}>{forecasts.map((item) => <option key={item.id} value={item.id}>{item.canonical_name} · {shortDate(item.start_date)}</option>)}</select></label>}</div>
      <div className="ta-forecast-meta"><b>{forecast.canonical_name}</b><span>{shortDate(forecast.start_date)}</span><span>Data through {shortDate(forecast.data_cutoff)}</span></div>
      <div className="table-scroll"><table><thead><tr><th>Player</th><th className="data">Seed</th><th className="data">Win event</th><th className="data">Top 8</th><th className="data">Confidence</th></tr></thead><tbody>{forecast.players.slice(0, 12).map((entry) => <tr key={entry.player_id}><td>{entry.player.display_name}</td><td className="data">{entry.seed ?? "—"}</td><td className="data">{pct(entry.title_probability)}{entry.interval_low !== null && entry.interval_high !== null && <span className="sample-note">{pct(entry.interval_low, 0)}–{pct(entry.interval_high, 0)}</span>}</td><td className="data">{pct(entry.top_8_probability)}</td><td className="data"><span className={`ta-confidence ${entry.confidence}`}>{entry.confidence}</span></td></tr>)}</tbody></table></div>
      <div className="hint">Probabilities are uncertain estimates, not picks or guarantees. Entrants and brackets can change after the listed data cutoff.</div>
      <div className="ta-source-links"><a href={forecast.entrant_source_url} target="_blank" rel="noreferrer">Entrants</a>{forecast.bracket_source_url && <a href={forecast.bracket_source_url} target="_blank" rel="noreferrer">Bracket</a>}</div>
    </section>
  );
}

function SourcesPanel({ catalog, selectedEvent, selectedSeries, seriesEditions, population }: {
  catalog: ArchiveCatalog;
  selectedEvent: ArchiveTournament | null;
  selectedSeries: ArchiveCatalog["series"][number] | null;
  seriesEditions: ArchiveTournament[];
  population: ArchivePopulation;
}) {
  const dataset = catalog.dataset!;
  const eventSources = selectedEvent ? [selectedEvent] : seriesEditions;
  const linkedEvents = eventSources.filter((event) => event.event_source_url && event.source_confidence !== "unverified");
  return (
    <section className="panel ta-sources">
      <h2>Sources</h2>
      <ul>
        <li><a href={dataset.source_url} target="_blank" rel="noreferrer">{dataset.source_label}</a> — public replay archive</li>
        <li><a href="https://liquipedia.net/smash/SSBMRank" target="_blank" rel="noreferrer">Liquipedia rankings and player pages</a> — player roster and rankings, available under <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noreferrer">CC BY-SA 3.0</a></li>
        {selectedSeries?.source_url && <li><a href={selectedSeries.source_url} target="_blank" rel="noreferrer">{selectedSeries.canonical_name}</a> — tournament-series reference</li>}
        {linkedEvents.map((event) => <li key={event.id}><a href={event.event_source_url!} target="_blank" rel="noreferrer">{tournamentLabel(event)}</a>{event.event_source_label ? ` — ${event.event_source_label}` : ""}</li>)}
      </ul>
      <div className="hint">
        Derived statistics from {int(dataset.parsed_replay_count)} parsed replay files, snapshot {shortDate(dataset.data_as_of)}.
        The {population === "broad" ? "venue" : "tournament"} benchmark is selected. Raw .slp files, local paths,
        unresolved identities, and private connect codes are not included in this public dataset. Event years come from
        the cited event references rather than replay-system clocks.
      </div>
    </section>
  );
}
