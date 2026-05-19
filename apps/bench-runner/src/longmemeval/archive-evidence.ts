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
  summarizeLongMemEvalReportSideEffects,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalRecallEvidenceSummary,
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

  return {
    report_side_effects: diagnostics.report_side_effects ?? null,
    scored_recall_evidence:
      diagnostics.scored_recall_evidence ??
      summarizeLongMemEvalRecallEvidence(diagnostics.questions)
  };
}

export function aggregateLongMemEvalArchiveEvidence(
  evidence: readonly LongMemEvalArchiveEvidenceSummary[]
): LongMemEvalArchiveEvidenceSummary {
  const sideEffects = evidence
    .map((item) => item.report_side_effects)
    .filter((item): item is LongMemEvalReportSideEffectSummary => item !== null);
  const recallEvidence = evidence
    .map((item) => item.scored_recall_evidence)
    .filter((item): item is LongMemEvalRecallEvidenceSummary => item !== null);

  return {
    report_side_effects:
      sideEffects.length === 0
        ? null
        : summarizeLongMemEvalReportSideEffects({
            mode: sideEffects[0]?.mode ?? "none",
            snapshots: sideEffects.flatMap((item) => item.snapshots)
          }),
    scored_recall_evidence:
      recallEvidence.length === 0
        ? null
        : aggregateRecallEvidence(recallEvidence)
  };
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
    scored_recall_evidence: evidence.scored_recall_evidence
  };
}

function buildDelta(
  current: KpiPayload,
  currentEvidence: LongMemEvalArchiveEvidenceSummary,
  opposite: KpiPayload,
  oppositeEvidence: LongMemEvalArchiveEvidenceSummary
): LongMemEvalArchiveDelta {
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
        currentEvidence.scored_recall_evidence?.graph_support_gold_count,
        oppositeEvidence.scored_recall_evidence?.graph_support_gold_count
      ),
      path_plasticity_gold_count: nullableDelta(
        currentEvidence.scored_recall_evidence?.path_plasticity_gold_count,
        oppositeEvidence.scored_recall_evidence?.path_plasticity_gold_count
      ),
      graph_expansion_plane_count: nullableDelta(
        currentEvidence.scored_recall_evidence?.graph_expansion_plane_count,
        oppositeEvidence.scored_recall_evidence?.graph_expansion_plane_count
      ),
      path_expansion_plane_count: nullableDelta(
        currentEvidence.scored_recall_evidence?.path_expansion_plane_count,
        oppositeEvidence.scored_recall_evidence?.path_expansion_plane_count
      )
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

  for (const item of evidence) {
    deliveredResultCount += item.delivered_result_count;
    graphSupportGoldCount += item.graph_support_gold_count;
    pathPlasticityGoldCount += item.path_plasticity_gold_count;
    graphExpansionPlaneCount += item.graph_expansion_plane_count;
    pathExpansionPlaneCount += item.path_expansion_plane_count;
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
    delivered_plane_counts: {
      first_admitted: firstAdmitted,
      winning_admission: winningAdmission
    },
    gold_source_channel_counts: goldChannels,
    gold_source_plane_counts: goldPlanes
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
