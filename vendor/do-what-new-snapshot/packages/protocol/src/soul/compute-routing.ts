import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

const computeProviderPriorityValues = [
  "official_api",
  "custom_api",
  "local_model",
  "stub"
] as const;

export const ComputeProviderPriority = {
  OFFICIAL_API: "official_api",
  CUSTOM_API: "custom_api",
  LOCAL_MODEL: "local_model",
  STUB: "stub"
} as const;

export const ComputeProviderPrioritySchema = z.enum(computeProviderPriorityValues);

export const ComputeRoutingDecisionSchema = z
  .object({
    decision_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    selected_provider: ComputeProviderPrioritySchema,
    model_id: NonEmptyStringSchema,
    adapter: NonEmptyStringSchema.optional(),
    selection_reason: NonEmptyStringSchema,
    decided_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type ComputeProviderPriority = z.infer<typeof ComputeProviderPrioritySchema>;
export type ComputeRoutingDecision = z.infer<typeof ComputeRoutingDecisionSchema>;
