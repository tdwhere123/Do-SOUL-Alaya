import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

export const DeferredObligationKindSchema = z.enum([
  "safety_finding",
  "data_cleanup",
  "evidence_refresh",
  "governance_pledge"
]);

export const DeferredObligationStateSchema = z.enum([
  "pending",
  "fulfilled",
  "expired",
  "waived"
]);

export const DeferredObligationSchema = z
  .object({
    obligation_id: NonEmptyStringSchema,
    kind: DeferredObligationKindSchema,
    state: DeferredObligationStateSchema,
    description: NonEmptyStringSchema,
    source_run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    target_entity_id: NonEmptyStringSchema.optional(),
    created_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema,
    fulfilled_at: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

export type DeferredObligationKind = z.infer<typeof DeferredObligationKindSchema>;
export type DeferredObligationState = z.infer<typeof DeferredObligationStateSchema>;
export type DeferredObligation = z.infer<typeof DeferredObligationSchema>;
