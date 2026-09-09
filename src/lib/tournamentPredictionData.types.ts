export type TournamentPredictionModelId =
  | "neutral"
  | "higher-seed"
  | "recency-elo"
  | "glicko2"
  | "dynamic-bradley-terry"
  | "regularized-bt-recent-form";

export interface TournamentPredictionPlayer {
  id: string;
  name: string;
  seed: number;
}

export interface TournamentPredictionMatch {
  id: string;
  label: string;
  phase: "top16" | "top8";
  bracket: "upper" | "lower" | "final";
  round: string;
  playerIds: readonly [string, string];
  probabilities: readonly [number, number];
  predictedWinnerId: string;
  decision: "model" | "lower-seed-number";
  isReset: boolean;
}

export interface TournamentPredictionPlacement {
  placement: number;
  playerId: string;
}

export interface TournamentPredictionModel {
  id: TournamentPredictionModelId;
  name: string;
  shortName: string;
  explanation: string;
  recommended: boolean;
  heldOut: {
    predictions: number;
    events: number;
    brier: number;
    logLoss: number;
  };
  championId: string;
  top8PlayerIds: readonly string[];
  matches: readonly TournamentPredictionMatch[];
  placements: readonly TournamentPredictionPlacement[];
}

export interface TournamentPrediction {
  id: string;
  name: string;
  eventName: string;
  startDate: string;
  sourceUrl: string;
  sourceSha256: string;
  snapshot: {
    fetchedAt: string;
    state: string;
    entrantCount: number;
  };
  scenario: {
    kind: "seed-projected-top-16";
    label: string;
    explanation: string;
    missingPoolNames: readonly string[];
    missingEntrantCount: number;
  };
  training: {
    events: number;
    sets: number;
    datasetSha256: string;
    evaluationRunHash: string;
  };
  defaultModelId: TournamentPredictionModelId;
  players: readonly TournamentPredictionPlayer[];
  models: readonly TournamentPredictionModel[];
  caveats: readonly string[];
}

export interface TournamentPredictionCatalog {
  schemaVersion: 1;
  generatedAt: string;
  tournaments: readonly TournamentPrediction[];
}
