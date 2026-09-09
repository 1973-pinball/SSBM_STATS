import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const TABLES = ["events", "players", "aliases", "entrants", "seeds", "sets", "standings", "provenance"];
const CATEGORIES = new Set(["cache", "raw", "datasets", "reports"]);
const roundPage = (bytes) => bytes === 0 ? 0 : Math.ceil(bytes / 8192) * 8192;
const sum = (rows, key) => rows.reduce((n, row) => n + row[key], 0);

/** Metadata-only inventory. Never follows links or opens credential contents. */
export async function inventoryStorage(root) {
  const files = [];
  const excluded = ["storage-reports/**", "latest-storage.json"];
  if (!(await lstat(root)).isDirectory()) throw new Error("Storage root must be a real directory");
  async function walk(directory, relative = "") {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const rel = relative ? relative + "/" + name : name;
      // Avoid recursive growth caused by measuring the report itself.
      if (["storage-reports", "latest-storage.json"].includes(rel)) continue;
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("Storage inventory refuses symbolic links");
      if (info.isDirectory()) await walk(file, rel);
      else if (info.isFile()) {
        if (name.endsWith(".tmp")) throw new Error("Temporary research output found; wait for other CLI writers to finish");
        const top = rel.split("/")[0];
        files.push({ path: rel, category: CATEGORIES.has(top) ? top : "other",
          bytes: info.size, allocatedBytes: Number.isFinite(info.blocks) ? info.blocks * 512 : null });
      } else throw new Error("Storage inventory encountered a non-regular file");
    }
  }
  await walk(root);
  const categories = [...CATEGORIES, "other"].map((category) => {
    const rows = files.filter((file) => file.category === category);
    return { category, files: rows.length, bytes: sum(rows, "bytes"),
      allocatedBytes: rows.some((r) => r.allocatedBytes == null) ? null : sum(rows, "allocatedBytes") };
  });
  return { files, categories, excluded, fileCount: files.length, bytes: sum(files, "bytes"),
    allocatedBytes: files.some((r) => r.allocatedBytes == null) ? null : sum(files, "allocatedBytes") };
}

/** Capacity scenarios, deliberately NOT a PostgreSQL size estimator or bound. */
export function projectStorage(dataset, { predictions = [] } = {}) {
  if (dataset.schemaVersion !== 1 || !Array.isArray(predictions)) throw new Error("Unsupported storage input schema");
  const collections = TABLES.map((name) => [name, dataset[name]]);
  collections.push(["predictions_one_run", predictions]);
  const tables = collections.map(([table, rows]) => {
    if (!Array.isArray(rows)) throw new Error("Missing canonical storage collection: " + table);
    return { table, rows: rows.length,
      jsonPayloadBytes: rows.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0) };
  });
  const assumptions = { pageBytes: 8192, rowOverheadBudgetBytes: 64,
    indexesPerTable: 2, indexEntryBudgetBytes: 64, operatingHeadroomFraction: 0.3,
    payloadFactors: [1, 1.5, 2] };
  const scenarios = assumptions.payloadFactors.map((payloadFactor) => {
    const rows = tables.map((table) => {
      const tableBytes = roundPage(table.jsonPayloadBytes * payloadFactor + table.rows * assumptions.rowOverheadBudgetBytes);
      const indexBytes = assumptions.indexesPerTable * roundPage(table.rows * assumptions.indexEntryBudgetBytes);
      return { table: table.table, tableBytes, indexBytes, totalBytes: tableBytes + indexBytes };
    });
    const totalBytes = sum(rows, "totalBytes");
    return { payloadFactor, tables: rows, tableBytes: sum(rows, "tableBytes"), indexBytes: sum(rows, "indexBytes"),
      totalBytes, withHeadroomBytes: Math.ceil(totalBytes * (1 + assumptions.operatingHeadroomFraction)) };
  });
  return { status: "assumption-based-capacity-scenarios-not-measured-postgres", tables, assumptions, scenarios,
    warnings: [
      "One row per canonical collection entry plus one selected prediction run; raw/cache copies are not projected for upload.",
      "No database schema, indexes, migration, connection or upload has been created.",
      "Payload factors and per-row/index budgets are explicit planning assumptions, not measured JSONB expansion or confidence bounds.",
      "Actual PostgreSQL storage depends on column types, keys, page packing, TOAST compression, indexes and update history.",
      "Scenarios exclude WAL, backups, replicas, catalogs, quality/report documents and future prediction runs. Headroom is an arbitrary 30% allowance, not a guarantee.",
      "No extrapolation to all majors: these selected events have very different field sizes and may overlap in player identities.",
      "Validate later against an approved representative schema using pg_table_size, pg_indexes_size and pg_total_relation_size.",
    ],
    sources: [
      { title: "PostgreSQL page and row layout", url: "https://www.postgresql.org/docs/18/storage-page-layout.html" },
      { title: "PostgreSQL TOAST compression and out-of-line storage", url: "https://www.postgresql.org/docs/18/storage-toast.html" },
      { title: "PostgreSQL database object size functions", url: "https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE" },
    ] };
}

