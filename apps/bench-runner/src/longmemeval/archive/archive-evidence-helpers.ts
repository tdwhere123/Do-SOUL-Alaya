import type { BenchSimulateReportMode, KpiPayload } from "@do-soul/alaya-eval";
import type {
  LongMemEvalArchiveComparisonEntry,
  LongMemEvalArchiveDelta,
  LongMemEvalArchiveEvidenceSummary
} from "./archive-evidence.js";
import type {
  LongMemEvalRecallEvidenceSummary,
  LongMemEvalReportSideEffectSnapshot,
  LongMemEvalReportSideEffectSummary
} from "../diagnostics.js";
import { createEmptyMissTaxonomyDistribution } from "../diagnostics/miss/diagnostics-miss-taxonomy.js";

type CompactCompatibleReportSideEffects = Omit<
  LongMemEvalReportSideEffectSummary,
  "snapshots"
> & {
  readonly snapshot_count?: unknown;
  readonly snapshots?: LongMemEvalReportSideEffectSummary["snapshots"];
};

type ReportSideEffectAggregation = ReturnType<typeof createReportSideEffectAggregation>;
type RecallEvidenceAggregation = ReturnType<typeof createRecallEvidenceAggregation>;

export function aggregateLongMemEvalArchiveEvidence(
  evidence: readonly LongMemEvalArchiveEvidenceSummary[]
): LongMemEvalArchiveEvidenceSummary {
  const sideEffects = evidence
    .map((item) => item.report_side_effects)
    .filter((item) => item !== null) as CompactCompatibleReportSideEffects[];
  const recallEvidence = evidence
    .map((item) => item.scored_recall_evidence)
    .filter((item): item is LongMemEvalRecallEvidenceSummary => item !== null);

  return {
    report_side_effects: aggregateReportSideEffects(sideEffects),
    scored_recall_evidence: recallEvidence.length === 0 ? null : aggregateRecallEvidence(recallEvidence)
  };
}

function aggregateReportSideEffects(
  sideEffects: readonly CompactCompatibleReportSideEffects[]
): LongMemEvalReportSideEffectSummary | null {
  if (sideEffects.length === 0) return null;
  const aggregation = createReportSideEffectAggregation();
  for (const item of sideEffects) accumulateReportSideEffect(aggregation, item);
  return {
    mode: sideEffects[0]?.mode ?? "none",
    workspaces_observed: aggregation.workspacesObserved,
    memory_graph_edges_total: aggregation.memoryGraphEdgesTotal,
    memory_graph_edges_by_type: aggregation.memoryGraphEdgesByType,
    recalls_edge_count: aggregation.recallsEdgeCount,
    path_relations_total: aggregation.pathRelationsTotal,
    latest_path_event_at: aggregation.latestPathEventAt,
    snapshots: aggregation.snapshots
  };
}

function createReportSideEffectAggregation() {
  return {
    memoryGraphEdgesByType: {} as Record<string, number>,
    snapshots: [] as LongMemEvalReportSideEffectSnapshot[],
    workspacesObserved: 0, memoryGraphEdgesTotal: 0, recallsEdgeCount: 0,
    pathRelationsTotal: 0, latestPathEventAt: null as string | null
  };
}

function accumulateReportSideEffect(
  aggregation: ReportSideEffectAggregation,
  item: CompactCompatibleReportSideEffects
): void {
  appendReportSideEffectSnapshots(aggregation.snapshots, item);
  aggregation.workspacesObserved += requiredFiniteNumber(item.workspaces_observed, "workspaces_observed");
  aggregation.memoryGraphEdgesTotal += optionalFiniteNumber(item.memory_graph_edges_total, "memory_graph_edges_total");
  aggregation.recallsEdgeCount += requiredFiniteNumber(item.recalls_edge_count, "recalls_edge_count");
  aggregation.pathRelationsTotal += requiredFiniteNumber(item.path_relations_total, "path_relations_total");
  mergeCounts(
    aggregation.memoryGraphEdgesByType,
    optionalNumberRecord(item.memory_graph_edges_by_type, "memory_graph_edges_by_type")
  );
  updateLatestPathEventAt(aggregation, item.latest_path_event_at);
}

function appendReportSideEffectSnapshots(
  snapshots: LongMemEvalReportSideEffectSnapshot[],
  item: CompactCompatibleReportSideEffects
): void {
  if (Array.isArray(item.snapshots)) {
    snapshots.push(...item.snapshots);
    return;
  }
  requiredNonNegativeInteger(item.snapshot_count, "snapshot_count");
}

