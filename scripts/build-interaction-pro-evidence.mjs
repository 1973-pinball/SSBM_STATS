#!/usr/bin/env node
/** Compile reviewed public aliases against the frozen local archive; never changes tournament tiers. */
import assert from "node:assert/strict";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleInteractionProEvidence } from "./lib/interaction-pro-evidence.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(["--cache", "--output", "--registry"].includes(process.argv[i]) && process.argv[i + 1],
    "Use --cache DIR [--output FILE.local.json] [--registry FILE]");
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
assert.ok(args.has("cache"), "--cache is required");
const cache = path.resolve(args.get("cache"));
const output = path.resolve(args.get("output") ?? path.join(cache, "interaction-pro-evidence.local.json"));
assert.ok(output.endsWith(".local.json"), "Per-game identity evidence must stay local: use FILE.local.json");
const registryFile = path.resolve(args.get("registry") ?? fileURLToPath(new URL("./data/interaction-pro-overrides.json", import.meta.url)));
const [populationBytes, registryBytes, rankingBytes, sourceAuditBytes] = await Promise.all([
  readFile(path.join(cache, "interaction-population.local.json")), readFile(registryFile),
  readFile(path.join(cache, "public-export-v10/archive_player_rankings.ndjson")),
  readFile(path.join(cache, "source-audit-2026-10-22.json")),
]);
const data = await assembleInteractionProEvidence({ populationBytes, registryBytes, rankingBytes, sourceAuditBytes,
  readResults: bundle => readFile(path.join(cache, "results-v6", `${bundle.replace(/\.(zip|7z)$/, "")}.json`)),
  onBundle: (bundle, games) => console.log(`Reviewed ${bundle}: ${games} conservative singles`),
});
await mkdir(path.dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, JSON.stringify(data));
await rename(`${output}.tmp`, output);
console.log(JSON.stringify({ status: "passed", ...data.summary }));
