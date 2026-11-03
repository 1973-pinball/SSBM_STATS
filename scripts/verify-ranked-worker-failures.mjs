/** A failed parser must reject queued work, not strand an unattended ingest. */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerPool } from "./build-ranked-baselines.mjs";

const pool = new WorkerPool(1, path.join(tmpdir(), `missing-ranked-parser-${process.pid}.mjs`));
let timer;
try {
  const outcomes = await Promise.race([
    Promise.allSettled(Array.from({ length: 20 }, () => pool.run(Buffer.alloc(16)))),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker failure stranded queued work")), 5000); }),
  ]);
  assert.equal(outcomes.length, 20); assert.ok(outcomes.every(result => result.status === "rejected"));
  await assert.rejects(pool.run(Buffer.alloc(16)), /Cannot find module|missing-ranked-parser/);
} finally { clearTimeout(timer); await pool.close(); }
console.log("Ranked worker failures reject active, queued, and subsequent work without hanging.");
