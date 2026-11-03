import type { Account, Filters, GameType, ResolvedGame, ResolvedTeamGame } from "../lib/types";
import { charName, stageName } from "../lib/melee";
import { useMemo, useState } from "react";
import { DEFAULT_FILTERS, accountLabel } from "../lib/types";
import { customRangeError, localDay } from "../lib/stats";
import { shortDate } from "../lib/format";

interface Props {
  filters: Filters;
  setFilters: (f: Filters) => void;
  games: ResolvedGame[]; // unfiltered, for option lists
  teamGames: ResolvedTeamGame[];
  hasTeamGames: boolean;
  accounts: Account[];
  cpuGameCount: number;
}

const GAME_TYPES: readonly GameType[] = ["ranked", "unranked", "direct", "offline", "unknown"];

const modeLabel = (mode: GameType) => `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;

function modeSummary(modes: GameType[] | null): string {
  if (modes === null) return "All modes";
  const excluded = GAME_TYPES.filter((mode) => !modes.includes(mode));
  if (excluded.length === 1) return `All except ${modeLabel(excluded[0]!)}`;
  if (modes.length === 1) return modeLabel(modes[0]!);
  return `${modes.length} modes`;
}

export function FilterBar({ filters, setFilters, games, teamGames, hasTeamGames, accounts, cpuGameCount }: Props) {
  const isTeams = filters.format === "teams";
  const [mobileOpen, setMobileOpen] = useState(false);

  // Option lists come from whichever format is active — offering "vs Fox" when no
  // 2v2 opponent played Fox would produce an empty dashboard with no explanation.
  const opts = useMemo(() => {
    const myChars = new Set<number>();
    const oppChars = new Set<number>();
    const stages = new Set<number>();
    const oppCodes = new Map<string, number>();
    const mateCodes = new Map<string, number>();
    const dayCounts = new Map<string, number>();
    const myCodes = new Map<string, number>();
    const bumpMine = (code: string | null) => {
      if (code) myCodes.set(code, (myCodes.get(code) ?? 0) + 1);
    };
    const bump = (code: string | null) => {
      if (code) oppCodes.set(code, (oppCodes.get(code) ?? 0) + 1);
    };
    const bumpDay = (d: Date | null) => {
      if (d) {
        const day = localDay(d);
        dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
      }
    };
    if (isTeams) {
      for (const g of teamGames) {
        myChars.add(g.me.characterId);
        stages.add(g.rec.stageId);
        bumpDay(g.date);
        bumpMine(g.me.connectCode);
        if (g.teammate.connectCode) {
          mateCodes.set(g.teammate.connectCode, (mateCodes.get(g.teammate.connectCode) ?? 0) + 1);
        }
        for (const o of g.opps) {
          oppChars.add(o.characterId);
          bump(o.connectCode);
        }
      }
    } else {
      for (const g of games) {
        myChars.add(g.me.characterId);
        oppChars.add(g.opp.characterId);
        stages.add(g.rec.stageId);
        bump(g.opp.connectCode);
        bumpDay(g.date);
        bumpMine(g.me.connectCode);
      }
    }
    const topCodes = (m: Map<string, number>) =>
      Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([c]) => c);
    return {
      myChars: Array.from(myChars).sort((a, b) => a - b),
      oppChars: Array.from(oppChars).sort((a, b) => a - b),
      stages: Array.from(stages).sort((a, b) => a - b),
      codes: topCodes(oppCodes),
      mateCodes: topCodes(mateCodes),
      myCodes,
      // Most recent session first — that's almost always the one being looked up.
      days: Array.from(dayCounts.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, count]) => ({ day, count })),
    };
  }, [games, teamGames, isTeams]);

  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const numOrNull = (v: string) => (v === "" ? null : Number(v));
  const selectedModes = filters.gameTypes ?? GAME_TYPES;
  const selectedModeSummary = modeSummary(filters.gameTypes);
  const toggleMode = (mode: GameType) => {
    const next = filters.gameTypes === null ? [...GAME_TYPES] : [...filters.gameTypes];
    const index = next.indexOf(mode);
    if (index >= 0) next.splice(index, 1);
    else next.push(mode);
    if (next.length === 0) return;
    set({ gameTypes: next.length === GAME_TYPES.length ? null : next });
  };

  const isDefault =
    !filters.includeCpuGames &&
    filters.range === "all" &&
    filters.day === null &&
    filters.accountCode === null &&
    filters.myCharacter === null &&
    filters.oppCharacter === null &&
    filters.stageId === null &&
    filters.opponentCode === null &&
    filters.teammateCode === null &&
    filters.gameTypes === null;

  const rangeLabels: Record<Filters["range"], string> = {
    all: "All time",
    "7d": "Last 7 days",
    "14d": "Last 14 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    "1y": "Last year",
    custom: `${filters.rangeStart ?? "Start"} – ${filters.rangeEnd ?? "End"}`,
  };
  const rangeError = filters.range === "custom" && filters.day === null
    ? customRangeError(filters.rangeStart, filters.rangeEnd) : null;
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (filters.includeCpuGames) activeFilters.push({ key: "cpu", label: "CPU games included", clear: () => set({ includeCpuGames: false }) });
  if (filters.range !== "all") activeFilters.push({ key: "range", label: rangeLabels[filters.range], clear: () => set({ range: "all", rangeStart: null, rangeEnd: null }) });
  if (filters.day) activeFilters.push({ key: "day", label: shortDate(new Date(`${filters.day}T12:00:00`)), clear: () => set({ day: null }) });
  if (filters.accountCode) {
    const account = accounts.find((a) => a.code === filters.accountCode);
    activeFilters.push({ key: "account", label: account ? accountLabel(account) : filters.accountCode, clear: () => set({ accountCode: null }) });
  }
  if (filters.myCharacter !== null) activeFilters.push({ key: "me", label: `Me: ${charName(filters.myCharacter)}`, clear: () => set({ myCharacter: null }) });
  if (filters.oppCharacter !== null) activeFilters.push({ key: "vs", label: `Vs: ${charName(filters.oppCharacter)}`, clear: () => set({ oppCharacter: null }) });
  if (filters.stageId !== null) activeFilters.push({ key: "stage", label: stageName(filters.stageId), clear: () => set({ stageId: null }) });
  if (filters.teammateCode) activeFilters.push({ key: "teammate", label: `With: ${filters.teammateCode}`, clear: () => set({ teammateCode: null }) });
  if (filters.opponentCode) activeFilters.push({ key: "opponent", label: `Opponent: ${filters.opponentCode}`, clear: () => set({ opponentCode: null }) });
  if (filters.gameTypes !== null) activeFilters.push({ key: "mode", label: selectedModeSummary, clear: () => set({ gameTypes: null }) });

  return (
    <div className={`filters ${mobileOpen ? "open" : ""}`}>
      <div className="filter-mobile-summary">
        <button
          className="filter-toggle"
          aria-expanded={mobileOpen}
          aria-controls="dashboard-filter-fields"
          onClick={() => setMobileOpen((v) => !v)}
        >
          Filters{activeFilters.length ? ` (${activeFilters.length})` : ""}
          <span aria-hidden="true">{mobileOpen ? "▲" : "▼"}</span>
        </button>
        <span className="filter-format-label">{isTeams ? "Teams · 2v2" : "Singles · 1v1"}</span>
      </div>
      <div className="filter-fields" id="dashboard-filter-fields">
      {(cpuGameCount > 0 || filters.includeCpuGames) && (
        <label title="Only games explicitly marked CPU are excluded. Games with unknown CPU status stay included.">
          CPU games
          <select value={filters.includeCpuGames ? "include" : "exclude"} onChange={(e) => set({ includeCpuGames: e.target.value === "include" })}>
            <option value="exclude">Exclude confirmed ({cpuGameCount.toLocaleString()})</option>
            <option value="include">Include confirmed</option>
          </select>
        </label>
      )}
      {hasTeamGames && (
        <label>
          Format
          {/* Separate axis from Mode: a 2v2 is also ranked/direct/offline. Switching
              format clears the other filters, whose option lists don't carry over. */}
          <select
            value={filters.format}
            onChange={(e) => setFilters({ ...DEFAULT_FILTERS, format: e.target.value as Filters["format"], range: filters.range, rangeStart: filters.rangeStart, rangeEnd: filters.rangeEnd })}
          >
            <option value="singles">Singles (1v1)</option>
            <option value="teams">Teams (2v2)</option>
          </select>
        </label>
      )}
      {/* Only worth a control once there's more than one account to split. */}
      {accounts.length > 1 && (
        <label>
          Account
          <select value={filters.accountCode ?? ""} onChange={(e) => set({ accountCode: e.target.value || null })}>
            <option value="">All accounts</option>
            {accounts.map((a) => {
              const n = opts.myCodes.get(a.code) ?? 0;
              return (
                <option key={a.code} value={a.code}>
                  {accountLabel(a)}
                  {n > 0 ? ` — ${n.toLocaleString()}` : " — none here"}
                </option>
              );
            })}
          </select>
        </label>
      )}
      <label>
        Range
        {/* Disabled while a specific day is picked — the day wins (see applyFilters). */}
        <select
          value={filters.range}
          disabled={filters.day !== null}
          onChange={(e) => {
            const range = e.target.value as Filters["range"];
            set(range === "custom" ? {
              range,
              rangeStart: filters.rangeStart ?? opts.days.at(-1)?.day ?? localDay(new Date()),
              rangeEnd: filters.rangeEnd ?? opts.days[0]?.day ?? localDay(new Date()),
            } : { range });
          }}
        >
          <option value="all">All time</option>
          <option value="7d">Last 7 days</option>
          <option value="14d">Last 14 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="1y">Last year</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {filters.range === "custom" && <>
        <label>
          From
          <input
            type="date"
            aria-label="Start date"
            value={filters.rangeStart ?? ""}
            max={filters.rangeEnd ?? undefined}
            disabled={filters.day !== null}
            aria-invalid={Boolean(rangeError)}
            aria-describedby={rangeError ? "custom-range-error" : undefined}
            onChange={(e) => set({ rangeStart: e.target.value || null })}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            aria-label="End date"
            value={filters.rangeEnd ?? ""}
            min={filters.rangeStart ?? undefined}
            disabled={filters.day !== null}
            aria-invalid={Boolean(rangeError)}
            aria-describedby={rangeError ? "custom-range-error" : undefined}
            onChange={(e) => set({ rangeEnd: e.target.value || null })}
          />
        </label>
        {rangeError && <div className="filter-range-error" id="custom-range-error" role="status">{rangeError}</div>}
      </>}
      <label>
        Day
        <select value={filters.day ?? ""} onChange={(e) => set({ day: e.target.value || null })}>
          <option value="">Any day</option>
          {opts.days.map((d) => (
            <option key={d.day} value={d.day}>
              {shortDate(new Date(`${d.day}T12:00:00`))} ({d.count})
            </option>
          ))}
        </select>
      </label>
      <label>
        Me
        <select value={filters.myCharacter ?? ""} onChange={(e) => set({ myCharacter: numOrNull(e.target.value) })}>
          <option value="">All characters</option>
          {opts.myChars.map((c) => (
            <option key={c} value={c}>
              {charName(c)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {isTeams ? "Vs (either)" : "Vs"}
        <select value={filters.oppCharacter ?? ""} onChange={(e) => set({ oppCharacter: numOrNull(e.target.value) })}>
          <option value="">All characters</option>
          {opts.oppChars.map((c) => (
            <option key={c} value={c}>
              {charName(c)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Stage
        <select value={filters.stageId ?? ""} onChange={(e) => set({ stageId: numOrNull(e.target.value) })}>
          <option value="">All stages</option>
          {opts.stages.map((s) => (
            <option key={s} value={s}>
              {stageName(s)}
            </option>
          ))}
        </select>
      </label>
      {isTeams && (
        <label>
          Teammate
          <select value={filters.teammateCode ?? ""} onChange={(e) => set({ teammateCode: e.target.value || null })}>
            <option value="">Anyone</option>
            {opts.mateCodes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {isTeams ? "Opponent (either)" : "Opponent"}
        <select value={filters.opponentCode ?? ""} onChange={(e) => set({ opponentCode: e.target.value || null })}>
          <option value="">Anyone</option>
          {opts.codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <div className="filter-control">
        <span>Mode</span>
        <details className="mode-picker">
          <summary aria-label={`Modes: ${selectedModeSummary}`}>
            <span>{selectedModeSummary}</span>
            <span className="mode-picker-chevron" aria-hidden="true">▾</span>
          </summary>
          <div className="mode-picker-menu" role="group" aria-label="Game modes">
            <label className="mode-picker-option mode-picker-all">
              <input
                type="checkbox"
                checked={filters.gameTypes === null}
                onChange={() => set({ gameTypes: null })}
              />
              <span>All modes</span>
            </label>
            {GAME_TYPES.map((mode) => {
              const checked = selectedModes.includes(mode);
              return (
                <label className="mode-picker-option" key={mode}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && selectedModes.length === 1}
                    onChange={() => toggleMode(mode)}
                  />
                  <span>{modeLabel(mode)}</span>
                </label>
              );
            })}
          </div>
        </details>
      </div>
      </div>
      {!isDefault && (
        <div className="active-filter-row" aria-label="Active filters">
          <span className="active-filter-label">Active</span>
          {activeFilters.map((item) => (
            <button key={item.key} className="filter-chip" onClick={item.clear} aria-label={`Remove ${item.label} filter`}>
              {item.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button className="clear-filters" onClick={() => setFilters({ ...DEFAULT_FILTERS, format: filters.format })}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
