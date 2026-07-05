import type { FullGoldCoverage } from "@do-soul/alaya-eval";
import { isAbstentionQuestionId } from "./abstention.js";
import { buildLongMemEvalDeliveryContribution } from "./diagnostics-delivery-bridge.js";
import { ratio } from "./diagnostics-quality-helpers.js";
import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";

// full_gold/gold_coverage use delivered rank (what the agent saw); pool_recall
// uses pool rank (pre-budget reach) so a budget-dropped gold still counts as found.
function deliveredWithin(gold: LongMemEvalGoldDiagnostic, k: number): boolean {
  return gold.final_rank !== null && gold.final_rank <= k;
}

function poolWithin(gold: LongMemEvalGoldDiagnostic, k: number): boolean {
  const poolRank = gold.pre_budget_rank ?? gold.fused_rank;
  return poolRank !== null && poolRank <= k;
}

export function buildLongMemEvalFullGoldCoverage(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): FullGoldCoverage {
  let goldBearingQuestions = 0;
  let fullGoldAt5 = 0;
  let fullGoldAt10 = 0;
  let goldTotal = 0;
  let goldDeliveredAt5 = 0;
  let goldDeliveredAt10 = 0;
  let goldPoolAt50 = 0;
  let goldPoolAt100 = 0;

  for (const question of diagnostics) {
    if (isAbstentionQuestionId(question.question_id) || question.gold.length === 0) {
      continue;
    }
    goldBearingQuestions++;
    let allDeliveredAt5 = true;
    let allDeliveredAt10 = true;
    for (const gold of question.gold) {
      goldTotal++;
      if (deliveredWithin(gold, 5)) goldDeliveredAt5++;
      else allDeliveredAt5 = false;
      if (deliveredWithin(gold, 10)) goldDeliveredAt10++;
      else allDeliveredAt10 = false;
      if (poolWithin(gold, 50)) goldPoolAt50++;
      if (poolWithin(gold, 100)) goldPoolAt100++;
    }
    if (allDeliveredAt5) fullGoldAt5++;
    if (allDeliveredAt10) fullGoldAt10++;
  }

  return {
    gold_bearing_questions: goldBearingQuestions,
    full_gold_at_5: ratio(fullGoldAt5, goldBearingQuestions),
    full_gold_at_10: ratio(fullGoldAt10, goldBearingQuestions),
    gold_coverage_at_5: ratio(goldDeliveredAt5, goldTotal),
    gold_coverage_at_10: ratio(goldDeliveredAt10, goldTotal),
    pool_recall_at_50: ratio(goldPoolAt50, goldTotal),
    pool_recall_at_100: ratio(goldPoolAt100, goldTotal),
    delivery_contribution: buildLongMemEvalDeliveryContribution(diagnostics)
  };
}
