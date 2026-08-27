import type { RecallCandidate, RecallPolicy } from "@do-soul/alaya-protocol";
import { normalizeEmbeddingProviderDegradationReason } from "../embedding-mcp-degradation.js";
import type { PreparedEmbeddingQueryHandle } from "../../embedding-recall/embedding-recall-service.js";
import type {
  EvidenceCandidateScoringResult
} from "../../embedding-recall/embedding-recall-service.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { RecallAnswerShapePlan } from "../query/recall-answer-shape-plan.js";
import type {
  RecallCandidateDiagnostic,
  RecallFineAssessmentCandidateDiagnostic,
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
import { isLegacyCandidateDiagnostic } from
  "./diagnostics/finalize-candidate-diagnostics.js";
export { finalizeRecallCandidateDiagnostics } from
  "./diagnostics/finalize-candidate-diagnostics.js";
import type { EmbeddingSupplementCollectionStatus } from "../supplements/supplements.js";
import type { QueryConditionParityView } from "./query-condition-parity.js";
import type { RecallPacketPlanTrace } from
  "../delivery/packet-plan/packet-plan-trace.js";
import type { RecallFiniteFieldChannelCapture } from
  "../field/finite-field-capture.js";
import type { RecallQueryEntityExtractionCapture } from
  "../field/query-entity-attribution-producer.js";
import type { RecallQueryFactFrameExtractionCapture } from
  "../field/query-attribution/query-fact-frame-attribution-producer.js";
import type { RecallRetrievalFieldRefinementReceipt } from
  "../field/refinement/field-refinement-receipt.js";
import type { RecallFieldRefinementStopCertificate } from
  "../field/refinement/field-refinement-stop-certificate.js";
import type {
  OpenSemanticFactorFormationCapture,
  QueryOsfSemanticCompletenessReceipt
} from
  "@do-soul/alaya-protocol";
import type { OpenSemanticFactorCompatibilityTrace } from
  "../field/open-semantic-factors/compatibility-trace.js";
import type { OpenSemanticFactorCompositionReceipt } from
  "../field/open-semantic-factors/composition.js";
import type { OpenSemanticFactorActivationReceipt } from
  "../field/open-semantic-factors/activation.js";
import type { KindConstraintAlignmentReceipt } from
  "../field/kind-projection/alignment.js";
import type { PinnedProjectionCandidateSelection } from
  "../field/retrieval/projection/pinned-projection-selection.js";
import type { CaptureProofDiagnostics } from
  "./diagnostics/capture-proof-diagnostics.js";

type BuildRecallDiagnosticsParams = Readonly<{
  readonly captureReceipt?: Readonly<
    import("../shadow/canonical-delivery.js").CanonicalSelectionReceipt
  >;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly queryEntityExtraction?: Readonly<RecallQueryEntityExtractionCapture>;
  readonly queryFactFrameExtraction?: Readonly<RecallQueryFactFrameExtractionCapture>;
  readonly queryOpenSemanticFactorFormation?: Readonly<OpenSemanticFactorFormationCapture>;
  readonly queryOpenSemanticFactorCompletenessReceipt?: Readonly<
    QueryOsfSemanticCompletenessReceipt
  >;
  readonly openSemanticFactorCompatibilityTrace?: Readonly<
    OpenSemanticFactorCompatibilityTrace
  >;
  readonly openSemanticFactorComposition?: Readonly<
    OpenSemanticFactorCompositionReceipt
  >;
  readonly openSemanticFactorActivation?: Readonly<
    OpenSemanticFactorActivationReceipt
  >;
  readonly kindConstraintAlignment?: Readonly<KindConstraintAlignmentReceipt>;
  readonly retrievalFieldCaptures?: readonly Readonly<RecallFiniteFieldChannelCapture>[];
  readonly retrievalFieldRefinementReceipts?:
    readonly Readonly<RecallRetrievalFieldRefinementReceipt>[];
  readonly fieldRefinementStopCertificate?:
    Readonly<RecallFieldRefinementStopCertificate>;
  readonly queryCondition?: QueryConditionParityView;
  readonly fieldProjectionTrace?: Readonly<
    PinnedProjectionCandidateSelection & {
      readonly generation_id: string;
      readonly condition_digest: string;
    }
  >;
  readonly answerShapePlan?: Readonly<RecallAnswerShapePlan>;
  readonly captureProofDiagnostics?: CaptureProofDiagnostics;
  readonly querySoughtFacets?: readonly string[];
  readonly totalScanned: number;
  readonly candidatePoolCount: number;
  readonly preBudgetCount: number;
  readonly deliveredCount: number;
  readonly packetPlanTrace?: Readonly<RecallPacketPlanTrace>;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly embeddingSupplementStatus: EmbeddingSupplementCollectionStatus;
  readonly evidenceEmbeddingScoring?: Readonly<EvidenceCandidateScoringResult>;
  readonly providerDegradationReason: string | null;
  readonly answerRerankDiagnostics: Readonly<RecallAnswerRerankDiagnostics>;
  readonly degradationReasons?: readonly RecallDegradationReason[];
  readonly graphExpansionDiagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidates: readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[];
  readonly fineAssessmentPrunedCandidates:
    readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[];
  // Production MCP never reads per-candidate dumps; clone only for diagnosticCapture.
  readonly includeCandidateEvidence?: boolean;
  readonly tokenEconomy: Readonly<RecallTokenEconomy>;
  readonly embeddingWorkspaceScan?: Readonly<RecallEmbeddingWorkspaceScanDiagnostics> | null;
  readonly phaseLatencyMs?: Readonly<Record<string, number>>;
}>;

export const EMPTY_RECALL_CANDIDATE_DIAGNOSTICS: readonly Readonly<RecallCandidateDiagnostic>[] =
  Object.freeze([]);
export const EMPTY_FINE_ASSESSMENT_PRUNED_DIAGNOSTICS:
  readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[] = Object.freeze([]);
const EMPTY_FUSION_BREAKDOWN: RecallDiagnostics["fusion_breakdown"] = Object.freeze([]);

export function buildRecallDiagnostics(
  params: BuildRecallDiagnosticsParams
): Readonly<RecallDiagnostics> {
  const embeddingWorkspaceScan = params.embeddingWorkspaceScan ?? null;
  return Object.freeze({
    ...(params.captureReceipt === undefined ? {} : { capture_receipt: params.captureReceipt }),
    query_probes: freezeRecallQueryProbes(params.queryProbes),
    ...buildOptionalQueryDiagnosticFields(params),
    query_sought_facets: Object.freeze([...(params.querySoughtFacets ?? [])]),
    total_scanned: params.totalScanned,
    candidate_pool_count: params.candidatePoolCount,
    pre_budget_count: params.preBudgetCount,
    delivered_count: params.deliveredCount,
    ...(params.packetPlanTrace === undefined
      ? {}
      : { packet_plan_trace: params.packetPlanTrace }),
    embedding_provider_status: params.embeddingProviderStatus,
    embedding_supplement_status: params.embeddingSupplementStatus,
    ...buildEvidenceEmbeddingDiagnostics(params.evidenceEmbeddingScoring),
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
      params.fineAssessmentPrunedCandidates,
      params.includeCandidateEvidence !== false
    ),
    token_economy: params.tokenEconomy,
    ...(params.phaseLatencyMs === undefined
      ? {}
      : { phase_latency_ms: Object.freeze({ ...params.phaseLatencyMs }) })
  });
}

