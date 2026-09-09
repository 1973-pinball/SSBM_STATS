import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../liquipedia-data.mjs";

export const DEFAULT_ROOT = path.join(ROOT, ".forecast");
export const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export async function writeJson(file, value) {
  return writeText(file, JSON.stringify(value) + "\n");
}

export async function writeText(file, value) {
  if (typeof value !== "string") throw new TypeError("Expected text output");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, value, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

// Never expose research output via Vite/public or a tracked repository subtree.
// Alternative roots must be outside this checkout; the default .forecast is ignored.
export async function researchRoot(value = DEFAULT_ROOT) {
  const requested = path.resolve(value);
  let ancestor = requested;
  while (true) {
    try { await stat(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
  }
  const actual = path.resolve(await realpath(ancestor), path.relative(ancestor, requested));
  const relative = path.relative(ROOT, actual);
  const inRepo = relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  if (inRepo && actual !== DEFAULT_ROOT) throw new Error("Research output inside the repo must use the ignored .forecast directory");
  if (requested === DEFAULT_ROOT && actual !== DEFAULT_ROOT) throw new Error("Refusing a symlinked .forecast directory");
  if (actual === path.parse(actual).root || actual === path.dirname(ROOT)) throw new Error("Choose a dedicated research directory");
  return actual;
}

// Read this variable only, without shell expansion, printing, or loading VITE_ vars.
export async function loadToken(envFile = path.join(ROOT, ".env.forecast.local")) {
  if (process.env.STARTGG_TOKEN?.trim()) return process.env.STARTGG_TOKEN.trim();
  let body;
  try { body = await readFile(envFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  const matches = body.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?STARTGG_TOKEN\s*=/.test(line));
  if (matches.length > 1) throw new Error("Duplicate STARTGG_TOKEN entries in local environment file");
  if (!matches.length) return undefined;
  let value = matches[0].slice(matches[0].indexOf("=") + 1).trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const match = value.match(/^(["'])([^\r\n]*)\1\s*(?:#.*)?$/);
    if (!match) throw new Error("Invalid quoted STARTGG_TOKEN in local environment file");
    value = match[2];
  } else value = value.replace(/\s+#.*$/, "").trim();
  return value || undefined;
}
