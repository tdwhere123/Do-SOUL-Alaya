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

export interface FullGoldDeliveryAccumulator {
  goldBearingQuestions: number;
  fullGoldAt5: number;
  coreFullGoldAt5: number;
  deliveryLiftQuestions: number;
  deliveryDropQuestions: number;
  goldTotal: number;
  goldDeliveredAt5: number;
  coreGoldDeliveredAt5: number;
  deliveryLiftGolds: number;
  deliveryDropGolds: number;
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
  const counters = createFullGoldDeliveryAccumulator();
  for (const question of questions) {
    recordFullGoldDeliveryQuestion(counters, question);
  }

  return renderFullGoldDeliveryContribution(counters);
}

export function renderFullGoldDeliveryContribution(
  counters: FullGoldDeliveryAccumulator
): FullGoldDeliveryContribution {
  return {
    gold_bearing_questions: counters.goldBearingQuestions,
    full_gold_at_5: ratio(counters.fullGoldAt5, counters.goldBearingQuestions),
    core_full_gold_at_5: ratio(counters.coreFullGoldAt5, counters.goldBearingQuestions),
    delivery_lift_questions: counters.deliveryLiftQuestions,
    delivery_drop_questions: counters.deliveryDropQuestions,
    gold_coverage_at_5: ratio(counters.goldDeliveredAt5, counters.goldTotal),
    core_gold_coverage_at_5: ratio(counters.coreGoldDeliveredAt5, counters.goldTotal),
    delivery_lift_golds: counters.deliveryLiftGolds,
    delivery_drop_golds: counters.deliveryDropGolds
  } satisfies FullGoldDeliveryContribution;
}

export function createFullGoldDeliveryAccumulator(): FullGoldDeliveryAccumulator {
  return {
    goldBearingQuestions: 0,
    fullGoldAt5: 0,
    coreFullGoldAt5: 0,
    deliveryLiftQuestions: 0,
    deliveryDropQuestions: 0,
    goldTotal: 0,
    goldDeliveredAt5: 0,
    coreGoldDeliveredAt5: 0,
    deliveryLiftGolds: 0,
    deliveryDropGolds: 0
  };
}

export function recordFullGoldDeliveryQuestion(
  counters: FullGoldDeliveryAccumulator,
  question: FullGoldDeliveryQuestionInput
): void {
  if (question.gold.length === 0) {
    return;
  }
  counters.goldBearingQuestions += 1;
  const coverage = accumulateFullGoldCoverage(counters, question.gold);
  if (coverage.allDeliveredAt5) counters.fullGoldAt5 += 1;
  if (coverage.allCoreAt5) counters.coreFullGoldAt5 += 1;
  if (!coverage.allCoreAt5 && coverage.allDeliveredAt5) {
    counters.deliveryLiftQuestions += 1;
  }
  if (coverage.allCoreAt5 && !coverage.allDeliveredAt5) {
    counters.deliveryDropQuestions += 1;
  }
}

function accumulateFullGoldCoverage(
  counters: FullGoldDeliveryAccumulator,
  golds: readonly FullGoldDeliveryGoldInput[]
): { readonly allDeliveredAt5: boolean; readonly allCoreAt5: boolean } {
  let allDeliveredAt5 = true;
  let allCoreAt5 = true;
  for (const gold of golds) {
    counters.goldTotal += 1;
    const deliveredAt5 = within(gold.deliveredRank, DELIVERY_MISS_TOP_K);
    const coreAt5 = within(gold.coreRank, DELIVERY_MISS_TOP_K);
    if (deliveredAt5) counters.goldDeliveredAt5 += 1;
    else allDeliveredAt5 = false;
    if (coreAt5) counters.coreGoldDeliveredAt5 += 1;
    else allCoreAt5 = false;
    if (!coreAt5 && deliveredAt5) counters.deliveryLiftGolds += 1;
    if (coreAt5 && !deliveredAt5) counters.deliveryDropGolds += 1;
  }
  return { allDeliveredAt5, allCoreAt5 };
}
