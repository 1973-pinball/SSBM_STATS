/**
 * Reanalysis matches saved file identities, not game-content identities. A
 * cloud-restored or moved-path survivor can therefore have an already-seen
 * local alias that is absent from the explicit repair queue. Report that case
 * instead of completing a zero-work scan without explaining the next action.
 */
export function interactionAnalysisFeedback(
  requestedIds: Iterable<string>,
  discoveredIds: Iterable<string>,
  completedIds: Iterable<string>,
): string | null {
  const requested = new Set(requestedIds);
  const found = new Set(discoveredIds);
  const completed = new Set(completedIds);
  let missing = 0, unfinished = 0;
  for (const id of requested) {
    // A newly parsed alias may have established the same content identity even
    // though the saved source path is absent. Do not warn after that success.
    if (completed.has(id)) continue;
    if (!found.has(id)) missing++;
    else unfinished++;
  }
  const messages: string[] = [];
  if (missing) messages.push(`${missing.toLocaleString()} replay${missing === 1 ? "" : "s"} could not be matched to ${missing === 1 ? "its" : "their"} saved ${missing === 1 ? "path" : "paths"}. In Interactions, use Select replay files to analyze moved or cloud-restored replays.`);
  if (unfinished) messages.push(`Analysis could not finish for ${unfinished.toLocaleString()} matched replay${unfinished === 1 ? "" : "s"}. Retry after any recording has finished, or use Select replay files to choose another copy.`);
  return messages.length ? `${messages.join(" ")} Your saved stats are still available.` : null;
}