function updateLatestPathEventAt(
  aggregation: ReportSideEffectAggregation,
  candidate: string | null | undefined
): void {
  if (candidate !== null && candidate !== undefined &&
      (aggregation.latestPathEventAt === null || candidate > aggregation.latestPathEventAt)) {
    aggregation.latestPathEventAt = candidate;
  }
}

function requiredFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `invalid report_side_effects.${fieldName}: expected finite number`
    );
  }
  return value;
}

// Retained for historical archive delta compat: legacy edge-plane fields are
// optional post-cutover, so absent/null reads collapse to zero instead of
// throwing on the required path.
function optionalFiniteNumber(value: unknown, fieldName: string): number {
  if (value === undefined || value === null) {
    return 0;
  }
  return requiredFiniteNumber(value, fieldName);
}

function optionalNumberRecord(
  value: unknown,
  fieldName: string
): Record<string, number> {
  if (value === undefined || value === null) {
    return {};
  }
  return requiredNumberRecord(value, fieldName);
}

function requiredNonNegativeInteger(value: unknown, fieldName: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid report_side_effects.${fieldName}: expected non-negative integer`
    );
  }
  return value;
}

function requiredNumberRecord(
  value: unknown,
  fieldName: string
): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `invalid report_side_effects.${fieldName}: expected number record`
    );
  }

  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    result[key] = requiredFiniteNumber(count, `${fieldName}.${key}`);
  }
  return result;
}

export function toComparisonEntry(
  slug: string | null,
  payload: KpiPayload,
  evidence: LongMemEvalArchiveEvidenceSummary
): LongMemEvalArchiveComparisonEntry {
  return {
    slug,
    run_at: payload.run_at,
    simulate_report: payload.simulate_report ?? "none",
    r_at_1: payload.kpi.r_at_1,
    r_at_5: payload.kpi.r_at_5,
    r_at_10: payload.kpi.r_at_10,
    tier_distribution: payload.kpi.tier_distribution,
    degradation_reasons: payload.kpi.degradation_reasons,
    report_side_effects: evidence.report_side_effects,
    scored_recall_evidence:
      evidence.scored_recall_evidence === null
        ? null
        : normalizeRecallEvidenceSummary(evidence.scored_recall_evidence)
  };
}

export function buildDelta(
  current: KpiPayload,
  currentEvidence: LongMemEvalArchiveEvidenceSummary,
  opposite: KpiPayload,
  oppositeEvidence: LongMemEvalArchiveEvidenceSummary
): LongMemEvalArchiveDelta {
  const currentRecallEvidence = normalizeArchiveRecallEvidence(currentEvidence);
  const oppositeRecallEvidence = normalizeArchiveRecallEvidence(oppositeEvidence);

  return {
    ...buildKpiDelta(current, opposite),
    report_side_effects: buildReportSideEffectsDelta(currentEvidence, oppositeEvidence),
    scored_recall_evidence: buildScoredRecallEvidenceDelta(
      currentRecallEvidence,
      oppositeRecallEvidence
    ),
    hit_at_5_flips: compareHitAt5(current, opposite)
  };
}

function normalizeArchiveRecallEvidence(
  evidence: LongMemEvalArchiveEvidenceSummary
): LongMemEvalRecallEvidenceSummary | null {
  return evidence.scored_recall_evidence === null
    ? null
    : normalizeRecallEvidenceSummary(evidence.scored_recall_evidence);
}

function buildKpiDelta(
  current: KpiPayload,
  opposite: KpiPayload
): Pick<
  LongMemEvalArchiveDelta,
  "r_at_1" | "r_at_5" | "r_at_10" | "tier_distribution" | "degradation_reasons"
> {
  return {
    r_at_1: current.kpi.r_at_1 - opposite.kpi.r_at_1,
    r_at_5: current.kpi.r_at_5 - opposite.kpi.r_at_5,
    r_at_10: current.kpi.r_at_10 - opposite.kpi.r_at_10,
    tier_distribution: {
      hot: current.kpi.tier_distribution.hot - opposite.kpi.tier_distribution.hot,
      warm: current.kpi.tier_distribution.warm - opposite.kpi.tier_distribution.warm,
      cold: current.kpi.tier_distribution.cold - opposite.kpi.tier_distribution.cold
    },
    degradation_reasons: {
      none:
        current.kpi.degradation_reasons.none -
        opposite.kpi.degradation_reasons.none,
      warm_cascade_engaged:
        current.kpi.degradation_reasons.warm_cascade_engaged -
        opposite.kpi.degradation_reasons.warm_cascade_engaged,
      cold_cascade_engaged:
        current.kpi.degradation_reasons.cold_cascade_engaged -
        opposite.kpi.degradation_reasons.cold_cascade_engaged,
      recall_explainability_partial:
        current.kpi.degradation_reasons.recall_explainability_partial -
        opposite.kpi.degradation_reasons.recall_explainability_partial
    }
  };
}

function buildReportSideEffectsDelta(
  current: LongMemEvalArchiveEvidenceSummary,
  opposite: LongMemEvalArchiveEvidenceSummary
): LongMemEvalArchiveDelta["report_side_effects"] {
  return {
    recalls_edge_count: nullableDelta(
      current.report_side_effects?.recalls_edge_count,
      opposite.report_side_effects?.recalls_edge_count
    ),
    path_relations_total: nullableDelta(
      current.report_side_effects?.path_relations_total,
      opposite.report_side_effects?.path_relations_total
    ),
    memory_graph_edges_total: nullableDelta(
      current.report_side_effects?.memory_graph_edges_total,
      opposite.report_side_effects?.memory_graph_edges_total
    )
  };
}

function buildScoredRecallEvidenceDelta(
  current: LongMemEvalRecallEvidenceSummary | null,
  opposite: LongMemEvalRecallEvidenceSummary | null
): LongMemEvalArchiveDelta["scored_recall_evidence"] {
  return {
    graph_support_gold_count: nullableDelta(
      current?.graph_support_gold_count,
      opposite?.graph_support_gold_count
    ),
    path_plasticity_gold_count: nullableDelta(
      current?.path_plasticity_gold_count,
      opposite?.path_plasticity_gold_count
    ),
    graph_expansion_plane_count: nullableDelta(
      current?.graph_expansion_plane_count,
      opposite?.graph_expansion_plane_count
    ),
    path_expansion_plane_count: nullableDelta(
      current?.path_expansion_plane_count,
      opposite?.path_expansion_plane_count
    ),
    graph_expansion_plane_count_per_hop: [
      nullableDelta(
        current?.graph_expansion_plane_count_per_hop[0],
        opposite?.graph_expansion_plane_count_per_hop[0]
      ),
      nullableDelta(
        current?.graph_expansion_plane_count_per_hop[1],
        opposite?.graph_expansion_plane_count_per_hop[1]
      )
    ],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: nullableDelta(
        current?.graph_expansion_plane_count_per_edge_type.derives_from,
        opposite?.graph_expansion_plane_count_per_edge_type.derives_from
      ),
      recalls: nullableDelta(
        current?.graph_expansion_plane_count_per_edge_type.recalls,
        opposite?.graph_expansion_plane_count_per_edge_type.recalls
      ),
      supports: nullableDelta(
        current?.graph_expansion_plane_count_per_edge_type.supports,
        opposite?.graph_expansion_plane_count_per_edge_type.supports
      )
    }
  };
}

function aggregateRecallEvidence(
  evidence: readonly LongMemEvalRecallEvidenceSummary[]
): LongMemEvalRecallEvidenceSummary {
  const aggregation = createRecallEvidenceAggregation();
  for (const item of evidence) {
    accumulateRecallEvidence(aggregation, item);
  }

  return {
    delivered_result_count: aggregation.deliveredResultCount,
    graph_support_gold_count: aggregation.graphSupportGoldCount,
    path_plasticity_gold_count: aggregation.pathPlasticityGoldCount,
    graph_expansion_plane_count: aggregation.graphExpansionPlaneCount,
    path_expansion_plane_count: aggregation.pathExpansionPlaneCount,
    graph_expansion_plane_count_per_hop: [
      aggregation.graphExpansionHop1Count,
      aggregation.graphExpansionHop2Count
    ],
    graph_expansion_plane_count_per_edge_type: aggregation.graphExpansionEdgeTypes,
    delivered_plane_counts: {
      first_admitted: aggregation.firstAdmitted,
      winning_admission: aggregation.winningAdmission
    },
    miss_taxonomy_distribution: aggregation.missTaxonomyDistribution,
    gold_source_channel_counts: aggregation.goldChannels,
    gold_source_plane_counts: aggregation.goldPlanes
  };
}

function createRecallEvidenceAggregation() {
  return {
    firstAdmitted: {} as Record<string, number>,
    winningAdmission: {} as Record<string, number>,
    goldChannels: {} as Record<string, number>,
    goldPlanes: {} as Record<string, number>,
    missTaxonomyDistribution: createEmptyMissTaxonomyDistribution(),
    graphExpansionEdgeTypes: { derives_from: 0, recalls: 0, supports: 0 },
    deliveredResultCount: 0,
    graphSupportGoldCount: 0,
    pathPlasticityGoldCount: 0,
    graphExpansionPlaneCount: 0,
    pathExpansionPlaneCount: 0,
    graphExpansionHop1Count: 0,
    graphExpansionHop2Count: 0
  };
}

function accumulateRecallEvidence(
  aggregation: RecallEvidenceAggregation,
  item: LongMemEvalRecallEvidenceSummary
): void {
  accumulateRecallEvidenceMetrics(aggregation, item);
  mergeCounts(aggregation.firstAdmitted, item.delivered_plane_counts.first_admitted);
  mergeCounts(aggregation.winningAdmission, item.delivered_plane_counts.winning_admission);
  mergeCounts(
    aggregation.missTaxonomyDistribution,
    item.miss_taxonomy_distribution ?? createEmptyMissTaxonomyDistribution()
  );
  mergeCounts(aggregation.goldChannels, item.gold_source_channel_counts);
  mergeCounts(aggregation.goldPlanes, item.gold_source_plane_counts);
}

function accumulateRecallEvidenceMetrics(
  aggregation: RecallEvidenceAggregation,
  item: LongMemEvalRecallEvidenceSummary
): void {
  aggregation.deliveredResultCount += item.delivered_result_count;
  aggregation.graphSupportGoldCount += item.graph_support_gold_count;
  aggregation.pathPlasticityGoldCount += item.path_plasticity_gold_count;
  aggregation.graphExpansionPlaneCount += item.graph_expansion_plane_count;
  aggregation.pathExpansionPlaneCount += item.path_expansion_plane_count;
  const hopCounts = readArchiveGraphExpansionPlaneCountPerHop(
    (item as { readonly graph_expansion_plane_count_per_hop?: unknown })
      .graph_expansion_plane_count_per_hop
  );
  const edgeTypeCounts = readArchiveGraphExpansionPlaneCountPerEdgeType(
    (item as { readonly graph_expansion_plane_count_per_edge_type?: unknown })
      .graph_expansion_plane_count_per_edge_type
  );
  aggregation.graphExpansionHop1Count += hopCounts[0];
  aggregation.graphExpansionHop2Count += hopCounts[1];
  aggregation.graphExpansionEdgeTypes.derives_from += edgeTypeCounts.derives_from;
  aggregation.graphExpansionEdgeTypes.recalls += edgeTypeCounts.recalls;
  aggregation.graphExpansionEdgeTypes.supports += edgeTypeCounts.supports;
}

export function normalizeRecallEvidenceSummary(
  evidence: LongMemEvalRecallEvidenceSummary
): LongMemEvalRecallEvidenceSummary {
  return aggregateRecallEvidence([evidence]);
}

function readArchiveGraphExpansionPlaneCountPerHop(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return [0, 0];
  const first = typeof value[0] === "number" && Number.isFinite(value[0])
    ? Math.trunc(value[0])
    : 0;
  const second = typeof value[1] === "number" && Number.isFinite(value[1])
    ? Math.trunc(value[1])
    : 0;
  return [first, second];
}

function readArchiveGraphExpansionPlaneCountPerEdgeType(value: unknown): {
  readonly derives_from: number;
  readonly recalls: number;
  readonly supports: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { derives_from: 0, recalls: 0, supports: 0 };
  }
  const record = value as Readonly<Record<string, unknown>>;
  return {
    derives_from: typeof record.derives_from === "number" && Number.isFinite(record.derives_from)
      ? Math.trunc(record.derives_from)
      : 0,
    recalls: typeof record.recalls === "number" && Number.isFinite(record.recalls)
      ? Math.trunc(record.recalls)
      : 0,
    supports: typeof record.supports === "number" && Number.isFinite(record.supports)
      ? Math.trunc(record.supports)
      : 0
  };
}

function compareHitAt5(
  current: KpiPayload,
  opposite: KpiPayload
): LongMemEvalArchiveDelta["hit_at_5_flips"] {
  const oppositeById = new Map(
    opposite.kpi.per_scenario.map((row) => [row.id, row.hit_at_5])
  );
  let compared = 0;
  let gained = 0;
  let lost = 0;
  for (const row of current.kpi.per_scenario) {
    const previousHit = oppositeById.get(row.id);
    if (previousHit === undefined) continue;
    compared += 1;
    if (!previousHit && row.hit_at_5) gained += 1;
    if (previousHit && !row.hit_at_5) lost += 1;
  }
  return {
    compared_count: compared,
    gained,
    lost
  };
}

export function oppositeColdWarmMode(
  mode: BenchSimulateReportMode
): BenchSimulateReportMode | null {
  if (mode === "none") return "mixed";
  if (mode === "mixed") return "none";
  return null;
}

function nullableDelta(current: number | undefined, previous: number | undefined): number | null {
  if (current === undefined || previous === undefined) return null;
  return current - previous;
}

function mergeCounts(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
