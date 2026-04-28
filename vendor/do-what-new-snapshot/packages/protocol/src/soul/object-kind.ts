import { z } from "zod";

const objectKindValues = [
  "evidence_capsule",
  "memory_entry",
  "synthesis_capsule",
  "claim_form",
  "green_status",
  "slot",
  "surface_identity",
  "surface_anchor",
  "surface_binding",
  "conflict_matrix_edge",
  "cross_cutting_permission",
  "project_mapping_anchor",
  "memory_graph_edge",
  "path_relation"
] as const;

const controlPlaneObjectKindValues = [
  "task_object_surface",
  "recall_policy",
  "context_lens",
  "working_projection",
  "verification_result",
  "governance_lease",
  "budget_bankruptcy_state",
  "bankruptcy_dossier",
  "proposal",
  "session_override",
  "promotion_gate",
  "handoff_record",
  "gap_record",
  "orphan_radar",
  "activation_candidate"
] as const;

const retentionPolicyValues = ["session_only", "run_scoped", "persistent"] as const;
const scopeClassValues = ["project", "global_domain", "global_core"] as const;

export const ObjectKind = {
  EVIDENCE_CAPSULE: "evidence_capsule",
  MEMORY_ENTRY: "memory_entry",
  SYNTHESIS_CAPSULE: "synthesis_capsule",
  CLAIM_FORM: "claim_form",
  GREEN_STATUS: "green_status",
  SLOT: "slot",
  SURFACE_IDENTITY: "surface_identity",
  SURFACE_ANCHOR: "surface_anchor",
  SURFACE_BINDING: "surface_binding",
  CONFLICT_MATRIX_EDGE: "conflict_matrix_edge",
  CROSS_CUTTING_PERMISSION: "cross_cutting_permission",
  PROJECT_MAPPING_ANCHOR: "project_mapping_anchor",
  MEMORY_GRAPH_EDGE: "memory_graph_edge",
  PATH_RELATION: "path_relation"
} as const;

export const ControlPlaneObjectKind = {
  TASK_OBJECT_SURFACE: "task_object_surface",
  RECALL_POLICY: "recall_policy",
  CONTEXT_LENS: "context_lens",
  WORKING_PROJECTION: "working_projection",
  VERIFICATION_RESULT: "verification_result",
  GOVERNANCE_LEASE: "governance_lease",
  BUDGET_BANKRUPTCY_STATE: "budget_bankruptcy_state",
  BANKRUPTCY_DOSSIER: "bankruptcy_dossier",
  PROPOSAL: "proposal",
  SESSION_OVERRIDE: "session_override",
  PROMOTION_GATE: "promotion_gate",
  HANDOFF_RECORD: "handoff_record",
  GAP_RECORD: "gap_record",
  ORPHAN_RADAR: "orphan_radar",
  ACTIVATION_CANDIDATE: "activation_candidate"
} as const;

export const RetentionPolicy = {
  SESSION_ONLY: "session_only",
  RUN_SCOPED: "run_scoped",
  PERSISTENT: "persistent"
} as const;

export const ScopeClass = {
  PROJECT: "project",
  GLOBAL_DOMAIN: "global_domain",
  GLOBAL_CORE: "global_core"
} as const;

export const ObjectKindSchema = z.enum(objectKindValues);
export const ControlPlaneObjectKindSchema = z.enum(controlPlaneObjectKindValues);
export const RetentionPolicySchema = z.enum(retentionPolicyValues);
export const ScopeClassSchema = z.enum(scopeClassValues);

export type ObjectKind = z.infer<typeof ObjectKindSchema>;
export type ControlPlaneObjectKind = z.infer<typeof ControlPlaneObjectKindSchema>;
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;
export type ScopeClass = z.infer<typeof ScopeClassSchema>;
