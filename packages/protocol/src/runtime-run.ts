import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "./schema-primitives.js";
import { ToolCategorySchema } from "./tool-spec.js";

export const EngineClassSchema = z.enum(["coding_engine", "conversation_engine"]);
export const ClaimModeSchema = z.enum(["STRICT", "PREFERRED"]);
export const WorkerRunStateSchema = z.enum(["init", "active", "completed", "suspended", "aborted", "frozen"]);
export const GardenProviderKindSchema = z.enum([
  "local_heuristics",
  "official_api"
]);

export const GardenProviderKind = {
  LOCAL_HEURISTICS: "local_heuristics",
  OFFICIAL_API: "official_api"
} as const;

export const PrincipalRunSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    engine_class: EngineClassSchema,
    claim_mode: ClaimModeSchema,
    task_surface_ref: NonEmptyStringSchema.nullable(),
    context_lens_ref: NonEmptyStringSchema.nullable(),
    stance_resolution_ref: NonEmptyStringSchema.optional(),
    governance_lease_ref: NonEmptyStringSchema.optional(),
    active_node_id: NonEmptyStringSchema.nullable(),
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const DelegatedWorkerReturnKindSchema = z.enum([
  "handoff",
  "gap",
  "patch_diff",
  "verification_result",
  "analysis_note",
  "proposal_candidate",
  "evidence_pointer_set"
]);

export const DelegatedWorkerRunSchema = z
  .object({
    worker_run_id: NonEmptyStringSchema,
    principal_run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    requesting_run_id: NonEmptyStringSchema,
    engine_class: EngineClassSchema,
    state: WorkerRunStateSchema,
    subtask_description: NonEmptyStringSchema,
    local_surface_ref: NonEmptyStringSchema,
    local_evidence_pointer: NonEmptyStringSchema.nullable(),
    restricted_tool_set: z.array(NonEmptyStringSchema).readonly(),
    local_budget: z
      .object({
        max_worker_delegations: NonNegativeIntSchema,
        max_tool_calls: NonNegativeIntSchema,
        max_output_tokens: NonNegativeIntSchema,
        max_wall_time_ms: NonNegativeIntSchema
      })
      .strict()
      .readonly(),
    agreed_return_format: z
      .object({
        allowed_return_kinds: z.array(DelegatedWorkerReturnKindSchema).min(1).readonly(),
        requires_structured_summary: z.boolean()
      })
      .strict()
      .readonly(),
    principal_security_snapshot: z
      .object({
        governance_lease_ref: NonEmptyStringSchema,
        hard_constraint_refs: z.array(NonEmptyStringSchema).readonly(),
        denied_tool_categories: z.array(ToolCategorySchema).readonly()
      })
      .strict()
      .readonly(),
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type EngineClass = z.infer<typeof EngineClassSchema>;
export type ClaimMode = z.infer<typeof ClaimModeSchema>;
export type WorkerRunState = z.infer<typeof WorkerRunStateSchema>;
export type GardenProviderKind = z.infer<typeof GardenProviderKindSchema>;
export type DelegatedWorkerReturnKind = z.infer<typeof DelegatedWorkerReturnKindSchema>;
export type PrincipalRun = Readonly<z.infer<typeof PrincipalRunSchema>>;
export type DelegatedWorkerRun = Readonly<z.infer<typeof DelegatedWorkerRunSchema>>;
