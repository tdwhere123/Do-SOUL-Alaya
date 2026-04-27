import { assertNonNegativeInteger, assertObject, assertOneOf, assertText, assertTextArray } from "../foundation/validation.js";
import type { MemoryDimension } from "../ontology/types.js";
import { memoryDimensions } from "../ontology/types.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  PromotionCandidate,
  PromotionCondition,
  PromotionDecision,
  PromotionGate
} from "./types.js";
import { promotionConditionKinds } from "./types.js";

export function evaluatePromotionGate(candidate: PromotionCandidate, gate: PromotionGate): PromotionDecision {
  validatePromotionCandidate(candidate);
  validatePromotionGate(gate);

  const conditions = gate.per_dimension_defaults?.[candidate.dimension] ?? gate.conditions;
  const unmet = conditions.filter((condition) => condition.required && !conditionSatisfied(candidate, condition));
  const hasHitlApproval = candidate.governance_receipt?.approved === true;

  if (candidate.dimension === "hazard" || candidate.high_risk) {
    if (!hasHitlApproval) {
      return {
        outcome: "pending_review",
        lifecycle_state: "pending_review",
        reason: "hitl_required",
        hitl_required: true
      };
    }
  }

  if (unmet.length > 0) {
    return {
      outcome: defaultNonDurableOutcome(candidate.dimension),
      lifecycle_state: defaultNonDurableOutcome(candidate.dimension) === "pending_review" ? "pending_review" : "candidate",
      reason: `gate_unmet:${unmet.map((condition) => condition.condition_kind).join(",")}`,
      hitl_required: false
    };
  }

  return {
    outcome: "durable",
    lifecycle_state: "durable",
    reason: "gate_satisfied",
    hitl_required: false
  };
}

export function validatePromotionCandidate(candidate: PromotionCandidate): PromotionCandidate {
  assertObject(candidate, "PromotionCandidate");
  assertText(candidate.target_id, "target_id");
  assertOneOf(candidate.dimension, memoryDimensions, "dimension");
  assertTextArray(candidate.evidence_refs, "evidence_refs", { nonEmpty: true });
  assertTextArray(candidate.source_refs, "source_refs", { nonEmpty: true });
  assertNonNegativeInteger(candidate.stability_duration_ms, "stability_duration_ms");
  assertNonNegativeInteger(candidate.active_contradictions, "active_contradictions");
  assertBoolean(candidate.scope_determined, "scope_determined");
  assertBoolean(candidate.governance_subject_compilable, "governance_subject_compilable");
  assertBoolean(candidate.high_risk, "high_risk");
  if (candidate.governance_receipt !== undefined && candidate.governance_receipt !== null) {
    assertBoolean(candidate.governance_receipt.approved, "governance_receipt.approved");
    assertText(candidate.governance_receipt.actor, "governance_receipt.actor");
    assertText(candidate.governance_receipt.reason, "governance_receipt.reason");
    assertText(candidate.governance_receipt.decided_at, "governance_receipt.decided_at");
  }
  return candidate;
}

export function validatePromotionGate(gate: PromotionGate): PromotionGate {
  assertObject(gate, "PromotionGate");
  if (!Array.isArray(gate.conditions) || gate.conditions.length === 0) {
    throw new AlayaValidationError("PromotionGate.conditions must not be empty.");
  }
  gate.conditions.forEach(validatePromotionCondition);
  if (gate.per_dimension_defaults !== undefined && gate.per_dimension_defaults !== null) {
    assertObject(gate.per_dimension_defaults, "per_dimension_defaults");
    for (const [dimension, conditions] of Object.entries(gate.per_dimension_defaults)) {
      assertOneOf(dimension, memoryDimensions, `per_dimension_defaults.${dimension}`);
      if (!Array.isArray(conditions) || conditions.length === 0) {
        throw new AlayaValidationError(`per_dimension_defaults.${dimension} must not be empty.`);
      }
      conditions.forEach(validatePromotionCondition);
    }
  }
  return gate;
}

function validatePromotionCondition(condition: PromotionCondition): void {
  assertObject(condition, "PromotionCondition");
  assertOneOf(condition.condition_kind, promotionConditionKinds, "condition_kind");
  if (condition.threshold !== null) {
    assertNonNegativeInteger(condition.threshold, "threshold");
  }
  assertBoolean(condition.required, "required");
}

function conditionSatisfied(candidate: PromotionCandidate, condition: PromotionCondition): boolean {
  switch (condition.condition_kind) {
    case "min_evidence_count":
      return candidate.evidence_refs.length >= (condition.threshold ?? 1);
    case "min_stability_duration":
      return candidate.stability_duration_ms >= (condition.threshold ?? 0);
    case "no_active_contradictions":
      return candidate.active_contradictions === 0;
    case "scope_determined":
      return candidate.scope_determined;
    case "governance_subject_compilable":
      return candidate.governance_subject_compilable;
  }
}

function defaultNonDurableOutcome(dimension: MemoryDimension): "candidate" | "pending_review" {
  if (dimension === "hazard") {
    return "pending_review";
  }
  return "candidate";
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new AlayaValidationError(`${label} must be boolean.`);
  }
}
