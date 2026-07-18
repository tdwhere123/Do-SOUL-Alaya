import type { RecallCandidate, RecallPolicy } from "@do-soul/alaya-protocol";
import type { PreparedEmbeddingQueryHandle } from "../../embedding-recall/embedding-recall-service.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type {
  RecallCandidateDiagnostic,
  RecallAnswerRerankDiagnostics,
  RecallDegradationReason,
  RecallDiagnostics,
  RecallEmbeddingProviderStatus,
  RecallEmbeddingWorkspaceScanDiagnostics,
  FineAssessmentPrunedCandidateDiagnostic,
  RecallGraphExpansionDiagnostics,
  RecallTokenEconomy
} from "./recall-service-types.js";
import { countFamiliesWithHits } from "../delivery/fusion-delivery-families.js";
import type { EmbeddingSupplementCollectionStatus } from "../supplements/supplements.js";

type BuildRecallDiagnosticsParams = Readonly<{
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly querySoughtFacets?: readonly string[];
  readonly totalScanned: number;
  readonly candidatePoolCount: number;
  readonly preBudgetCount: number;
  readonly deliveredCount: number;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly embeddingSupplementStatus: EmbeddingSupplementCollectionStatus;
  readonly providerDegradationReason: string | null;
  readonly answerRerankDiagnostics: Readonly<RecallAnswerRerankDiagnostics>;
  readonly degradationReasons?: readonly RecallDegradationReason[];
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly fineAssessmentPrunedCandidates:
    readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[];
  readonly tokenEconomy: Readonly<RecallTokenEconomy>;
  readonly embeddingWorkspaceScan?: Readonly<RecallEmbeddingWorkspaceScanDiagnostics> | null;
  readonly phaseLatencyMs?: Readonly<Record<string, number>>;
}>;

export function buildRecallDiagnostics(
  params: BuildRecallDiagnosticsParams
): Readonly<RecallDiagnostics> {
  const embeddingWorkspaceScan = params.embeddingWorkspaceScan ?? null;
  return Object.freeze({
    query_probes: freezeRecallQueryProbes(params.queryProbes),
    query_sought_facets: Object.freeze([...(params.querySoughtFacets ?? [])]),
    total_scanned: params.totalScanned,
    candidate_pool_count: params.candidatePoolCount,
    pre_budget_count: params.preBudgetCount,
    delivered_count: params.deliveredCount,
    embedding_provider_status: params.embeddingProviderStatus,
    embedding_supplement_status: params.embeddingSupplementStatus,
    provider_degradation_reason: params.providerDegradationReason,
    ...buildAnswerRerankDiagnostics(params.answerRerankDiagnostics),
    ...buildDegradationDiagnostics(params.degradationReasons),
    ...buildEmbeddingWorkspaceScanDiagnostics(embeddingWorkspaceScan),
    graph_expansion_plane_count_per_hop:
      params.graphExpansionDiagnostics.graph_expansion_plane_count_per_hop,
    graph_expansion_plane_count_per_edge_type:
      params.graphExpansionDiagnostics.graph_expansion_plane_count_per_edge_type,
    ...(params.graphExpansionDiagnostics.multi_seed_graph_fan_in === undefined
      ? {}
      : { multi_seed_graph_fan_in: params.graphExpansionDiagnostics.multi_seed_graph_fan_in }),
    ...buildCandidateEvidenceDiagnostics(
      params.candidates,
      params.fineAssessmentPrunedCandidates
    ),
    token_economy: params.tokenEconomy,
    ...(params.phaseLatencyMs === undefined
      ? {}
      : { phase_latency_ms: Object.freeze({ ...params.phaseLatencyMs }) })
  });
}

function buildDegradationDiagnostics(
  reasons: readonly RecallDegradationReason[] | undefined
): Pick<RecallDiagnostics, "degradation_reasons"> | Record<string, never> {
  return reasons === undefined || reasons.length === 0
    ? {}
    : { degradation_reasons: Object.freeze([...new Set(reasons)]) };
}

function buildCandidateEvidenceDiagnostics(
  candidates: readonly Readonly<RecallCandidateDiagnostic>[],
  prunedCandidates: readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[]
): Pick<
  RecallDiagnostics,
  "fusion_breakdown" | "candidates" | "fine_assessment_pruned_candidates"
> {
  return {
    fusion_breakdown: freezeFusionBreakdown(candidates),
    candidates: Object.freeze([...candidates]),
    fine_assessment_pruned_candidates: Object.freeze([...prunedCandidates])
  };
}

