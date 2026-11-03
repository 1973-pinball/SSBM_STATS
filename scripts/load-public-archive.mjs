#!/usr/bin/env node

/** Load a staged public-archive export through Supabase's service-role REST API. */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { computeArchiveContentSha256 } from "./lib/archive-content-hash.mjs";
import { inspectArchiveExportRows, requirePooledProArchiveSupport } from "./lib/archive-load-preflight.mjs";

const CACHE_ROOT = process.env.NIKKI_ARCHIVE_CACHE_ROOT ?? path.join(
  homedir(),
  process.platform === "darwin" ? "Library/Caches" : ".cache",
  "SSBM_DASHBOARD_nikki_archive",
);
const options = {
  dir: path.join(CACHE_ROOT, "public-export"),
  env: ".env.archive.local",
  forecastDir: null,
  forecastOnly: false,
  publish: false,
  dryRun: false,
};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--publish") options.publish = true;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--forecast-only") options.forecastOnly = true;
  else if (arg === "--dir" || arg === "--env" || arg === "--forecast-dir") {
    const value = process.argv[++index];
    if (!value) throw new Error(`${arg} needs a value`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    options[key] = value;
  } else {
    throw new Error(
      "Usage: load-public-archive.mjs [--dir DIR] [--forecast-dir DIR] [--forecast-only] "
      + "[--env FILE] [--dry-run] [--publish]",
    );
  }
}
if (options.forecastOnly && !options.forecastDir) throw new Error("--forecast-only requires --forecast-dir DIR");

const loadEnvFile = (file) => {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
};

