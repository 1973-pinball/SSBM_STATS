/** An explicitly reviewed subset of an existing public archive, never a silent partial rebuild. */
export const archiveBundleStem = (name) => String(name).replace(/\.(?:7z|zip|json)$/i, "");

export function planArchiveSourcePopulation(audit, excludedNames, resultFiles) {
  if (!audit?.dataset?.id || !Array.isArray(audit.sources) || audit.sources.length !== audit.dataset.archive_count) {
    throw new Error("Source audit must contain the complete original dataset bundle list");
  }
  const sourceByStem = new Map();
  const prefix = `${audit.dataset.id}:`;
  for (const source of audit.sources) {
    if (!source.id?.startsWith(prefix)) throw new Error(`Source audit bundle has a different dataset: ${source.id}`);
    const stem = source.id.slice(prefix.length);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(stem) || sourceByStem.has(stem)) throw new Error(`Invalid or duplicate source bundle: ${stem}`);
    if (!Number.isSafeInteger(source.replay_file_count) || source.replay_file_count < 0
      || !Number.isSafeInteger(source.compressed_bytes) || source.compressed_bytes <= 0) throw new Error(`Invalid source counts: ${stem}`);
    if (source.sourceFilename !== null && archiveBundleStem(source.sourceFilename) !== stem) throw new Error(`Source filename disagrees with bundle: ${stem}`);
    sourceByStem.set(stem, source);
  }
  const excludedBundles = [...new Set(excludedNames.map(archiveBundleStem))].sort();
  for (const stem of excludedBundles) if (!sourceByStem.has(stem)) throw new Error(`Excluded bundle is not in the original dataset: ${stem}`);
  const excluded = new Set(excludedBundles);
  const includedBundles = [...sourceByStem.keys()].filter((stem) => !excluded.has(stem)).sort();
  if (!includedBundles.length) throw new Error("Source selection cannot exclude every bundle");
  const actual = resultFiles.map(archiveBundleStem).sort();
  const actualSet = new Set(actual);
  const includedSet = new Set(includedBundles);
  const missing = includedBundles.filter((stem) => !actualSet.has(stem));
  const unexpected = actual.filter((stem) => !includedSet.has(stem));
  if (missing.length || unexpected.length || actual.length !== actualSet.size) {
    throw new Error(`Parsed bundle cohort differs from the reviewed source selection; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`);
  }
  const includedSources = includedBundles.map((stem) => sourceByStem.get(stem));
  return {
    sourceByStem,
    metadata: {
      baseDatasetId: audit.dataset.id,
      originalBundleCount: audit.sources.length,
      includedBundles,
      excludedBundles,
      expectedReplayFiles: includedSources.reduce((sum, source) => sum + source.replay_file_count, 0),
      expectedCompressedBytes: includedSources.reduce((sum, source) => sum + source.compressed_bytes, 0),
    },
  };
}

export function assertArchiveSourcePayload(plan, resultFile, payload) {
  const stem = archiveBundleStem(resultFile);
  const source = plan.sourceByStem.get(stem);
  if (!source || !plan.metadata.includedBundles.includes(stem) || archiveBundleStem(payload.bundle) !== stem) {
    throw new Error(`Parsed payload does not belong to the selected source bundle: ${resultFile}`);
  }
  if (source.sourceFilename && payload.bundle !== source.sourceFilename) throw new Error(`Source filename drift for ${stem}`);
  if (payload.replayFiles !== source.replay_file_count) {
    throw new Error(`Replay-file count drift for ${stem}: parsed=${payload.replayFiles}, original=${source.replay_file_count}`);
  }
}

export function assertArchiveSourceDownload(plan, bundle, actualBytes) {
  const source = plan.sourceByStem.get(archiveBundleStem(bundle));
  if (!source || actualBytes !== source.compressed_bytes) {
    throw new Error(`Compressed byte count drift for ${bundle}: local=${actualBytes}, original=${source?.compressed_bytes}`);
  }
}
