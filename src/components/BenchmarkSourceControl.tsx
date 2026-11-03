import { BENCHMARK_LABELS } from "../lib/benchmarkCohorts";

export type ComparisonSource = "diamond" | "master" | "tournament" | "pro";
export function BenchmarkSourceControl({ value, onChange }: { value: ComparisonSource; onChange: (value: ComparisonSource) => void }) {
  return <label>Highlight against<select value={value} onChange={event => onChange(event.target.value as ComparisonSource)}>
    {(["diamond", "master", "tournament", "pro"] as const).map(source => <option key={source} value={source}>{BENCHMARK_LABELS[source]}</option>)}
  </select></label>;
}
