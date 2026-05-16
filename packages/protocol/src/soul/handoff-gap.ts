import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

export const HandoffRecordSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.HANDOFF_RECORD),
    handoff_kind: NonEmptyStringSchema,
    source_run_id: NonEmptyStringSchema,
    target_run_id: NonEmptyStringSchema.nullable(),
    surface_id: NonEmptyStringSchema.nullable(),
    ttl_ms: NonNegativeIntSchema.nullable()
  })
  .readonly();

export const GapRecordSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.GAP_RECORD),
    gap_kind: NonEmptyStringSchema,
    detected_in_run_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema.nullable(),
    description: NonEmptyStringSchema,
    ttl_ms: NonNegativeIntSchema.nullable()
  })
  .readonly();

export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
export type GapRecord = z.infer<typeof GapRecordSchema>;
