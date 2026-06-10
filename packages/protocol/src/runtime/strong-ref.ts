import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

const strongRefReasonValues = ["governance_lease", "security_snapshot", "active_projection"] as const;
const targetStaleStatusValues = ["fresh", "stale", "missing"] as const;

export const StrongRefReasonSchema = z.enum(strongRefReasonValues);

export const StrongRefSchema = z
  .object({
    ref_id: NonEmptyStringSchema,
    source_entity_type: NonEmptyStringSchema,
    source_entity_id: NonEmptyStringSchema,
    target_entity_type: NonEmptyStringSchema,
    target_entity_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    reason: StrongRefReasonSchema,
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const TargetStaleStatusSchema = z.enum(targetStaleStatusValues);

export const TargetRevalidateResultSchema = z
  .object({
    ref_id: NonEmptyStringSchema,
    status: TargetStaleStatusSchema,
    revalidated_at: IsoDatetimeStringSchema,
    stale_since: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

export type StrongRefReason = z.infer<typeof StrongRefReasonSchema>;
export type StrongRef = Readonly<z.infer<typeof StrongRefSchema>>;
export type TargetStaleStatus = z.infer<typeof TargetStaleStatusSchema>;
export type TargetRevalidateResult = Readonly<z.infer<typeof TargetRevalidateResultSchema>>;
