import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalMissTaxonomy,
  LongMemEvalQuestionMeasurementAxes
} from "./diagnostics-types.js";
import type { LongMemEvalSeedDropReasons } from "./seed-drop-reasons.js";
import { deriveQuestionMeasurementStatus } from
  "./measurement/question-measurement-status.js";

export interface LongMemEvalQuestionCohortLedger {
  readonly measurement_evidence_mode?: "legacy_synthesized";
  readonly measurement_status:
    | "scorable"
    | "abstention_unscorable"
    | "evaluator_identity_unscorable";
  readonly dataset_cohort: "answerable" | "abstention" | "adjudicated_invalid";
  readonly extraction_materialization: {
    readonly status: "memory_emitted" | "drop" | "unknown";
    readonly emitted_memory_count: number;
    readonly reason: "candidate_absent" | "materialization_drop" | null;
  };
  readonly evaluator_gold_identity: {
    readonly status: "present" | "absent" | "ambiguous";
    readonly object_ids: readonly string[];
  };
  readonly retrieval_status: "hit_at_5" | "miss_at_5" | "not_applicable";
  readonly evidence_status: "complete" | "partial" | "missing";
  readonly evaluation_issue_reason:
    | "missing_diagnostics"
    | "empty_gold_identity"
    | "extraction_materialization_drop"
    | "gold_taxonomy_fallthrough"
    | "identity_join_error"
    | "evaluator_data_identity_inconsistency"
    | "evaluator_data_identity_indeterminate"
    | "adjudicated_dataset_issue"
    | null;
  readonly candidate_pool_complete: boolean;
  readonly quality_axes?: LongMemEvalQuestionMeasurementAxes;
  readonly stage_ranks: readonly LongMemEvalGoldStageRanks[];
  readonly final_verdict:
    | "hit_at_5"
    | "miss_at_5"
    | "abstained_correctly"
    | "abstain_false_confident"
    | "abstention_uncalibrated"
    | "evaluation_unscorable"
    | "evaluator_data_identity_inconsistency"
    | "evaluator_data_identity_indeterminate"
    | "adjudicated_invalid";
}

interface LongMemEvalGoldStageRanks {
  readonly object_id: string;
  readonly fused_rank: number | null;
  readonly rank_after_feature_rerank: number | null;
  readonly rank_after_lexical_priority: number | null;
  readonly rank_after_synthesis_reserve: number | null;
  readonly rank_after_structural_reserve: number | null;
  readonly rank_after_coverage_selector: number | null;
  readonly rank_after_session_coverage: number | null;
  readonly selection_order: number | null;
  readonly final_rank: number | null;
}

export function buildQuestionCohortLedger(input: {
  readonly isAbstention: boolean;
  readonly premiseInvalid: boolean;
  readonly hitAt5: boolean;
  readonly goldMemoryIds: readonly string[];
  readonly gold: readonly LongMemEvalGoldDiagnostic[];
  readonly diagnosticsAvailable: boolean;
  readonly candidatePoolComplete: boolean;
  readonly identityConflictObjectIds?: readonly string[];
  readonly missTaxonomy: LongMemEvalMissTaxonomy | null;
  readonly seedDropReasons?: LongMemEvalSeedDropReasons;
}): LongMemEvalQuestionCohortLedger {
  const datasetCohort = input.premiseInvalid || hasAbstentionIdentityConflict(input)
    ? "adjudicated_invalid"
    : input.isAbstention ? "abstention" : "answerable";
  const ambiguousIdentity = input.goldMemoryIds.some((id) =>
    input.identityConflictObjectIds?.includes(id) === true
  );
  const identityPresent = input.goldMemoryIds.length > 0 && !ambiguousIdentity;
  const primitives = buildMeasurementPrimitives(input, datasetCohort, ambiguousIdentity);
  return {
    measurement_status: deriveQuestionMeasurementStatus({
      isAbstention: input.isAbstention,
      cohortLedger: { dataset_cohort: datasetCohort, ...primitives }
    }),
    dataset_cohort: datasetCohort,
    ...primitives,
    retrieval_status: datasetCohort === "answerable" && identityPresent
      ? input.hitAt5 ? "hit_at_5" : "miss_at_5"
      : "not_applicable",
    evidence_status: !input.diagnosticsAvailable
      ? "missing"
      : input.candidatePoolComplete ? "complete" : "partial",
    candidate_pool_complete: input.candidatePoolComplete,
    stage_ranks: input.gold.map(toStageRanks),
    final_verdict: finalVerdict(input, datasetCohort, identityPresent)
  };
}

