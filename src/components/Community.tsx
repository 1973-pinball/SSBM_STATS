import { useEffect, useMemo, useState } from "react";
import type { ResolvedGame } from "../lib/types";
import {
  COMMUNITY_MIN_CONTRIBUTORS,
  COMMUNITY_MIN_PLAYERS,
  COMMUNITY_MIN_GAMES,
  demoCommunitySnapshot,
  fetchCommunitySnapshot,
  type CommunitySnapshot,
} from "../lib/community";
import { charName, stageName } from "../lib/melee";
import { num, pct, shortDate } from "../lib/format";
import { INCLUDED_STAGE_IDS } from "../lib/config";
import { moveTabFocus } from "../lib/a11y";
import { fetchArchivePlayerGameCount, fetchLatestArchiveDataset } from "../lib/publicArchive";
import { ArchiveCommunityBenchmark } from "./ArchiveCommunityBenchmark";
import { Kpi } from "./Kpi";
import {
  ArchiveMatchupAtlasComparison,
  ArchiveMoveAtlasComparison,
  ArchiveStageAtlasComparison,
} from "./CommunityArchiveAtlas";

type CommunityView = "atlas" | "benchmarks";

const VIEWS: { id: CommunityView; label: string }[] = [
  { id: "atlas", label: "Atlas" },
  { id: "benchmarks", label: "You vs Community" },
];

const gameTypes = ["all", "ranked", "unranked", "direct", "offline"];
const DEFAULT_GAMES_LOOKBACK = 150;

const EMPTY_COMMUNITY_SNAPSHOT: CommunitySnapshot = {
  refreshedAt: "",
  contributorCount: 0,
  playerGameCount: 0,
  minContributors: COMMUNITY_MIN_CONTRIBUTORS,
  minPlayers: COMMUNITY_MIN_PLAYERS,
  minGames: COMMUNITY_MIN_GAMES,
  matchups: [],
  characterStages: [],
  benchmarks: [],
  moves: [],
  execution: [],
  months: [],
  characters: [],
  stages: [],
};

interface Props {
  games: ResolvedGame[];
  isDemo: boolean;
  onOpenAccount: () => void;
}

const selectCharacters = (snapshot: CommunitySnapshot): number[] =>
  snapshot.characters.map((c) => c.characterId).sort((a, b) => charName(a).localeCompare(charName(b)));

