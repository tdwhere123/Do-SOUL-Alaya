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
  type FullGoldCoverage,
  type FullGoldDeliveryContribution,
  FullGoldDeliveryContributionSchema,
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
} from "./schema/kpi-schema.js";

export {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  aggregateEdgeProposalRatePerQuestion,
  type EdgeProposalKpiEventRow,
  type ProposalsPerQuestionRollup
} from "./metrics/edge-proposal-kpi.js";

export {
  buildTokenEconomy,
  computeTokenSavedRatio,
  type TokenEconomyInput
} from "./metrics/token-economy.js";

export {
  collectReleaseHardGates,
  combineVerdicts,
  releaseHardGateAllowsLatestPassing,
  releaseHardGateVerdict,
  type BenchmarkHardGate
} from "./gates/release-gates.js";

export {
  evaluateSeedExtractionReleaseBlocker,
  formatSeedExtractionCounters,
  hasSeedExtractionReleaseBlocker,
  isLongMemEvalBenchName,
  type SeedExtractionReleaseBlocker
} from "./gates/seed-extraction-blocker.js";

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
} from "./gates/thresholds.js";

export { buildDiffVsPrevious, diffKpis, verdictBadge } from "./history/diff.js";

export {
  benchArchiveDiscriminator,
  entrySlug,
  listEntries,
  policyShapeSlug,
  readEntry,
  readEntryForDiff,
  readLatest,
  readPrevious,
  simulateReportSlug,
  writeEntry,
  type HistoryEntry,
  type HistoryLayout
} from "./history/history.js";

export { renderFindings, renderReport } from "./reporting/report.js";

export {
  SAMPLE_SIZE_LABEL_THRESHOLDS,
  WILSON_Z_95,
  ciAwareBand,
  deriveSampleSizeLabel,
  wilsonHalfWidthPp,
  wilsonInterval,
  type SampleSizeLabel
} from "./metrics/wilson-ci.js";

export { runCli } from "./cli/index.js";

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
} from "./metrics/utilization-buckets.js";

export {
  PlaneAttributionRowSchema,
  computePlaneAttribution,
  extractPlaneAttributionRows,
  shareOfPlane,
  type PlaneAttributionRow,
  type PlaneAttributionShare,
  type PlaneAttributionResult
} from "./metrics/cohort-attribution.js";