function buildMeasurementPrimitives(
  input: Parameters<typeof buildQuestionCohortLedger>[0],
  cohort: LongMemEvalQuestionCohortLedger["dataset_cohort"],
  ambiguousIdentity: boolean
) {
  const identityPresent = input.goldMemoryIds.length > 0 && !ambiguousIdentity;
  return {
    extraction_materialization: extractionStatus(input),
    evaluator_gold_identity: {
      status: ambiguousIdentity
        ? "ambiguous" as const
        : identityPresent ? "present" as const : "absent" as const,
      object_ids: input.goldMemoryIds
    },
    evaluation_issue_reason: evaluationIssueReason(input, cohort, ambiguousIdentity)
  };
}

function extractionStatus(
  input: Parameters<typeof buildQuestionCohortLedger>[0]
): LongMemEvalQuestionCohortLedger["extraction_materialization"] {
  if (input.goldMemoryIds.length > 0) {
    return { status: "memory_emitted", emitted_memory_count: input.goldMemoryIds.length, reason: null };
  }
  if ((input.seedDropReasons?.materialization_drop ?? 0) > 0) {
    return { status: "drop", emitted_memory_count: 0, reason: "materialization_drop" };
  }
  if ((input.seedDropReasons?.candidate_absent ?? 0) > 0) {
    return { status: "drop", emitted_memory_count: 0, reason: "candidate_absent" };
  }
  return { status: "unknown", emitted_memory_count: 0, reason: null };
}

function evaluationIssueReason(
  input: Parameters<typeof buildQuestionCohortLedger>[0],
  cohort: LongMemEvalQuestionCohortLedger["dataset_cohort"],
  ambiguousIdentity: boolean
): LongMemEvalQuestionCohortLedger["evaluation_issue_reason"] {
  if (hasAbstentionIdentityConflict(input)) {
    return "evaluator_data_identity_inconsistency";
  }
  if (cohort === "adjudicated_invalid") return "adjudicated_dataset_issue";
  if (cohort === "abstention") return null;
  if (!input.diagnosticsAvailable) return "missing_diagnostics";
  if (extractionStatus(input).status === "drop") return "extraction_materialization_drop";
  if (input.goldMemoryIds.length === 0) return "empty_gold_identity";
  if (ambiguousIdentity) return "identity_join_error";
  return input.missTaxonomy === "evaluation_or_gold_issue"
    ? "gold_taxonomy_fallthrough"
    : null;
}

function finalVerdict(
  input: Parameters<typeof buildQuestionCohortLedger>[0],
  cohort: LongMemEvalQuestionCohortLedger["dataset_cohort"],
  identityPresent: boolean
): LongMemEvalQuestionCohortLedger["final_verdict"] {
  if (hasAbstentionIdentityConflict(input)) {
    return "evaluator_data_identity_inconsistency";
  }
  if (cohort === "adjudicated_invalid") return "adjudicated_invalid";
  if (cohort === "abstention") return "abstention_uncalibrated";
  if (!identityPresent) return "evaluation_unscorable";
  return input.hitAt5 ? "hit_at_5" : "miss_at_5";
}

export function hasAbstentionIdentityConflict(
  input: {
    readonly isAbstention: boolean;
    readonly goldMemoryIds: readonly string[];
  }
): boolean {
  return input.isAbstention && input.goldMemoryIds.length > 0;
}

function toStageRanks(gold: LongMemEvalGoldDiagnostic): LongMemEvalGoldStageRanks {
  return {
    object_id: gold.object_id,
    fused_rank: gold.fused_rank,
    rank_after_feature_rerank: gold.rank_after_feature_rerank,
    rank_after_lexical_priority: gold.rank_after_lexical_priority,
    rank_after_synthesis_reserve: gold.rank_after_synthesis_reserve,
    rank_after_structural_reserve: gold.rank_after_structural_reserve,
    rank_after_coverage_selector: gold.rank_after_coverage_selector,
    rank_after_session_coverage: gold.rank_after_session_coverage,
    selection_order: gold.selection_order,
    final_rank: gold.final_rank
  };
}
