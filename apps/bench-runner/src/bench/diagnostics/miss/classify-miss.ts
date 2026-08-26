import {
  hasLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "../../extraction/seed-fuel/seed-drop-reasons.js";
import {
  emptyGoldFieldContext,
  isFieldOrderingMiss,
  isGoldInField,
  type GoldFieldContext
} from "../gold-field-membership.js";
import {
  hasStructuralPlane,
  isDeliveryBudgetLoss
} from "../schema/diagnostics-private.js";
import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "../schema/diagnostics-types.js";

export interface ClassifyMissInput {
  readonly hitAt5: boolean;
  readonly gold: readonly LongMemEvalGoldDiagnostic[];
  readonly diagnosticsAvailable: boolean;
  readonly isAbstention: boolean;
  readonly seedDropReasons?: LongMemEvalSeedDropReasons;
  readonly field?: GoldFieldContext;
}

export function classifyMiss(
  input: ClassifyMissInput
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  if (input.isAbstention) return "abstention_uncalibrated";
  if (input.gold.length === 0) {
    return hasLongMemEvalSeedDropReasons(input.seedDropReasons)
      ? "candidate_absent"
      : "no_gold";
  }
  if (input.hitAt5) return "hit_at_5";
  if (!input.diagnosticsAvailable) return "diagnostics_unavailable";
  if (input.gold.some(isDeliveryBudgetLoss)) return "budget_dropped";
  const field = input.field ?? emptyGoldFieldContext();
  if (input.gold.some((item) => isFieldOrderingMiss(item, field))) return "under_ranked";
  if (input.gold.some((item) => item.candidate_status === "active_constraint_delivered")) {
    return "active_constraint_only";
  }
  return classifyFieldAbsenceGap(input.gold, field);
}

function classifyFieldAbsenceGap(
  gold: readonly LongMemEvalGoldDiagnostic[],
  field: GoldFieldContext
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  const absentWithPlanes = gold.filter((item) =>
    !isGoldInField(item, field) && item.source_planes.length > 0
  );
  if (absentWithPlanes.some((item) => !item.source_planes.includes("lexical"))) {
    return "lexical_gap";
  }
  if (absentWithPlanes.some((item) => !hasStructuralPlane(item.source_planes))) {
    return "structural_gap";
  }
  return "candidate_absent";
}
