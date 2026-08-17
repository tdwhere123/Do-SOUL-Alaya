import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "../schema/diagnostics-types.js";
import { readGoldObjectIds } from "../gold-object-identities.js";
import { goldPoolRank } from "./pool-rank.js";
import type {
  AttributionMechanism,
  AttributionStage,
  GoldObjectStageRow
} from "./types.js";

export function classifyGoldObjectStage(input: {
  readonly question: LongMemEvalQuestionDiagnostic;
  readonly gold: LongMemEvalGoldDiagnostic;
  readonly opportunityQuestion: boolean;
}): GoldObjectStageRow {
  const { question, gold } = input;
  const prunedIds = prunedObjectIds(question);
  const candidateIds = candidateObjectIds(question);
  const emitted = isMemoryEmitted(question);
  const poolRank = goldPoolRank(gold);
  const finalRank = gold.final_rank;
  const taxonomy = gold.miss_taxonomy;

  let stage: AttributionStage;
  let proof: string;

  if (finalRank !== null && finalRank <= 5) {
    stage = 7;
    proof = "final_rank<=5";
  } else if (
    taxonomy === "materialization_drop" ||
    isExtractionDrop(question) ||
    (taxonomy === "candidate_absent" && !emitted)
  ) {
    stage = 1;
    proof = taxonomy === "materialization_drop"
      ? "gold.materialization_drop"
      : "write_or_unevaluable";
  } else if (
    taxonomy === "fine_assessment_drop" ||
    prunedIds.has(gold.object_id)
  ) {
    stage = 3;
    proof = taxonomy === "fine_assessment_drop"
      ? "gold.fine_assessment_drop"
      : "id_in_fine_assessment_pruned_candidates";
  } else if (
    taxonomy === "candidate_absent" &&
    emitted &&
    !candidateIds.has(gold.object_id) &&
    !prunedIds.has(gold.object_id)
  ) {
    stage = 2;
    proof = "memory_emitted_and_absent_from_candidates_and_prune";
  } else if (
    taxonomy === "budget_drop" ||
    taxonomy === "answer_set_coverage_drop" ||
    hasCoverageOrBudgetSignal(gold)
  ) {
    stage = 5;
    proof = taxonomy ?? "coverage_or_budget_signal";
  } else if (poolRank !== null && poolRank <= 10) {
    stage = 6;
    proof = "pool_rank<=10_not_delivered_top5";
  } else if (poolRank !== null) {
    stage = 4;
    proof = "waist_present_pool_rank_gt_10";
  } else if (taxonomy === "candidate_absent") {
    stage = 2;
    proof = "gold.candidate_absent_without_ranks";
  } else {
    stage = 1;
    proof = "unevaluable_or_unranked_fallback";
  }

  return {
    question_id: question.question_id,
    object_id: gold.object_id,
    object_kind: gold.object_kind,
    stage,
    mechanism: classifyMechanism(stage, gold, poolRank),
    opportunity_pre_budget_6_10:
      input.opportunityQuestion && poolRank !== null && poolRank <= 10,
    miss_taxonomy: taxonomy,
    pool_rank: poolRank,
    final_rank: finalRank,
    proof
  };
}

export function classifyMechanism(
  stage: AttributionStage,
  gold: LongMemEvalGoldDiagnostic,
  poolRank: number | null
): AttributionMechanism {
  if (stage === 7 || stage === 1 || stage === 2 || stage === 3) return null;
  if (
    gold.miss_taxonomy === "budget_drop" ||
    gold.miss_taxonomy === "answer_set_coverage_drop" ||
    hasCoverageOrBudgetSignal(gold)
  ) {
    return "coverage_admission";
  }
  if (poolRank === null) return null;
  // Fused already outside top-5 means composition owned the loss before final order.
  if (gold.fused_rank !== null && gold.fused_rank > 5) return "composition";
  if (gold.miss_taxonomy === "delivery_order_drop" || stage === 6) {
    return "residual_order";
  }
  if (stage === 4) return "composition";
  return null;
}

function hasCoverageOrBudgetSignal(gold: LongMemEvalGoldDiagnostic): boolean {
  if (gold.budget_drop_reason !== null) {
    const rank = gold.pre_budget_rank ?? gold.fused_rank;
    if (rank !== null && rank <= 10) return true;
  }
  const preCoverage =
    gold.rank_after_feature_rerank ??
    gold.rank_after_fusion ??
    gold.fused_rank;
  const coverageRank = gold.rank_after_coverage_selector;
  return (
    preCoverage !== null &&
    preCoverage <= 5 &&
    coverageRank !== null &&
    coverageRank > 5
  );
}

function isMemoryEmitted(question: LongMemEvalQuestionDiagnostic): boolean {
  const status = question.cohort_ledger?.extraction_materialization.status;
  return status === "memory_emitted" || status === "evidence_preserved";
}

function isExtractionDrop(question: LongMemEvalQuestionDiagnostic): boolean {
  return question.cohort_ledger?.extraction_materialization.status === "drop";
}

function prunedObjectIds(
  question: LongMemEvalQuestionDiagnostic
): ReadonlySet<string> {
  return new Set(
    (question.fine_assessment_pruned_candidates ?? []).map((row) => row.object_id)
  );
}

function candidateObjectIds(
  question: LongMemEvalQuestionDiagnostic
): ReadonlySet<string> {
  return new Set((question.candidates ?? []).map((row) => row.object_id));
}

export function questionHasEmptyGold(
  question: LongMemEvalQuestionDiagnostic
): boolean {
  return readGoldObjectIds(question).length === 0;
}
