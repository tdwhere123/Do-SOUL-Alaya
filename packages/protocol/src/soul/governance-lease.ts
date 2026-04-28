import { z } from "zod";
import { NonEmptyStringSchema } from "../schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

export const governanceLeasePiercingConditionKindValues = [
  "unsubmitted_changes",
  "severe_diagnostic_jump",
  "explicit_lifecycle_event"
] as const;

export const GovernanceLeasePiercingConditionKind = {
  UNSUBMITTED_CHANGES: "unsubmitted_changes",
  SEVERE_DIAGNOSTIC_JUMP: "severe_diagnostic_jump",
  EXPLICIT_LIFECYCLE_EVENT: "explicit_lifecycle_event"
} as const;

export const GovernanceLeasePiercingConditionKindSchema = z.enum(governanceLeasePiercingConditionKindValues);

export const PiercingConditionSchema = z
  .object({
    condition_kind: GovernanceLeasePiercingConditionKindSchema,
    description: NonEmptyStringSchema
  })
  .readonly();

export const GovernanceLeaseSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.GOVERNANCE_LEASE),
    lease_id: NonEmptyStringSchema,
    holder: NonEmptyStringSchema,
    piercing_conditions: z.array(PiercingConditionSchema).readonly()
  })
  .readonly();

export type GovernanceLeasePiercingConditionKind = z.infer<typeof GovernanceLeasePiercingConditionKindSchema>;
export type PiercingCondition = z.infer<typeof PiercingConditionSchema>;
export type GovernanceLease = z.infer<typeof GovernanceLeaseSchema>;