function buildAnswerRerankDiagnostics(
  diagnostics: Readonly<RecallAnswerRerankDiagnostics>
): Pick<
  RecallDiagnostics,
  | "answer_rerank_status"
  | "answer_rerank_expected_count"
  | "answer_rerank_scored_count"
  | "answer_rerank_failure_class"
> {
  return {
    answer_rerank_status: diagnostics.status,
    answer_rerank_expected_count: diagnostics.expected_count,
    answer_rerank_scored_count: diagnostics.scored_count,
    answer_rerank_failure_class: diagnostics.failure_class
  };
}

export function recordRecallDegradation(
  target: Readonly<{ readonly degradationReasons?: Set<RecallDegradationReason> }>,
  reason: RecallDegradationReason
): void {
  target.degradationReasons?.add(reason);
}

function freezeRecallQueryProbes(
  queryProbes: Readonly<RecallQueryProbes>
): Readonly<RecallDiagnostics["query_probes"]> {
  return Object.freeze({
    normalized_query: queryProbes.normalized_query,
    object_ids: Object.freeze([...queryProbes.object_ids]),
    subject_hints: Object.freeze([...queryProbes.subject_hints]),
    evidence_refs: Object.freeze([...queryProbes.evidence_refs]),
    run_ids: Object.freeze([...queryProbes.run_ids]),
    surface_ids: Object.freeze([...queryProbes.surface_ids]),
    file_paths: Object.freeze([...queryProbes.file_paths]),
    command_names: Object.freeze([...queryProbes.command_names]),
    package_names: Object.freeze([...queryProbes.package_names]),
    task_refs: Object.freeze([...queryProbes.task_refs]),
    dimensions: Object.freeze([...queryProbes.dimensions]),
    scope_classes: Object.freeze([...queryProbes.scope_classes]),
    domain_tags: Object.freeze([...queryProbes.domain_tags]),
    lexical_terms: Object.freeze([...queryProbes.lexical_terms]),
    expanded_terms: Object.freeze([...queryProbes.expanded_terms]),
    phrases: Object.freeze([...queryProbes.phrases]),
    char_ngrams: Object.freeze([...queryProbes.char_ngrams]),
    date_terms: Object.freeze([...queryProbes.date_terms])
  });
}

function buildEmbeddingWorkspaceScanDiagnostics(
  embeddingWorkspaceScan: Readonly<RecallEmbeddingWorkspaceScanDiagnostics> | null
): Readonly<Partial<RecallDiagnostics>> {
  return {
    ...(embeddingWorkspaceScan?.workspace_scan_cap === undefined
      ? {}
      : { embedding_workspace_scan_cap: embeddingWorkspaceScan.workspace_scan_cap }),
    ...(embeddingWorkspaceScan?.workspace_scanned_count === undefined
      ? {}
      : { embedding_workspace_scanned_count: embeddingWorkspaceScan.workspace_scanned_count }),
    ...(embeddingWorkspaceScan?.workspace_scan_truncated === undefined
      ? {}
      : { embedding_workspace_truncated: embeddingWorkspaceScan.workspace_scan_truncated }),
    ...(embeddingWorkspaceScan?.provider_kind === undefined
      ? {}
      : { embedding_workspace_provider_kind: embeddingWorkspaceScan.provider_kind }),
    ...(embeddingWorkspaceScan?.model_id === undefined
      ? {}
      : { embedding_workspace_model_id: embeddingWorkspaceScan.model_id }),
    ...(embeddingWorkspaceScan?.schema_version === undefined
      ? {}
      : { embedding_workspace_schema_version: embeddingWorkspaceScan.schema_version })
  };
}

function freezeFusionBreakdown(
  candidates: readonly Readonly<RecallCandidateDiagnostic>[]
): Readonly<RecallDiagnostics["fusion_breakdown"]> {
  return Object.freeze(
    candidates.map((candidate) => Object.freeze({
      candidate_key: candidate.candidate_key,
      object_id: candidate.object_id,
      object_kind: candidate.object_kind,
      origin_plane: candidate.origin_plane,
      facet_overlap: candidate.facet_overlap,
      per_stream_rank: candidate.per_stream_rank,
      fused_rank: candidate.fused_rank,
      fused_score: candidate.fused_score,
      fused_rank_contribution_per_stream: candidate.fused_rank_contribution_per_stream,
      ...(candidate.per_axis_rank === undefined
        ? {}
        : { per_axis_rank: candidate.per_axis_rank }),
      ...(candidate.per_axis_contribution === undefined
        ? {}
        : { per_axis_contribution: candidate.per_axis_contribution }),
      ...(candidate.flood_potential === undefined
        ? {}
        : { flood_potential: candidate.flood_potential }),
      ...(candidate.flood_fuel_coverage === undefined
        ? {}
        : { flood_fuel_coverage: candidate.flood_fuel_coverage })
    }))
  );
}

