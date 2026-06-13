import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

const upgradeAssessmentAxisFields = {
  recurrence_runs: NonNegativeIntSchema.nullable(),
  recurrence_surfaces: NonNegativeIntSchema.nullable(),
  governance_impact: z.number().nullable(),
  unresolved_age_ms: NonNegativeIntSchema.nullable(),
  upgrade_candidate: z.boolean().nullable()
} as const;

export const UpgradeAssessmentAxisSchema = z.object(upgradeAssessmentAxisFields).readonly();

export const HandoffRecordSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.HANDOFF_RECORD),
    handoff_kind: NonEmptyStringSchema,
    source_run_id: NonEmptyStringSchema,
    target_run_id: NonEmptyStringSchema.nullable(),
    surface_id: NonEmptyStringSchema.nullable(),
    ttl_ms: NonNegativeIntSchema.nullable(),
    ...upgradeAssessmentAxisFields
  })
  .readonly();

export const GapRecordSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.GAP_RECORD),
    gap_kind: NonEmptyStringSchema,
    detected_in_run_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema.nullable(),
    description: NonEmptyStringSchema,
    ttl_ms: NonNegativeIntSchema.nullable(),
    ...upgradeAssessmentAxisFields
  })
  .readonly();

export type UpgradeAssessmentAxis = z.infer<typeof UpgradeAssessmentAxisSchema>;
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
export type GapRecord = z.infer<typeof GapRecordSchema>;