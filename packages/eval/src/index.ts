export {
  BenchName,
  BenchPolicyShapeSchema,
  BenchSimulateReportModeSchema,
  BenchSplit,
  HarnessMode,
  KpiPayloadSchema,
  RecallWeightOverridesSummarySchema,
  Verdict,
  type DegradationReasons,
  type DiffVsPrevious,
  type EdgeProposalAutoAccept,
  type EdgeProposalRate,
  type KpiCore,
  type KpiPayload,
  type QualityMetrics,
  type RecallWeightOverridesSummary,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type PerScenarioRow,
  type SeedExtractionPath,
  type TierDistribution,
  type TokenEconomy,
  type RecallTokenEconomy
} from "./kpi-schema.js";

export {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  type EdgeProposalKpiEventRow
} from "./edge-proposal-kpi.js";

export {
  buildTokenEconomy,
  computeTokenSavedRatio,
  type TokenEconomyInput
} from "./token-economy.js";

export {
  collectReleaseHardGates,
  combineVerdicts,
  releaseHardGateAllowsLatestPassing,
  releaseHardGateVerdict,
  type BenchmarkHardGate
} from "./release-gates.js";

export {
  evaluateSeedExtractionReleaseBlocker,
  formatSeedExtractionCounters,
  hasSeedExtractionReleaseBlocker,
  isLongMemEvalBenchName,
  type SeedExtractionReleaseBlocker
} from "./seed-extraction-blocker.js";

export {
  DEFAULT_THRESHOLDS,
  classifyHotShareDrop,
  classifyLatencyGrowth,
  classifyRatioDrop,
  rollupWorstVerdict,
  type KpiDelta,
  type KpiDiffResult,
  type RatioBand,
  type RatioGrowthBand,
  type ThresholdConfig
} from "./thresholds.js";

export { buildDiffVsPrevious, diffKpis, verdictBadge } from "./diff.js";

export {
  benchArchiveDiscriminator,
  entrySlug,
  listEntries,
  policyShapeSlug,
  readEntry,
  readLatest,
  readPrevious,
  simulateReportSlug,
  writeEntry,
  type HistoryEntry,
  type HistoryLayout
} from "./history.js";

export { renderFindings, renderReport } from "./report.js";

export {
  SAMPLE_SIZE_LABEL_THRESHOLDS,
  WILSON_Z_95,
  ciAwareBand,
  deriveSampleSizeLabel,
  wilsonHalfWidthPp,
  wilsonInterval,
  type SampleSizeLabel
} from "./wilson-ci.js";

export { runCli } from "./cli.js";

export { LONGMEMEVAL_S_META, type DatasetMeta } from "./longmemeval/dataset.js";
export {
  SYNTHETIC_SCENARIOS,
  type SyntheticScenario
} from "./self/scenarios.js";

export {
  UtilizationBucketDeliverySchema,
  UtilizationBucketReportSchema,
  computeUtilizationBuckets,
  rollUpUtilizationBucketsByCohort,
  listSingleUsedAnchorDeliveries,
  type UtilizationBucketDelivery,
  type UtilizationBucketReport,
  type UtilizationBucketCounts,
  type UtilizationBucketCohortRow
} from "./utilization-buckets.js";

export {
  PlaneAttributionRowSchema,
  computePlaneAttribution,
  extractPlaneAttributionRows,
  shareOfPlane,
  type PlaneAttributionRow,
  type PlaneAttributionShare,
  type PlaneAttributionResult
} from "./cohort-attribution.js";