function buildOptionalQueryDiagnosticFields(
  params: BuildRecallDiagnosticsParams
): Partial<RecallDiagnostics> {
  return {
    ...(params.includeCandidateEvidence === false
      ? {}
      : (params.captureProofDiagnostics ?? {})),
    ...(params.queryEntityExtraction === undefined
      ? {}
      : { query_entity_extraction: params.queryEntityExtraction }),
    ...(params.queryFactFrameExtraction === undefined
      ? {}
      : { query_fact_frame_extraction: params.queryFactFrameExtraction }),
    ...(params.queryOpenSemanticFactorFormation === undefined
      ? {}
      : {
        query_open_semantic_factor_formation:
          params.queryOpenSemanticFactorFormation
      }),
    ...(params.queryOpenSemanticFactorCompletenessReceipt === undefined
      ? {}
      : { query_open_semantic_factor_completeness_receipt:
          params.queryOpenSemanticFactorCompletenessReceipt }),
    ...(params.openSemanticFactorCompatibilityTrace === undefined
      ? {}
      : {
        open_semantic_factor_compatibility_trace:
          params.openSemanticFactorCompatibilityTrace
      }),
    ...(params.openSemanticFactorComposition === undefined
      ? {}
      : {
        open_semantic_factor_composition:
          params.openSemanticFactorComposition
      }),
    ...(params.openSemanticFactorActivation === undefined
      ? {}
      : {
        open_semantic_factor_activation:
          params.openSemanticFactorActivation
      }),
    ...(params.kindConstraintAlignment === undefined
      ? {}
      : { kind_constraint_alignment: params.kindConstraintAlignment }),
    ...(params.retrievalFieldCaptures === undefined
      ? {}
      : { retrieval_field_captures: Object.freeze([...params.retrievalFieldCaptures]) }),
    ...(params.retrievalFieldRefinementReceipts === undefined
      ? {}
      : {
        retrieval_field_refinement_receipts:
          Object.freeze([...params.retrievalFieldRefinementReceipts])
      }),
    ...(params.fieldRefinementStopCertificate === undefined
      ? {}
      : {
        field_refinement_stop_certificate:
          params.fieldRefinementStopCertificate
      }),
    ...(params.queryCondition === undefined
      ? {}
      : { query_condition: params.queryCondition }),
    ...(params.fieldProjectionTrace === undefined
      ? {}
      : { field_projection_trace: params.fieldProjectionTrace }),
    ...(params.answerShapePlan === undefined
      ? {}
      : { answer_shape_plan: params.answerShapePlan })
  };
}

