import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import { uniqueStrings } from "../../expansion/path-relations.js";
import {
  clamp01,
  isSynthesisChildCandidate,
  isWorkspaceMemoryCandidate
} from "../../runtime/recall-service-helpers.js";
import type {
  RecallAdmissionPlane,
  RecallAdmissionDiagnosticPass,
  RecallCandidateDiagnostic,
  RecallCandidateDropReason,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import { selectRecallAdmissionAttributionPlane } from "../../scoring/scoring.js";
import { buildRecallCandidateAnswerFeatures } from "../fine-assessment-answer-features.js";
import { buildCandidateSelectorObservation } from
  "./candidate-selector-observation.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "../fine-assessment-selection.js";

interface CandidateRankContext {
  readonly deliveryRank: number | undefined;
  readonly finalRelevance: number;
  readonly answerRelevanceRank: number | undefined;
}

export function createFineAssessmentDiagnostic(
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  selectionOrder: number,
  finalRank: number | null,
  droppedReason: RecallCandidateDropReason | null,
  context: FineAssessmentSelectionContext,
  admissionPass: RecallAdmissionDiagnosticPass
): Readonly<RecallCandidateDiagnostic> {
  const admissionPlanes: readonly RecallAdmissionPlane[] = Object.freeze([
    ...(candidate.admissionPlanes ?? ["activation"])
  ]);
  const ranks = resolveCandidateRankContext(candidate, candidateKey, context);
  return Object.freeze({
    ...buildIdentityDiagnosticFields(candidate, candidateKey),
    ...buildAdmissionDiagnosticFields(candidate, admissionPlanes),
    pre_budget_rank: selectionOrder,
    selection_order: selectionOrder,
    admission_attempts: Object.freeze([Object.freeze({
      pass: admissionPass,
      selection_order: selectionOrder,
      admitted: droppedReason === null,
      dropped_reason: droppedReason
    })]),
    evidence_projection_matches: collectEvidenceProjectionMatches(
      candidate,
      context.supplementaryData
    ),
    ...buildFusionDiagnosticFields(candidate),
    final_rank: finalRank,
    post_rank: finalRank,
    in_final_packet: droppedReason === null,
    eviction_reason: droppedReason,
    dropped_reason: droppedReason,
    within_budget: droppedReason === null,
    ...buildRelevanceDiagnosticFields(candidate, ranks),
    ...buildSupplementDiagnosticFields(candidate, context.supplementaryData),
    source_channels: buildSourceChannels(candidate, admissionPlanes),
    path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])]),
    ...buildAnswerFeatureDiagnostics(candidate, context),
    ...buildDecisionTraceDiagnostics(candidate, context),
    ...(context.captureAnswerFeatures
      ? { selector_observation: buildCandidateSelectorObservation(candidate, context) }
      : {}),
    ...buildCompatibilityStageDiagnosticAliases(candidate.fusion.fused_rank, ranks.deliveryRank, selectionOrder),
    session_key: candidate.entry.surface_id ?? candidate.entry.run_id ?? "<no-session>"
  });
}

function collectEvidenceProjectionMatches(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
) {
  const evidenceRefs = new Set(candidate.entry.evidence_refs);
  if (candidate.objectKind === "evidence_capsule") {
    evidenceRefs.add(candidate.entry.object_id);
  }
  const matchesByRef = supplementaryData.evidenceProjectionMatchesByRef ?? {};
  return Object.freeze([...evidenceRefs].flatMap((evidenceRef) =>
    matchesByRef[evidenceRef] ?? []
  ).sort((left, right) =>
    right.normalized_rank - left.normalized_rank ||
    left.projection_kind.localeCompare(right.projection_kind) ||
    (left.projection_id ?? 0) - (right.projection_id ?? 0)
  ));
}

export function buildFinalScoreFactors(
  candidate: FineAssessmentCandidate,
  finalRelevance: number
): RecallScoreFactors {
  return Object.freeze({ ...candidate.effectiveFactors, relevance: finalRelevance });
}

function buildIdentityDiagnosticFields(
  candidate: FineAssessmentCandidate,
  candidateKey: string
) {
  return {
    candidate_key: candidateKey,
    object_id: candidate.entry.object_id,
    object_kind: candidate.objectKind ?? "memory_entry",
    created_at: candidate.entry.created_at,
    facet_overlap: candidate.fusion.facet_overlap,
    facet_overlap_status: candidate.fusion.facet_overlap_status,
    dimension: candidate.entry.dimension,
    origin_plane: candidate.originPlane ?? "workspace_local"
  };
}

function buildAdmissionDiagnosticFields(
  candidate: FineAssessmentCandidate,
  admissionPlanes: readonly RecallAdmissionPlane[]
) {
  return {
    admission_planes: admissionPlanes,
    plane_first_admitted: candidate.firstAdmissionPlane ?? admissionPlanes[0] ?? "activation",
    plane_winning_admission: selectRecallAdmissionAttributionPlane(
      admissionPlanes,
      candidate.firstAdmissionPlane
    )
  };
}

function buildRelevanceDiagnosticFields(
  candidate: FineAssessmentCandidate,
  ranks: CandidateRankContext
) {
  return {
    relevance_score: ranks.finalRelevance,
    ...(ranks.answerRelevanceRank === undefined ? {} : {
      answer_relevance_score: ranks.finalRelevance,
      answer_relevance_rank: ranks.answerRelevanceRank
    }),
    additive_score: candidate.effectiveScore,
    score_factors: buildFinalScoreFactors(candidate, ranks.finalRelevance)
  };
}

