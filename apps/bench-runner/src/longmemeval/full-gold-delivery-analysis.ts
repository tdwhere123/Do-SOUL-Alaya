import { DELIVERY_MISS_TOP_K } from "./delivery-miss-taxonomy.js";
import type { FullGoldDeliveryContribution } from "@do-soul/alaya-eval";

export interface FullGoldDeliveryGoldInput {
  readonly objectId: string;
  readonly deliveredRank: number | null;
  readonly coreRank: number | null;
}

export interface FullGoldDeliveryQuestionInput {
  readonly questionId: string;
  readonly gold: readonly FullGoldDeliveryGoldInput[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function within(rank: number | null, k: number): boolean {
  return rank !== null && rank <= k;
}

export function analyzeFullGoldDeliveryContribution(
  questions: readonly FullGoldDeliveryQuestionInput[]
): FullGoldDeliveryContribution {
  let goldBearingQuestions = 0;
  let fullGoldAt5 = 0;
  let coreFullGoldAt5 = 0;
  let deliveryLiftQuestions = 0;
  let deliveryDropQuestions = 0;
  let goldTotal = 0;
  let goldDeliveredAt5 = 0;
  let coreGoldDeliveredAt5 = 0;
  let deliveryLiftGolds = 0;
  let deliveryDropGolds = 0;

  for (const question of questions) {
    if (question.gold.length === 0) {
      continue;
    }
    goldBearingQuestions += 1;
    let allDeliveredAt5 = true;
    let allCoreAt5 = true;
    for (const gold of question.gold) {
      goldTotal += 1;
      const deliveredAt5 = within(gold.deliveredRank, DELIVERY_MISS_TOP_K);
      const coreAt5 = within(gold.coreRank, DELIVERY_MISS_TOP_K);
      if (deliveredAt5) {
        goldDeliveredAt5 += 1;
      } else {
        allDeliveredAt5 = false;
      }
      if (coreAt5) {
        coreGoldDeliveredAt5 += 1;
      } else {
        allCoreAt5 = false;
      }
      if (!coreAt5 && deliveredAt5) {
        deliveryLiftGolds += 1;
      }
      if (coreAt5 && !deliveredAt5) {
        deliveryDropGolds += 1;
      }
    }
    if (allDeliveredAt5) {
      fullGoldAt5 += 1;
    }
    if (allCoreAt5) {
      coreFullGoldAt5 += 1;
    }
    if (!allCoreAt5 && allDeliveredAt5) {
      deliveryLiftQuestions += 1;
    }
    if (allCoreAt5 && !allDeliveredAt5) {
      deliveryDropQuestions += 1;
    }
  }

  return {
    gold_bearing_questions: goldBearingQuestions,
    full_gold_at_5: ratio(fullGoldAt5, goldBearingQuestions),
    core_full_gold_at_5: ratio(coreFullGoldAt5, goldBearingQuestions),
    delivery_lift_questions: deliveryLiftQuestions,
    delivery_drop_questions: deliveryDropQuestions,
    gold_coverage_at_5: ratio(goldDeliveredAt5, goldTotal),
    core_gold_coverage_at_5: ratio(coreGoldDeliveredAt5, goldTotal),
    delivery_lift_golds: deliveryLiftGolds,
    delivery_drop_golds: deliveryDropGolds
  } satisfies FullGoldDeliveryContribution;
}
