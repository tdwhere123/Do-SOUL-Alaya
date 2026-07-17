import type { RecallCandidateDropReason } from "@do-soul/alaya-core";

const DROP_REASON_VALUES = [
  "duplicate",
  "dimension_limit",
  "embedding_head_dominance",
  "max_entries",
  "max_total_tokens"
] as const satisfies readonly RecallCandidateDropReason[];

type ExhaustiveDropReasons<T extends readonly RecallCandidateDropReason[]> =
  Exclude<RecallCandidateDropReason, T[number]> extends never ? T : never;

export const DELIVERY_MISS_DROP_REASONS:
  ExhaustiveDropReasons<typeof DROP_REASON_VALUES> = DROP_REASON_VALUES;

export type DeliveryMissDropReason = (typeof DELIVERY_MISS_DROP_REASONS)[number];

export function isDeliveryMissDropReason(
  value: string
): value is DeliveryMissDropReason {
  return (DELIVERY_MISS_DROP_REASONS as readonly string[]).includes(value);
}

export function requireDeliveryMissDropReason(
  value: string | null
): DeliveryMissDropReason | null {
  if (value === null || isDeliveryMissDropReason(value)) return value;
  throw new Error(`unsupported recall candidate drop reason: ${value}`);
}

export const DELIVERY_MISS_TOP_K = 5;
export const DELIVERY_BUDGET_LOSS_RANK = 10;

export type DeliveryMissTaxonomy =
  | "candidate_absent"
  | "materialization_drop"
  | "fine_assessment_drop"
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
  readonly rankAfterFeatureRerank: number | null;
  readonly rankAfterCoverageSelector: number | null;
  readonly coverageSelectorAction: DeliveryStageAction | null;
}

export interface ClassifyDeliveryMissInput {
  readonly deliveredRank: number | null;
  readonly candidate: DeliveryMissCandidateInput | undefined;
  readonly anyObjectCandidate: DeliveryMissCandidateInput | undefined;
  readonly fineAssessmentPruned?: boolean;
  readonly anyObjectFineAssessmentPruned?: boolean;
  readonly diagnosticsAvailable: boolean;
}

export function classifyDeliveryMissTaxonomy(
  input: ClassifyDeliveryMissInput
): DeliveryMissTaxonomy | null {
  if (input.deliveredRank !== null && input.deliveredRank <= DELIVERY_MISS_TOP_K) {
    return null;
  }
  if (!input.diagnosticsAvailable) {
    return null;
  }
  if (input.candidate === undefined && input.fineAssessmentPruned === true) {
    return "fine_assessment_drop";
  }
  if (input.candidate === undefined) {
    return input.anyObjectCandidate === undefined &&
      input.anyObjectFineAssessmentPruned !== true
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
  const preCoverageRank = candidate.rankAfterFeatureRerank ??
    candidate.rankAfterFusion ?? candidate.fusedRank;
  const coverageRank = candidate.rankAfterCoverageSelector;
  return preCoverageRank !== null &&
    preCoverageRank <= DELIVERY_MISS_TOP_K &&
    coverageRank !== null &&
    coverageRank > DELIVERY_MISS_TOP_K;
}