function buildSupplementDiagnosticFields(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
) {
  const localMemory = isWorkspaceMemoryCandidate(candidate);
  return {
    lexical_rank: lexicalRank(candidate, supplementaryData),
    structural_score: diagnosticStructuralScore(candidate, supplementaryData),
    path_suppression_score: localMemory
      ? supplementaryData.pathSuppressionScores[candidate.entry.object_id] ?? 0
      : 0,
    source_cohort_key: localMemory
      ? supplementaryData.sourceCohortKeys[candidate.entry.object_id] ?? null
      : null
  };
}

function buildAnswerFeatureDiagnostics(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
) {
  if (!context.captureAnswerFeatures) return {};
  const evidenceGist = isWorkspaceMemoryCandidate(candidate)
    ? context.supplementaryData.evidenceGistsByMemoryId[candidate.entry.object_id]
    : undefined;
  const answerSupport = context.answerSupportByCandidateKey.get(
    candidate.fusion.candidate_key
  );
  return {
    answer_features: buildRecallCandidateAnswerFeatures(
      candidate.entry,
      candidate.objectKind ?? "memory_entry",
      evidenceGist,
      answerSupport,
      context.answerSupportObservationsByCandidateKey.get(
        candidate.fusion.candidate_key
      )
    )
  };
}

function buildDecisionTraceDiagnostics(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
) {
  if (!context.captureAnswerFeatures) return {};
  const candidateKey = candidate.fusion.candidate_key;
  const deepHeadTrace = context.deepHeadTraceByCandidateKey.get(candidateKey);
  const coverageMarginalGain =
    context.coverageMarginalGainByCandidateKey.get(candidateKey);
  return {
    ...(deepHeadTrace === undefined ? {} : { deep_head_trace: deepHeadTrace }),
    ...(coverageMarginalGain === undefined
      ? {}
      : { coverage_marginal_gain: coverageMarginalGain })
  };
}

function diagnosticStructuralScore(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
): number {
  const supplementary = isWorkspaceMemoryCandidate(candidate)
    ? supplementaryData.structuralScores[candidate.entry.object_id] ?? 0
    : 0;
  return clamp01(candidate.structuralScore ?? supplementary);
}

function resolveCandidateRankContext(
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  context: FineAssessmentSelectionContext
): CandidateRankContext {
  return {
    deliveryRank: context.rankByCandidateKey.get(candidateKey),
    finalRelevance: context.finalRelevanceByCandidateKey.get(candidateKey) ?? candidate.fusion.fused_score,
    answerRelevanceRank: context.answerRelevanceRankByCandidateKey.get(candidateKey)
  };
}

function buildFusionDiagnosticFields(candidate: FineAssessmentCandidate) {
  const fusion = candidate.fusion;
  return {
    fused_rank: fusion.fused_rank,
    fused_score: fusion.fused_score,
    per_stream_rank: fusion.per_stream_rank,
    fused_rank_contribution_per_stream: fusion.fused_rank_contribution_per_stream,
    ...(fusion.per_axis_rank === undefined ? {} : { per_axis_rank: fusion.per_axis_rank }),
    ...(fusion.per_axis_contribution === undefined
      ? {}
      : { per_axis_contribution: fusion.per_axis_contribution }),
    ...(fusion.flood_potential === undefined ? {} : { flood_potential: fusion.flood_potential }),
    ...(fusion.flood_fuel_coverage === undefined
      ? {}
      : { flood_fuel_coverage: fusion.flood_fuel_coverage })
  };
}

function buildCompatibilityStageDiagnosticAliases(
  fusionRank: number | undefined,
  deliveryRank: number | undefined,
  selectionOrder: number
) {
  // Live stages only. Retired delivery stages (lexical priority, session coverage,
  // synthesis/structural reserve) are omitted — aliasing them to delivery/selection
  // ranks would invent independent stage losses for stage-matrix replay.
  return {
    rank_after_fusion: fusionRank,
    rank_after_feature_rerank: deliveryRank,
    rank_after_coverage_selector: selectionOrder,
    coverage_selector_action: resolveCoverageSelectorAction(deliveryRank, selectionOrder)
  };
}

function resolveCoverageSelectorAction(
  beforeRank: number | undefined,
  afterRank: number
): "noop" | "kept" | "promoted" | "displaced" {
  if (beforeRank === undefined) return "noop";
  if (afterRank < beforeRank) return "promoted";
  if (afterRank > beforeRank) return "displaced";
  return "kept";
}

function lexicalRank(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
): number | null {
  if (candidate.originPlane === "global") return null;
  if (candidate.objectKind === "synthesis_capsule" || isSynthesisChildCandidate(candidate)) {
    return supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? null;
  }
  return isWorkspaceMemoryCandidate(candidate)
    ? supplementaryData.ftsRanks[candidate.entry.object_id] ?? null
    : null;
}

function buildSourceChannels(
  candidate: FineAssessmentCandidate,
  admissionPlanes: readonly RecallAdmissionPlane[]
): readonly string[] {
  return Object.freeze(uniqueStrings([
    candidate.originPlane ?? "workspace_local",
    candidate.sourceChannel ?? "",
    ...(candidate.sourceChannels ?? []),
    ...((candidate.effectiveFactors.embedding_similarity ?? 0) > 0 ? ["semantic_supplement"] : []),
    ...admissionPlanes.map((plane) => `plane:${plane}`)
  ].filter((channel) => channel.length > 0)));
}