const mib = (bytes) => bytes == null ? "unavailable" : (bytes / 1048576).toFixed(2);

export function storageMarkdown(report) {
  return [
    "# Local forecast storage report", "",
    "Measured files and assumption-based database capacity scenarios. No uploads.", "",
    "Latest canonical dataset: **" + report.datasetBytes + " bytes (" + mib(report.datasetBytes) + " MiB)**.",
    report.evaluationRunHash
      ? "Selected model output: " + report.predictionRows + " set-prediction rows from one evaluation run."
      : "No evaluation selected; model-output storage is not included in the projection.", "",
    "## Measured local files", "",
    "| Category | Files | Logical MiB | Allocated MiB |", "|---|---:|---:|---:|",
    ...report.inventory.categories.map((r) => "| " + r.category + " | " + r.files + " | " + mib(r.bytes) + " | " + mib(r.allocatedBytes) + " |"),
    "| Total | " + report.inventory.fileCount + " | " + mib(report.inventory.bytes) + " | " + mib(report.inventory.allocatedBytes) + " |", "",
    "Includes retained historical datasets/reports, not just latest outputs. Storage reports themselves are excluded to prevent self-counting.",
    "Allocated bytes come from filesystem block counts; APFS compression/clones/shared blocks can make this differ from physical space uniquely consumed.",
    "Inventory is not an atomic filesystem snapshot. Run after other forecast CLI writers have stopped.", "",
    "## Hypothetical table payloads", "",
    "| Collection | Rows | UTF-8 JSON payload MiB |", "|---|---:|---:|",
    ...report.projection.tables.map((r) => "| " + r.table + " | " + r.rows + " | " + mib(r.jsonPayloadBytes) + " |"), "",
    "## Database capacity scenarios — not measured sizes or bounds", "",
    "Assume one collection entry per row, 64 bytes extra per row, two indexes budgeted at 64 bytes per entry each, and 8 KiB page rounding. These are planning choices, not actual PostgreSQL row/index sizes.", "",
    "| JSON payload factor | Tables MiB | Indexes MiB | Total MiB | With 30% allowance MiB |",
    "|---|---:|---:|---:|---:|",
    ...report.projection.scenarios.map((r) => "| " + r.payloadFactor + "× | " + mib(r.tableBytes) + " | " + mib(r.indexBytes) + " | " + mib(r.totalBytes) + " | " + mib(r.withHeadroomBytes) + " |"), "",
    ...report.projection.warnings.map((warning) => "- " + warning), "",
    "The PostgreSQL references explain why real table/index storage cannot be inferred exactly from JSON file bytes: "
      + report.projection.sources.map((source) => "[" + source.title + "](" + source.url + ")").join(", ") + ".", "",
  ].join("\n");
}
