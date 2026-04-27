import { assertObject, assertOneOf, assertText, assertTextArray } from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  GovernanceActionClass,
  GovernanceActionRequest,
  GovernanceBypassSignal,
  GovernancePolicyDecision
} from "./types.js";
import { governanceActionClasses } from "./types.js";

const operatorReasonRequiredClasses = new Set<GovernanceActionClass>([
  "destructive",
  "global",
  "cross_project",
  "override",
  "strengthening"
]);

export function evaluateGovernanceAction(request: GovernanceActionRequest): GovernancePolicyDecision {
  validateGovernanceActionRequest(request);
  const operatorReasonRequired = operatorReasonRequiredClasses.has(request.action_class);
  const hitlRequired = operatorReasonRequired || request.action_class !== "normal";

  if (operatorReasonRequired && request.operator_reason?.trim()) {
    if (request.governance_receipt?.approved !== true) {
      return {
        outcome: "pending_review",
        reason: "hitl_required",
        operator_reason_required: true,
        hitl_required: true
      };
    }
    return {
      outcome: "durable",
      reason: "governance_approved",
      operator_reason_required: true,
      hitl_required: true
    };
  }

  if (operatorReasonRequired) {
    return {
      outcome: "pending_review",
      reason: "operator_reason_required",
      operator_reason_required: true,
      hitl_required: true
    };
  }

  return {
    outcome: "candidate",
    reason: "low_risk_candidate",
    operator_reason_required: false,
    hitl_required: false
  };
}

export function detectGovernanceBypass(input: {
  readonly attempted_mutation: string;
  readonly actor: string;
  readonly recoverable?: boolean;
}): GovernanceBypassSignal {
  assertObject(input, "governance bypass input");
  assertText(input.attempted_mutation, "attempted_mutation");
  assertText(input.actor, "actor");
  return {
    outcome: "not_promoted",
    severity: "blocking",
    reason: `governance_bypass:${input.attempted_mutation}`,
    recoverable: input.recoverable ?? false
  };
}

export function validateGovernanceActionRequest(request: GovernanceActionRequest): GovernanceActionRequest {
  assertObject(request, "GovernanceActionRequest");
  assertOneOf(request.action_class, governanceActionClasses, "action_class");
  assertTextArray(request.source_refs, "source_refs", { nonEmpty: true });
  assertTextArray(request.evidence_refs, "evidence_refs", { nonEmpty: true });
  if (request.operator_reason !== undefined && request.operator_reason !== null) {
    assertText(request.operator_reason, "operator_reason");
  }
  if (request.governance_receipt !== undefined && request.governance_receipt !== null) {
    if (typeof request.governance_receipt.approved !== "boolean") {
      throw new AlayaValidationError("governance_receipt.approved must be boolean.");
    }
    assertText(request.governance_receipt.actor, "governance_receipt.actor");
    assertText(request.governance_receipt.reason, "governance_receipt.reason");
    assertText(request.governance_receipt.decided_at, "governance_receipt.decided_at");
  }
  return request;
}
