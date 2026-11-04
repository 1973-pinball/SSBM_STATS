import type { ReactNode } from "react";
import { RANKED_SOURCE_DESCRIPTION } from "../lib/benchmarkCohorts";
import type { RankedBenchmarkState } from "../lib/rankedBenchmarks";

export function RankedBenchmarkSource({ state, summary = "Ranked source and sample", children }: {
  state: Pick<RankedBenchmarkState, "manifest" | "loading" | "error">;
  summary?: string;
  children?: ReactNode;
}) {
  return <div className="hint ranked-benchmark-source">
    {state.loading && <p role="status">Loading historical ranked comparisons…</p>}
    {state.error && <p role="status">{state.error}</p>}
    <details><summary>{summary}</summary>
      {children}
      <p>{RANKED_SOURCE_DESCRIPTION}</p>
      {state.manifest && <>
        <p>{state.manifest.source.selectionMethod}</p>
        <p>The sample includes completed human singles with four starting stocks on standard stages, lasting 30 seconds to 8 minutes 10 seconds. Early quit-outs and incomplete recordings are excluded.</p>
        <p>Source: <a href={state.manifest.source.url} target="_blank" rel="noreferrer">{state.manifest.source.repository}</a> · snapshot {state.manifest.datasetId}.
          {" "}Only derived aggregate counters are downloaded; your replays remain local.</p>
      </>}
    </details>
  </div>;
}