function buildEvidenceEmbeddingDiagnostics(
  scoring: Readonly<EvidenceCandidateScoringResult> | undefined
): Pick<
  RecallDiagnostics,
  | "evidence_embedding_status"
  | "evidence_embedding_expected_count"
  | "evidence_embedding_scored_count"
  | "evidence_embedding_inference_calls"
  | "evidence_embedding_latency_ms"
  | "evidence_embedding_failure_class"
  | "evidence_embedding_selection_receipt"
> {
  return {
    evidence_embedding_status: scoring?.status ?? "not_requested",
    evidence_embedding_expected_count: scoring?.expectedCount ?? 0,
    evidence_embedding_scored_count: scoring?.scoredCount ?? 0,
    evidence_embedding_inference_calls: scoring?.inferenceCalls ?? 0,
    evidence_embedding_latency_ms: scoring?.latencyMs ?? 0,
    evidence_embedding_failure_class: scoring?.failureClass ?? null,
    ...(scoring?.selectionReceipt === undefined
      ? {}
      : { evidence_embedding_selection_receipt: scoring.selectionReceipt })
  };
}

function buildDegradationDiagnostics(
  reasons: readonly RecallDegradationReason[] | undefined
): Pick<RecallDiagnostics, "degradation_reasons"> | Record<string, never> {
  return reasons === undefined || reasons.length === 0
    ? {}
    : { degradation_reasons: Object.freeze([...new Set(reasons)]) };
}

function buildCandidateEvidenceDiagnostics(
  candidates: readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[],
  prunedCandidates: readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[],
  includeCandidateEvidence: boolean
): Pick<
  RecallDiagnostics,
  "fusion_breakdown" | "candidates" | "fine_assessment_pruned_candidates"
> {
  if (!includeCandidateEvidence) {
    return {
      fusion_breakdown: EMPTY_FUSION_BREAKDOWN,
      candidates: EMPTY_RECALL_CANDIDATE_DIAGNOSTICS,
      fine_assessment_pruned_candidates: EMPTY_FINE_ASSESSMENT_PRUNED_DIAGNOSTICS
    };
  }
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
  candidates: readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[]
): Readonly<RecallDiagnostics["fusion_breakdown"]> {
  return Object.freeze(
    candidates.filter(isLegacyCandidateDiagnostic).map((candidate) => Object.freeze({
      candidate_key: candidate.candidate_key,
      object_id: candidate.object_id,
      object_kind: candidate.object_kind,
      origin_plane: candidate.origin_plane,
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
  readonly preBudgetCandidates: readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[];
  readonly embeddingInferenceCalls: number;
}>): Readonly<RecallTokenEconomy> {
  let deliveredContextTokensEstimate = 0;
  for (const candidate of params.deliveredCandidates) {
    deliveredContextTokensEstimate += candidate.token_estimate;
  }
  // Distinct fusion families with any member-stream hit — decorrelated vote surface (~5), not raw lanes.
  const fusionFamiliesWithHits = countFamiliesWithHits(
    params.preBudgetCandidates.filter(isLegacyCandidateDiagnostic)
  );
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

export function resolveEmbeddingProviderStatus(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null,
  degradedReason: string | null
): RecallEmbeddingProviderStatus {
  if (degradedReason === "query_embedding_unusable") {
    return "query_embedding_unusable";
  }
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

export { normalizeEmbeddingProviderDegradationReason };
