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
  const measured = assertMeasurementContractSet(shards);
  if (metrics.every((item) => item === undefined)) return undefined;
  if (metrics.some((item) => item === undefined)) {
    if (measured) throw new Error("merge refused: quality metrics missing from measured shard");
    return undefined;
  }

  const state = createMergeQualityMetricsState();
  for (const metric of metrics) {
    if (metric !== undefined) {
      accumulateMergedQualityMetric(state, metric);
    }
  }
  const merged = buildMergedQualityMetrics(state);
  const abstention = mergeAbstentionMetrics(
    metrics as readonly QualityMetrics[], measured
  );
  return abstention === undefined ? merged : { ...merged, abstention };
}

export function assertMergeMeasurementContracts(shards: readonly KpiPayload[]): void {
  assertMeasurementContractSet(shards);
  for (const shard of shards) assertShardMeasurementContract(shard);
}

function assertMeasurementContractSet(shards: readonly KpiPayload[]): boolean {
  if (shards.some(hasLegacyAbstention)) {
    throw new Error("merge refused: legacy v1 abstention schema cannot be promoted to v2");
  }
  const measured = shards.some(hasCurrentMeasurementEvidence);
  if (!measured) return false;
  for (const shard of shards) assertCompleteCurrentMeasurementContract(shard);
  return true;
}

function hasLegacyAbstention(shard: KpiPayload): boolean {
  return shard.kpi.quality_metrics?.abstention?.schema_version === "bench-abstention.v1";
}

function hasCurrentMeasurementEvidence(shard: KpiPayload): boolean {
  return shard.answerable_evaluated_count !== undefined ||
    shard.measurement_attribution !== undefined ||
    shard.kpi.quality_metrics?.abstention?.schema_version === "bench-abstention.v2";
}

function assertCompleteCurrentMeasurementContract(shard: KpiPayload): void {
  if (shard.answerable_evaluated_count === undefined ||
      shard.measurement_attribution === undefined) {
    throw new Error("merge refused: current measurement contract missing from one or more shards");
  }
  if (shard.measurement_attribution.schema_version !==
      "bench-measurement-attribution.v2") {
    throw new Error("merge refused: legacy measurement attribution cannot be promoted");
  }
  if (shard.kpi.quality_metrics === undefined) {
    throw new Error("merge refused: quality metrics missing from measured shard");
  }
  if (shard.kpi.quality_metrics.abstention?.schema_version !== "bench-abstention.v2") {
    throw new Error("merge refused: abstention contract missing from measured shard");
  }
}

function assertShardMeasurementContract(shard: KpiPayload): void {
  const answerable = shard.answerable_evaluated_count;
  if (answerable === undefined) return;
  const rows = shard.kpi.per_scenario;
  if (rows.length !== shard.evaluated_count) {
    throw new Error("merge refused: per_scenario length must equal evaluated_count");
  }
  if (rows.some((row) => row.scorable === undefined)) {
    throw new Error("merge refused: new denominator requires explicit scorable rows");
  }
  const scorable = rows.filter((row) => row.scorable === true).length;
  if (scorable !== answerable) {
    throw new Error("merge refused: answerable_evaluated_count must match scorable=true rows");
  }
  const unscorable = rows.length - scorable;
  const abstentionTotal = shard.kpi.quality_metrics?.abstention?.total ?? 0;
  const identityUnscorable =
    shard.kpi.quality_metrics?.evaluator_identity_unscorable_count;
  if (identityUnscorable === undefined ||
      unscorable !== abstentionTotal + identityUnscorable) {
    throw new Error(
      "merge refused: scorable=false rows must match abstention and evaluator identity unscorable counts"
    );
  }
}

function mergeAbstentionMetrics(
  metrics: readonly QualityMetrics[],
  measured: boolean
): QualityMetrics["abstention"] {
  const values = metrics.map((metric) => metric.abstention);
  if (values.every((value) => value === undefined)) {
    if (measured) throw new Error("merge refused: abstention contract missing from measured shards");
    return undefined;
  }
  if (values.some((value) => value === undefined)) {
    throw new Error("merge refused: abstention contract missing from one or more shards");
  }
  const present = values.filter((value) => value !== undefined);
  if (new Set(present.map((value) => value.schema_version)).size !== 1) {
    throw new Error("merge refused: abstention schema versions differ across shards");
  }
  if (present[0]?.schema_version === "bench-abstention.v1") {
    throw new Error("merge refused: legacy v1 abstention schema cannot be promoted to v2");
  }
  const total = present.reduce((sum, value) => sum + value.total, 0);
  return {
    schema_version: "bench-abstention.v2",
    total,
    scored: 0,
    unscorable: total,
    method: "fused_margin_diagnostic_only",
    calibration_status: "uncalibrated",
    gate_eligible: false
  };
}
