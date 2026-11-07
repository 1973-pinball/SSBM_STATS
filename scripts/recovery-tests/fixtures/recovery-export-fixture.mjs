import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { readDataset } from "../../lib/liquipedia-data.mjs";
import { computeArchiveContentSha256 } from "../../lib/archive-content-hash.mjs";
import { RECOVERY_BOUNDARY_CONTRACT, RECOVERY_PARSER_INPUTS } from "../../lib/archive-recovery-boundary.mjs";
import { OOTB5_EVIDENCE } from "../../lib/ootb5-recovery.mjs";
import { createRecoveredAudit } from "../../revise-ootb5-source-audit.mjs";

export const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const readJson = async filename => JSON.parse(await readFile(filename, "utf8"));
export async function put(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
export const readRows = async (dir, table) => (await readFile(path.join(dir, `${table}.ndjson`), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
export const putRows = (dir, table, rows) => put(path.join(dir, `${table}.ndjson`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPOSITORY, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(`Fixture command failed (${code}): ${stderr}\n${stdout.slice(-3000)}`)));
  });
}

export async function createRecoveryExportFixture(directory, { paddingBundles = 65 } = {}) {
  const vite = await createServer({ root: REPOSITORY, configFile: false, envDir: false, appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  let capability;
  try { ({ getSpecialMoveCapability: capability } = await vite.ssrLoadModule("/src/lib/specialMoves.ts")); }
  finally { await vite.close(); }
  const padding = Array.from({ length: paddingBundles }, (_, index) => `padding-${String(index).padStart(2, "0")}`);
  const eventIds = ["aaa", "ootb5", ...padding, "zzz"];
  const eventDocument = { events: eventIds.map(id => ({ id, name: `Synthetic ${id}`, year: 2026,
    sourceUrl: `https://example.com/fixture/${id}`, sourceLabel: "Synthetic test evidence", sourceConfidence: "verified", isTournament: true })) };
  const seriesDocument = { series: [{ id: "synthetic-series", name: "Synthetic series", sourceUrl: "https://example.com/fixture", eventIds }] };
  const identityDocument = { players: [], overrides: ["aaa", "zzz", "ootb5"].map(eventId => ({
    kind: "event_aliases", eventId, resolution: "probable", sourceUrl: `https://example.com/fixture/${eventId}`,
    aliases: [{ observedAlias: "Fixture Zain", playerId: "zain" }, ...(eventId === "ootb5" ? [
      { observedAlias: "Fixture Moky", playerId: "moky" }, { observedAlias: "Fixture Cody", playerId: "codyschwab" },
    ] : [])],
  })) };
  const supplementalDocument = { schemaVersion: 1, reviewedAt: "2026-11-02", overrides: ["aaa", "zzz"].map(eventId => ({
    kind: "event_aliases", eventId, resolution: "probable", sourceUrl: `https://example.com/fixture/${eventId}`,
    aliases: [{ observedAlias: "Fixture Moky", playerId: "moky" }, { observedAlias: "Fixture Cody", playerId: "codyschwab" }],
  })) };
  const specialMoves = (character, index, slot) => {
    const moves = { 2: { attempts: 4, landed: 3, damage: 12.345, kills: 1, killPctSum: 100, openings: 1, openingDmg: 12.345, lcSuccess: 1, lcFail: 0 } };
    for (const id of [18, 19, 20, 21]) {
      const allowed = capability(character, id), attempts = index % 3 === 0 ? 0 : 1;
      moves[id] = { landed: 0, damage: 0, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lcSuccess: 0, lcFail: 0 };
      if (allowed.attempts && !(index === 0 && slot === 0 && id === 19)) {
        moves[id].attempts = attempts;
        if (allowed.outcomes) Object.assign(moves[id], { hitAttempts: 0, noHitAttempts: attempts, incompleteAttempts: 0 });
      }
    }
    return moves;
  };
  const record = index => ({ ok: true, statsVersion: 6, file: `bracket/station-${index}/game.slp`,
    identityKey: `synthetic-game-${index}`, playedAt: `2026-08-01T12:${String(index).padStart(2, "0")}:00Z`,
    consoleNick: "Synthetic console", legalStage: true, playableRoster: true, durationFrames: 3600 + index,
    isTeams: false, stageId: index < 24 || index === 30 ? 31 : 2, winnerIndex: index % 2, winnerTeamId: null,
    players: [1, 18].map((characterId, slot) => ({ playerIndex: slot, teamId: null, characterId,
      displayName: slot ? "Fixture Zain" : index % 2 ? "Fixture Cody" : "Fixture Moky", nametag: "",
      totalDamage: 42.125 + index, neutralWins: 3, kills: 2, openingsPerKill: 1.5,
      damagePerOpening: 14.25, inputsPerMinute: 100.123456, lCancelSuccess: 5, lCancelFail: 1,
      techs: { inPlace: 2, toward: 1, away: 0, missed: 1, wallSuccess: 0, wallMissed: 0 },
      actions: { rolls: 1, airDodges: 2, spotDodges: 1, wavedashes: 3, wavelands: 2, dashDances: 4, ledgeGrabs: 2, crouchCancels: 0, grabs: 1 },
      moveStats: specialMoves(characterId, index, slot) })),
  });
  const originalRecords = Array.from({ length: 30 }, (_, index) => record(index));
  // A usable event recording without bracket/sequence evidence remains aggregate-only.
  originalRecords[29].file = "venue/station-29/game.slp";
  originalRecords[29].players.forEach((player, slot) => { player.displayName = `Unreviewed fixture ${slot}`; });
  const duplicated = (index, suffix) => ({ ...structuredClone(originalRecords[index]), file: `bracket/recovered-${suffix}/game.slp` });
  const restoredRecords = [duplicated(16, "old-zzz"), duplicated(0, "old-aaa"), record(30),
    { ...record(30), file: "bracket/recovered-duplicate/game.slp" }];
  const recordsByStem = new Map([["aaa", originalRecords.slice(0, 16)], ["zzz", originalRecords.slice(16)],
    ["ootb5", restoredRecords], ...padding.map(id => [id, []])]);
  const sourceByStem = new Map(eventIds.map(stem => [stem, { id: `nikki-2026-09-08-v8:${stem}`,
    sourceFilename: `${stem}.7z`, compressed_bytes: Buffer.byteLength(`Synthetic archive: ${stem}`), replay_file_count: recordsByStem.get(stem).length }]));
  const oldAudit = { dataset: { id: "nikki-2026-09-08-v8", archive_count: eventIds.length },
    sources: eventIds.map(stem => ({ ...sourceByStem.get(stem), ...(stem === "ootb5" ? { sourceFilename: null } : {}) })) };
  const oldAuditPath = path.join(directory, "old-audit.local.json"), auditPath = path.join(directory, "audit.local.json");
  const verification = path.join(directory, "verification.local.json"), provenance = path.join(directory, "provenance.local.json");
  const originalBytes = Buffer.from(JSON.stringify(oldAudit));
  const evidence = { ...OOTB5_EVIDENCE, originalAuditSha256: hash(originalBytes),
    compressedBytes: sourceByStem.get("ootb5").compressed_bytes, replayFiles: restoredRecords.length };
  const recoveredHash = hash("Synthetic archive: ootb5");
  const provenanceDocument = { schemaVersion: 1, bundleStem: "ootb5", archiveSha256: recoveredHash,
    reviewedBy: "Synthetic fixture reviewer", reviewedAt: "2026-11-07T00:00:00Z", originalUnmodified: true,
    basis: "historical-sha256", historicalSha256: recoveredHash, evidenceReference: "Synthetic unit-test evidence only" };
  const provenanceBytes = Buffer.from(JSON.stringify(provenanceDocument));
  const verificationDocument = { schemaVersion: 1, type: "recoveryVerification", bundleStem: "ootb5",
    originalAuditSha256: hash(originalBytes), expected: { compressedBytes: evidence.compressedBytes, replayFiles: evidence.replayFiles },
    archive: { compressedBytes: evidence.compressedBytes, sha256: recoveredHash, sourceFilename: "ootb5.7z", format: "7z" },
    replayFiles: evidence.replayFiles, slpzFiles: 0, integrityTest: { passed: true },
    provenanceEvidenceSha256: hash(provenanceBytes), provenance: provenanceDocument, status: "verified-historical-hash" };
  const verificationBytes = Buffer.from(JSON.stringify(verificationDocument));
  const audit = createRecoveredAudit(originalBytes, verificationBytes, provenanceBytes,
    { revision: "ootb5-recovery-synthetic", createdAt: "2026-11-07T00:00:00Z", evidence });
  await put(verification, verificationBytes); await put(provenance, provenanceBytes);
  const events = path.join(directory, "events.local.json"), series = path.join(directory, "series.local.json");
  const identities = path.join(directory, "identities.local.json"), supplemental = path.join(directory, "interaction-pro-overrides.json");
  await Promise.all([[oldAuditPath, oldAudit], [auditPath, audit], [events, eventDocument], [series, seriesDocument],
    [identities, identityDocument], [supplemental, supplementalDocument]].map(([filename, value]) => put(filename, value)));
  const roots = [path.join(directory, "old"), path.join(directory, "recovery")], exports = [];
  for (const [index, root] of roots.entries()) {
    const results = path.join(root, "results-v6"), downloads = path.join(root, "downloads");
    const selected = index ? audit.sources : oldAudit.sources.filter(source => source.sourceFilename);
    for (const source of selected) {
      const stem = source.sourceFilename.replace(/\.7z$/, ""), records = recordsByStem.get(stem);
      await put(path.join(downloads, source.sourceFilename), `Synthetic archive: ${stem}`);
      await put(path.join(results, `${stem}.json`), { schemaVersion: 2, statsVersion: 6, statProfile: "dashboard-full-derived-v1",
        source: "https://replays.nikki.sh/", analyzedAt: "2026-11-07T00:00:00Z", bundle: source.sourceFilename,
        replayFiles: records.length, parsed: records.length, failed: 0, records });
    }
    const curationPath = path.join(root, "curation.local.json"), dir = path.join(root, "export");
    await run(["scripts/curate-nikki-archive.mjs", results, curationPath]);
    await run(["scripts/build-nikki-public-archive.mjs", "--results", results, "--downloads", downloads,
      "--curation", curationPath, "--events", events, "--series", series, "--identities", identities,
      "--supplemental-identities", supplemental, "--source-audit", index ? auditPath : oldAuditPath,
      ...(!index ? ["--exclude-bundles", "ootb5"] : []), "--data-as-of", "2026-09-08", "--version", index ? "v12" : "v11", "--output", dir]);
    exports.push({ dir, payloadFiles: (await readdir(results)).filter(name => name.endsWith(".json")).sort().map(name => path.join(results, name)),
      audit: index ? audit : oldAudit, auditSha256: hash(await readFile(index ? auditPath : oldAuditPath)), curation: await readJson(curationPath) });
  }
  const common = { eventDocument, seriesDocument, identityDocument, supplementalDocument,
    supplementalSha256: hash(await readFile(supplemental)), rankingDataset: readDataset(), capability, requiredCharacters: [1, 18] };
  assert.equal(audit.sources.length, paddingBundles + 3);
  const parserHasher = createHash("sha256");
  for (const name of RECOVERY_PARSER_INPUTS) { parserHasher.update(name); parserHasher.update(await readFile(path.join(REPOSITORY, name))); }
  const parserSha256 = parserHasher.digest("hex");
  await put(path.join(roots[0], "source-audit-2026-10-22.json"), originalBytes);
  await put(path.join(roots[0], "archive-curation-v6.json"), exports[0].curation);
  for (const [index, root] of roots.entries()) {
    const selected = index ? audit.sources : oldAudit.sources.filter(source => source.sourceFilename);
    for (const source of selected) {
      const filename = source.sourceFilename.replace(/\.7z$/, ".json"), output = path.join(root, "results-v6", filename);
      await put(path.join(root, "backfill-v6", "receipts", filename), {
        bundle: source.sourceFilename, compressedBytes: source.compressed_bytes, statsVersion: 6, specialMoveIds: [18, 19, 20, 21],
        parserSha256, auditSha256: exports[index].auditSha256, output, outputSha256: hash(await readFile(output)),
        ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
      });
    }
    await put(path.join(root, "backfill-v6", "state.json"), { statsVersion: 6, parserSha256, auditSha256: exports[index].auditSha256,
      finishedAt: "2026-11-07T00:00:00Z", expectedBundles: selected.length,
      expectedReplayFiles: selected.reduce((sum, source) => sum + source.replay_file_count, 0),
      failures: [], pending: [], completed: selected.map(source => ({ bundle: source.sourceFilename })) });
  }
  const baselineManifest = await readJson(path.join(exports[0].dir, "manifest.json"));
  const oldSources = oldAudit.sources.filter(source => source.sourceFilename);
  const contract = { ...RECOVERY_BOUNDARY_CONTRACT, evidence, parserSha256, baselineContentSha256: baselineManifest.contentSha256,
    oldSourceCount: oldSources.length, sourceCount: audit.sources.length, oldReplayFiles: 30, replayFiles: 34,
    oldCompressedBytes: oldSources.reduce((sum, source) => sum + source.compressed_bytes, 0),
    compressedBytes: audit.sources.reduce((sum, source) => sum + source.compressed_bytes, 0), oldParsed: 30, oldFailed: 0 };
  const pipeline = {
    options: { oldCache: roots[0], cache: roots[1], audit: auditPath, verification, provenance,
      beforeDir: exports[0].dir, afterDir: exports[1].dir, curation: path.join(roots[1], "curation.local.json"),
      report: path.join(directory, "readiness.local.json") },
    dependencies: { contract, requiredCharacters: [1, 18], registries: { events, series, identities, supplemental,
      rankings: path.join(REPOSITORY, "src/lib/liquipedia/data.ts") } },
  };
  return { directory, common, before: { ...common, ...exports[0] }, after: { ...common, ...exports[1] }, pipeline };
}

/** Make a malicious fixture internally hash/count consistent so reference reconstruction is the gate under test. */
export async function resealExport(dir) {
  const manifest = await readJson(path.join(dir, "manifest.json")), qa = await readJson(path.join(dir, "qa.json"));
  const [dataset] = await readRows(dir, "archive_datasets");
  for (const table of manifest.loadOrder) manifest.tableCounts[table] = (await readRows(dir, table)).length;
  dataset.import_counts = manifest.tableCounts;
  dataset.content_sha256 = await computeArchiveContentSha256({ dir, datasetRow: dataset });
  manifest.contentSha256 = dataset.content_sha256; qa.contentSha256 = dataset.content_sha256; qa.tableCounts = manifest.tableCounts;
  await putRows(dir, "archive_datasets", [dataset]);
  await put(path.join(dir, "manifest.json"), manifest); await put(path.join(dir, "qa.json"), qa);
}
