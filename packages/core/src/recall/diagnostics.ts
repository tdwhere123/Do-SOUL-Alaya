import type { RecallCandidate, RecallPolicy } from "@do-soul/alaya-protocol";
import type { PreparedEmbeddingQueryHandle } from "../embedding-recall-service.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import type {
  RecallCandidateDiagnostic,
  RecallDiagnostics,
  RecallEmbeddingProviderStatus,
  RecallGraphExpansionDiagnostics,
  RecallTokenEconomy
} from "./recall-service-types.js";
import { RECALL_FUSION_STREAMS } from "./fusion-delivery.js";

export function buildRecallDiagnostics(params: Readonly<{
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly totalScanned: number;
  readonly candidatePoolCount: number;
  readonly preBudgetCount: number;
  readonly deliveredCount: number;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly providerDegradationReason: string | null;
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly tokenEconomy: Readonly<RecallTokenEconomy>;
}>): Readonly<RecallDiagnostics> {
  return Object.freeze({
    query_probes: Object.freeze({
      object_ids: Object.freeze([...params.queryProbes.object_ids]),
      subject_hints: Object.freeze([...params.queryProbes.subject_hints]),
      evidence_refs: Object.freeze([...params.queryProbes.evidence_refs]),
      run_ids: Object.freeze([...params.queryProbes.run_ids]),
      surface_ids: Object.freeze([...params.queryProbes.surface_ids]),
      file_paths: Object.freeze([...params.queryProbes.file_paths]),
      command_names: Object.freeze([...params.queryProbes.command_names]),
      package_names: Object.freeze([...params.queryProbes.package_names]),
      task_refs: Object.freeze([...params.queryProbes.task_refs]),
      dimensions: Object.freeze([...params.queryProbes.dimensions]),
      scope_classes: Object.freeze([...params.queryProbes.scope_classes]),
      domain_tags: Object.freeze([...params.queryProbes.domain_tags]),
      lexical_terms: Object.freeze([...params.queryProbes.lexical_terms]),
      expanded_terms: Object.freeze([...params.queryProbes.expanded_terms]),
      phrases: Object.freeze([...params.queryProbes.phrases]),
      char_ngrams: Object.freeze([...params.queryProbes.char_ngrams]),
      date_terms: Object.freeze([...params.queryProbes.date_terms])
    }),
    total_scanned: params.totalScanned,
    candidate_pool_count: params.candidatePoolCount,
    pre_budget_count: params.preBudgetCount,
    delivered_count: params.deliveredCount,
    embedding_provider_status: params.embeddingProviderStatus,
    provider_degradation_reason: params.providerDegradationReason,
    graph_expansion_plane_count_per_hop:
      params.graphExpansionDiagnostics.graph_expansion_plane_count_per_hop,
    graph_expansion_plane_count_per_edge_type:
      params.graphExpansionDiagnostics.graph_expansion_plane_count_per_edge_type,
    ...(params.graphExpansionDiagnostics.multi_seed_graph_fan_in === undefined
      ? {}
      : { multi_seed_graph_fan_in: params.graphExpansionDiagnostics.multi_seed_graph_fan_in }),
    fusion_breakdown: Object.freeze(
      params.candidates.map((candidate) => Object.freeze({
        candidate_key: candidate.candidate_key,
        object_id: candidate.object_id,
        object_kind: candidate.object_kind,
        origin_plane: candidate.origin_plane,
        per_stream_rank: candidate.per_stream_rank,
        fused_rank: candidate.fused_rank,
        fused_score: candidate.fused_score,
        fused_rank_contribution_per_stream: candidate.fused_rank_contribution_per_stream
      }))
    ),
    candidates: Object.freeze([...params.candidates]),
    token_economy: params.tokenEconomy
  });
}

/**
 * Pure derivation of per-recall token economy from already-computed recall
 * state. Synchronous, allocation-light, and never widens the diagnostics
 * surface beyond integer counters and the existing token_estimate sum.
 *
 * @anchor compute-recall-token-economy: every figure must be derivable
 * from data already produced for the recall result. Adding a field that
 * needs new traversal of the corpus would push instrumentation past the
 * "no measurable latency budget impact" red line of phase 7.
 *
 * Exported only so the recall-service test suite can pin the latency
 * contract (O-1 regression: nested per-stream/per-candidate scan stays
 * sub-50µs even at the worst-case bench cardinality). Production callers
 * still go through RecallService.recall — there is no separate runtime
 * entry point.
 */
export function computeRecallTokenEconomy(params: Readonly<{
  readonly deliveredCandidates: readonly Readonly<RecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly preBudgetCandidates: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly embeddingInferenceCalls: number;
}>): Readonly<RecallTokenEconomy> {
  let deliveredContextTokensEstimate = 0;
  for (const candidate of params.deliveredCandidates) {
    deliveredContextTokensEstimate += candidate.token_estimate;
  }
  // Count distinct fusion streams that produced at least one non-null
  // rank across the pre-budget candidate set. Iterates over the typed
  // RECALL_FUSION_STREAMS list so the count tracks the protocol's
  // fusion-stream surface, not an ad-hoc subset.
  let fusionStreamsWithHits = 0;
  for (const stream of RECALL_FUSION_STREAMS) {
    const hit = params.preBudgetCandidates.some(
      (candidate) => candidate.per_stream_rank[stream] !== null
    );
    if (hit) {
      fusionStreamsWithHits += 1;
    }
  }
  return Object.freeze({
    delivered_context_tokens_estimate: deliveredContextTokensEstimate,
    coarse_pool_size: params.coarsePoolSize,
    fine_evaluated: params.fineEvaluated,
    fusion_streams_with_hits: fusionStreamsWithHits,
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
          dropped_reason: null,
          within_budget: true
        });
      }
      if (diagnostic.dropped_reason !== null) {
        return diagnostic;
      }
      return Object.freeze({
        ...diagnostic,
        final_rank: null,
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
