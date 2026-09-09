import type { TournamentPredictionModelId } from "./tournamentPredictionData.types";

export type TournamentPredictionBacktestEvidenceModeId =
  | "strict-seeds"
  | "availability-assumed";

export type TournamentPredictionSettingValue = string | number | boolean | null;

export interface TournamentPredictionBacktestMetrics {
  logLoss: number;
  brier: number;
  accuracy: number;
  auc: number;
}

export interface TournamentPredictionBacktestInterval {
  estimate: number | null;
  interval95: {
    lower: number;
    upper: number;
  } | null;
  status: "descriptive-paired-event-bootstrap" | "not-available";
}

export interface TournamentPredictionSelectedSetting {
  candidateId: string;
  isDefault: boolean;
  options: Readonly<Record<string, TournamentPredictionSettingValue>>;
  count: number;
  frequency: number;
}

export interface TournamentPredictionBacktestTuning {
  matureEvents: number;
  fallbackEvents: number;
  selectionModes: {
    fixed: number;
    warmupDefault: number;
    innerUnavailableDefault: number;
    innerSelected: number;
  };
  versusDefault: {
    betterWhen: "negative";
    logLoss: TournamentPredictionBacktestInterval;
    brier: TournamentPredictionBacktestInterval;
  };
  selectedSettings: readonly TournamentPredictionSelectedSetting[];
}

export interface TournamentPredictionBacktestModel {
  id: TournamentPredictionModelId;
  name: string;
  outerEvents: number;
  scoredOuterEvents: number;
  outerSets: number;
  eventMacro: TournamentPredictionBacktestMetrics;
  pooledCoverage: number;
  tuning: TournamentPredictionBacktestTuning;
}

export interface TournamentPredictionBacktestSourceHashes {
  pointerSha256: string;
  runHash: string;
  runSha256: string;
  forecastSha256: string;
  evaluationSha256: string;
  reportSha256: string;
  engineManifestSha256: string;
  datasetSha256: string;
  datasetSemanticSha256: string;
  implementationSha256: string;
  tuningSpecFileSha256: string;
  tuningSpecSemanticSha256: string;
  outcomeReconciliationSha256: string;
}

export interface TournamentPredictionBacktestEvidenceMode {
  id: TournamentPredictionBacktestEvidenceModeId;
  label: string;
  description: string;
  allowHistoricalSeeds: boolean;
  snapshotVerified: false;
  selectedModel: null;
  productize: false;
  models: readonly TournamentPredictionBacktestModel[];
  caveats: readonly string[];
  sourceHashes: TournamentPredictionBacktestSourceHashes;
}

export interface TournamentPredictionBacktestBundle {
  schemaVersion: 1;
  kind: "tournament-prediction-public-backtest-v1";
  status: "exploratory-not-confirmatory";
  coverage: {
    events: number;
    sets: number;
    scoringUnit: "eligible realized target set";
  };
  modes: readonly TournamentPredictionBacktestEvidenceMode[];
}
