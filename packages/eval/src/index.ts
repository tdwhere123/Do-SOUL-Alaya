export {
  BenchName,
  BenchSplit,
  HarnessMode,
  KpiPayloadSchema,
  Verdict,
  type DegradationReasons,
  type DiffVsPrevious,
  type KpiCore,
  type KpiPayload,
  type PerScenarioRow,
  type TierDistribution
} from "./kpi-schema.js";

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
  entrySlug,
  listEntries,
  readEntry,
  readLatest,
  readPrevious,
  writeEntry,
  type HistoryEntry,
  type HistoryLayout
} from "./history.js";

export { renderFindings, renderReport } from "./report.js";

export {
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
