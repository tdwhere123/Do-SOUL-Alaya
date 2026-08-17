import type { LongMemEvalQuestionDiagnostic } from "../schema/diagnostics-types.js";
import { readQuestionMissTaxonomy } from "../miss/diagnostics-miss-taxonomy.js";
import { readGoldObjectIds } from "../gold-object-identities.js";
import {
  bestGoldPoolRank,
  isKpiPreBudget610Opportunity,
  isRankBucketCandidateAbsent
} from "./pool-rank.js";
import {
  classifyGoldObjectStage,
  classifyMechanism,
  questionHasEmptyGold
} from "./classify-gold.js";
import type {
  AttributionMechanism,
  AttributionStage,
  QuestionStageRow
} from "./types.js";

export function classifyQuestionStage(
  question: LongMemEvalQuestionDiagnostic
): QuestionStageRow {
  const opportunity = isKpiPreBudget610Opportunity({
    hitAt5: question.hit_at_5,
    golds: question.gold
  });
  const bestPoolRank = bestGoldPoolRank(question.gold);
  const taxonomy = readQuestionMissTaxonomy(question);
  const emptyGold = questionHasEmptyGold(question);
  const extractionDrop =
    question.cohort_ledger?.extraction_materialization.status === "drop";

  let stage: AttributionStage;
  let proof: string;
  let mechanism: AttributionMechanism = null;

  if (question.hit_at_5) {
    stage = 7;
    proof = "hit_at_5";
  } else if (
    emptyGold ||
    extractionDrop ||
    taxonomy === "evaluation_or_gold_issue" ||
    taxonomy === "materialization_drop"
  ) {
    stage = 1;
    proof = emptyGold
      ? "empty_gold_or_write_loss"
      : (taxonomy ?? "extraction_materialization_drop");
  } else if (taxonomy === "fine_assessment_drop") {
    stage = 3;
    proof = "miss_taxonomy.fine_assessment_drop";
  } else if (taxonomy === "candidate_absent") {
    const formation = question.query_open_semantic_factor_formation;
    const emitted =
      question.cohort_ledger?.extraction_materialization.status ===
        "memory_emitted" ||
      question.cohort_ledger?.extraction_materialization.status ===
        "evidence_preserved";
    if (formation !== null && formation !== undefined && formation.status !== "formed") {
      stage = 2;
      proof = `semantic_factor_formation_${formation.status}`;
    } else {
      stage = emitted && !emptyGold ? 2 : 1;
      proof = emitted
        ? "miss_taxonomy.candidate_absent_with_emitted_gold"
        : "miss_taxonomy.candidate_absent_unevaluable";
    }
  } else if (
    taxonomy === "budget_drop" ||
    taxonomy === "answer_set_coverage_drop"
  ) {
    stage = 5;
    proof = `miss_taxonomy.${taxonomy}`;
    mechanism = "coverage_admission";
  } else if (bestPoolRank !== null && bestPoolRank <= 10) {
    stage = 6;
    proof = "kpi_pre_budget_6_10_opportunity";
    mechanism = mechanismFromBestGold(question, stage);
  } else if (bestPoolRank !== null) {
    stage = 4;
    proof = "waist_present_best_pool_rank_gt_10";
    mechanism = mechanismFromBestGold(question, stage);
  } else {
    stage = 1;
    proof = "unranked_miss_fallback";
  }

  return {
    question_id: question.question_id,
    stage,
    mechanism,
    opportunity_pre_budget_6_10: opportunity,
    miss_taxonomy: taxonomy,
    best_pool_rank: bestPoolRank,
    hit_at_5: question.hit_at_5,
    proof
  };
}

function mechanismFromBestGold(
  question: LongMemEvalQuestionDiagnostic,
  stage: AttributionStage
): AttributionMechanism {
  if (question.gold.length === 0) return null;
  let best = question.gold[0]!;
  let bestRank = bestGoldPoolRank([best]);
  for (const gold of question.gold) {
    const rank = bestGoldPoolRank([gold]);
    if (rank !== null && (bestRank === null || rank < bestRank)) {
      best = gold;
      bestRank = rank;
    }
  }
  return classifyMechanism(stage, best, bestRank);
}

export function isQualityCandidateAbsent(
  question: LongMemEvalQuestionDiagnostic
): boolean {
  return (
    question.miss_classification === "candidate_absent" &&
    readGoldObjectIds(question).length === 0
  );
}

export function isMissTaxonomyCandidateAbsent(
  question: LongMemEvalQuestionDiagnostic
): boolean {
  if (question.hit_at_5) return false;
  return readQuestionMissTaxonomy(question) === "candidate_absent";
}

export function isDeliveryOrderDrop(
  question: LongMemEvalQuestionDiagnostic
): boolean {
  if (question.hit_at_5) return false;
  return readQuestionMissTaxonomy(question) === "delivery_order_drop";
}

export { isRankBucketCandidateAbsent, classifyGoldObjectStage };
