import type { QualityMetrics } from "@do-soul/alaya-eval";
import type {
  DiagnosticRecallResult,
  LongMemEvalGoldDiagnostic
} from "./diagnostics-types.js";

type GoldRankBucketKey =
  | "delivered_top5"
  | "pre_budget_6_10"
  | "pre_budget_11_25"
  | "pre_budget_26_50"
  | "pre_budget_51_100"
  | "pre_budget_gt_100"
  | "candidate_absent";

export function emptyGoldRankBucketTally(): Record<GoldRankBucketKey, number> {
  return {
    delivered_top5: 0,
    pre_budget_6_10: 0,
    pre_budget_11_25: 0,
    pre_budget_26_50: 0,
    pre_budget_51_100: 0,
    pre_budget_gt_100: 0,
    candidate_absent: 0
  };
}

// Mirror the best-gold bucket thresholds (lines above): delivered in top-5 wins;
// otherwise the pre-budget pool rank (fused_rank fallback) places the gold.
export function classifyGoldRankBucket(
  gold: LongMemEvalGoldDiagnostic
): GoldRankBucketKey {
  if (gold.final_rank !== null && gold.final_rank <= 5) {
    return "delivered_top5";
  }
  const rank = gold.pre_budget_rank ?? gold.fused_rank;
  if (rank === null) return "candidate_absent";
  if (rank <= 10) return "pre_budget_6_10";
  if (rank <= 25) return "pre_budget_11_25";
  if (rank <= 50) return "pre_budget_26_50";
  if (rank <= 100) return "pre_budget_51_100";
  return "pre_budget_gt_100";
}

// Ordinal sort key: in-window golds (final_rank 1-5) sort ahead of pool-only
// golds (pre-budget rank), so ordinal 0 is the gold that did best.
export function goldOrdinalSortRank(gold: LongMemEvalGoldDiagnostic): number {
  if (gold.final_rank !== null && gold.final_rank <= 5) {
    return gold.final_rank;
  }
  return gold.pre_budget_rank ?? gold.fused_rank ?? Number.POSITIVE_INFINITY;
}

export type TopDistractorBucket =
  | "existing_score_dominant"
  | "synthesis_reserved"
  | "source_proximity_local_only"
  | "path_or_graph_dominant"
  | "lexical_topic_neighbor"
  | "unknown";

// Attribute a top-5 distractor (a result occupying a slot a missed gold wanted)
// to the dominant force that put it there: a synthesis reserve, the scalar
// existing_score prior, source proximity, path/graph fan-in, or a lexical/
// semantic topic neighbor — by its largest fused-rank stream contribution.
export function classifyTopDistractor(
  delivered: DiagnosticRecallResult
): TopDistractorBucket {
  if (delivered.object_kind === "synthesis_capsule") {
    return "synthesis_reserved";
  }
  const contributions = delivered.fused_rank_contribution_per_stream;
  if (contributions === null) {
    return "unknown";
  }
  let bestStream: string | null = null;
  let bestValue = 0;
  for (const [stream, value] of Object.entries(contributions)) {
    if (typeof value === "number" && value > bestValue) {
      bestValue = value;
      bestStream = stream;
    }
  }
  if (bestStream === null) {
    return "unknown";
  }
  if (bestStream === "existing_score") {
    return "existing_score_dominant";
  }
  if (bestStream === "source_proximity" || bestStream === "source_evidence_agreement") {
    return "source_proximity_local_only";
  }
  if (
    bestStream === "path_expansion" ||
    bestStream === "graph_expansion" ||
    bestStream === "entity_seed"
  ) {
    return "path_or_graph_dominant";
  }
  return "lexical_topic_neighbor";
}

