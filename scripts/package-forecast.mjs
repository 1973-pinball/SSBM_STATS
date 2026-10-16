#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = path.join(ROOT, ".forecast");
const HASH = "[a-f0-9]{64}";
const DATASET_FILE = /^(?:dataset|quality|registry|public-source-audit|corpus-audit|outcome-reconciliation(?:-[a-f0-9]{64})?|corpus-[a-f0-9]{64}|corpus-source-readiness-[a-f0-9]{64})\.json$/;
const REPORT_FILE = /^(?:comparison\.(?:json|md)|predictions\.json|calibration(?:-in-sample)?\.svg)$/;
const digest = (body) => createHash("sha256").update(body).digest("hex");

function requirePath(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) throw new Error(`Invalid ${label} path`);
  return value;
}

async function checkedFile(root, relative) {
  const file = path.join(root, relative);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup input must be a regular file: ${relative}`);
  const actual = await realpath(file);
  const inside = path.relative(root, actual);
  if (inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)) {
    throw new Error(`Backup input escapes the research directory: ${relative}`);
  }
  return file;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function jsonFile(root, relative, optional = false) {
  try { return JSON.parse(await readFile(await checkedFile(root, relative), "utf8")); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
}

async function addDirectory(root, directory, expression, files) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!expression.test(entry.name)) continue;
    const relative = `${directory}/${entry.name}`;
    await checkedFile(root, relative);
    files.add(relative);
  }
}

function assertPublicBundle(bundle) {
  const fields = ["schemaVersion", "event", "entrants", "sets", "seeds", "phaseGroups", "standings", "provenance"];
  if (bundle.schemaVersion !== 1 || bundle.provenance?.transport !== "startgg-public-legacy-v1"
      || bundle.provenance?.publicSourceAudit?.collectionsReconciled !== true
      || Object.keys(bundle).some((key) => !fields.includes(key))
      || !bundle.event?.id || !["entrants", "sets", "seeds", "phaseGroups", "standings"].every((key) => Array.isArray(bundle[key]))) {
    throw new Error("--bundle must be a reconciled, sanitized public event bundle");
  }
  for (const entrant of bundle.entrants) {
    if (Object.keys(entrant).some((key) => !["id", "name", "participants"].includes(key))) {
      throw new Error("Public bundle contains unsupported entrant fields");
    }
    for (const participant of entrant.participants ?? []) {
      if (Object.keys(participant).some((key) => !["id", "gamerTag", "player"].includes(key))
          || Object.keys(participant.player ?? {}).some((key) => key !== "id")) {
        throw new Error("Public bundle contains unsupported participant profile fields");
      }
    }
  }
  if (bundle.provenance.requests?.some((request) => Object.keys(request).some((key) =>
    !["source", "transport", "requestHash", "responseHash", "fetchedAt", "url", "operation"].includes(key)))) {
    throw new Error("Public bundle contains unsupported request metadata");
  }
  if (bundle.provenance.requests?.some((request) =>
    !/^https:\/\/api\.start\.gg\/(?:tournament\/[\w-]+|(?:event|phase_group|entrant)\/[1-9]\d*(?:\?expand\[\]=[a-z]+(?:&expand\[\]=[a-z]+)*)?)$/.test(request.url))) {
    throw new Error("Public bundle contains unsupported request URLs");
  }
}

export async function collectBackupFiles({ root = DEFAULT_ROOT, bundle }) {
  root = await realpath(path.resolve(root));
  const latest = await jsonFile(root, "latest.json");
  const dataset = requirePath(latest.dataset, new RegExp(`^datasets/(${HASH})/dataset\\.json$`), "dataset");
  if (dataset.split("/")[1] !== latest.sha256
      || await hashFile(await checkedFile(root, dataset)) !== latest.sha256) throw new Error("Dataset checksum mismatch");
  const files = new Set(["latest.json"]);
  await addDirectory(root, path.posix.dirname(dataset), DATASET_FILE, files);
  const evaluation = await jsonFile(root, "latest-evaluation.json", true);
  if (evaluation) {
    const report = requirePath(evaluation.report, new RegExp(`^reports/(${HASH})/comparison\\.json$`), "evaluation");
    const predictionsFile = requirePath(evaluation.predictions, new RegExp(`^reports/(${HASH})/predictions\\.json$`), "evaluation predictions");
    const comparison = await jsonFile(root, report);
    const predictions = await jsonFile(root, predictionsFile);
    if (report.split("/")[1] !== evaluation.runHash || evaluation.sourceDatasetSha256 !== latest.sha256
        || path.posix.dirname(predictionsFile) !== path.posix.dirname(report)
        || comparison.sourceDatasetSha256 !== latest.sha256
        || digest(JSON.stringify({ report: comparison, predictions })) !== evaluation.runHash) throw new Error("Evaluation dataset or run checksum mismatch");
    files.add("latest-evaluation.json");
    await addDirectory(root, path.posix.dirname(report), REPORT_FILE, files);
  }
  const model = await jsonFile(root, "latest-model.json", true);
  let fittedArtifact;
  if (model) {
    const modelFile = requirePath(model.model, new RegExp(`^models/(${HASH})\\.json$`), "model");
    if (path.posix.basename(modelFile, ".json") !== model.sha256
        || await hashFile(await checkedFile(root, modelFile)) !== model.sha256
        || model.sourceDatasetSha256 !== latest.sha256) throw new Error("Fitted model checksum or dataset mismatch");
    fittedArtifact = await jsonFile(root, modelFile);
    if (fittedArtifact.sourceDatasetSha256 !== latest.sha256) throw new Error("Fitted model dataset mismatch");
    files.add("latest-model.json");
    files.add(modelFile);
  }
  if (!bundle) throw new Error("Provide --bundle with the sanitized upcoming public event bundle");
  const bundleRelative = path.relative(root, path.resolve(bundle)).split(path.sep).join("/");
  requirePath(bundleRelative, new RegExp(`^public-raw/(${HASH})\\.json$`), "public bundle");
  const bundleFile = await checkedFile(root, bundleRelative);
  if (await hashFile(bundleFile) !== path.posix.basename(bundleRelative, ".json")) throw new Error("Public bundle checksum mismatch");
  const upcoming = await jsonFile(root, bundleRelative);
  assertPublicBundle(upcoming);
  if (model && (model.forecastEventId !== `startgg:event:${upcoming.event.id}`
      || fittedArtifact.forecastEventId !== model.forecastEventId
      || fittedArtifact.sourceSnapshotSha256 !== path.posix.basename(bundleRelative, ".json"))) {
    throw new Error("Fitted model does not match the selected upcoming event snapshot");
  }
  files.add(bundleRelative);
  return { root, files: [...files].sort(), datasetSha256: latest.sha256, bundle: bundleRelative,
    eventId: String(upcoming.event.id), hasEvaluation: Boolean(evaluation), hasModel: Boolean(model) };
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)));
  });
}

function codeState() {
  const options = { cwd: ROOT, encoding: "utf8", windowsHide: true, shell: false };
  return { commit: execFileSync("git", ["rev-parse", "HEAD"], options).trim(),
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], options).trim()) };
}

export async function packageForecast(options = {}) {
  const selected = await collectBackupFiles(options);
  const requestedBackups = path.join(selected.root, "backups");
  await mkdir(requestedBackups, { recursive: true });
  const backups = await realpath(requestedBackups);
  if (backups !== requestedBackups) throw new Error("Refusing a symlinked backups directory");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = path.resolve(options.output ?? path.join(backups, `forecast-${selected.datasetSha256.slice(0, 12)}-${stamp}.tgz`));
  if (!output.endsWith(".tgz")) throw new Error("Backup output must end with .tgz");
  const stage = await mkdtemp(path.join(backups, "stage-"));
  const resolvedStage = await realpath(stage);
  if (path.dirname(resolvedStage) !== path.resolve(backups) || !path.basename(resolvedStage).startsWith("stage-")) {
    throw new Error("Unexpected staging directory");
  }
  try {
    const files = [];
    for (const relative of selected.files) {
      const archivePath = `.forecast/${relative}`;
      const destination = path.join(stage, archivePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(await checkedFile(selected.root, relative), destination);
      const sha256 = await hashFile(destination);
      if (sha256 !== await hashFile(await checkedFile(selected.root, relative))) throw new Error(`Input changed during backup: ${relative}`);
      files.push({ path: archivePath, sha256, bytes: (await lstat(destination)).size });
    }
    const staged = await collectBackupFiles({ root: path.join(stage, ".forecast"), bundle: path.join(stage, ".forecast", selected.bundle) });
    if (staged.datasetSha256 !== selected.datasetSha256) throw new Error("Dataset pointer changed during backup");
    const manifest = { schemaVersion: 1, kind: "forecast-model-ready-backup", createdAt: new Date().toISOString(),
      code: codeState(), datasetSha256: selected.datasetSha256, upcomingEventId: selected.eventId,
      upcomingBundle: `.forecast/${selected.bundle}`, hasEvaluation: selected.hasEvaluation, hasModel: selected.hasModel,
      exclusions: ["source response caches", "other raw event bundles", "tokens and environment files", "Slippi replays", "tuning checkpoints"], files };
    const manifestPath = ".forecast/backup-manifest.json";
    await writeFile(path.join(stage, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const list = path.join(stage, "archive-files.txt");
    await writeFile(list, [...files.map((file) => file.path), manifestPath].join("\n") + "\n", "utf8");
    await mkdir(path.dirname(output), { recursive: true });
    await runTar(["-czf", output, "-C", stage, "-T", list]);
    const sha256 = await hashFile(output);
    await writeFile(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, "utf8");
    return { output, sha256, bytes: (await lstat(output)).size, fileCount: files.length + 1,
      datasetSha256: selected.datasetSha256, upcomingBundle: manifest.upcomingBundle,
      hasEvaluation: selected.hasEvaluation, hasModel: selected.hasModel, code: manifest.code };
  } finally {
    await rm(resolvedStage, { recursive: true, force: true });
  }
}

export async function verifyForecastBackup(root = DEFAULT_ROOT) {
  root = await realpath(path.resolve(root));
  const manifest = await jsonFile(root, "backup-manifest.json");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "forecast-model-ready-backup" || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported backup manifest");
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !file.path.startsWith(".forecast/") || file.path.includes("\\")) throw new Error("Invalid backup file path");
    const relative = file.path.slice(".forecast/".length);
    if (relative.split("/").some((part) => !part || part === "." || part === "..") || seen.has(relative)) throw new Error("Invalid or duplicate backup file path");
    seen.add(relative);
    const source = await checkedFile(root, relative);
    if ((await lstat(source)).size !== file.bytes || await hashFile(source) !== file.sha256) throw new Error(`Backup checksum mismatch: ${relative}`);
  }
  if (!seen.has("latest.json")) throw new Error("Backup is missing its dataset pointer");
  const bundle = requirePath(manifest.upcomingBundle, new RegExp(`^\\.forecast/public-raw/(${HASH})\\.json$`), "backup bundle");
  const selected = await collectBackupFiles({ root, bundle: path.join(root, bundle.slice(".forecast/".length)) });
  if (selected.datasetSha256 !== manifest.datasetSha256 || selected.files.length !== seen.size
      || selected.files.some((file) => !seen.has(file))) throw new Error("Backup manifest does not match the allowed forecast artifacts");
  return { verified: true, files: seen.size, datasetSha256: manifest.datasetSha256, code: manifest.code,
    upcomingBundle: manifest.upcomingBundle };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--verify") options.verify = true;
    else if (["--root", "--bundle", "--output"].includes(key) && argv[index + 1] && !argv[index + 1].startsWith("--")) options[key.slice(2)] = argv[++index];
    else throw new Error("Usage: node scripts/package-forecast.mjs [--root DIR] --bundle FILE [--output FILE.tgz] | --verify [--root DIR]");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const operation = options.verify ? verifyForecastBackup(options.root) : packageForecast(options);
  operation.then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
