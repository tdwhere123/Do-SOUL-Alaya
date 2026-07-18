import type { FullGoldCoverage } from "@do-soul/alaya-eval";
import { isAbstentionQuestionId } from "./abstention.js";
import { resolveCoreDeliveryRank } from "./miss/diagnostics-delivery-bridge.js";
import {
  createFullGoldDeliveryAccumulator,
  recordFullGoldDeliveryQuestion,
  renderFullGoldDeliveryContribution,
  type FullGoldDeliveryAccumulator
} from "./miss/full-gold-delivery-analysis.js";
import { ratio } from "./quality/diagnostics-quality-helpers.js";
import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "./schema/diagnostics-types.js";

// Delivered rank drives full_gold; pre-budget pool rank drives pool_recall; fusion rank drives delivery_contribution.
function deliveredWithin(gold: LongMemEvalGoldDiagnostic, k: number): boolean {
  return gold.final_rank !== null && gold.final_rank <= k;
}

function poolWithin(gold: LongMemEvalGoldDiagnostic, k: number): boolean {
  const poolRank = gold.pre_budget_rank ?? gold.fused_rank;
  return poolRank !== null && poolRank <= k;
}

export interface LongMemEvalFullGoldCoverageAccumulator {
  goldBearingQuestions: number;
  fullGoldAt5: number;
  fullGoldAt10: number;
  goldTotal: number;
  goldDeliveredAt5: number;
  goldDeliveredAt10: number;
  goldPoolAt50: number;
  goldPoolAt100: number;
  readonly delivery: FullGoldDeliveryAccumulator;
}

export function buildLongMemEvalFullGoldCoverage(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): FullGoldCoverage {
  const accumulator = createLongMemEvalFullGoldCoverageAccumulator();
  for (const question of diagnostics) {
    recordLongMemEvalFullGoldCoverage(accumulator, question);
  }
  return renderLongMemEvalFullGoldCoverage(accumulator);
}

export function createLongMemEvalFullGoldCoverageAccumulator():
LongMemEvalFullGoldCoverageAccumulator {
  return {
    goldBearingQuestions: 0,
    fullGoldAt5: 0,
    fullGoldAt10: 0,
    goldTotal: 0,
    goldDeliveredAt5: 0,
    goldDeliveredAt10: 0,
    goldPoolAt50: 0,
    goldPoolAt100: 0,
    delivery: createFullGoldDeliveryAccumulator()
  };
}

export function recordLongMemEvalFullGoldCoverage(
  accumulator: LongMemEvalFullGoldCoverageAccumulator,
  question: LongMemEvalQuestionDiagnostic
): void {
  if (isAbstentionQuestionId(question.question_id) || question.gold.length === 0) return;
  accumulator.goldBearingQuestions += 1;
  let allDeliveredAt5 = true;
  let allDeliveredAt10 = true;
  for (const gold of question.gold) {
    accumulator.goldTotal += 1;
    if (deliveredWithin(gold, 5)) accumulator.goldDeliveredAt5 += 1;
    else allDeliveredAt5 = false;
    if (deliveredWithin(gold, 10)) accumulator.goldDeliveredAt10 += 1;
    else allDeliveredAt10 = false;
    if (poolWithin(gold, 50)) accumulator.goldPoolAt50 += 1;
    if (poolWithin(gold, 100)) accumulator.goldPoolAt100 += 1;
  }
  if (allDeliveredAt5) accumulator.fullGoldAt5 += 1;
  if (allDeliveredAt10) accumulator.fullGoldAt10 += 1;
  recordDeliveryContribution(accumulator.delivery, question);
}

export function renderLongMemEvalFullGoldCoverage(
  accumulator: LongMemEvalFullGoldCoverageAccumulator
): FullGoldCoverage {
  const questions = accumulator.goldBearingQuestions;
  const gold = accumulator.goldTotal;

  return {
    gold_bearing_questions: questions,
    full_gold_at_5: ratio(accumulator.fullGoldAt5, questions),
    full_gold_at_10: ratio(accumulator.fullGoldAt10, questions),
    gold_coverage_at_5: ratio(accumulator.goldDeliveredAt5, gold),
    gold_coverage_at_10: ratio(accumulator.goldDeliveredAt10, gold),
    pool_recall_at_50: ratio(accumulator.goldPoolAt50, gold),
    pool_recall_at_100: ratio(accumulator.goldPoolAt100, gold),
    delivery_contribution: renderFullGoldDeliveryContribution(accumulator.delivery)
  };
}

function recordDeliveryContribution(
  accumulator: FullGoldDeliveryAccumulator,
  question: LongMemEvalQuestionDiagnostic
): void {
  recordFullGoldDeliveryQuestion(accumulator, {
    questionId: question.question_id,
    gold: question.gold.map((row) => ({
      objectId: row.object_id,
      deliveredRank: row.final_rank,
      coreRank: resolveCoreDeliveryRank(row)
    }))
  });
}
