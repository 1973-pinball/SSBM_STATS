/** Versioned transport allowlists, checked against the detector labels by the benchmark suite. */
export const INTERACTION_CODEC_OPTIONS: Readonly<Record<string, readonly string[]>>;
/** Schema 2 / encoding 3: Tournament is the deduplicated Venue + conservative
 * sample union. Both functions reject older cohort meanings and private fields. */
export function encodeInteractionBenchmarks(value: unknown): unknown;
export function decodeInteractionBenchmarks(value: unknown): unknown;