/**
 * Pure derivation of per-recall token economy from already-computed state; synchronous, allocation-light, integer counters + the existing token_estimate sum only.
 * @anchor compute-recall-token-economy: every figure must be derivable from data already produced; a field needing fresh corpus traversal would breach the no-latency-impact contract.
 * Exported only so the test suite can pin the latency contract; production callers go through RecallService.recall.
 */
export function computeRecallTokenEconomy(params: Readonly<{
  readonly deliveredCandidates: readonly Readonly<RecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount?: number;
  readonly finePriorityOverflowCount?: number;
  readonly preBudgetCandidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly embeddingInferenceCalls: number;
}>): Readonly<RecallTokenEconomy> {
  let deliveredContextTokensEstimate = 0;
  for (const candidate of params.deliveredCandidates) {
    deliveredContextTokensEstimate += candidate.token_estimate;
  }
  // Distinct fusion families with any member-stream hit — decorrelated vote surface (~5), not raw lanes.
  const fusionFamiliesWithHits = countFamiliesWithHits(params.preBudgetCandidates);
  const finePrunedCount = params.finePrunedCount ??
    Math.max(0, params.coarsePoolSize - params.fineEvaluated);
  return Object.freeze({
    delivered_context_tokens_estimate: deliveredContextTokensEstimate,
    coarse_pool_size: params.coarsePoolSize,
    fine_evaluated: params.fineEvaluated,
    fine_pruned_count: finePrunedCount,
    fine_priority_overflow_count: Math.max(
      0,
      Math.trunc(params.finePriorityOverflowCount ?? 0)
    ),
    fusion_families_with_hits: fusionFamiliesWithHits,
    embedding_inference_calls: Math.max(0, Math.trunc(params.embeddingInferenceCalls))
  });
}

export function finalizeRecallCandidateDiagnostics(
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  deliveredCandidates: readonly Readonly<RecallCandidate>[]
): readonly Readonly<RecallCandidateDiagnostic>[] {
  const deliveredRankByCandidateKey = new Map<string, number>(
    deliveredCandidates.map((candidate, index) => [
      `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`,
      index + 1
    ] as const)
  );
  return Object.freeze(
    diagnostics.map((diagnostic) => {
      const deliveredRank = deliveredRankByCandidateKey.get(diagnostic.candidate_key) ?? null;
      if (deliveredRank !== null) {
        return Object.freeze({
          ...diagnostic,
          final_rank: deliveredRank,
          post_rank: deliveredRank,
          in_final_packet: true,
          eviction_reason: null,
          dropped_reason: null,
          within_budget: true
        });
      }
      if (diagnostic.dropped_reason !== null) {
        return Object.freeze({
          ...diagnostic,
          post_rank: diagnostic.final_rank,
          in_final_packet: false,
          eviction_reason: diagnostic.dropped_reason
        });
      }
      return Object.freeze({
        ...diagnostic,
        final_rank: null,
        post_rank: null,
        in_final_packet: false,
        eviction_reason: "max_entries" as const,
        dropped_reason: "max_entries" as const,
        within_budget: false
      });
    })
  );
}

export function resolveEmbeddingProviderStatus(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null,
  degradedReason: string | null
): RecallEmbeddingProviderStatus {
  if (degradedReason !== null) {
    return "provider_failed";
  }
  if (
    policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    preparedEmbeddingQuery === null
  ) {
    return "provider_not_requested";
  }
  const snapshot = preparedEmbeddingQuery.getSnapshot();
  switch (snapshot.status) {
    case "ready":
      return "provider_returned";
    case "pending":
      return "provider_pending";
    case "failed":
      return "provider_failed";
  }
}

export function resolveEmbeddingProviderDegradationReason(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null,
  degradedReason: string | null
): string | null {
  if (degradedReason !== null) {
    return degradedReason;
  }
  if (
    policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    preparedEmbeddingQuery === null
  ) {
    return null;
  }
  const snapshot = preparedEmbeddingQuery.getSnapshot();
  if (snapshot.status === "failed") {
    return normalizeEmbeddingProviderDegradationReason(snapshot.reason);
  }
  if (snapshot.status === "pending") {
    return "query_embedding_pending";
  }
  return null;
}

export function normalizeEmbeddingProviderDegradationReason(reason: string): string | null {
  const normalized = reason.trim().toLowerCase();
  if (
    normalized === "query_embedding_failed" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed" ||
    normalized === "query_embedding_pending"
  ) {
    return normalized;
  }
  return "provider_unavailable";
}
