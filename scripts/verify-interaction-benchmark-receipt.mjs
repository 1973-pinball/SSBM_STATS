#!/usr/bin/env node
/** Optional local audit. Reconstruct membership and rollups without exposing replay/player identities.
 * node scripts/verify-interaction-benchmark-receipt.mjs --cache DIR [--pro-evidence FILE.local.json] [--verify-files true]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "vite";
import { INTERACTION_FAMILIES, validateShippedInteractionSample, assertNoInteractionIdentityValues } from "./lib/interaction-benchmark-validation.mjs";
import { decodeInteractionBenchmarks } from "../src/lib/interactionBenchmarkCodec.mjs";
import { assembleInteractionProEvidence } from "./lib/interaction-pro-evidence.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i]?.startsWith("--") && process.argv[i + 1] !== undefined,
    "Use --cache DIR [--data FILE] [--pro-evidence FILE.local.json] [--verify-files true]");
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
assert.ok(args.has("cache"), "--cache is required; the audit reads existing local inputs only");
const cache = path.resolve(args.get("cache"));
const staging = path.join(cache, "interaction-sample-v8");
const verifyFiles = args.get("verify-files") === "true";
const hash = value => createHash("sha256").update(value).digest("hex");
const fileHash = async file => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
};
const normalized = name => name.replaceAll("\\", "/").replace(/^\.\//, "");
const conservative = game => ["verified", "probable"].includes(game.tier);
const tupleKey = row => [row.cohort, row.characterId, row.opponentCharacterId, row.stageId].join("|");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

const [dataText, manifestText, receiptText, populationBytes, sourceAuditBytes] = await Promise.all([
  readFile(path.resolve(args.get("data") ?? "src/data/interaction-benchmarks.json"), "utf8"),
  readFile(path.join(staging, "manifest.local.json"), "utf8"),
  readFile(path.join(staging, "receipt.local.json"), "utf8"),
  readFile(path.join(cache, "interaction-population.local.json")),
  readFile(path.join(cache, "source-audit-2026-10-22.json")),
]);
const data = decodeInteractionBenchmarks(JSON.parse(dataText)), manifest = JSON.parse(manifestText), receipt = JSON.parse(receiptText);
const population = JSON.parse(populationBytes), sourceAudit = JSON.parse(sourceAuditBytes);
const server = await createServer({ configFile: false, appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { INTERACTION_STATS_VERSION } = await server.ssrLoadModule("/src/lib/types.ts");
  const { LEDGE_OPTION_LABELS, OOS_OPTION_LABELS } = await server.ssrLoadModule("/src/lib/defensiveInteractions.ts");
  const { RECOVERY_ROUTE_LABELS, EDGEGUARD_TACTIC_LABELS } = await server.ssrLoadModule("/src/lib/recoveryInteractions.ts");
  const { PUNISH_ACTION_LABELS } = await server.ssrLoadModule("/src/lib/punishContext.ts");
  const { parseInteractionBenchmarkData } = await server.ssrLoadModule("/src/lib/interactionBenchmarks.ts");
  assert.ok(parseInteractionBenchmarkData(data), "shipped data must pass the browser's reader");
  validateShippedInteractionSample(data, { statsVersion: INTERACTION_STATS_VERSION, optionKeys: {
    ledge: LEDGE_OPTION_LABELS.map(row => row.key), oos: OOS_OPTION_LABELS.map(row => row.key), shieldExits: OOS_OPTION_LABELS.map(row => row.key),
    recoveries: Object.keys(RECOVERY_ROUTE_LABELS), edgeguards: Object.keys(EDGEGUARD_TACTIC_LABELS), beforeOpening: Object.keys(PUNISH_ACTION_LABELS),
  } });
  assert.equal(data.provenance.populationSha256, hash(populationBytes));
  assert.equal(data.provenance.sourceAuditSha256, hash(sourceAuditBytes));
  assert.equal(data.sourceDataset, population.sourceDataset);
  assert.equal(manifest.sourceDataset, data.sourceDataset);
  assert.equal(receipt.parserSha256, data.provenance.parserSha256);
  const parserSources = ["parse.ts", "types.ts", "interactionAnalysis.ts", "defensiveInteractions.ts", "recoveryInteractions.ts", "punishContext.ts"];
  const currentParser = hash(Buffer.concat(await Promise.all(parserSources.map(file => readFile(path.join("src/lib", file))))));
  assert.equal(currentParser, receipt.parserSha256, "receipt uses the current audited classifiers");
  assert.equal(data.sample.availableGames, population.games.length);

  // Independently choose the smallest bundles, then reconstruct all cohort memberships.
  const byBundle = new Map();
  for (const game of population.games) {
    assert.match(game.bundle, /^[^/\\]+\.(?:7z|zip)$/i);
    const group = byBundle.get(game.bundle) ?? []; group.push(game); byBundle.set(game.bundle, group);
  }
  const sizes = await Promise.all([...byBundle.keys()].map(async bundle => ({ bundle, bytes: (await stat(path.join(cache, "downloads", bundle))).size })));
  sizes.sort((a, b) => a.bytes - b.bytes || a.bundle.localeCompare(b.bundle));
  const bundles = sizes.slice(0, data.sample.bundles);
  assert.deepEqual(data.provenance.archives.map(row => row.bundle), bundles.map(row => row.bundle), "bundle selection matches smallest audited sources");
  const eligiblePros = new Set(bundles.flatMap(bundle => byBundle.get(bundle.bundle).filter(conservative).map(game => game.gameKey)));
  const vetted = new Map(), evidenceDigest = createHash("sha256");
  const evidenceStream = createReadStream(path.join(cache, "public-export-v10/archive_game_players.ndjson"));
  evidenceStream.on("data", chunk => evidenceDigest.update(chunk));
  for await (const line of createInterface({ input: evidenceStream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const player = JSON.parse(line);
    if (!eligiblePros.has(player.game_key) || !player.player_id
      || !["verified", "probable"].includes(player.identity_resolution) || !player.identity_source_url) continue;
    assert.ok(player.slot === 0 || player.slot === 1, "singles evidence must identify a valid player slot");
    const slots = vetted.get(player.game_key) ?? new Map();
    const value = { slot: player.slot, playerId: player.player_id, characterId: player.character_id };
    if (slots.has(player.slot)) assert.deepEqual(slots.get(player.slot), value, "conflicting pro identities cannot enter the sample");
    slots.set(player.slot, value); vetted.set(player.game_key, slots);
  }
  if (args.has("pro-evidence")) {
    const supplementalBytes = await readFile(path.resolve(args.get("pro-evidence")));
    evidenceDigest.update("\n"); evidenceDigest.update(supplementalBytes);
    const supplemental = JSON.parse(supplementalBytes);
    const [registryBytes, rankingBytes] = await Promise.all([
      readFile(new URL("./data/interaction-pro-overrides.json", import.meta.url)),
      readFile(path.join(cache, "public-export-v10/archive_player_rankings.ndjson")),
    ]);
    const reconstructed = await assembleInteractionProEvidence({ populationBytes, registryBytes, rankingBytes, sourceAuditBytes,
      readResults: bundle => readFile(path.join(cache, "results-v6", `${bundle.replace(/\.(zip|7z)$/, "")}.json`)),
    });
    assert.ok(isDeepStrictEqual(supplemental, reconstructed),
      "Supplemental identity rows, source hashes and totals must reconstruct exactly from reviewed rules and frozen records");
    assert.equal(supplemental.schemaVersion, 1);
    assert.equal(supplemental.sourceDataset, population.sourceDataset);
    assert.equal(supplemental.populationSha256, hash(populationBytes));
    assert.ok(Array.isArray(supplemental.rows));
    for (const player of supplemental.rows) {
      // Reconstruct all reviewed evidence above, then apply this run's bundle selection.
      if (!eligiblePros.has(player.game_key)) continue;
      assert.ok(player.player_id && ["verified", "probable"].includes(player.identity_resolution) && player.identity_source_url);
      assert.ok(player.slot === 0 || player.slot === 1);
      assert.ok(Number.isSafeInteger(player.character_id));
      const slots = vetted.get(player.game_key) ?? new Map();
      const value = { slot: player.slot, playerId: player.player_id, characterId: player.character_id };
      if (slots.has(player.slot)) assert.deepEqual(slots.get(player.slot), value, "supplemental evidence cannot replace an existing identity");
      slots.set(player.slot, value); vetted.set(player.game_key, slots);
    }
  }
  assert.equal(data.provenance.identityEvidenceSha256, evidenceDigest.digest("hex"));
  const expected = new Map(), expectedCounts = [];
  const membership = gameKey => {
    if (!expected.has(gameKey)) expected.set(gameKey, { venue: false, tournament: false, pros: new Map() });
    return expected.get(gameKey);
  };
  for (const bundle of bundles) {
    const games = byBundle.get(bundle.bundle), tournament = games.filter(conservative);
    for (const [cohort, eligible] of [["venue", games], ["tournament", tournament]]) {
      const picked = eligible.map(game => ({ gameKey: game.gameKey, rank: hash(`interactions-v8:${cohort}:${game.gameKey}`) }))
        .sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, data.provenance.perBundle);
      for (const game of picked) membership(game.gameKey)[cohort] = true;
    }
    for (const game of tournament) if (vetted.has(game.gameKey)) membership(game.gameKey).pros = vetted.get(game.gameKey);
    expectedCounts.push({ bundle: bundle.bundle, availableVenueGames: games.length, availableTournamentGames: tournament.length,
      sampledVenueGames: Math.min(games.length, data.provenance.perBundle), sampledTournamentGames: Math.min(tournament.length, data.provenance.perBundle) });
  }
  assert.deepEqual(manifest.counts, expectedCounts);
  assert.deepEqual(data.provenance.counts, expectedCounts);
  assert.equal(manifest.items.length, expected.size);
  assert.equal(data.sample.games, expected.size);
  const manifests = new Map(manifest.items.map(item => [item.gameKey, item]));
  const results = new Map(receipt.results.map(result => [result.gameKey, result]));
  assert.equal(manifests.size, manifest.items.length, "manifest must contain unique games");
  assert.equal(results.size, receipt.results.length, "parsed receipt must contain unique games");
  assert.deepEqual([...manifests.keys()].sort(), [...expected.keys()].sort());
  assert.deepEqual([...results.keys()].sort(), [...expected.keys()].sort(), "every selected game has exactly one parsed result");
  for (const [gameKey, item] of manifests) {
    const membership = expected.get(gameKey);
    assert.equal(item.venue, membership.venue); assert.equal(item.tournament, membership.tournament);
    assert.deepEqual([...item.proSlots].sort((a, b) => a.slot - b.slot), [...membership.pros.values()].sort((a, b) => a.slot - b.slot));
    assert.ok(byBundle.get(item.bundle)?.some(game => game.gameKey === gameKey && normalized(game.file) === normalized(item.file)
      && game.tier === item.tier), "manifest source must match the canonical population");
    const result = results.get(gameKey);
    assert.equal(result.players.length, 2); assert.equal(result.stageId, item.expected.stageId);
    assert.deepEqual(result.players.map(player => player.characterId), item.expected.characters);
  }

  // Recompute every exact cell and coverage count directly from per-game parsed observations.
  const empty = () => ({ games: 0, defenseGames: 0, recoveryGames: 0, punishGames: 0,
    ...Object.fromEntries(INTERACTION_FAMILIES.map(family => [family, {}])) });
  const rows = new Map(), totals = Object.fromEntries(["venue", "tournament", "pro"].map(cohort => [cohort, empty()]));
  const proIds = new Set();
  const accumulate = (target, player) => {
    target.games++;
    for (const [group, coverage, families] of [["defense", "defenseGames", ["ledge", "oos", "shieldExits"]],
      ["recovery", "recoveryGames", ["recoveries", "edgeguards"]], ["punish", "punishGames", ["beforeOpening"]]]) {
      if (player[group] === undefined) continue;
      target[coverage]++;
      for (const family of families) for (const [option, values] of Object.entries(player[group][family])) {
        const counters = target[family][option] ??= {};
        for (const [counter, value] of Object.entries(values)) counters[counter] = (counters[counter] ?? 0) + value;
      }
    }
  };
  for (const result of receipt.results) {
    const membership = expected.get(result.gameKey);
    for (let slot = 0; slot < 2; slot++) {
      const player = result.players[slot], opponent = result.players[1 - slot];
      const included = [];
      if (membership.venue) included.push("venue");
      if (membership.tournament) included.push("tournament");
      const pro = membership.pros.get(slot);
      if (pro) { assert.equal(pro.characterId, player.characterId); proIds.add(pro.playerId); included.push("pro"); }
      for (const cohort of included) {
        const dimensions = { cohort, characterId: player.characterId, opponentCharacterId: opponent.characterId, stageId: result.stageId };
        const key = tupleKey(dimensions);
        if (!rows.has(key)) rows.set(key, { ...dimensions, ...empty() });
        accumulate(rows.get(key), player); accumulate(totals[cohort], player);
      }
    }
  }
  const sortedRows = values => [...values].sort((a, b) => tupleKey(a).localeCompare(tupleKey(b))).map(canonical);
  assert.deepEqual(sortedRows(rows.values()), sortedRows(data.rows), "every published exact cell equals receipt observations");
  assert.deepEqual(canonical(totals), canonical(receipt.totals), "receipt cohort totals and coverage reconcile");
  assert.deepEqual(Object.fromEntries(Object.entries(totals).map(([cohort, value]) => [cohort, value.games])), data.provenance.cohortPlayerGames);
  assert.equal(proIds.size, data.sample.proPlayers);

  for (const archive of data.provenance.archives) {
    const audited = sourceAudit.sources.find(source => source.sourceFilename === archive.bundle);
    assert.ok(audited, "selected archive has a source audit");
    assert.equal((await stat(path.join(cache, "downloads", archive.bundle))).size, audited.compressed_bytes);
    const stem = archive.bundle.replace(/\.(?:7z|zip)$/i, "");
    const hashes = JSON.parse(await readFile(path.join(staging, `${stem}.hashes.local.json`), "utf8"));
    assert.equal(hashes.archiveSha256, archive.sha256);
    const oldRecords = JSON.parse(await readFile(path.join(cache, "results-v6", `${stem}.json`), "utf8")).records;
    const byFile = new Map(oldRecords.map(record => [normalized(record.file), record]));
    for (const item of manifest.items.filter(value => value.bundle === archive.bundle)) {
      const original = byFile.get(normalized(item.file));
      assert.ok(original?.ok && !original.isTeams);
      assert.deepEqual(item.expected, { playedAt: original.playedAt, stageId: original.stageId, durationFrames: original.durationFrames,
        characters: original.players.map(player => player.characterId), bytes: original.bytes });
      assert.equal(item.sha256, hashes.members[normalized(item.file)]);
      const expectedPath = path.resolve(staging, stem, normalized(item.file));
      assert.ok(expectedPath.startsWith(`${path.resolve(staging, stem)}${path.sep}`));
      assert.equal(path.resolve(item.extracted), expectedPath);
      if (verifyFiles) assert.equal(await fileHash(item.extracted), item.sha256, "staged replay bytes still match the parse receipt");
    }
    if (verifyFiles) assert.equal(await fileHash(path.join(cache, "downloads", archive.bundle)), archive.sha256, "source archive bytes still match provenance");
  }
  // Validate decoded values after the strict key allowlist. The compact option
  // dictionary includes "grab", which is also one player's public ID.
  assertNoInteractionIdentityValues(data, [...manifests.keys(), ...proIds]);
  assert.ok(!dataText.includes(cache) && !dataText.includes(cache.replaceAll("\\", "/")), "local cache path in shipped artifact");
  console.log(JSON.stringify({ status: "passed", games: expected.size, cells: rows.size, proPlayers: proIds.size,
    cohortPlayerGames: data.provenance.cohortPlayerGames, sourceFilesRehashed: verifyFiles }));
} finally {
  await server.close();
}
