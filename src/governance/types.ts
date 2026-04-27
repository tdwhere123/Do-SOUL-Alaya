import type { MemoryDimension } from "../ontology/types.js";

export const promotionOutcomes = ["durable", "candidate", "pending_review", "not_promoted"] as const;
export type PromotionOutcome = (typeof promotionOutcomes)[number];

export const lifecycleStates = ["candidate", "draft", "pending_review", "durable", "rejected", "not_promoted"] as const;
export type PromotionLifecycleState = (typeof lifecycleStates)[number];

export const promotionConditionKinds = [
  "min_evidence_count",
  "min_stability_duration",
  "no_active_contradictions",
  "scope_determined",
  "governance_subject_compilable"
] as const;
export type PromotionConditionKind = (typeof promotionConditionKinds)[number];

export interface PromotionCondition {
  readonly condition_kind: PromotionConditionKind;
  readonly threshold: number | null;
  readonly required: boolean;
}

export interface PromotionGate {
  readonly conditions: readonly PromotionCondition[];
  readonly per_dimension_defaults?: Partial<Record<MemoryDimension, readonly PromotionCondition[]>> | null;
}

export interface GovernanceReceipt {
  readonly approved: boolean;
  readonly actor: string;
  readonly reason: string;
  readonly decided_at: string;
}

export interface PromotionCandidate {
  readonly target_id: string;
  readonly dimension: MemoryDimension;
  readonly evidence_refs: readonly string[];
  readonly source_refs: readonly string[];
  readonly stability_duration_ms: number;
  readonly active_contradictions: number;
  readonly scope_determined: boolean;
  readonly governance_subject_compilable: boolean;
  readonly high_risk: boolean;
  readonly governance_receipt?: GovernanceReceipt | null;
}

export interface PromotionDecision {
  readonly outcome: PromotionOutcome;
  readonly lifecycle_state: PromotionLifecycleState;
  readonly reason: string;
  readonly hitl_required: boolean;
}

export const governanceActionClasses = [
  "normal",
  "destructive",
  "global",
  "cross_project",
  "override",
  "strengthening"
] as const;
export type GovernanceActionClass = (typeof governanceActionClasses)[number];

export interface GovernanceActionRequest {
  readonly action_class: GovernanceActionClass;
  readonly source_refs: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly operator_reason?: string | null;
  readonly governance_receipt?: GovernanceReceipt | null;
}

export interface GovernancePolicyDecision {
  readonly outcome: PromotionOutcome;
  readonly reason: string;
  readonly operator_reason_required: boolean;
  readonly hitl_required: boolean;
}

export interface GovernanceBypassSignal {
  readonly outcome: "not_promoted";
  readonly severity: "blocking";
  readonly reason: string;
  readonly recoverable: boolean;
}
