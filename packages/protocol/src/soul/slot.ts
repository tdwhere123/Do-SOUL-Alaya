import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { ClaimKindSchema } from "./claim-form.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { GovernanceSubjectSchema } from "./governance-subject.js";
import { ObjectKind, ScopeClassSchema } from "./object-kind.js";

const flipConditionKindValues = [
  "stronger_evidence",
  "higher_authority",
  "user_override",
  "scope_escalation",
  "time_decay"
] as const;

export const FlipConditionKind = {
  STRONGER_EVIDENCE: "stronger_evidence",
  HIGHER_AUTHORITY: "higher_authority",
  USER_OVERRIDE: "user_override",
  SCOPE_ESCALATION: "scope_escalation",
  TIME_DECAY: "time_decay"
} as const;

export const FlipConditionKindSchema = z.enum(flipConditionKindValues);

export const FlipConditionSchema = z
  .object({
    condition_kind: FlipConditionKindSchema,
    description: NonEmptyStringSchema,
    threshold: z.number().nullable()
  })
  .readonly();

export const SlotUniqueKeySchema = z
  .object({
    governance_subject: GovernanceSubjectSchema,
    claim_kind: ClaimKindSchema,
    scope_class: ScopeClassSchema
  })
  .readonly();

export const SlotSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.SLOT),
    governance_subject: GovernanceSubjectSchema,
    claim_kind: ClaimKindSchema,
    scope_class: ScopeClassSchema,
    winner_claim_id: NonEmptyStringSchema.nullable(),
    incumbent_since: IsoDatetimeStringSchema.nullable(),
    flip_conditions: z.array(FlipConditionSchema).readonly(),
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export type FlipConditionKind = z.infer<typeof FlipConditionKindSchema>;
export type FlipCondition = z.infer<typeof FlipConditionSchema>;
export type SlotUniqueKey = z.infer<typeof SlotUniqueKeySchema>;
export type Slot = z.infer<typeof SlotSchema>;
