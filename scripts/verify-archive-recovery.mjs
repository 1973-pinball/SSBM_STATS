#!/usr/bin/env node
/** Local-only original-source restoration QA. No sample profile, network, or publication. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { verifyRecoveryBoundary } from "./lib/archive-recovery-boundary.mjs";
import { verifyDerivedRecoveryExport, reconcileRecoveryAddition, digest } from "./lib/archive-recovery-export.mjs";
import { verifyRecoverySelectors } from "./lib/archive-recovery-selectors.mjs";
import { readDataset } from "./lib/liquipedia-data.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryFiles = {
  events: "scripts/data/nikki-event-registry.json", series: "scripts/data/nikki-series-registry.json",
  identities: "scripts/data/nikki-player-overrides.json", supplemental: "scripts/data/interaction-pro-overrides.json",
  rankings: "src/lib/liquipedia/data.ts",
};
const verificationInputs = [
  "scripts/verify-archive-recovery.mjs", "scripts/lib/archive-recovery-boundary.mjs",
  "scripts/lib/archive-recovery-export.mjs", "scripts/lib/archive-recovery-population.mjs",
  "scripts/lib/archive-recovery-rollups.mjs", "scripts/lib/archive-recovery-selectors.mjs",
  "scripts/lib/archive-source-population.mjs", "scripts/lib/archive-source-integrity.mjs",
  "scripts/lib/archive-content-hash.mjs", "scripts/lib/ootb5-recovery.mjs", "scripts/revise-ootb5-source-audit.mjs",
  "scripts/lib/liquipedia-data.mjs", "scripts/lib/liquipedia-parse.mjs", "src/lib/publicArchive.ts",
  "src/lib/executionMoveBenchmarks.ts", "src/components/CommunityArchiveAtlas.tsx", "src/components/Views.tsx",
  "src/lib/format.ts", "src/lib/melee.ts",
];
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
async function hashFile(filename) {
  const before = await lstat(filename);
  assert.ok(before.isFile() && !before.isSymbolicLink(), "Verification input must be a regular file");
  const hasher = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hasher.update(bytes);
  const after = await lstat(filename);
  assert.ok(["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]), "Verification input changed while hashing");
  return hasher.digest("hex");
}

export async function assertUnchangedRecoveryInputs(fingerprints) {
  for (const item of fingerprints) assert.equal(await hashFile(item.path), item.sha256, `Input changed during verification (${item.kind})`);
}

/** Internal dependencies are test seams only; the CLI exposes no relaxed profile. */
export async function verifyArchiveRecovery(options, { contract, requiredCharacters, registries = registryFiles } = {}) {
  const output = path.resolve(options.report);
  assert.ok(output.endsWith(".local.json"), "Readiness report contains local evidence; use .local.json");
  const outputParent = await realpath(path.dirname(output));
  const resolvedOutput = path.join(outputParent, path.basename(output));
  const beforeDir = path.resolve(options.beforeDir ?? path.join(options.oldCache, "public-export-v11"));
  for (const protectedDirectory of [options.oldCache, beforeDir, options.afterDir]) {
    assert.ok(!inside(await realpath(protectedDirectory), resolvedOutput), "Report must stay outside immutable inputs and exports");
  }
  try { await access(output); throw new Error("Readiness report already exists; select a new filename"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const boundary = await verifyRecoveryBoundary({ ...options, repo, registryFiles: registries }, contract ? { contract } : {});
  const fingerprints = [...boundary.inputFingerprints];
  const listings = [];
  for (const root of [boundary.oldCache, boundary.cache]) {
    const expectedNames = (root === boundary.oldCache ? boundary.oldPayloadFiles : boundary.payloadFiles).map(file => path.basename(file)).sort();
    for (const name of ["results-v6", "backfill-v6/receipts"]) {
      const dir = path.join(root, name);
      const names = (await readdir(dir)).filter(file => file.endsWith(".json")).sort();
      assert.deepEqual(names, expectedNames, "Source directory membership changed after the boundary check");
      listings.push({ dir, suffix: ".json", names });
    }
  }
  for (const dir of [boundary.beforeDir, boundary.afterDir]) {
    listings.push({ dir, suffix: ".ndjson", names: (await readdir(dir)).filter(file => file.endsWith(".ndjson")).sort() });
  }
  for (const filename of verificationInputs) {
    const absolute = path.join(repo, filename);
    fingerprints.push({ kind: "validator-and-selector-code", path: absolute, sha256: await hashFile(absolute) });
  }
  const readBound = async (filename, kind) => {
    const absolute = path.resolve(filename), bytes = await readFile(absolute);
    fingerprints.push({ kind, path: absolute, sha256: digest(bytes) });
    return JSON.parse(bytes);
  };
  const documents = {};
  for (const [key, filename] of Object.entries(registries)) {
    if (key !== "rankings") documents[key] = JSON.parse(await readFile(path.resolve(repo, filename)));
  }
  const curation = await readBound(options.curation, "recovery-curation");
  const baselineCuration = await readBound(path.join(options.oldCache, "archive-curation-v6.json"), "baseline-curation");
  const common = {
    eventDocument: documents.events, seriesDocument: documents.series, identityDocument: documents.identities,
    supplementalDocument: documents.supplemental, rankingDataset: readDataset(path.resolve(repo, registries.rankings)),
    supplementalSha256: boundary.registryHashes.supplemental, requiredCharacters,
  };
  const server = await createServer({ root: repo, configFile: false, envDir: false, appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  let capability;
  try { ({ getSpecialMoveCapability: capability } = await server.ssrLoadModule("/src/lib/specialMoves.ts")); }
  finally { await server.close(); }
  const before = await verifyDerivedRecoveryExport({ ...common, capability, dir: beforeDir,
    payloadFiles: boundary.oldPayloadFiles, audit: boundary.oldAudit, auditSha256: boundary.oldAuditSha256, curation: baselineCuration });
  const after = await verifyDerivedRecoveryExport({ ...common, capability, dir: options.afterDir,
    payloadFiles: boundary.payloadFiles, audit: boundary.audit, auditSha256: boundary.newAuditSha256, curation });
  const reconciliation = reconcileRecoveryAddition(before, after);
  const selectors = await verifyRecoverySelectors({ tables: after.tables, expectedRollups: after.rollups.rows, datasetId: after.manifest.datasetId });
  await assertUnchangedRecoveryInputs(fingerprints);
  for (const listing of listings) assert.deepEqual((await readdir(listing.dir)).filter(file => file.endsWith(listing.suffix)).sort(), listing.names,
    "Input directory membership changed during verification");
  const report = {
    schemaVersion: 1, type: "archiveRecoveryValidation", status: "validated-local-candidate",
    verifiedAt: new Date().toISOString(), datasetId: after.manifest.datasetId, contentSha256: after.manifest.contentSha256,
    baseline: { datasetId: before.manifest.datasetId, contentSha256: before.manifest.contentSha256 },
    sourcePopulation: after.manifest.sourcePopulation, parserSha256: boundary.parserSha256, statsVersion: 6,
    sourceAssurance: boundary.audit.recoveryRevision.assurance,
    baselineCounts: before.summary, recoveryCounts: after.summary, reconciliation, selectors,
    registryHashes: boundary.registryHashes, inputFingerprints: fingerprints,
    inputDirectoryFingerprints: listings.map(({ dir, names }) => ({ path: dir, sha256: digest(JSON.stringify(names)) })),
    publicationAuthorized: false,
    limits: [
      boundary.registryEvidenceLimit,
      "Source identity retains the assurance level and limitations of the reviewed recovery provenance.",
      "This validates derived statistics, source lineage, preservation, and offline selectors. It does not independently retest detector accuracy against every raw frame.",
      "The frozen stats6 Bow exclusions remain unknown. No detector, raw replay, published export, or database is changed.",
      "The dataset ID must still be checked against the live catalog and publication requires the owner's explicit approval. This command performs no network requests.",
      "Any recovered parser failures or unexplained raw-frame gaps require local evidence review before publication.",
    ],
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

async function main() {
  const args = new Map();
  const allowed = ["--old-cache", "--cache", "--audit", "--verification", "--provenance", "--dir", "--curation", "--report", "--before", "--accept-owner-attestation"];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert.ok(allowed.includes(key) && value && !args.has(key), "Expected unique known --name value arguments; no sample/recovery bypass flags exist");
    args.set(key, value);
  }
  for (const key of allowed.slice(0, 8)) assert.ok(args.has(key), `Missing ${key}`);
  if (args.has("--accept-owner-attestation")) assert.equal(args.get("--accept-owner-attestation"), "true");
  const report = await verifyArchiveRecovery({ oldCache: args.get("--old-cache"), cache: args.get("--cache"),
    audit: args.get("--audit"), verification: args.get("--verification"), provenance: args.get("--provenance"),
    afterDir: args.get("--dir"), beforeDir: args.get("--before"), curation: args.get("--curation"),
    report: args.get("--report"), acceptOwnerAttestation: args.get("--accept-owner-attestation") === "true" });
  console.log(JSON.stringify({ status: report.status, datasetId: report.datasetId, contentSha256: report.contentSha256,
    parsed: report.recoveryCounts.parsedFiles, uniqueGames: report.recoveryCounts.uniqueGames,
    comparedRollups: report.recoveryCounts.rollups.exported, selectors: report.selectors,
    publicationAuthorized: false }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(`Archive recovery validation rejected: ${error.message}`); process.exitCode = 1; }
}
