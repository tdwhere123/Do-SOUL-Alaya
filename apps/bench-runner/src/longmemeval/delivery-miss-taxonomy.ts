export type DeliveryMissDropReason =
  | "duplicate"
  | "dimension_limit"
  | "max_entries"
  | "max_total_tokens";

export const DELIVERY_MISS_TOP_K = 5;
export const DELIVERY_BUDGET_LOSS_RANK = 10;

export type DeliveryMissTaxonomy =
  | "candidate_absent"
  | "materialization_drop"
  | "budget_drop"
  | "delivery_order_drop"
  | "answer_set_coverage_drop";

export type DeliveryStageAction = "noop" | "kept" | "promoted" | "displaced";

export interface DeliveryMissCandidateInput {
  readonly objectKind: string;
  readonly preBudgetRank: number | null;
  readonly fusedRank: number | null;
  readonly finalRank: number | null;
  readonly droppedReason: DeliveryMissDropReason | null;
  readonly rankAfterFusion: number | null;
  readonly rankAfterCoverageSelector: number | null;
  readonly coverageSelectorAction: DeliveryStageAction | null;
}

export interface ClassifyDeliveryMissInput {
  readonly deliveredRank: number | null;
  readonly candidate: DeliveryMissCandidateInput | undefined;
  readonly anyObjectCandidate: DeliveryMissCandidateInput | undefined;
  readonly diagnosticsAvailable: boolean;
}

export function classifyDeliveryMissTaxonomy(
  input: ClassifyDeliveryMissInput
): DeliveryMissTaxonomy | null {
  if (input.deliveredRank !== null && input.deliveredRank <= DELIVERY_MISS_TOP_K) {
    return null;
  }
  if (!input.diagnosticsAvailable) {
    return "delivery_order_drop";
  }
  if (input.candidate === undefined) {
    return input.anyObjectCandidate === undefined
      ? "candidate_absent"
      : "materialization_drop";
  }
  if (isDeliveryBudgetDrop(input.candidate)) {
    return "budget_drop";
  }
  if (isAnswerSetCoverageDrop(input.candidate)) {
    return "answer_set_coverage_drop";
  }
  return "delivery_order_drop";
}

function isDeliveryBudgetDrop(candidate: DeliveryMissCandidateInput): boolean {
  if (candidate.droppedReason === null) {
    return false;
  }
  const candidateRank = candidate.preBudgetRank ?? candidate.fusedRank;
  return candidateRank !== null && candidateRank <= DELIVERY_BUDGET_LOSS_RANK;
}

function isAnswerSetCoverageDrop(candidate: DeliveryMissCandidateInput): boolean {
  const fusedRank = candidate.rankAfterFusion ?? candidate.fusedRank;
  if (fusedRank === null || fusedRank > DELIVERY_MISS_TOP_K) {
    return false;
  }
  if (candidate.coverageSelectorAction === "displaced") {
    return true;
  }
  const coverageRank = candidate.rankAfterCoverageSelector;
  return coverageRank !== null && coverageRank > DELIVERY_MISS_TOP_K;
}
