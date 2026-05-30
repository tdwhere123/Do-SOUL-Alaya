import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  listEntries,
  readEntry,
  type BenchName,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  summarizeLongMemEvalRecallEvidence,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalRecallEvidenceSummary,
  type LongMemEvalReportSideEffectSnapshot,
  type LongMemEvalReportSideEffectSummary
} from "./diagnostics.js";

export const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";
export const LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME =
  "longmemeval-cold-warm-comparison.json";

export interface LongMemEvalArchiveEvidenceSummary {
  readonly report_side_effects: LongMemEvalReportSideEffectSummary | null;
  readonly scored_recall_evidence: LongMemEvalRecallEvidenceSummary | null;
}

export interface LongMemEvalArchiveComparisonEntry {
  readonly slug: string | null;
  readonly run_at: string;
  readonly simulate_report: BenchSimulateReportMode;
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly tier_distribution: KpiPayload["kpi"]["tier_distribution"];
  readonly degradation_reasons: KpiPayload["kpi"]["degradation_reasons"];
  readonly report_side_effects: LongMemEvalReportSideEffectSummary | null;
  readonly scored_recall_evidence: LongMemEvalRecallEvidenceSummary | null;
}

export interface LongMemEvalArchiveDelta {
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly tier_distribution: KpiPayload["kpi"]["tier_distribution"];
  readonly degradation_reasons: KpiPayload["kpi"]["degradation_reasons"];
  readonly report_side_effects: {
    readonly recalls_edge_count: number | null;
    readonly path_relations_total: number | null;
    readonly memory_graph_edges_total: number | null;
  };
  readonly scored_recall_evidence: {
    readonly graph_support_gold_count: number | null;
    readonly path_plasticity_gold_count: number | null;
    readonly graph_expansion_plane_count: number | null;
    readonly path_expansion_plane_count: number | null;
    readonly graph_expansion_plane_count_per_hop: readonly [number | null, number | null];
    readonly graph_expansion_plane_count_per_edge_type: {
      readonly derives_from: number | null;
      readonly recalls: number | null;
      readonly supports: number | null;
    };
  };
  readonly hit_at_5_flips: {
    readonly compared_count: number;
    readonly gained: number;
    readonly lost: number;
  };
}

export interface LatestLongMemEvalArchive {
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly evidence: LongMemEvalArchiveEvidenceSummary;
}

export interface LongMemEvalColdWarmComparisonSidecar {
  readonly schema_version: 1;
  readonly comparison: "cold-none-vs-warm-mixed";
  readonly bench_name: "public";
  readonly split: string;
  readonly policy_shape: BenchPolicyShape;
  readonly current: LongMemEvalArchiveComparisonEntry;
  readonly opposite: LongMemEvalArchiveComparisonEntry | null;
  readonly delta_current_minus_opposite: LongMemEvalArchiveDelta | null;
  readonly note: string | null;
}

export function archiveEvidenceFromDiagnostics(
  diagnostics: LongMemEvalDiagnosticsSidecar | null
): LongMemEvalArchiveEvidenceSummary {
  if (diagnostics === null) {
    return {
      report_side_effects: null,
      scored_recall_evidence: null
    };
  }

  const scoredRecallEvidence =
    diagnostics.scored_recall_evidence ??
    (Array.isArray((diagnostics as { readonly questions?: unknown }).questions)
      ? summarizeLongMemEvalRecallEvidence(diagnostics.questions)
      : null);

  return {
    report_side_effects: diagnostics.report_side_effects ?? null,
    scored_recall_evidence:
      scoredRecallEvidence === null
        ? null
        : normalizeRecallEvidenceSummary(scoredRecallEvidence)
  };
}

type CompactCompatibleReportSideEffects = Omit<
  LongMemEvalReportSideEffectSummary,
  "snapshots"
> & {
  readonly snapshot_count?: unknown;
  readonly snapshots?: LongMemEvalReportSideEffectSummary["snapshots"];
};

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
    report_side_effects:
      aggregateReportSideEffects(sideEffects),
    scored_recall_evidence:
      recallEvidence.length === 0
        ? null
        : aggregateRecallEvidence(recallEvidence)
  };
}