loadEnvFile(options.env);
loadEnvFile(".env.local");

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const plans = [];
if (!options.forecastOnly) {
  plans.push({
    kind: "archive",
    dir: options.dir,
    manifest: JSON.parse(await readFile(path.join(options.dir, "manifest.json"), "utf8")),
  });
}
if (options.forecastDir) {
  plans.push({
    kind: "forecast",
    dir: options.forecastDir,
    manifest: JSON.parse(await readFile(path.join(options.forecastDir, "forecast-manifest.json"), "utf8")),
  });
}
const sameCounts = (left, right) => {
  if (!left || !right) return false;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => left[key] === right[key]);
};
const archivePlan = plans.find((plan) => plan.kind === "archive");
const forecastPlan = plans.find((plan) => plan.kind === "forecast");
if (archivePlan && forecastPlan && archivePlan.manifest.datasetId !== forecastPlan.manifest.datasetId) {
  throw new Error("Archive and forecast manifests reference different datasets");
}
if (forecastPlan && (!forecastPlan.manifest.sourceArchiveTableCounts
  || typeof forecastPlan.manifest.sourceArchiveGeneratedAt !== "string"
  || !/^[0-9a-f]{64}$/.test(forecastPlan.manifest.sourceArchiveSha256 ?? ""))) {
  throw new Error("Forecast manifest lacks its source archive fingerprint; rebuild the forecast");
}
if (archivePlan && forecastPlan && (
  archivePlan.manifest.generatedAt !== forecastPlan.manifest.sourceArchiveGeneratedAt
  || archivePlan.manifest.contentSha256 !== forecastPlan.manifest.sourceArchiveSha256
  || !sameCounts(archivePlan.manifest.tableCounts, forecastPlan.manifest.sourceArchiveTableCounts)
)) {
  throw new Error("Forecast was built from a different revision of the archive export");
}
const datasetId = archivePlan?.manifest.datasetId ?? forecastPlan.manifest.datasetId;
const expectedLoadOrders = {
  archive: [
    "archive_datasets", "archive_tournament_series", "archive_tournaments", "archive_bundles",
    "archive_players", "archive_player_aliases", "archive_player_rankings", "archive_sets",
    "archive_set_players", "archive_games", "archive_game_players", "archive_rollups",
  ],
  forecast: ["archive_model_runs", "archive_forecast_events", "archive_forecast_players"],
};
for (const plan of plans) {
  if (JSON.stringify(plan.manifest.loadOrder) !== JSON.stringify(expectedLoadOrders[plan.kind])) {
    throw new Error(`${plan.kind} manifest has an unexpected or unsafe load order`);
  }
}
if (archivePlan) {
  if (!/^[0-9a-f]{64}$/.test(archivePlan.manifest.contentSha256 ?? "")) {
    throw new Error("Archive manifest lacks a SHA-256 content fingerprint; rebuild the archive export");
  }
  const rows = (await readFile(path.join(archivePlan.dir, "archive_datasets.ndjson"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (rows.length !== 1 || rows[0].content_sha256 !== archivePlan.manifest.contentSha256) {
    throw new Error("Archive dataset row does not match the manifest content fingerprint");
  }
  const recomputed = await computeArchiveContentSha256({ dir: archivePlan.dir, datasetRow: rows[0] });
  if (recomputed !== archivePlan.manifest.contentSha256) {
    throw new Error("Archive table payloads do not match the manifest content fingerprint");
  }
}
if (forecastPlan) {
  const rows = (await readFile(path.join(forecastPlan.dir, "archive_model_runs.ndjson"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (!rows.length || rows.some((row) => row.dataset_content_sha256 !== forecastPlan.manifest.sourceArchiveSha256)) {
    throw new Error("Forecast model row does not match its source archive fingerprint");
  }
}

let requiresPooledPro = false;
for (const plan of plans) {
  console.log(`Validating ${plan.kind} export for ${plan.manifest.datasetId}…`);
  for (const table of plan.manifest.loadOrder) {
    const { count, hasPooledPro } = await inspectArchiveExportRows(path.join(plan.dir, `${table}.ndjson`),
      plan.kind === "archive" && table === "archive_rollups");
    requiresPooledPro ||= hasPooledPro;
    if (count !== plan.manifest.tableCounts[table]) {
      throw new Error(`${table}: manifest says ${plan.manifest.tableCounts[table]}, file has ${count}`);
    }
    console.log(`  ${table}: ${count.toLocaleString()} rows`);
  }
}

if (options.dryRun) {
  console.log("Dry run complete; no Supabase calls were made.");
  process.exit(0);
}
if (!url || !serviceKey) {
  throw new Error(
    "Supabase load credentials are missing. Put SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL " +
    "(or VITE_SUPABASE_URL) in .env.archive.local; never commit that file.",
  );
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
});
await requirePooledProArchiveSupport(supabase, requiresPooledPro);
const { error: schemaError } = await supabase.from("archive_datasets").select("id").limit(1);
if (schemaError) {
  throw new Error(
    `Public archive schema is not available (${schemaError.message}). Run supabase/public-archive.sql first.`,
  );
}
const { data: existingDataset, error: existingError } = await supabase
  .from("archive_datasets")
  .select("id,published,import_counts,content_sha256")
  .eq("id", datasetId)
  .maybeSingle();
if (existingError) throw new Error(`Could not check existing dataset: ${existingError.message}`);
if (archivePlan && existingDataset?.published) {
  throw new Error(
    `${datasetId} is already published. Build a new versioned dataset instead of mutating it in place, `
    + "or use --forecast-only to add a forecast.",
  );
}
if (options.forecastOnly && !existingDataset?.published) {
  throw new Error(`${datasetId} must exist and be published before a forecast-only load`);
}
if (options.forecastOnly && !sameCounts(existingDataset.import_counts, forecastPlan.manifest.sourceArchiveTableCounts)) {
  throw new Error("Forecast was built from a different revision of the published archive dataset");
}
if (options.forecastOnly && existingDataset.content_sha256 !== forecastPlan.manifest.sourceArchiveSha256) {
  throw new Error("Forecast content fingerprint does not match the published archive dataset");
}

if (forecastPlan) {
  const eventLines = createInterface({
    input: createReadStream(path.join(forecastPlan.dir, "archive_forecast_events.ndjson")),
    crlfDelay: Infinity,
  });
  const eventIds = [];
  for await (const line of eventLines) if (line.trim()) eventIds.push(JSON.parse(line).id);
  const { data: existingForecasts, error: forecastCheckError } = await supabase
    .from("archive_forecast_events")
    .select("id,published")
    .in("id", eventIds);
  if (forecastCheckError) throw new Error(`Could not check existing forecasts: ${forecastCheckError.message}`);
  const publishedIds = (existingForecasts ?? []).filter((row) => row.published).map((row) => row.id);
  if (publishedIds.length) {
    throw new Error(`Forecast event already published; use a new versioned id: ${publishedIds.join(", ")}`);
  }
}

const conflicts = {
  archive_datasets: "id",
  archive_tournament_series: "id",
  archive_tournaments: "id",
  archive_bundles: "id",
  archive_players: "id",
  archive_player_aliases: "player_id,normalized_alias",
  archive_player_rankings: "player_id,ranking_series,edition_label",
  archive_sets: "id",
  archive_set_players: "set_id,slot",
  archive_games: "game_key",
  archive_game_players: "game_key,slot",
  archive_rollups: "rollup_key",
  archive_model_runs: "id",
  archive_forecast_events: "id",
  archive_forecast_players: "forecast_event_id,player_id",
};
const batchSizes = {
  archive_game_players: 50,
  archive_rollups: 250,
};

const upsertBatch = async (table, rows) => {
  if (!rows.length) return;
  // Omit publication columns so resuming an interrupted staging load cannot
  // unpublish shared series/player rows from an older dataset.
  const stagedRows = rows.map(({ published: _published, published_at: _publishedAt, ...row }) => row);
  const { error } = await supabase.from(table).upsert(stagedRows, {
    onConflict: conflicts[table],
    ignoreDuplicates: false,
  });
  if (error) throw new Error(`${table}: ${error.message}`);
};

for (const plan of plans) {
  for (const table of plan.manifest.loadOrder) {
    const expected = plan.manifest.tableCounts[table];
    const batchSize = batchSizes[table] ?? 500;
    const lines = createInterface({
      input: createReadStream(path.join(plan.dir, `${table}.ndjson`)),
      crlfDelay: Infinity,
    });
    let batch = [];
    let loaded = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length < batchSize) continue;
      await upsertBatch(table, batch);
      loaded += batch.length;
      batch = [];
      if (loaded % Math.max(1000, batchSize * 10) === 0) {
        console.log(`  ${table}: ${loaded.toLocaleString()}/${expected.toLocaleString()}`);
      }
    }
    await upsertBatch(table, batch);
    loaded += batch.length;
    console.log(`Loaded ${table}: ${loaded.toLocaleString()} rows`);
  }
}

if (options.publish) {
  if (archivePlan) {
    const { error } = await supabase.rpc("publish_archive_dataset", { p_dataset_id: datasetId });
    if (error) throw new Error(`Dataset publication failed: ${error.message}`);
    console.log(`Published ${datasetId}.`);
  }
  if (forecastPlan) {
    const { error } = await supabase.rpc("publish_archive_forecast", {
      p_forecast_event_id: forecastPlan.manifest.forecastEventId,
      p_expected_player_count: forecastPlan.manifest.tableCounts.archive_forecast_players,
    });
    if (error) throw new Error(`Forecast publication failed: ${error.message}`);
    console.log(`Published forecast ${forecastPlan.manifest.forecastEventId}.`);
  }
} else {
  console.log("Staging load complete. Rows remain unpublished; rerun with --publish after verification.");
}
