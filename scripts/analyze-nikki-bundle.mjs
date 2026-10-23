#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { SlippiGame } from "@slippi/slippi-js/node";
import { build } from "vite";
import { ARCHIVE_STATS_VERSION, assertArchiveSpecialMeasurements } from "./lib/archive-move-coverage.mjs";

const LEGAL_STAGES = new Set([2, 3, 8, 28, 31, 32]);
const PLAYABLE_CHARACTERS = new Set(Array.from({ length: 26 }, (_, id) => id));

const clean = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

const normalizeCode = (value) => clean(value)?.toUpperCase() ?? null;
const userIdHash = (value) => {
  const id = clean(value);
  return id ? createHash("sha256").update(`nikki-archive-v1:${id}`).digest("hex") : null;
};

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function replayFiles(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.slp(?:z)?$/i.test(entry.name)) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

async function parseOne(file, root, bundle, parseFullReplay) {
  const relativeFile = path.relative(root, file);
  const buf = readFileSync(file);
  const bytes = buf.byteLength;
  const data = toArrayBuffer(buf);
  const full = parseFullReplay(`${bundle}/${relativeFile}|${bytes}`, relativeFile, data);

  // GameRecord omits offline nametags and raw Slippi user ids. Read the small
  // settings/metadata/end blocks again so the archive retains identity evidence
  // without retaining frames. Raw user ids are one-way hashed before staging.
  const game = new SlippiGame(data);
  try {
    const settings = game.getSettings();
    if (!settings?.players?.length) throw new Error("no settings block");
    const metadata = game.getMetadata();
    const end = game.getGameEnd({ skipProcessing: true });

    const players = settings.players.map((player, index) => {
      const metadataNames = metadata?.players?.[player.playerIndex]?.names;
      const parsed = full.players[index];
      if (!parsed) throw new Error(`missing parsed player side ${index}`);
      return {
        playerIndex: player.playerIndex,
        ...parsed,
        connectCode: normalizeCode(player.connectCode ?? metadataNames?.code ?? parsed.connectCode),
        displayName: clean(player.displayName ?? metadataNames?.netplay ?? parsed.displayName),
        nametag: clean(player.nametag),
        userIdHash: userIdHash(player.userId),
      };
    });

    const stableSides = players.map((player) =>
      player.connectCode ??
      (player.userIdHash ? `u:${player.userIdHash}` : null) ??
      (player.displayName ? `d:${player.displayName.toLocaleLowerCase("en-US")}` : null) ??
      (player.nametag ? `n:${player.nametag.toLocaleLowerCase("en-US")}` : null) ??
      `p${player.port}:${player.characterId}`,
    ).sort();
    const identityKey = full.playedAt
      ? `${full.playedAt}|${full.stageId}|${full.durationFrames}|${stableSides.join("+")}`
      : null;

    return {
      ok: true,
      file: relativeFile,
      bytes,
      statsVersion: full.statsVersion ?? null,
      slpVersion: clean(settings.slpVersion),
      playedAt: full.playedAt,
      durationFrames: full.durationFrames,
      stageId: full.stageId,
      gameType: full.gameType,
      isTeams: full.isTeams,
      legalStage: LEGAL_STAGES.has(full.stageId),
      playableRoster: players.every((player) => PLAYABLE_CHARACTERS.has(player.characterId)),
      identityKey,
      players,
      winnerIndex: full.winnerIndex,
      winnerTeamId: full.winnerTeamId,
      dmgMatrix: full.dmgMatrix ?? null,
      killMatrix: full.killMatrix ?? null,
      end: end ? {
        method: end.gameEndMethod ?? null,
        lrasInitiatorIndex: end.lrasInitiatorIndex ?? null,
        placements: end.placements ?? null,
      } : null,
      consoleNick: clean(metadata?.consoleNick),
    };
  } finally {
    game.disconnect?.();
  }
}

