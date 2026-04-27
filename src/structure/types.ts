export const pathAnchorKinds = ["object", "object_facet", "obligation", "risk_concern", "time_concern"] as const;
export type PathAnchorKind = (typeof pathAnchorKinds)[number];

export interface ObjectPathAnchorRef {
  readonly kind: "object";
  readonly object_id: string;
}

export interface ObjectFacetPathAnchorRef {
  readonly kind: "object_facet";
  readonly object_id: string;
  readonly facet_key: string;
}

export interface ObligationPathAnchorRef {
  readonly kind: "obligation";
  readonly source_object_id: string;
  readonly obligation_digest: string;
}

export interface RiskConcernPathAnchorRef {
  readonly kind: "risk_concern";
  readonly source_object_id: string;
  readonly concern_digest: string;
}

export interface TimeConcernPathAnchorRef {
  readonly kind: "time_concern";
  readonly source_object_id: string;
  readonly window_digest: string;
}

export type PathAnchorRef =
  | ObjectPathAnchorRef
  | ObjectFacetPathAnchorRef
  | ObligationPathAnchorRef
  | RiskConcernPathAnchorRef
  | TimeConcernPathAnchorRef;

export const manifestationLevels = ["stance_bias", "dialogue_nudge", "lens_entry"] as const;
export type ManifestationLevel = (typeof manifestationLevels)[number];

export const directionBiases = ["source_to_target", "target_to_source", "bidirectional_asymmetric"] as const;
export type DirectionBias = (typeof directionBiases)[number];

export const stabilityClasses = ["volatile", "normal", "stable", "pinned"] as const;
export type StabilityClass = (typeof stabilityClasses)[number];

export const pathGovernanceClasses = ["hint_only", "attention_only", "recall_allowed", "strictly_governed"] as const;
export type PathGovernanceClass = (typeof pathGovernanceClasses)[number];

export const pathLifecycleStates = ["active", "cooling_down", "retired"] as const;
export type PathLifecycleState = (typeof pathLifecycleStates)[number];

export interface PathRelationAnchors {
  readonly source_anchor: PathAnchorRef;
  readonly target_anchor: PathAnchorRef;
}

export interface PathRelationConstitution {
  readonly relation_kind: string;
  readonly why_this_relation_exists: readonly string[];
}

export interface PathEffectVector {
  readonly salience: number;
  readonly recall_bias: number;
  readonly verification_bias: number;
  readonly unfinishedness_bias: number;
  readonly default_manifestation_preference: ManifestationLevel;
}

export interface PathPlasticityState {
  readonly strength: number;
  readonly direction_bias: DirectionBias;
  readonly stability_class: StabilityClass;
  readonly support_events_count: number;
  readonly contradiction_events_count: number;
  readonly last_reinforced_at?: string;
  readonly last_weakened_at?: string;
}

export interface PathLifecycle {
  readonly state: PathLifecycleState;
  readonly retirement_rule: string;
  readonly cooldown_rule?: string;
  readonly override_rule?: string;
}

export interface PathLegitimacy {
  readonly evidence_basis: readonly string[];
  readonly governance_class: PathGovernanceClass;
}

export interface PathRelation {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors: PathRelationAnchors;
  readonly constitution: PathRelationConstitution;
  readonly effect_vector: PathEffectVector;
  readonly plasticity_state: PathPlasticityState;
  readonly lifecycle: PathLifecycle;
  readonly legitimacy: PathLegitimacy;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ActivationCandidate {
  readonly candidate_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly source_path_id: string;
  readonly source_anchor: PathAnchorRef;
  readonly target_anchor: PathAnchorRef;
  readonly why_now: string;
  readonly effect_vector_snapshot: PathEffectVector;
  readonly pressure: number;
  readonly confidence: number;
  readonly governance_ceiling: PathGovernanceClass;
  readonly created_at: string;
}

export interface ManifestationEscalationPolicy {
  readonly nudge_min_pressure: number;
  readonly nudge_min_confidence: number;
  readonly lens_min_pressure: number;
  readonly lens_min_confidence: number;
  readonly lens_requires_task_coupling: boolean;
  readonly lens_requires_governance_ceiling: boolean;
}

export interface ManifestationBudgetConfig {
  readonly workspace_id: string;
  readonly stance_bias_cap: number;
  readonly dialogue_nudge_cap: number;
  readonly lens_entry_cap: number;
  readonly escalation_policy: ManifestationEscalationPolicy;
  readonly updated_at: string;
}

export interface ManifestationBudgetRemaining {
  readonly stance_bias: number;
  readonly dialogue_nudge: number;
  readonly lens_entry: number;
}

export interface ManifestationDecision {
  readonly candidate_id: string;
  readonly source_path_id: string;
  readonly assigned_level: ManifestationLevel | null;
  readonly reason: string;
  readonly budget_remaining: ManifestationBudgetRemaining;
}

export interface TaskSurfaceRef {
  readonly context_refs: readonly string[];
}

export interface TopologyNode {
  readonly id: string;
  readonly kind: PathAnchorKind;
  readonly source_ref: PathAnchorRef;
}

export interface TopologyEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation_kind: string;
  readonly source_path_id: string;
  readonly governance_class: PathGovernanceClass;
}

export interface TopologyProjection {
  readonly derived_from: "active_path_relation";
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
}
