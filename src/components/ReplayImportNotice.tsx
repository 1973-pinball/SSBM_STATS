import type { ReplayImportReport } from "../lib/importReport";

interface Props {
  report: ReplayImportReport;
  onDismiss: () => void;
  onAccounts: () => void;
  onClearFilters: () => void;
  onIncludeCpu: () => void;
  onSwitchFormat: () => void;
}

const count = (n: number) => n.toLocaleString();
const dateLabel = (value: string) => new Date(value).toLocaleString(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** Local, per-selection feedback: old games must not hide a failed new import. */
export function ReplayImportNotice({ report, onDismiss, onAccounts, onClearFilters, onIncludeCpu, onSwitchFormat }: Props) {
  const { progress, exclusions } = report;
  const parsed = Math.max(0, progress.done - progress.failed - progress.unreadable - progress.deferred);
  return (
    <section className="panel" aria-label="Replay import report">
      <h2>Replay import report</h2>
      <p role="status">
        {count(parsed)} file{parsed === 1 ? "" : "s"} parsed · {count(progress.skippedCached)} already scanned
        {progress.failed > 0 && ` · ${count(progress.failed)} failed`}
        {progress.unreadable > 0 && ` · ${count(progress.unreadable)} unreadable`}
        {progress.deferred > 0 && ` · ${count(progress.deferred)} incomplete or still being written`}
      </p>
      {report.inspectedGames > 0 && (
        <p>
          {count(report.includedGames)} of {count(report.inspectedGames)} inspected games matched your accounts and game selection at import time.
          {report.cachedGames > 0 && ` This includes ${count(report.cachedGames)} previously cached game${report.cachedGames === 1 ? "" : "s"}.`}
          {report.latestParsedAt
            ? ` Latest recorded game date: ${dateLabel(report.latestParsedAt)}.`
            : " These inspected replays have no valid recorded game date."}
        </p>
      )}
      {report.latestMatchingAt && report.latestMatchingAt !== report.latestParsedAt && (
        <p>Latest inspected game for your accounts: {dateLabel(report.latestMatchingAt)}.</p>
      )}
      {(exclusions.noCode + exclusions.account + exclusions.unsupported + exclusions.cpu + exclusions.format + exclusions.filters > 0) && (
        <ul>
          {exclusions.noCode > 0 && <li>{count(exclusions.noCode)} had no recorded connect codes, so they could not be linked to your accounts.</li>}
          {exclusions.account > 0 && <li>{count(exclusions.account)} had no player matching your saved accounts ({report.accountCodes.join(", ") || "none"}). Check every account you played on.</li>}
          {exclusions.unsupported > 0 && <li>{count(exclusions.unsupported)} matched your accounts but used a stage, character, or game format the dashboard does not support.</li>}
          {exclusions.cpu > 0 && <li>{count(exclusions.cpu)} contained a recorded CPU player and were hidden by the CPU setting.</li>}
          {exclusions.format > 0 && <li>{count(exclusions.format)} were {report.format === "singles" ? "teams" : "singles"} games; the dashboard was showing {report.format}.</li>}
          {exclusions.filters > 0 && <li>{count(exclusions.filters)} were excluded by your date, account, character, opponent, teammate, stage, or mode filters.</li>}
        </ul>
      )}
      {progress.failed > 0 && <p>Some files could not be parsed. Add those replay files again to retry.</p>}
      {progress.unreadable > 0 && <p>Some files could not be opened. Make sure they are available on this device, then add them again.</p>}
      {progress.deferred > 0 && <p>Some files were incomplete or still being written. After Slippi has finished saving them, add them again to retry.</p>}
      {progress.skippedCached > 0 && <p>Already-scanned files were skipped. Their games may already be represented by another copy in your library.</p>}
      <p className="hint">
        Game dates come from the replay itself, not the file’s modified date. A game already in your library will not increase your game count.
      </p>
      <div className="acct-actions">
        {exclusions.account > 0 && <button className="ghost" onClick={onAccounts}>Check my accounts</button>}
        {exclusions.filters > 0 && <button className="ghost" onClick={onClearFilters}>Clear filters</button>}
        {exclusions.cpu > 0 && <button className="ghost" onClick={onIncludeCpu}>Include CPU games</button>}
        {exclusions.format > 0 && <button className="ghost" onClick={onSwitchFormat}>Show {report.format === "singles" ? "teams" : "singles"}</button>}
        <button className="ghost" onClick={onDismiss}>Dismiss import report</button>
      </div>
    </section>
  );
}