if (!isMainThread) {
  const { parseReplay: parseFullReplay } = await import(pathToFileURL(workerData.parseModule).href);
  const records = [];
  let processed = 0;
  for (const item of workerData.items) {
    try {
      records.push({ index: item.index, record: await parseOne(item.file, workerData.root, workerData.bundle, parseFullReplay) });
    } catch (error) {
      records.push({
        index: item.index,
        record: {
          ok: false,
          file: path.relative(workerData.root, item.file),
          bytes: (() => {
            try { return statSync(item.file).size; } catch { return null; }
          })(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    processed++;
    if (processed % 100 === 0) parentPort.postMessage({ type: "progress", count: 100 });
  }
  const remainder = processed % 100;
  if (remainder) parentPort.postMessage({ type: "progress", count: remainder });
  parentPort.postMessage({ type: "result", records });
  parentPort.close();
} else {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Usage: analyze-nikki-bundle.mjs --bundle NAME --dir DIR --output FILE [--workers N]");
    }
    args.set(key.slice(2), value);
  }

  const bundle = args.get("bundle");
  const directory = args.get("dir");
  const output = args.get("output");
  if (!bundle || !directory || !output) {
    throw new Error("Usage: analyze-nikki-bundle.mjs --bundle NAME --dir DIR --output FILE [--workers N]");
  }

  const files = await replayFiles(directory);
  const requestedWorkers = Number(args.get("workers") ?? 8);
  const workerCount = Math.min(
    files.length,
    Math.max(1, Math.min(8, availableParallelism(), Number.isFinite(requestedWorkers) ? requestedWorkers : 8)),
  );
  const lanes = Array.from({ length: workerCount }, () => []);
  files.forEach((file, index) => lanes[index % workerCount].push({ index, file }));

  // Vite performs the same TypeScript and extensionless-import resolution the
  // app build uses. Emit one temporary Node module for all parser workers rather
  // than maintaining a second implementation of the dashboard's stat formulas.
  const parserBuildDir = await mkdtemp(path.join(process.cwd(), ".nikki-full-parse-"));
  const parseModule = path.join(parserBuildDir, "parse.mjs");
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      ssr: path.resolve("src/lib/parse.ts"),
      outDir: parserBuildDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        external: ["@slippi/slippi-js"],
        output: { entryFileNames: "parse.mjs" },
      },
    },
  });

  const startedAt = Date.now();
  let parsedCount = 0;
  let lastReported = 0;
  const runLane = (items) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { items, root: directory, bundle, parseModule },
      execArgv: process.execArgv,
    });
    let settled = false;
    worker.on("message", (message) => {
      if (message.type === "progress") {
        parsedCount += message.count;
        if (parsedCount - lastReported >= 500 || parsedCount === files.length) {
          lastReported = parsedCount;
          const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
          process.stderr.write(`${bundle}: ${parsedCount}/${files.length} (${(parsedCount / seconds).toFixed(1)}/s)\n`);
        }
      } else if (message.type === "result") {
        settled = true;
        resolve(message.records);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`parser worker exited with code ${code}`));
    });
  });

  const indexed = (await Promise.all(lanes.map(runLane))).flat();
  indexed.sort((a, b) => a.index - b.index);
  const records = indexed.map(({ record }) => record);
  for (const record of records) {
    if (record.ok) assertArchiveSpecialMeasurements(record, `${bundle}/${record.file}`);
  }
  const payload = {
    schemaVersion: 2,
    statsVersion: ARCHIVE_STATS_VERSION,
    source: "https://replays.nikki.sh/",
    bundle,
    analyzedAt: new Date().toISOString(),
    statProfile: "dashboard-full-derived-v1",
    replayFiles: files.length,
    parsed: records.filter((record) => record.ok).length,
    failed: records.filter((record) => !record.ok).length,
    records,
  };
  await writeFile(output, `${JSON.stringify(payload)}\n`);
  await rm(parserBuildDir, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({
    bundle,
    replayFiles: payload.replayFiles,
    parsed: payload.parsed,
    failed: payload.failed,
    workers: workerCount,
    seconds: (Date.now() - startedAt) / 1000,
    output,
  })}\n`);
}
