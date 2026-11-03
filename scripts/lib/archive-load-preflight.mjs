import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Inspect the actual staged rows; a version label alone does not prove their shape. */
export async function inspectArchiveExportRows(file, inspectRollups = false) {
  let count = 0, hasPooledPro = false;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    count++;
    if (inspectRollups && !hasPooledPro && JSON.parse(line).scope === "pro") hasPooledPro = true;
  }
  return { count, hasPooledPro };
}

/** Call before any upsert. Legacy exports do not depend on the new migration. */
export async function requirePooledProArchiveSupport(client, required) {
  if (!required) return;
  const { data, error } = await client.rpc("archive_supports_pooled_pro_rollups");
  if (error || data !== true) {
    throw new Error("The live archive has not confirmed pooled Pro rollup support. "
      + "Apply supabase/archive-pro-rollups-upgrade.sql through a SQL administrator before loading this export. "
      + (error ? `Capability check failed: ${error.message}` : "The capability check did not return true."));
  }
}