function aggregateReportSideEffects(
  sideEffects: readonly CompactCompatibleReportSideEffects[]
): LongMemEvalReportSideEffectSummary | null {
  if (sideEffects.length === 0) {
    return null;
  }

  const memoryGraphEdgesByType: Record<string, number> = {};
  let workspacesObserved = 0;
  let memoryGraphEdgesTotal = 0;
  let recallsEdgeCount = 0;
  let pathRelationsTotal = 0;
  let latestPathEventAt: string | null = null;
  const snapshots: LongMemEvalReportSideEffectSnapshot[] = [];

  for (const item of sideEffects) {
    if (Array.isArray(item.snapshots)) {
      snapshots.push(...item.snapshots);
    } else {
      requiredNonNegativeInteger(item.snapshot_count, "snapshot_count");
    }
    workspacesObserved += requiredFiniteNumber(
      item.workspaces_observed,
      "workspaces_observed"
    );
    // memory_graph_edges_* are retained for historical archive delta compat;
    // read optionally because post-cutover archives may zero/omit them.
    memoryGraphEdgesTotal += optionalFiniteNumber(
      item.memory_graph_edges_total,
      "memory_graph_edges_total"
    );
    recallsEdgeCount += requiredFiniteNumber(
      item.recalls_edge_count,
      "recalls_edge_count"
    );
    pathRelationsTotal += requiredFiniteNumber(
      item.path_relations_total,
      "path_relations_total"
    );
    for (const [edgeType, count] of Object.entries(
      optionalNumberRecord(
        item.memory_graph_edges_by_type,
        "memory_graph_edges_by_type"
      )
    )) {
      memoryGraphEdgesByType[edgeType] =
        (memoryGraphEdgesByType[edgeType] ?? 0) + count;
    }
    if (
      item.latest_path_event_at !== null &&
      item.latest_path_event_at !== undefined &&
      (latestPathEventAt === null || item.latest_path_event_at > latestPathEventAt)
    ) {
      latestPathEventAt = item.latest_path_event_at;
    }
  }

  return {
    mode: sideEffects[0]?.mode ?? "none",
    workspaces_observed: workspacesObserved,
    memory_graph_edges_total: memoryGraphEdgesTotal,
    memory_graph_edges_by_type: memoryGraphEdgesByType,
    recalls_edge_count: recallsEdgeCount,
    path_relations_total: pathRelationsTotal,
    latest_path_event_at: latestPathEventAt,
    snapshots
  };
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

export async function readLongMemEvalDiagnosticsSidecar(
  layout: HistoryLayout,
  benchName: BenchName,
  slug: string
): Promise<LongMemEvalDiagnosticsSidecar | null> {
  try {
    const raw = await readFile(
      path.join(layout.historyRoot, benchName, slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME),
      "utf8"
    );
    return JSON.parse(raw) as LongMemEvalDiagnosticsSidecar;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function readLatestLongMemEvalOppositeArchive(input: {
  readonly layout: HistoryLayout;
  readonly current: KpiPayload;
}): Promise<LatestLongMemEvalArchive | null> {
  const currentMode = input.current.simulate_report ?? "none";
  const oppositeMode = oppositeColdWarmMode(currentMode);
  if (oppositeMode === null) {
    return null;
  }

  const policyShape = input.current.policy_shape ?? "stress";
  const slugs = await listEntries(input.layout, "public");
  for (let i = slugs.length - 1; i >= 0; i -= 1) {
    const slug = slugs[i];
    if (slug === undefined) continue;
    const payload = await readEntry(input.layout, "public", slug);
    if (
      payload !== null &&
      payload.split === input.current.split &&
      payload.embedding_provider === input.current.embedding_provider &&
      (payload.policy_shape ?? "stress") === policyShape &&
      (payload.simulate_report ?? "none") === oppositeMode
    ) {
      const diagnostics = await readLongMemEvalDiagnosticsSidecar(
        input.layout,
        "public",
        slug
      );
      return {
        slug,
        payload,
        evidence: archiveEvidenceFromDiagnostics(diagnostics)
      };
    }
  }
  return null;
}

export function buildLongMemEvalColdWarmComparisonSidecar(input: {
  readonly currentSlug: string | null;
  readonly current: KpiPayload;
  readonly currentEvidence: LongMemEvalArchiveEvidenceSummary;
  readonly opposite: LatestLongMemEvalArchive | null;
}): LongMemEvalColdWarmComparisonSidecar {
  const currentMode = input.current.simulate_report ?? "none";
  const policyShape = input.current.policy_shape ?? "stress";
  const oppositeMode = oppositeColdWarmMode(currentMode);
  const current = toComparisonEntry(
    input.currentSlug,
    input.current,
    input.currentEvidence
  );
  const opposite =
    input.opposite === null
      ? null
      : toComparisonEntry(
          input.opposite.slug,
          input.opposite.payload,
          input.opposite.evidence
        );
  const delta =
    input.opposite === null
      ? null
      : buildDelta(
          input.current,
          input.currentEvidence,
          input.opposite.payload,
          input.opposite.evidence
        );

  return {
    schema_version: 1,
    comparison: "cold-none-vs-warm-mixed",
    bench_name: "public",
    split: input.current.split,
    policy_shape: policyShape,
    current,
    opposite,
    delta_current_minus_opposite: delta,
    note:
      oppositeMode === null
        ? `simulate_report=${currentMode} is outside the cold-none/warm-mixed comparison pair`
        : opposite === null
          ? `No prior same split/policy/embedding_provider simulate_report=${oppositeMode} archive found`
          : null
  };
}

export function renderLongMemEvalColdWarmComparisonSidecar(
  sidecar: LongMemEvalColdWarmComparisonSidecar
): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

function toComparisonEntry(
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

function buildDelta(
  current: KpiPayload,
  currentEvidence: LongMemEvalArchiveEvidenceSummary,
  opposite: KpiPayload,
  oppositeEvidence: LongMemEvalArchiveEvidenceSummary
): LongMemEvalArchiveDelta {
  const currentRecallEvidence =
    currentEvidence.scored_recall_evidence === null
      ? null
      : normalizeRecallEvidenceSummary(currentEvidence.scored_recall_evidence);
  const oppositeRecallEvidence =
    oppositeEvidence.scored_recall_evidence === null
      ? null
      : normalizeRecallEvidenceSummary(oppositeEvidence.scored_recall_evidence);

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
    },
    report_side_effects: {
      recalls_edge_count: nullableDelta(
        currentEvidence.report_side_effects?.recalls_edge_count,
        oppositeEvidence.report_side_effects?.recalls_edge_count
      ),
      path_relations_total: nullableDelta(
        currentEvidence.report_side_effects?.path_relations_total,
        oppositeEvidence.report_side_effects?.path_relations_total
      ),
      memory_graph_edges_total: nullableDelta(
        currentEvidence.report_side_effects?.memory_graph_edges_total,
        oppositeEvidence.report_side_effects?.memory_graph_edges_total
      )
    },
    scored_recall_evidence: {
      graph_support_gold_count: nullableDelta(
        currentRecallEvidence?.graph_support_gold_count,
        oppositeRecallEvidence?.graph_support_gold_count
      ),
      path_plasticity_gold_count: nullableDelta(
        currentRecallEvidence?.path_plasticity_gold_count,
        oppositeRecallEvidence?.path_plasticity_gold_count
      ),
      graph_expansion_plane_count: nullableDelta(
        currentRecallEvidence?.graph_expansion_plane_count,
        oppositeRecallEvidence?.graph_expansion_plane_count
      ),
      path_expansion_plane_count: nullableDelta(
        currentRecallEvidence?.path_expansion_plane_count,
        oppositeRecallEvidence?.path_expansion_plane_count
      ),
      graph_expansion_plane_count_per_hop: [
        nullableDelta(
          currentRecallEvidence?.graph_expansion_plane_count_per_hop[0],
          oppositeRecallEvidence?.graph_expansion_plane_count_per_hop[0]
        ),
        nullableDelta(
          currentRecallEvidence?.graph_expansion_plane_count_per_hop[1],
          oppositeRecallEvidence?.graph_expansion_plane_count_per_hop[1]
        )
      ],
      graph_expansion_plane_count_per_edge_type: {
        derives_from: nullableDelta(
          currentRecallEvidence?.graph_expansion_plane_count_per_edge_type.derives_from,
          oppositeRecallEvidence?.graph_expansion_plane_count_per_edge_type.derives_from
        ),
        recalls: nullableDelta(
          currentRecallEvidence?.graph_expansion_plane_count_per_edge_type.recalls,
          oppositeRecallEvidence?.graph_expansion_plane_count_per_edge_type.recalls
        ),
        supports: nullableDelta(
          currentRecallEvidence?.graph_expansion_plane_count_per_edge_type.supports,
          oppositeRecallEvidence?.graph_expansion_plane_count_per_edge_type.supports
        )
      }
    },
    hit_at_5_flips: compareHitAt5(current, opposite)
  };
}

function aggregateRecallEvidence(
  evidence: readonly LongMemEvalRecallEvidenceSummary[]
): LongMemEvalRecallEvidenceSummary {
  const firstAdmitted: Record<string, number> = {};
  const winningAdmission: Record<string, number> = {};
  const goldChannels: Record<string, number> = {};
  const goldPlanes: Record<string, number> = {};
  let deliveredResultCount = 0;
  let graphSupportGoldCount = 0;
  let pathPlasticityGoldCount = 0;
  let graphExpansionPlaneCount = 0;
  let pathExpansionPlaneCount = 0;
  let graphExpansionHop1Count = 0;
  let graphExpansionHop2Count = 0;
  const graphExpansionEdgeTypes = {
    derives_from: 0,
    recalls: 0,
    supports: 0
  };

  for (const item of evidence) {
    deliveredResultCount += item.delivered_result_count;
    graphSupportGoldCount += item.graph_support_gold_count;
    pathPlasticityGoldCount += item.path_plasticity_gold_count;
    graphExpansionPlaneCount += item.graph_expansion_plane_count;
    pathExpansionPlaneCount += item.path_expansion_plane_count;
    const graphExpansionHopCounts = readArchiveGraphExpansionPlaneCountPerHop(
      (item as { readonly graph_expansion_plane_count_per_hop?: unknown })
        .graph_expansion_plane_count_per_hop
    );
    const graphExpansionEdgeTypeCounts = readArchiveGraphExpansionPlaneCountPerEdgeType(
      (item as { readonly graph_expansion_plane_count_per_edge_type?: unknown })
        .graph_expansion_plane_count_per_edge_type
    );
    graphExpansionHop1Count += graphExpansionHopCounts[0];
    graphExpansionHop2Count += graphExpansionHopCounts[1];
    graphExpansionEdgeTypes.derives_from += graphExpansionEdgeTypeCounts.derives_from;
    graphExpansionEdgeTypes.recalls += graphExpansionEdgeTypeCounts.recalls;
    graphExpansionEdgeTypes.supports += graphExpansionEdgeTypeCounts.supports;
    mergeCounts(firstAdmitted, item.delivered_plane_counts.first_admitted);
    mergeCounts(winningAdmission, item.delivered_plane_counts.winning_admission);
    mergeCounts(goldChannels, item.gold_source_channel_counts);
    mergeCounts(goldPlanes, item.gold_source_plane_counts);
  }

  return {
    delivered_result_count: deliveredResultCount,
    graph_support_gold_count: graphSupportGoldCount,
    path_plasticity_gold_count: pathPlasticityGoldCount,
    graph_expansion_plane_count: graphExpansionPlaneCount,
    path_expansion_plane_count: pathExpansionPlaneCount,
    graph_expansion_plane_count_per_hop: [graphExpansionHop1Count, graphExpansionHop2Count],
    graph_expansion_plane_count_per_edge_type: graphExpansionEdgeTypes,
    delivered_plane_counts: {
      first_admitted: firstAdmitted,
      winning_admission: winningAdmission
    },
    gold_source_channel_counts: goldChannels,
    gold_source_plane_counts: goldPlanes
  };
}

function normalizeRecallEvidenceSummary(
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

function oppositeColdWarmMode(
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

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
