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
  type KpiCore,
  type KpiPayload,
  type QualityMetrics,
  type RecallWeightOverridesSummary,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type PerScenarioRow,
  type TierDistribution
} from "./kpi-schema.js";

export {
  collectReleaseHardGates,
  combineVerdicts,
  releaseHardGateVerdict,
  type BenchmarkHardGate
} from "./release-gates.js";

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

export { diffKpis, verdictBadge } from "./diff.js";

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