export function hasEvidenceStreamContribution(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("evidence_anchor") ||
    gold.source_planes.includes("evidence_fts") ||
    gold.source_channels.includes("evidence_anchor") ||
    gold.source_channels.includes("evidence_fts") ||
    (gold.per_stream_rank?.evidence_fts ?? null) !== null ||
    (gold.per_stream_rank?.evidence_structural_agreement ?? null) !== null ||
    (gold.per_stream_rank?.source_evidence_agreement ?? null) !== null
  );
}

export function hasPathStreamContribution(delivered: DiagnosticRecallResult): boolean {
  return (
    delivered.plane_first_admitted === "path_expansion" ||
    delivered.plane_winning_admission === "path_expansion" ||
    (delivered.per_stream_rank?.path_expansion ?? null) !== null
  );
}

// Path fan-in diagnostic: a gold candidate bears the path_expansion stream when
// it was admitted on the path plane or fired the path_expansion fusion stream.
// The diagnostic does not prove a specific relation_kind.
// see also: apps/bench-runner/src/longmemeval/diagnostics.ts buildLongMemEvalQualityMetrics
export function hasGoldPathExpansionStream(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("path_expansion") ||
    gold.plane_first_admitted === "path_expansion" ||
    gold.plane_winning_admission === "path_expansion" ||
    (gold.per_stream_rank?.path_expansion ?? null) !== null
  );
}

// Graph fan-in diagnostic: a gold candidate bears genuine MULTI-HOP
// graph_expansion reach when it was admitted on the graph_expansion plane. The
// graph_expansion admission carries a double-count guard (it skips any target
// path_expansion already admitted as a direct hop-1 neighbor, see
// recall-service.ts addGraphExpansionCandidates), so plane membership isolates
// the hop-2+ reach the direct path pass never produced.
//
// invariant: the per_stream_rank.graph_expansion term is DELIBERATELY NOT a
// multi-hop signal here. The production graph_expansion fusion STREAM score is
// max(graphExpansionScores, normalizeGraphSupport(graphSupportCounts)) — the
// graphSupport aggregate can count hop-1 inbound support, so a direct hop-1 path
// gold fires a nonzero graph_expansion per_stream_rank too. Counting
// it would mis-attribute hop-1 path golds as graph-bearing and over-report
// graph_gold_*. We rely on the admission plane (true multi-hop) instead; the
// path-primary partition (hasGoldPathExpansionStream) still credits the direct
// hop-1 term, and graph_only_hit_at_5_count remains the clean multi-hop metric.
// see also: apps/bench-runner/src/longmemeval/diagnostics.ts buildLongMemEvalQualityMetrics
// see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
export function hasGoldGraphExpansionStream(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("graph_expansion") ||
    gold.plane_first_admitted === "graph_expansion" ||
    gold.plane_winning_admission === "graph_expansion"
  );
}

export function isDeliveredOrderNonMonotonic(
  results: readonly DiagnosticRecallResult[]
): boolean {
  return isDeliveredScoreOrderNonMonotonic(
    results.map((result) => result.relevance_score)
  );
}

function isDeliveredScoreOrderNonMonotonic(scores: readonly number[]): boolean {
  for (let i = 1; i < scores.length; i++) {
    const current = scores[i];
    const previous = scores[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current > previous) return true;
  }
  return false;
}

export function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

// @anchor per-plane-recall-coverage: shared by buildLongMemEvalQualityMetrics
// and cli-merge-quality.ts mergeQualityMetrics so single-shard and merged kpi.json carry
// the same per-plane block shape.
export function buildPerPlaneRecallCoverage(
  goldCounts: ReadonlyMap<string, number>,
  hitAt5Counts: ReadonlyMap<string, number>
): QualityMetrics["per_plane_recall_coverage"] {
  return Object.fromEntries(
    [...goldCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([plane, goldCount]) => {
        const hitCount = hitAt5Counts.get(plane) ?? 0;
        return [
          plane,
          {
            gold_count: goldCount,
            hit_at_5_count: hitCount,
            hit_at_5_rate: ratio(hitCount, goldCount)
          }
        ];
      })
  );
}
