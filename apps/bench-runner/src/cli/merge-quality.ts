import type { KpiPayload, QualityMetrics } from "@do-soul/alaya-eval";
import {
  accumulateMergedQualityMetric,
  buildMergedQualityMetrics,
  createMergeQualityMetricsState
} from "./merge-quality-state.js";

export function mergeQualityMetrics(
  shards: readonly KpiPayload[]
): QualityMetrics | undefined {
  if (shards.length === 0) return undefined;
  const metrics = shards.map((shard) => shard.kpi.quality_metrics);
  if (metrics.every((item) => item === undefined)) return undefined;
  if (metrics.some((item) => item === undefined)) return undefined;

  const state = createMergeQualityMetricsState();
  for (const metric of metrics) {
    if (metric !== undefined) {
      accumulateMergedQualityMetric(state, metric);
    }
  }
  return buildMergedQualityMetrics(state);
}
