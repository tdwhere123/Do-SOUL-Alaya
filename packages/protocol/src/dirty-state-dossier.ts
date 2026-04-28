import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "./schema-primitives.js";

const dirtyStatePanicTriggerValues = [
  "evidence_corruption",
  "governance_bypass",
  "state_inconsistency",
  "budget_violation",
  "safety_gate_failure",
  "manual"
] as const;

export const DirtyStatePanicTriggerSchema = z.enum(dirtyStatePanicTriggerValues);

export const AffectedDataScopeEntrySchema = z
  .object({
    entity_type: NonEmptyStringSchema,
    entity_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const DirtyStateDossierSchema = z
  .object({
    dossier_id: NonEmptyStringSchema,
    worker_run_id: NonEmptyStringSchema,
    principal_run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    trigger: DirtyStatePanicTriggerSchema,
    panic_source: NonEmptyStringSchema,
    panic_summary: NonEmptyStringSchema,
    affected_data_scope: z.array(AffectedDataScopeEntrySchema).readonly(),
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type DirtyStatePanicTrigger = z.infer<typeof DirtyStatePanicTriggerSchema>;
export type AffectedDataScopeEntry = z.infer<typeof AffectedDataScopeEntrySchema>;
export type DirtyStateDossier = z.infer<typeof DirtyStateDossierSchema>;
