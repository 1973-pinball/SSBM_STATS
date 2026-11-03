#!/usr/bin/env node
// Aggregate a deterministic convenience sample, reusing verified parses when available.
// No raw replay, path, game identity, or player identity enters the shipped artifact.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, statfs, mkdtemp, rm, lstat, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { build } from "vite";
import { archiveMemberList } from "./lib/interaction-archive-paths.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const fileHash = async file => { const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest("hex"); };
const normalized = name => name.replaceAll("\\", "/").replace(/^\.\//, "");
const families = ["ledge", "oos", "shieldExits", "recoveries", "edgeguards", "beforeOpening"];
const empty = () => ({ games: 0, defenseGames: 0, recoveryGames: 0, punishGames: 0,
  ...Object.fromEntries(families.map(key => [key, {}])) });
function add(target, player) {
  target.games++;
  for (const [field, group, keys] of [
    ["defenseGames", player.defense, ["ledge", "oos", "shieldExits"]],
    ["recoveryGames", player.recovery, ["recoveries", "edgeguards"]],
    ["punishGames", player.punish, ["beforeOpening"]],
  ]) {
    if (!group) continue;
    target[field]++;
    for (const family of keys) for (const [option, counters] of Object.entries(group[family])) {
      const row = target[family][option] ??= {};
      for (const [key, value] of Object.entries(counters)) row[key] = (row[key] ?? 0) + value;
    }
  }
}
if (!isMainThread) {
  const { parseReplay } = await import(pathToFileURL(workerData.parser).href);
  const results = [];
  for (const item of workerData.items) {
    const bytes = await readFile(item.extracted);
    if (hash(bytes) !== item.sha256) throw new Error("Staged replay changed after verification");
    const rec = parseReplay(item.gameKey, "archive-sample.slp", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (rec.parseError || rec.statsVersion !== workerData.statsVersion || rec.isTeams || rec.players.length !== 2
      || rec.playedAt !== item.expected.playedAt || rec.stageId !== item.expected.stageId || rec.durationFrames !== item.expected.durationFrames
      || rec.players.some((p, index) => p.characterId !== item.expected.characters[index])) {
      throw new Error(`Replay metadata or parser-version mismatch in ${item.bundle}`);
    }
    results.push({ gameKey: item.gameKey, stageId: rec.stageId, players: rec.players.map(p => ({
      characterId: p.characterId, defense: p.defense, recovery: p.recovery, punish: p.punish,
    })) });
  }
  parentPort.postMessage(results);
} else {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith("--") || process.argv[i + 1] === undefined) throw new Error("Use --cache DIR [--pro-evidence FILE.local.json] [--prepare-only true] [--cached-only true] [--bundle-count N (default all)] [--per-bundle 100] [--extract-workers 4] [--tar-encoding utf-8|windows-1252] [--output FILE]");
    args.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
  if (!args.has("cache")) throw new Error("--cache is required; source inputs are never downloaded by this command");
  if (args.has("cached-only") && !["true", "false"].includes(args.get("cached-only"))) throw new Error("--cached-only must be true or false");
  const cache = path.resolve(args.get("cache"));
  // Freeze the sample seed and staging location across detector upgrades.
  const staging = path.join(cache, "interaction-sample-v8");
  const bundleCount = Number(args.get("bundle-count") ?? Number.MAX_SAFE_INTEGER), perBundle = Number(args.get("per-bundle") ?? 100);
  const extractWorkers = Number(args.get("extract-workers") ?? 4);
  const tarEncoding = args.get("tar-encoding") ?? (process.platform === "win32" ? "windows-1252" : "utf-8");
  if (!["utf-8", "windows-1252"].includes(tarEncoding)) throw new Error("--tar-encoding must be utf-8 or windows-1252");
  if (![bundleCount, perBundle, extractWorkers].every(n => Number.isSafeInteger(n) && n > 0) || extractWorkers > 4) throw new Error("Sample sizes must be positive integers; extraction concurrency must be 1–4");
  const indexBytes = await readFile(path.join(cache, "interaction-population.local.json"));
  const index = JSON.parse(indexBytes);
  const auditBytes = await readFile(path.join(cache, "source-audit-2026-10-22.json"));
  const audit = JSON.parse(auditBytes);
  const proBytes = await readFile(path.join(cache, "public-export-v10/archive_game_players.ndjson"));
  const supplementalBytes = args.has("pro-evidence") ? await readFile(path.resolve(args.get("pro-evidence"))) : null;
  const supplemental = supplementalBytes ? JSON.parse(supplementalBytes) : null;
  if (supplemental && (supplemental.schemaVersion !== 1 || supplemental.sourceDataset !== index.sourceDataset
    || supplemental.populationSha256 !== hash(indexBytes) || !Array.isArray(supplemental.rows))) {
    throw new Error("Supplemental Pro evidence must match the frozen source population");
  }
  const identityEvidenceSha256 = hash(supplementalBytes ? Buffer.concat([proBytes, Buffer.from("\n"), supplementalBytes]) : proBytes);
  // The export is staging data (published=false for every row). Identity evidence,
  // not that deployment flag, defines the curated named-player sample.
  const pros = new Map();
  const eligibleProGames = new Set(index.games.filter(game => ["verified", "probable"].includes(game.tier)).map(game => game.gameKey));
  if (supplemental?.rows.some(row => !eligibleProGames.has(row.game_key))) throw new Error("Supplemental identities must belong to conservative singles");
  for (const p of [...proBytes.toString().trim().split(/\r?\n/).map(JSON.parse), ...(supplemental?.rows ?? [])]) {
    if (!eligibleProGames.has(p.game_key)) continue;
    if (!p.player_id || !["verified", "probable"].includes(p.identity_resolution) || !p.identity_source_url) continue;
    const slots = pros.get(p.game_key) ?? [];
    if (![0, 1].includes(p.slot) || !Number.isSafeInteger(p.character_id)) throw new Error("Invalid Pro evidence player slot");
    const prior = slots.find(slot => slot.slot === p.slot);
    if (prior && (prior.playerId !== p.player_id || prior.characterId !== p.character_id)) throw new Error("Conflicting Pro identity evidence");
    if (!prior) slots.push({ slot: p.slot, playerId: p.player_id, characterId: p.character_id });
    pros.set(p.game_key, slots);
  }
  const grouped = new Map();
  for (const g of index.games) {
    if (!/^[^/\\]+\.(?:7z|zip)$/i.test(g.bundle)) throw new Error("Invalid bundle name");
    const group = grouped.get(g.bundle) ?? [];
    group.push(g); grouped.set(g.bundle, group);
  }
  const bundles = (await Promise.all([...grouped.keys()].map(async name => ({ name, bytes: (await stat(path.join(cache, "downloads", name))).size }))))
    .sort((a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name)).slice(0, bundleCount);
  const selected = new Map(), counts = [];
  for (const bundle of bundles) {
    const all = grouped.get(bundle.name);
    const tournament = all.filter(g => ["verified", "probable"].includes(g.tier));
    const ranked = (games, cohort) => [...games].sort((a, b) => hash(`interactions-v8:${cohort}:${a.gameKey}`).localeCompare(hash(`interactions-v8:${cohort}:${b.gameKey}`))).slice(0, perBundle);
    const take = (game, cohort) => { const entry = selected.get(game.gameKey) ?? { ...game, venue: false, tournament: false, proSlots: [] }; entry[cohort] = true; selected.set(game.gameKey, entry); };
    // Keep these two draws and their seeds frozen. The displayed Tournament
    // cohort is their union, not their sum and not a new random sample.
    const venueDraw = ranked(all, "venue"), tournamentDraw = ranked(tournament, "tournament");
    const venueKeys = new Set(venueDraw.map(game => game.gameKey));
    const overlap = tournamentDraw.filter(game => venueKeys.has(game.gameKey)).length;
    for (const game of venueDraw) take(game, "venue");
    for (const game of tournamentDraw) take(game, "tournament");
    for (const game of tournament) if (pros.has(game.gameKey)) {
      const entry = selected.get(game.gameKey) ?? { ...game, venue: false, tournament: false, proSlots: [] };
      entry.proSlots = pros.get(game.gameKey); selected.set(game.gameKey, entry);
    }
    counts.push({ bundle: bundle.name, availableVenueGames: all.length, availableTournamentGames: tournament.length,
      sampledVenueGames: venueDraw.length, sampledTournamentGames: tournamentDraw.length,
      sampledOverlapGames: overlap, sampledUnionGames: venueDraw.length + tournamentDraw.length - overlap });
  }
  await mkdir(staging, { recursive: true });
  const command = (program, argv) => new Promise((resolve, reject) => {
    const child = spawn(program, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; let stderr = Buffer.alloc(0);
    child.stdout.on("data", chunk => { stdout.push(chunk); });
    child.stderr.on("data", chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-8000); });
    child.on("error", reject); child.on("close", code => code === 0
      ? resolve(new TextDecoder(tarEncoding).decode(Buffer.concat(stdout)))
      : reject(new Error(`${program}: ${code}: ${new TextDecoder(tarEncoding).decode(stderr)}`)));
  });
  console.log(`Preparing ${selected.size} unique games across ${bundles.length} bundles (up to ${perBundle} games per cohort per bundle)`);
  let stagedBundles = 0;
  const stageBundle = async (bundle) => {
    const source = audit.sources.find(s => s.sourceFilename === bundle.name);
    if (!source || bundle.bytes !== source.compressed_bytes) throw new Error("Archive does not match source audit size");
    const items = [...selected.values()].filter(g => g.bundle === bundle.name);
    const archive = path.join(cache, "downloads", bundle.name);
    bundle.sha256 = await fileHash(archive);
    const names = (await command("tar", ["-tf", archive])).split(/\r?\n/).filter(Boolean);
    for (const name of names) {
      const n = normalized(name);
      if (n.startsWith("/") || /^[a-z]:/i.test(n) || n.split("/").includes("..") || /[\r\n]/.test(n)) throw new Error("Unsafe archive member");
    }
    if (names.filter(n => /\.slp(?:z)?$/i.test(n)).length !== source.replay_file_count) throw new Error("Archive replay count differs from source audit");
    if (names.some(n => /\.slpz$/i.test(n))) throw new Error("This archive builder supports .slp members only; compressed replay members need an explicit decoder");
    if ((await command("tar", ["-tvf", archive])).split(/\r?\n/).filter(Boolean).some(line => !/^[d-]/.test(line))) throw new Error("Archive links or special objects are not supported");
    const members = new Map(names.map(n => [normalized(n), n]));
    const root = path.join(staging, bundle.name.replace(/\.(?:7z|zip)$/i, ""));
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Staging directory must not be a link");
    const receiptFile = path.join(staging, `${path.basename(root)}.hashes.local.json`);
    const prior = await readFile(receiptFile, "utf8").then(JSON.parse).catch(() => null);
    const records = JSON.parse(await readFile(path.join(cache, "results-v6", `${path.basename(root)}.json`), "utf8")).records;
    const byFile = new Map(records.map(r => [normalized(r.file), r]));
    const wanted = []; let fullUnicodeExtraction = false;
    for (const item of items) {
      let name = members.get(normalized(item.file));
      const record = byFile.get(normalized(item.file));
      if (!name && process.platform === "win32" && tarEncoding === "windows-1252") {
        // Native tar can extract Unicode filenames that its console code page
        // cannot list or select. Use the fully audited archive for these rare
        // bundles, then verify the real Unicode paths and replay metadata.
        const candidate = normalized(item.file);
        if (candidate.startsWith("/") || candidate.includes(":") || candidate.split("/").includes("..")
          || ["\0", "\r", "\n"].some(char => candidate.includes(char))) throw new Error("Unsafe audited member name");
        try { archiveMemberList([candidate], tarEncoding); }
        catch (error) {
          if (!error.message.includes("cannot be represented")) throw error;
          name = candidate; fullUnicodeExtraction = true;
        }
      }
      if (!name || !record?.ok || record.isTeams) throw new Error(`Missing audited member in ${bundle.name}`);
      const destination = path.resolve(root, normalized(name));
      if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Extraction target escapes staging directory");
      item.extracted = destination;
      item.expected = { playedAt: record.playedAt, stageId: record.stageId, durationFrames: record.durationFrames, characters: record.players.map(p => p.characterId), bytes: record.bytes };
      const stored = await lstat(destination).catch(() => null);
      if (stored?.isSymbolicLink()) throw new Error("Staged replay must not be a link");
      if (prior?.archiveSha256 !== bundle.sha256 || stored?.size !== record.bytes
        || !prior?.members?.[normalized(name)] || await fileHash(destination) !== prior.members[normalized(name)]) wanted.push(name);
    }
    if (wanted.length) {
      if (fullUnicodeExtraction) {
        const expectedBytes = records.reduce((sum, record) => sum + (record.bytes ?? 0), 0);
        const disk = await statfs(staging);
        if (disk.bavail * disk.bsize < expectedBytes + 8 * 1024 ** 3) throw new Error("Insufficient room for Unicode archive extraction");
        console.log(`${bundle.name}: extracting audited archive to preserve Unicode member names`);
        await command("tar", ["-xf", archive, "-C", root]);
      } else {
        const list = path.join(staging, `${path.basename(root)}.members.local.txt`);
        await writeFile(list, archiveMemberList(wanted, tarEncoding));
        await command("tar", ["-xf", archive, "-C", root, "-T", list]);
      }
    }
    const hashes = {};
    for (const item of items) {
      if ((await stat(item.extracted)).size !== item.expected.bytes) throw new Error("Extracted replay size differs from audited record");
      item.sha256 = await fileHash(item.extracted);
      hashes[normalized(item.file)] = item.sha256;
    }
    await writeFile(receiptFile, JSON.stringify({ archiveSha256: bundle.sha256, members: hashes }));
    console.log(`[${++stagedBundles}/${bundles.length}] ${bundle.name}: ${items.length} selected replays staged`);
  };
  // Largest solid archives first avoids leaving one long extraction at the end.
  // Keep the separate, size-ascending bundle list for deterministic provenance.
  const extractionQueue = [...bundles].reverse();
  let nextBundle = 0;
  const staged = await Promise.allSettled(Array.from({ length: Math.min(extractWorkers, bundles.length) }, async () => {
    while (nextBundle < extractionQueue.length) {
      const bundle = extractionQueue[nextBundle++];
      try { await stageBundle(bundle); }
      catch (error) { console.error(`Staging failed for ${bundle.name}: ${error.message}`); throw error; }
    }
  }));
  const failure = staged.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  const items = [...selected.values()];
  await writeFile(path.join(staging, "manifest.local.json"), JSON.stringify({ sourceDataset: index.sourceDataset, counts, items }));
  console.log(`${items.length} unique games selected across ${bundles.length} bundles`);
  if (args.get("prepare-only") === "true") process.exit(0);
  const parserSources = ["parse.ts", "types.ts", "interactionAnalysis.ts", "defensiveInteractions.ts", "recoveryInteractions.ts", "punishContext.ts"];
  const fingerprint = async () => hash(Buffer.concat(await Promise.all(parserSources.map(f => readFile(path.join("src/lib", f))))));
  const parserSha256 = await fingerprint();
  const buildDir = await mkdtemp(path.resolve(".nikki-full-parse-interactions-"));
  const resolvedBuild = path.resolve(buildDir);
  if (path.dirname(resolvedBuild) !== process.cwd() || !path.basename(resolvedBuild).startsWith(".nikki-full-parse-interactions-")) throw new Error("Unexpected parser cleanup path");
  try {
    await build({ configFile: false, logLevel: "silent", build: { ssr: path.resolve("src/lib/parse.ts"), outDir: buildDir, emptyOutDir: true, minify: false,
      rollupOptions: { external: ["@slippi/slippi-js"], output: { entryFileNames: "parse.mjs" } } } });
    const resultCacheFile = path.join(staging, "parsed-cache.local.json");
    const previousResults = await readFile(resultCacheFile, "utf8").then(JSON.parse).catch(() => null);
    const cached = new Map(previousResults?.parserSha256 === parserSha256
      ? previousResults.results.map(result => [result.gameKey, result]) : []);
    const results = [], pending = [];
    for (const item of items) {
      const prior = cached.get(item.gameKey);
      if (prior?.rawSha256 === item.sha256 && prior.stageId === item.expected.stageId
        && prior.players.length === 2 && prior.players.every((p, i) => p.characterId === item.expected.characters[i])) {
        const { rawSha256: _rawSha256, ...result } = prior;
        results.push(result);
      } else pending.push(item);
    }
    console.log(`Reusing ${results.length} verified parses; ${pending.length} games require analysis`);
    if (args.get("cached-only") === "true" && pending.length) throw new Error("Cached-only rebuild requires a matching verified parse for every selected replay");
    const checkpoint = async () => {
      if (parserSha256 !== await fingerprint()) throw new Error("Parser changed during benchmark run; refuse to save mixed classifiers");
      const tmp = `${resultCacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify({ parserSha256, results: [...cached.values()] }));
      await rename(tmp, resultCacheFile);
    };
    const width = 6;
    // Bounded batches keep Slippi allocations from accumulating across thousands of games.
    for (let offset = 0; offset < pending.length; offset += width * 20) {
      const batch = pending.slice(offset, offset + width * 20);
      const lanes = Array.from({ length: Math.min(width, batch.length) }, () => []);
      batch.forEach((item, i) => lanes[i % lanes.length].push(item));
      const done = await Promise.all(lanes.map(lane => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { parser: path.join(buildDir, "parse.mjs"), statsVersion: 9, items: lane } });
        let received = false;
        worker.on("message", rows => { received = true; resolve(rows); }); worker.on("error", reject);
        worker.on("exit", code => { if (code || !received) reject(new Error(`Parser worker exited ${code}`)); });
      })));
      for (const result of done.flat()) {
        results.push(result);
        cached.set(result.gameKey, { ...result, rawSha256: selected.get(result.gameKey).sha256 });
      }
      await checkpoint();
      console.log(`Parsed ${results.length}/${items.length}`);
    }
    if (parserSha256 !== await fingerprint()) throw new Error("Parser changed during benchmark run; rerun to avoid mixing classifiers");
    // Keep floating-point damage sums reproducible across cold and resumed runs.
    results.sort((a, b) => a.gameKey.localeCompare(b.gameKey));
    const rows = new Map(), proPlayers = new Set(), totals = { tournament: empty(), pro: empty() };
    for (const result of results) {
      const item = selected.get(result.gameKey);
      for (const [slot, player] of result.players.entries()) {
        const cohorts = [(item.venue || item.tournament) && "tournament"];
        const pro = item.proSlots.find(p => p.slot === slot);
        if (pro) {
          if (pro.characterId !== player.characterId || !item.tournament && !["verified", "probable"].includes(item.tier)) throw new Error("Pro evidence mismatch");
          proPlayers.add(pro.playerId); cohorts.push("pro");
        }
        for (const cohort of cohorts.filter(Boolean)) {
          const dimensions = { cohort, characterId: player.characterId, opponentCharacterId: result.players[1 - slot].characterId, stageId: result.stageId };
          const key = JSON.stringify(dimensions), row = rows.get(key) ?? { ...dimensions, ...empty() };
          add(row, player); add(totals[cohort], player); rows.set(key, row);
        }
      }
    }
    const output = { schemaVersion: 2, statsVersion: 9, generatedAt: new Date().toISOString(), sourceDataset: index.sourceDataset,
      sourceUrl: "https://replays.nikki.sh/",
      method: `Experimental archive sample covering ${bundles.length === grouped.size ? `all ${bundles.length} eligible audited bundles` : `the ${bundles.length} smallest eligible audited bundles`}. Tournament is the deduplicated union of the frozen Venue and conservative Tournament draws, each selecting up to ${perBundle} singles games per bundle by hash. Each game/player side enters Tournament once even if selected by both draws. This includes eligible event-venue recordings without set-level proof. Pro Tournament includes all evidence-mapped player sides in those bundles' conservative tournament games. Per-bundle sampling caps and archive coverage can bias estimates; counts pool opportunities, not players. Tournament and Pro Tournament may overlap and are not skill ranks. All dates; exact character, opponent and stage filters.`,
      sample: { bundles: bundles.length, games: items.length, availableGames: index.games.length, proPlayers: proPlayers.size },
      provenance: { parserSha256, populationSha256: hash(indexBytes), sourceAuditSha256: hash(auditBytes), identityEvidenceSha256, archives: bundles.map(b => ({ bundle: b.name, sha256: b.sha256 })), perBundle, counts,
        cohortPlayerGames: Object.fromEntries(Object.entries(totals).map(([cohort, row]) => [cohort, row.games])) },
      rows: [...rows.values()].sort((a, b) => a.cohort.localeCompare(b.cohort) || a.characterId - b.characterId || a.opponentCharacterId - b.opponentCharacterId || a.stageId - b.stageId),
    };
    const outputFile = path.resolve(args.get("output") ?? "src/data/interaction-benchmarks.json");
    const { encodeInteractionBenchmarks } = await import("../src/lib/interactionBenchmarkCodec.mjs");
    const outputTmp = `${outputFile}.tmp`;
    await writeFile(outputTmp, JSON.stringify(encodeInteractionBenchmarks(output)));
    await writeFile(path.join(staging, "receipt.local.json"), JSON.stringify({ parserSha256, totals, results }));
    await rename(outputTmp, outputFile);
    console.log(JSON.stringify({ rows: output.rows.length, sample: output.sample, cohortPlayerGames: output.provenance.cohortPlayerGames, bytes: (await stat(outputFile)).size }));
  } finally {
    await rm(resolvedBuild, { recursive: true, force: true });
  }
}