export function Community({ games, isDemo, onOpenAccount }: Props) {
  const [view, setView] = useState<CommunityView>("atlas");
  const [lookbackInput, setLookbackInput] = useState(String(DEFAULT_GAMES_LOOKBACK));
  const [snapshot, setSnapshot] = useState<CommunitySnapshot | null>(null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);
  const [archivePlayerGames, setArchivePlayerGames] = useState<number | null>(null);
  const [archiveGames, setArchiveGames] = useState<number | null>(null);
  const demo = useMemo(() => demoCommunitySnapshot(games), [games]);

  useEffect(() => {
    if (isDemo) {
      setSnapshot(demo);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    void fetchCommunitySnapshot()
      .then((next) => { if (alive) setSnapshot(next); })
      .catch(() => { if (alive) setError("Community data is temporarily unavailable."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [demo, isDemo]);

  useEffect(() => {
    let alive = true;
    void fetchLatestArchiveDataset()
      .then(async (dataset) => dataset
        ? { games: dataset.broad_game_count, playerGames: await fetchArchivePlayerGameCount(dataset.id) }
        : null)
      .then((counts) => {
        if (!alive || counts === null) return;
        setArchiveGames(counts.games);
        setArchivePlayerGames(counts.playerGames);
      })
      .catch(() => { /* The Community views remain usable without archive totals. */ });
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="empty-note">Loading anonymous community aggregates…</div>;

  // Demo data is derived synchronously, so use it on the first render instead
  // of mounting placeholder controls that would retain their empty selection.
  const displaySnapshot = snapshot ?? (isDemo ? demo : EMPTY_COMMUNITY_SNAPSHOT);
  const hasSnapshot = snapshot !== null || isDemo;
  const overallBenchmark = displaySnapshot.benchmarks.find((row) => row.characterId === -1);
  const nextMilestone = displaySnapshot.contributorCount < 25
    ? 25
    : displaySnapshot.contributorCount < 100
      ? 100
      : Math.ceil((displaySnapshot.contributorCount + 1) / 100) * 100;
  const progress = Math.min(100, (displaySnapshot.contributorCount / nextMilestone) * 100);
  const lookbackGames = normalizeGamesLookback(lookbackInput);
  const lookback = {
    lookbackGames,
    lookbackInput,
    onLookbackInputChange: setLookbackInput,
  };

  return (
    <>
      <div className="panel community-warmup community-preview-progress">
          <div className="eyebrow">Community Lab · SSBM Stats growth</div>
          <h2>See the community sample grow</h2>
          <p>
            Each SSBM Stats breakdown needs at least {displaySnapshot.minPlayers} unique players and {displaySnapshot.minGames} distinct games,
            including opponents. Players are identified by connect code; contributor counts are informational.
            Opt-in contributions and the historical tournament archive remain separate comparison samples.
            {" "}Each unique contributed singles game supplies two player samples, one for each character.
            Duplicate uploads count once; opponents do not increase the contributor count.
          </p>
          <div
            className="community-progress"
            aria-label={`${displaySnapshot.contributorCount} of ${nextMilestone} contributors toward the next milestone`}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="community-progress-footer">
            <div className="community-progress-label">
              <b>{hasSnapshot ? displaySnapshot.contributorCount.toLocaleString() : "—"}</b> / {nextMilestone.toLocaleString()} SSBM Stats users toward the next milestone ·{" "}
              <b>{hasSnapshot ? displaySnapshot.playerGameCount.toLocaleString() : "—"}</b> opt-in player-games ·{" "}
              <b>{archiveGames === null ? "—" : archiveGames.toLocaleString()}</b> historical games
              {archivePlayerGames === null ? null : <> ({archivePlayerGames.toLocaleString()} player-games)</>}
            </div>
            <button className="primary" onClick={onOpenAccount}>Review contribution settings</button>
          </div>
          {error && <div className="error-note" role="alert">{error}</div>}
      </div>

      {overallBenchmark && <section className="panel" aria-label="SSBM Stats overall benchmarks">
        <h2>SSBM Stats · all characters</h2>
        <p className="hint">
          Published medians across {overallBenchmark.contributors.toLocaleString()} contributors · all opponents and all history ·
          approximately {overallBenchmark.games.toLocaleString()} player samples · updated {shortDate(displaySnapshot.refreshedAt)}.
          Each contributor has equal weight. {overallBenchmark.players === undefined ? "" : `Approximately ${overallBenchmark.players.toLocaleString()} unique players are represented. `}
          Character and matchup breakdowns qualify separately.
        </p>
        <div className="kpi-strip">
          <Kpi label="L-cancel success" value={pct(overallBenchmark.lCancel === null ? null : overallBenchmark.lCancel.p50 / 100)} />
          <Kpi label="Openings / kill" value={num(overallBenchmark.openingsPerKill?.p50 ?? null)} />
          <Kpi label="Damage / opening" value={num(overallBenchmark.damagePerOpening?.p50 ?? null)} />
          <Kpi label="Inputs / min" value={num(overallBenchmark.inputsPerMinute?.p50 ?? null)} />
        </div>
      </section>}

      <div className="tabs community-tabs" role="tablist" aria-label="Community views">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            role="tab"
            tabIndex={view === item.id ? 0 : -1}
            aria-selected={view === item.id}
            className={view === item.id ? "active" : ""}
            onKeyDown={moveTabFocus}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === "atlas" && <>
        <MatchupAtlas snapshot={displaySnapshot} games={games} {...lookback} />
        <StageLab snapshot={displaySnapshot} games={games} {...lookback} />
        <MoveAtlas snapshot={displaySnapshot} games={games} {...lookback} />
      </>}
      {view === "benchmarks" && <CommunityBenchmarks snapshot={displaySnapshot} games={games} {...lookback} />}
    </>
  );
}

interface LookbackProps {
  lookbackGames: number;
  lookbackInput: string;
  onLookbackInputChange: (value: string) => void;
}

function normalizeGamesLookback(input: string): number {
  const value = Number(input);
  return input.trim() !== "" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : DEFAULT_GAMES_LOOKBACK;
}

function GamesLookbackInput({ lookbackGames, lookbackInput, onLookbackInputChange }: LookbackProps) {
  return (
    <label>
      My games lookback
      <span className="number-suffix unitless">
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={lookbackInput}
          onChange={(event) => onLookbackInputChange(event.target.value)}
          onBlur={() => onLookbackInputChange(String(lookbackGames))}
        />
      </span>
    </label>
  );
}

const allHistory = <T extends { lookbackDays: unknown }>(row: T): boolean => row.lookbackDays === null;
const recentGames = (games: ResolvedGame[], count: number): ResolvedGame[] => games.slice(-count);

const mostPlayedCharacter = (games: ResolvedGame[]): number | null => {
  const counts = new Map<number, number>();
  for (const game of games) counts.set(game.me.characterId, (counts.get(game.me.characterId) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || charName(a[0]).localeCompare(charName(b[0])))[0]?.[0] ?? null;
};

const defaultCharacter = (games: ResolvedGame[], available: number[]): number => {
  const mostPlayed = mostPlayedCharacter(games);
  return mostPlayed !== null && available.includes(mostPlayed) ? mostPlayed : available[0] ?? -1;
};

function MatchupAtlas({ snapshot, games, ...lookback }: { snapshot: CommunitySnapshot; games: ResolvedGame[] } & LookbackProps) {
  const communityRows = snapshot.matchups.filter(allHistory);
  const chars = [...new Set([
    ...communityRows.map((row) => row.characterId),
    ...games.map((game) => game.me.characterId),
  ])]
    .sort((a, b) => charName(a).localeCompare(charName(b)));
  const preferredCharacterId = defaultCharacter(games, chars);
  const [characterId, setCharacterId] = useState(preferredCharacterId);
  const selectedCharacterId = chars.includes(characterId) ? characterId : preferredCharacterId;
  const [stageId, setStageId] = useState(0);
  const [gameType, setGameType] = useState("all");
  const rows = communityRows
    .filter((r) => r.characterId === selectedCharacterId && r.stageId === stageId && r.gameType === gameType)
    .sort((a, b) => b.games - a.games);
  if (selectedCharacterId < 0) return <div className="panel empty-note">Choose a character to compare matchup samples.</div>;
  return <ArchiveMatchupAtlasComparison
    games={games}
    characterId={selectedCharacterId}
    stageId={stageId}
    gameType={gameType}
    lookbackGames={lookback.lookbackGames}
    communityRows={rows}
    onCharacterChange={setCharacterId}
    controls={<>
      <label>Character<select value={selectedCharacterId} onChange={(event) => setCharacterId(Number(event.target.value))}>{chars.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
      <label>Stage<select value={stageId} onChange={(event) => setStageId(Number(event.target.value))}><option value={0}>All legal stages</option>{INCLUDED_STAGE_IDS.map((id) => <option key={id} value={id}>{stageName(id)}</option>)}</select></label>
      <label>Mode<select value={gameType} onChange={(event) => setGameType(event.target.value)}>{gameTypes.map((mode) => <option key={mode} value={mode}>{mode === "all" ? "All modes" : mode}</option>)}</select></label>
      <GamesLookbackInput {...lookback} />
    </>}
  />;
}

function CommunityBenchmarks({ snapshot, games, ...lookback }: { snapshot: CommunitySnapshot; games: ResolvedGame[] } & LookbackProps) {
  const chars = useMemo(() => {
    const ids = new Set(selectCharacters(snapshot));
    for (const game of games) ids.add(game.me.characterId);
    return [...ids].sort((a, b) => charName(a).localeCompare(charName(b)));
  }, [games, snapshot]);
  const preferredCharacterId = defaultCharacter(games, chars);
  const [characterId, setCharacterId] = useState(preferredCharacterId);
  const selectedCharacterId = chars.includes(characterId) ? characterId : preferredCharacterId;
  const row = snapshot.benchmarks.find((item) => item.characterId === selectedCharacterId);
  const communityExecution = snapshot.execution.find((item) => item.lookbackDays === null && item.characterId === selectedCharacterId);
  const communityCharacter = snapshot.characters.find((item) => item.characterId === selectedCharacterId);
  const communityMoves = snapshot.moves.filter((move) => move.lookbackDays === null && move.characterId === selectedCharacterId);
  const selected = useMemo(
    () => {
      const matching = games.filter((game) => game.me.characterId === selectedCharacterId);
      return recentGames(matching, lookback.lookbackGames);
    },
    [games, lookback.lookbackGames, selectedCharacterId],
  );
  return <ArchiveCommunityBenchmark
    games={selected}
    characterId={selectedCharacterId < 0 ? null : selectedCharacterId}
    communityMoves={communityMoves}
    communityBenchmark={row}
    communityExecution={communityExecution}
    communityCharacter={communityCharacter}
    controls={<>
      <label>Character<select value={selectedCharacterId} onChange={(event) => setCharacterId(Number(event.target.value))}>{chars.length === 0 && <option value={-1}>—</option>}{chars.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
      <GamesLookbackInput {...lookback} />
    </>}
    onCharacterChange={setCharacterId}
  />;
}

function MoveAtlas({ snapshot, games, ...lookback }: { snapshot: CommunitySnapshot; games: ResolvedGame[] } & LookbackProps) {
  const communityMoves = snapshot.moves.filter(allHistory);
  const communityExecution = snapshot.execution.filter(allHistory);
  const chars = [...new Set([
    ...communityMoves.map((m) => m.characterId),
    ...communityExecution.filter((r) => r.characterId !== -1).map((r) => r.characterId),
    ...games.map((game) => game.me.characterId),
  ])].sort((a, b) => charName(a).localeCompare(charName(b)));
  const preferredCharacterId = defaultCharacter(games, chars);
  const [characterId, setCharacterId] = useState(preferredCharacterId);
  const selectedCharacterId = chars.includes(characterId) ? characterId : preferredCharacterId;
  const rows = communityMoves.filter((m) => m.characterId === selectedCharacterId).sort((a, b) => b.damage - a.damage);
  const execution = communityExecution.find((row) => row.characterId === selectedCharacterId);
  const benchmark = snapshot.benchmarks.find((row) => row.characterId === selectedCharacterId);
  if (selectedCharacterId < 0) return <div className="panel empty-note">Choose a character to compare move samples.</div>;
  return <ArchiveMoveAtlasComparison
    games={games}
    characterId={selectedCharacterId}
    lookbackGames={lookback.lookbackGames}
    communityRows={rows}
    communityExecution={execution}
    communityBenchmark={benchmark}
    onCharacterChange={setCharacterId}
    controls={<>
      <label>Character<select value={selectedCharacterId} onChange={(event) => setCharacterId(Number(event.target.value))}>{chars.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
      <GamesLookbackInput {...lookback} />
    </>}
  />;
}

function StageLab({ snapshot, games, ...lookback }: { snapshot: CommunitySnapshot; games: ResolvedGame[] } & LookbackProps) {
  const overall = snapshot.matchups.filter((r) => allHistory(r) && r.stageId === 0 && r.gameType === "all").sort((a, b) => b.games - a.games);
  const characterStages = snapshot.characterStages.filter((r) => allHistory(r) && r.gameType === "all");
  const chars = [...new Set([
    ...overall.map((row) => row.characterId),
    ...characterStages.map((row) => row.characterId),
    ...games.map((game) => game.me.characterId),
  ])]
    .sort((a, b) => charName(a).localeCompare(charName(b)));
  const preferredCharacterId = defaultCharacter(games, chars);
  const [characterId, setCharacterId] = useState(preferredCharacterId);
  const selectedCharacterId = chars.includes(characterId) ? characterId : preferredCharacterId;
  const localGames = recentGames(games.filter((game) => game.me.characterId === selectedCharacterId), lookback.lookbackGames);
  const communityOpponents = overall.filter((r) => r.characterId === selectedCharacterId);
  const opponentIds = [...new Set([
    ...communityOpponents.map((row) => row.opponentCharacterId),
    ...localGames.filter((game) => game.me.characterId === selectedCharacterId).map((game) => game.opp.characterId),
  ])].sort((a, b) => charName(a).localeCompare(charName(b)));
  const [opponentId, setOpponentId] = useState<number | null>(null);
  const selectedOpponentId = opponentId === null || opponentIds.includes(opponentId)
    ? opponentId
    : null;
  const rows = snapshot.matchups.filter((r) => allHistory(r)
    && r.characterId === selectedCharacterId
    && (selectedOpponentId === null || r.opponentCharacterId === selectedOpponentId)
    && r.stageId !== 0
    && r.gameType === "all");
  if (selectedCharacterId < 0) return <div className="panel empty-note">Choose a character to compare stage samples.</div>;
  return <ArchiveStageAtlasComparison
    games={games}
    characterId={selectedCharacterId}
    opponentId={selectedOpponentId}
    lookbackGames={lookback.lookbackGames}
    communityRows={rows}
    communityCharacterStages={characterStages.filter((r) => r.characterId === selectedCharacterId)}
    onCharacterChange={(id) => {
      setCharacterId(id);
      if (selectedOpponentId === null) return;
      const nextCommunity = overall.find((row) => row.characterId === id)?.opponentCharacterId;
      const nextLocal = localGames.find((game) => game.me.characterId === id)?.opp.characterId;
      setOpponentId(nextCommunity ?? nextLocal ?? null);
    }}
    controls={<>
      <label>Character<select value={selectedCharacterId} onChange={(event) => { const id = Number(event.target.value); setCharacterId(id); if (selectedOpponentId === null) return; const nextCommunity = overall.find((row) => row.characterId === id)?.opponentCharacterId; const nextLocal = localGames.find((game) => game.me.characterId === id)?.opp.characterId; setOpponentId(nextCommunity ?? nextLocal ?? null); }}>{chars.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
      <label>Opponent<select value={selectedOpponentId ?? "all"} onChange={(event) => setOpponentId(event.target.value === "all" ? null : Number(event.target.value))}><option value="all">All opponents</option>{opponentIds.map((id) => <option key={id} value={id}>{charName(id)}</option>)}</select></label>
      <GamesLookbackInput {...lookback} />
    </>}
  />;
}
