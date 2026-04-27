export const ontologyObjectKinds = [
  "evidence_capsule",
  "memory_entry",
  "synthesis_capsule",
  "claim_form"
] as const;

export type OntologyObjectKind = (typeof ontologyObjectKinds)[number];

export const runtimeObjectKinds = [
  "activation_candidate",
  "context_lens",
  "working_projection",
  "promotion_gate",
  "session_override"
] as const;

export type RuntimeObjectKind = (typeof runtimeObjectKinds)[number];

export const objectLifecycleStates = ["draft", "active", "dormant", "archived", "tombstone"] as const;
export type ObjectLifecycleState = (typeof objectLifecycleStates)[number];

export const retentionPolicies = ["session_only", "run_scoped", "persistent"] as const;
export type RetentionPolicy = (typeof retentionPolicies)[number];

export interface PersistentObjectEnvelope {
  readonly object_id: string;
  readonly object_kind: OntologyObjectKind | "path_relation";
  readonly schema_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly lifecycle_state: ObjectLifecycleState;
}

export interface RuntimeObjectEnvelope {
  readonly runtime_id: string;
  readonly object_kind: RuntimeObjectKind;
  readonly task_surface_ref: string | null;
  readonly expires_at: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: RetentionPolicy;
}
