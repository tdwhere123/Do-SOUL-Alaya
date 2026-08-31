import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "../schema/diagnostics-types.js";
import { isDeliveryAdmissionLoss } from "../schema/diagnostics-private.js";
import { readGoldObjectIds } from "../gold-object-identities.js";
import { goldPoolRank, hasCoverageOrBudgetSignal } from "./pool-rank.js";
import {
  classifyHonestHigherRObj,
  type HonestHigherRObjVerdict
} from "./honest-higher-r-obj.js";
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
    stage = "delivered_top5";
    proof = "final_rank<=5";
  } else if (
    taxonomy === "materialization_drop" ||
    isExtractionDrop(question) ||
    (taxonomy === "candidate_absent" && !emitted)
  ) {
    stage = "write_or_unevaluable";
    proof = taxonomy === "materialization_drop"
      ? "gold.materialization_drop"
      : "write_or_unevaluable";
  } else if (
    taxonomy === "fine_assessment_drop" ||
    prunedIds.has(gold.object_id)
  ) {
    stage = "pre_waist_prune";
    proof = taxonomy === "fine_assessment_drop"
      ? "gold.fine_assessment_drop"
      : "id_in_fine_assessment_pruned_candidates";
  } else if (
    taxonomy === "candidate_absent" &&
    emitted &&
    !candidateIds.has(gold.object_id) &&
    !prunedIds.has(gold.object_id)
  ) {
    stage = "raw_pool_absent";
    proof = "memory_emitted_and_absent_from_candidates_and_prune";
  } else if (
    taxonomy === "budget_drop" ||
    taxonomy === "answer_set_coverage_drop" ||
    isDeliveryAdmissionLoss(gold) ||
    hasCoverageOrBudgetSignal(gold)
  ) {
    stage = "coverage_or_budget";
    proof = isDeliveryAdmissionLoss(gold)
      ? "delivery_admission_refusal"
      : (taxonomy ?? "coverage_or_budget_signal");
  } else if (poolRank !== null && poolRank <= 10) {
    stage = "near_top_final_order";
    proof = "pool_rank<=10_not_delivered_top5";
  } else if (poolRank !== null) {
    stage = "waist_composition";
    proof = "waist_present_pool_rank_gt_10";
  } else if (taxonomy === "candidate_absent") {
    stage = "raw_pool_absent";
    proof = "gold.candidate_absent_without_ranks";
  } else {
    stage = "write_or_unevaluable";
    proof = "unevaluable_or_unranked_fallback";
  }

  const nearTop =
    stage === "near_top_final_order"
      ? classifyHonestHigherRObj({ question, gold })
      : null;

  return {
    question_id: question.question_id,
    object_id: gold.object_id,
    object_kind: gold.object_kind,
    stage,
    mechanism: classifyMechanism(stage, gold, poolRank, nearTop),
    opportunity_pre_budget_6_10:
      input.opportunityQuestion && poolRank !== null && poolRank <= 10,
    miss_taxonomy: taxonomy,
    pool_rank: poolRank,
    final_rank: finalRank,
    proof,
    ...(nearTop === null
      ? {}
      : {
          near_top_class: nearTop.classification,
          gold_family_max: nearTop.gold_family_max,
          rank5_family_max: nearTop.rank5_family_max
        })
  };
}

export function classifyMechanism(
  stage: AttributionStage,
  gold: LongMemEvalGoldDiagnostic,
  poolRank: number | null,
  nearTop: HonestHigherRObjVerdict | null = null
): AttributionMechanism {
  if (
    stage === "delivered_top5" ||
    stage === "write_or_unevaluable" ||
    stage === "raw_pool_absent" ||
    stage === "pre_waist_prune"
  ) return null;
  if (
    gold.miss_taxonomy === "budget_drop" ||
    gold.miss_taxonomy === "answer_set_coverage_drop" ||
    isDeliveryAdmissionLoss(gold) ||
    hasCoverageOrBudgetSignal(gold)
  ) {
    return "coverage_admission";
  }
  if (poolRank === null) return null;
  // Every top-5 occupier legally outranks the gold on family-max R_obj:
  // the fused order is honest, not a Gamma reorder or composition loss.
  if (nearTop?.classification === "honest_higher_r_obj") {
    return "honest_higher_r_obj";
  }
  // Fused already outside top-5 means composition owned the loss before final order.
  if (gold.fused_rank !== null && gold.fused_rank > 5) return "composition";
  if (gold.miss_taxonomy === "delivery_order_drop" || stage === "near_top_final_order") {
    return "residual_order";
  }
  if (stage === "waist_composition") return "composition";
  return null;
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
