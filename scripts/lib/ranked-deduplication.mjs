import assert from "node:assert/strict";
import { sha256 } from "./ranked-source-stream.mjs";

/** A raw stream identifies a wrapper duplicate only when all source evidence
 * and sanitized measurements agree too. Conflicting wrappers fail closed. */
export function createRankedWrapperDeduplicator() {
  const rawStreams = new Map(); let duplicates = 0;
  return {
    add(result, effectiveReasons) {
      if (!result.rawCommandSha256) return true;
      const signature = sha256(JSON.stringify({ tiers: result.tiers, reasons: [...effectiveReasons].sort(), record: result.record }));
      const prior = rawStreams.get(result.rawCommandSha256);
      if (!prior) { rawStreams.set(result.rawCommandSha256, { sha256: result.sha256, signature }); return true; }
      assert.notEqual(prior.sha256, result.sha256, "byte duplicates must be removed before wrapper deduplication");
      assert.equal(prior.signature, signature, "identical raw commands have conflicting wrapper tier evidence, quality gates, or measurements");
      duplicates++; return false;
    },
    get duplicateCopies() { return duplicates; },
  };
}
