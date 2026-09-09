import type {
  DiagnosticAnswerShapePlan,
  LongMemEvalReplayCandidate,
  NarrowRecallDiagnostics
} from "../../diagnostics/schema/diagnostics-types.js";

// Archived ranking traces need their original evidence bindings to be replayable.
// These checks validate recorded values; they do not select or score candidates.
export function historicalCandidatePoolComplete(
  diagnostics: NarrowRecallDiagnostics | null,
  candidates: readonly LongMemEvalReplayCandidate[]
): boolean {
  if (diagnostics?.rankingAuthority === "prefix_sk") {
    return diagnostics.candidatePoolComplete === true &&
      diagnostics.captureReceipt?.execution.status === "captured";
  }
  return diagnostics?.candidatePoolComplete === true &&
    candidates.every((candidate) =>
      isReplayCandidateComplete(candidate, diagnostics.answerShapePlan)
    );
}

function isReplayCandidateComplete(
  candidate: LongMemEvalReplayCandidate,
  answerShapePlan: DiagnosticAnswerShapePlan | null
): boolean {
  const legacyComplete = candidate.per_stream_rank !== null &&
    candidate.fused_rank_contribution_per_stream !== null &&
    candidate.score_factors.activation !== undefined &&
    candidate.score_factors.created_at !== undefined;
  if (!legacyComplete || answerShapePlan === null) return legacyComplete;
  return hasCompleteAnswerTrace(candidate, answerShapePlan) &&
    hasConsistentDeepHeadDecision(candidate);
}

function hasCompleteAnswerTrace(
  candidate: LongMemEvalReplayCandidate,
  plan: DiagnosticAnswerShapePlan
): boolean {
  if (
    candidate.answer_features === null ||
    candidate.deep_head_trace === null ||
    candidate.coverage_marginal_gain === null
  ) return false;
  if (plan.status !== "high_confidence") return true;
  const support = candidate.answer_features.answer_support ?? null;
  if (support === null || support.shape !== plan.shape) return false;
  return hasConsistentAnswerSupport(candidate, plan, support);
}

function hasConsistentAnswerSupport(
  candidate: LongMemEvalReplayCandidate,
  plan: DiagnosticAnswerShapePlan,
  support: NonNullable<
    NonNullable<LongMemEvalReplayCandidate["answer_features"]>["answer_support"]
  >
): boolean {
  const expectedEligible = candidate.object_kind === "memory_entry" &&
    candidate.answer_features!.evidence_refs.length > 0;
  if (support.eligible !== expectedEligible) return false;
  if (!support.matched_target_terms.every((term) => plan.target_terms.includes(term))) {
    return false;
  }
  if (!support.matched_relation_terms.every((term) => plan.relation_terms.includes(term))) {
    return false;
  }
  if (
    support.eligible &&
    support.status !== "observation_only" &&
    support.authority === undefined
  ) return false;
  const authorityRef = support.authority?.evidence_ref ?? null;
  if (
    authorityRef !== null &&
    !candidate.answer_features!.evidence_refs.includes(authorityRef)
  ) return false;
  if (!support.eligible || support.status === "observation_only") return true;
  const expectedRelationSupport = plan.relation_terms.length === 0 ||
    support.matched_relation_terms.length > 0;
  return support.relation_supported === expectedRelationSupport;
}

function hasConsistentDeepHeadDecision(
  candidate: LongMemEvalReplayCandidate
): boolean {
  const trace = candidate.deep_head_trace;
  if (trace === null) return false;
  if (trace.score_source === "cross_encoder") {
    return candidate.answer_relevance_score !== null &&
      approximatelyEqual(candidate.answer_relevance_score, trace.resolved_score!);
  }
  if (trace.score_source === "cross_encoder_unscored") {
    return candidate.answer_relevance_score === null;
  }
  if (
    trace.score_source !== "fusion_evidence" &&
    trace.score_source !== "fusion_embedding_evidence" &&
    trace.score_source !== "field_baseline"
  ) return true;
  if (candidate.fused_score === null || trace.resolved_score === null) return false;
  const resident = trace.score_source === "fusion_embedding_evidence"
    ? probabilisticOr(candidate.fused_score, trace.embedding_signal ?? 0)
    : candidate.fused_score;
  return approximatelyEqual(
    trace.resolved_score,
    probabilisticOr(resident, trace.resolved_evidence)
  );
}

function probabilisticOr(left: number, right: number): number {
  return left + right - left * right;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}
