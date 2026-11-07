/** Offline execution of production archive selectors against independently verified rows. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { dimensionKey } from "./archive-recovery-rollups.mjs";

const groups = [[18, "neutral-b"], [19, "side-b"], [20, "up-b"], [21, "down-b"]];
const usageFields = ["attempts", "attemptGames", "outcomeGames", "hitAttempts", "noHitAttempts", "incompleteAttempts"];
const metrics = [["attemptsPerGame", "attempts"], ["noHitPerGame", "noHitPerGame"], ["noHitRate", "noHitRate"]];
const rowsOf = (rows) => rows instanceof Map ? [...rows.values()] : [...rows];
const globalRow = (row) => row.series_id === null && row.tournament_id === null && row.set_id === null;

// Only the subset of Supabase's read API used by these selectors is exposed.
// Indexes keep the complete 26-character/matchup matrix inexpensive offline.
function localClient(tables) {
  const stores = new Map(Object.entries(tables).map(([table, rows]) => [table,
    { rows: rows.map((row) => ({ ...row, published: true })), indexes: new Map() }]));
  function indexed(store, column, value) {
    let index = store.indexes.get(column);
    if (!index) {
      index = new Map();
      for (const row of store.rows) {
        const list = index.get(row[column]) ?? []; list.push(row); index.set(row[column], list);
      }
      store.indexes.set(column, index);
    }
    return index.get(value) ?? [];
  }
  class Query {
    constructor(store) { this.store = store; this.candidates = store.rows; this.filters = []; this.orders = []; this.start = 0; this.end = Infinity; }
    select(fields) { this.fields = fields === "*" ? null : fields.split(","); return this; }
    eq(column, value) {
      const candidates = indexed(this.store, column, value);
      if (candidates.length < this.candidates.length) this.candidates = candidates;
      this.filters.push((row) => row[column] === value); return this;
    }
    is(column, value) { assert.equal(value, null); return this.eq(column, value); }
    not(column, operator, value) {
      assert.equal(operator, "is"); assert.equal(value, null); this.filters.push((row) => row[column] !== null); return this;
    }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    order(column, options = {}) { this.orders.push([column, options.ascending !== false]); return this; }
    range(start, end) { this.start = start; this.end = end; return this; }
    limit(count) { this.end = this.start + count - 1; return this; }
    response() {
      const selected = this.candidates.filter((row) => this.filters.every((filter) => filter(row)));
      selected.sort((a, b) => {
        for (const [field, ascending] of this.orders) {
          const order = typeof a[field] === "string" ? a[field].localeCompare(b[field]) : a[field] - b[field];
          if (order) return ascending ? order : -order;
        }
        return 0;
      });
      return { data: selected.slice(this.start, this.end + 1).map((row) => this.fields
        ? Object.fromEntries(this.fields.map((field) => [field, row[field]])) : { ...row }), error: null };
    }
    then(resolve, reject) { return Promise.resolve(this.response()).then(resolve, reject); }
    async maybeSingle() { const result = this.response(); assert.ok(result.data.length <= 1); return { ...result, data: result.data[0] ?? null }; }
  }
  return { from(table) { assert.ok(stores.has(table), `unexpected offline table ${table}`); return new Query(stores.get(table)); } };
}

function expectedCommunityAggregate(sources, datasetId, format, population, opponent) {
  if (!sources.length) return null;
  const ordered = [...sources].sort((a, b) => a.rollup_key.localeCompare(b.rollup_key));
  const out = { ...ordered[0], rollup_key: `community-character-aggregate:${datasetId}:${format}:${population}:${opponent ?? "all"}`,
    character_id: null, game_count: 0, win_rate_game_count: 0, wins: 0,
    identified_player_count: null, player_balanced_sample_count: null, metrics: { playerBalanced: null, moves: null, actions: {} } };
  for (const source of ordered) {
    for (const field of ["game_count", "win_rate_game_count", "wins"]) out[field] += source[field];
    for (const [field, value] of Object.entries(source.metrics)) {
      if (typeof value === "number") out.metrics[field] = (out.metrics[field] ?? 0) + value;
    }
    for (const [field, value] of Object.entries(source.metrics.actions)) out.metrics.actions[field] = (out.metrics.actions[field] ?? 0) + value;
    if (source.metrics.moves !== null) out.metrics.moves ??= {};
    for (const [id, move] of Object.entries(source.metrics.moves ?? {})) {
      const target = out.metrics.moves[id] ??= {};
      for (const [field, value] of Object.entries(move)) target[field] = (target[field] ?? 0) + value;
    }
  }
  return out;
}

/** Every expected metric originates in the independent reconstruction, not the selected row. */
export async function verifyRecoverySelectors({ tables, expectedRollups, datasetId }) {
  const expected = rowsOf(expectedRollups).filter(globalRow);
  assert.ok(expected.every((row) => row.dataset_id === datasetId), "selector reference dataset is isolated");
  const adapterKey = `__recoverySelectors_${randomUUID().replaceAll("-", "")}`;
  globalThis[adapterKey] = localClient(tables);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network access is forbidden during recovery selector checks"); };
  let server;
  try {
    server = await createServer({ root: fileURLToPath(new URL("../../", import.meta.url)), configFile: false, envDir: false,
      appType: "custom", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] }, plugins: [{ name: "recovery-offline-selectors", enforce: "pre",
        resolveId(source) { if (source === "@supabase/supabase-js") return "\0recovery-forbidden-supabase-sdk"; },
        load(id) {
          if (id.replaceAll("\\", "/").endsWith("/src/lib/supabase.ts")) return `export const supabase = globalThis.${adapterKey};`;
          if (id === "\0recovery-forbidden-supabase-sdk") throw new Error("Supabase SDK import is forbidden in offline selector validation");
        },
        transform(source, id) {
          if (id.replaceAll("\\", "/").endsWith("/src/components/CommunityArchiveAtlas.tsx")) {
            return `${source}\nexport { formatMoveMetric as recoveryFormatMoveMetric, archiveMoveMetric as recoveryArchiveMoveMetric };`;
          }
          if (id.replaceAll("\\", "/").endsWith("/src/components/Views.tsx")) return `${source}\nexport { MOVE_METRIC_CHOICES as recoveryMetricChoices };`;
        },
      }] });
    const archive = await server.ssrLoadModule("/src/lib/publicArchive.ts");
    const helpers = await server.ssrLoadModule("/src/lib/executionMoveBenchmarks.ts");
    const atlas = await server.ssrLoadModule("/src/components/CommunityArchiveAtlas.tsx");
    const { recoveryMetricChoices } = await server.ssrLoadModule("/src/components/Views.tsx");
    const { num } = await server.ssrLoadModule("/src/lib/format.ts");
    const { CURRENT_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
    const checks = { communitySelections: 0, proSelections: 0, namedSelections: 0, atlasRows: 0,
      metricChecks: 0, absentSelections: 0, zeroValues: 0, unavailableValues: 0, measuredRateChecks: 0, reparseNotices: 0 };

    function check(actual, wanted, label) {
      assert.equal(Boolean(actual), Boolean(wanted), `${label}: exact published sample presence`);
      if (!wanted) checks.absentSelections++;
      else assert.deepEqual({ ...actual, published: false }, wanted, `${label}: exact independently reconstructed selector row`);
      for (const [moveId, key] of groups) {
        const selectedMove = helpers.groupedArchiveMove(actual, key), sourceMove = wanted?.metrics.moves?.[moveId] ?? null;
        assert.equal(Boolean(selectedMove), Boolean(sourceMove), `${label} ${key}: move presence`);
        for (const field of usageFields) assert.equal(selectedMove?.[field], sourceMove?.[field], `${label} ${key}: independent ${field}`);
        for (const [metric, atlasMetric] of metrics) {
          const tracked = (sourceMove?.attemptGames ?? 0) > 0, outcomes = (sourceMove?.outcomeGames ?? 0) > 0
            && ["hitAttempts", "noHitAttempts", "incompleteAttempts"].every((field) => sourceMove[field] !== undefined);
          const completed = outcomes ? sourceMove.hitAttempts + sourceMove.noHitAttempts : 0;
          const value = !wanted || !sourceMove || wanted.game_count <= 0 ? null : metric === "attemptsPerGame"
            ? tracked ? sourceMove.attempts / sourceMove.attemptGames : null
            : outcomes ? metric === "noHitPerGame" ? sourceMove.noHitAttempts / sourceMove.outcomeGames
              : completed > 0 ? sourceMove.noHitAttempts / completed * 100 : null : null;
          assert.equal(helpers.archiveMoveBenchmark(actual, key, metric), value, `${label} ${key}: independent ${metric}`);
          const sample = metric === "attemptsPerGame" ? sourceMove?.attemptGames ?? 0 : sourceMove?.outcomeGames ?? 0;
          assert.equal(helpers.archiveMoveComparisonGames(actual, key, metric), sample, `${label} ${key}: measured comparison sample`);
          const unmeasuredNote = (wanted?.stats_version ?? 0) < CURRENT_STATS_VERSION ? "Archive reparse needed" : "No tracked games";
          const expectedNote = !wanted ? undefined : metric === "attemptsPerGame"
            ? tracked ? `${sourceMove.attemptGames.toLocaleString()} tracked games` : unmeasuredNote
            : outcomes ? metric === "noHitRate" ? `${completed.toLocaleString()} completed uses`
              : `${sourceMove.outcomeGames.toLocaleString()} outcome-tracked games`
              : tracked ? "Outcome tracking unavailable" : unmeasuredNote;
          assert.equal(helpers.archiveMoveSample(actual, key, metric), expectedNote, `${label} ${key}: sample note`);
          if (expectedNote === "Archive reparse needed") checks.reparseNotices++;
          const atlasValue = atlas.recoveryArchiveMoveMetric(selectedMove ? { ...selectedMove, key } : undefined, atlasMetric, actual);
          const atlasExpected = value === null ? null : metric === "noHitRate" ? value / 100 : value;
          assert.equal(atlasValue, atlasExpected, `${label} ${key}: Atlas metric`);
          const expectedAtlasText = value === null ? "—" : metric === "noHitRate" ? `${(atlasExpected * 100).toFixed(1)}%` : value.toFixed(2);
          assert.equal(atlas.recoveryFormatMoveMetric(atlasValue, atlasMetric), expectedAtlasText, `${label} ${key}: Atlas display`);
          const definition = recoveryMetricChoices.find((choice) => choice.key === metric);
          assert.equal(definition?.digits, 1); assert.equal(definition?.unit, metric === "noHitRate" ? "%" : "");
          const executionText = value === null ? "—" : `${num(value, definition.digits)}${definition.unit}`;
          assert.equal(executionText, value === null ? "—" : `${value.toFixed(1)}${metric === "noHitRate" ? "%" : ""}`);
          checks.metricChecks++;
          if (value === null) checks.unavailableValues++; else { checks.measuredRateChecks++; if (value === 0) checks.zeroValues++; }
        }
      }
    }

    function checkRows(actual, wanted, label) {
      const byKey = new Map(actual.map((row) => [dimensionKey(row), row]));
      assert.equal(byKey.size, actual.length, `${label}: duplicate selector dimensions`);
      assert.equal(actual.length, wanted.length, `${label}: exact matchup/stage row set`);
      for (const row of wanted) { check(byKey.get(dimensionKey(row)), row, label); checks.atlasRows++; }
    }

    for (const format of ["singles", "doubles"]) {
      const formatRows = expected.filter((row) => row.format === format);
      for (const character of [null, ...Array.from({ length: 26 }, (_, i) => i)]) {
        const relevant = formatRows.filter((row) => character === null || row.character_id === character);
        const opponents = new Set([null, ...relevant.map((row) => row.opponent_character_id).filter((value) => value !== null)]);
        const missing = Array.from({ length: 26 }, (_, i) => i).find((id) => !opponents.has(id)) ?? 999;
        opponents.add(missing);
        for (const opponent of opponents) {
          const selected = await archive.fetchArchiveCommunityBenchmarks(datasetId, character, format, opponent);
          for (const population of ["broad", "conservative"]) {
            const sources = formatRows.filter((row) => row.scope === "community" && row.population === population
              && row.stage_id === null && row.opponent_character_id === opponent
              && (character === null ? row.character_id !== null : row.character_id === character));
            const wanted = character === null ? expectedCommunityAggregate(sources, datasetId, format, population, opponent) : sources[0] ?? null;
            check(selected[population], wanted, `community:${format}:${population}:${character}:${opponent}`);
            checks.communitySelections++;
          }
          const pro = await archive.fetchArchiveProAggregateAtlasRows(datasetId, character, format, opponent);
          const wantedPro = formatRows.filter((row) => row.scope === "pro" && row.character_id === character
            && row.opponent_character_id === opponent && row.stage_id === null);
          checkRows(pro, wantedPro, `pooledPro:${format}:${character}:${opponent}`);
          // Explicitly check absent cells, so a fallback cannot hide behind an empty loop.
          if (!wantedPro.length) check(pro[0] ?? null, null, `pooledPro:${format}:${character}:${opponent}:absent`);
          checks.proSelections++;
        }
        if (character !== null) {
          checkRows(await archive.fetchArchiveCommunityAtlasRows(datasetId, character, format),
            formatRows.filter((row) => row.scope === "community" && row.character_id === character), `communityAtlas:${format}:${character}`);
          checkRows(await archive.fetchArchiveProAggregateAtlasRows(datasetId, character, format),
            formatRows.filter((row) => row.scope === "pro" && row.character_id === character), `proAtlas:${format}:${character}`);
        }
      }
      const named = formatRows.filter((row) => row.scope === "player" && row.character_id !== null);
      const pairs = new Map(named.map((row) => [`${row.player_id}|${row.character_id}`, row]));
      for (const source of pairs.values()) {
        const selected = await archive.fetchArchivePlayerAtlasRows(datasetId, source.player_id, source.character_id, format);
        checkRows(selected, named.filter((row) => row.player_id === source.player_id && row.character_id === source.character_id),
          `named:${format}:${source.player_id}:${source.character_id}`);
        checks.namedSelections++;
      }
      assert.deepEqual(await archive.fetchArchivePlayerAtlasRows(datasetId, "__recovery_missing_player__", 0, format), [],
        "unknown named player has no fallback");
    }
    return checks;
  } finally {
    try { if (server) await server.close(); }
    finally { globalThis.fetch = savedFetch; delete globalThis[adapterKey]; }
  }
}
