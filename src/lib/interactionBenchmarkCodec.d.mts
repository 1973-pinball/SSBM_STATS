/** Versioned transport allowlists, checked against the detector labels by the benchmark suite. */
export const INTERACTION_CODEC_OPTIONS: Readonly<Record<string, readonly string[]>>;
/** Both functions validate their input and throw on malformed or unexpected fields. */
export function encodeInteractionBenchmarks(value: unknown): unknown;
export function decodeInteractionBenchmarks(value: unknown): unknown;
