import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { GovernanceLeasePiercingConditionKindSchema } from "../soul/governance-lease.js";

const phase3BEventTypeValues = [
  "soul.session_override.applied",
  "soul.session_override.promoted",
  "soul.green.granted",
  "soul.green.pierced",
  "soul.verification.completed",
  "soul.governance_lease.acquired",
  "soul.governance_lease.released",
  "soul.governance_lease.pierced"
] as const;

export const Phase3BEventType = {
  SOUL_SESSION_OVERRIDE_APPLIED: "soul.session_override.applied",
  SOUL_SESSION_OVERRIDE_PROMOTED: "soul.session_override.promoted",
  SOUL_GREEN_GRANTED: "soul.green.granted",
  SOUL_GREEN_PIERCED: "soul.green.pierced",
  SOUL_VERIFICATION_COMPLETED: "soul.verification.completed",
  SOUL_GOVERNANCE_LEASE_ACQUIRED: "soul.governance_lease.acquired",
  SOUL_GOVERNANCE_LEASE_RELEASED: "soul.governance_lease.released",
  SOUL_GOVERNANCE_LEASE_PIERCED: "soul.governance_lease.pierced"
} as const;

export const Phase3BEventTypeSchema = z.enum(phase3BEventTypeValues);

export const PromotionOutcomeSchema = z.enum(["durable", "candidate", "pending_review", "not_promoted"]);

export const SoulSessionOverrideAppliedPayloadSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    target_object: NonEmptyStringSchema,
    correction: NonEmptyStringSchema,
    priority: NonNegativeIntSchema,
    run_id: NonEmptyStringSchema,
    expires_at: IsoDatetimeStringSchema.nullable(),
    derived_from: NonEmptyStringSchema.nullable().optional(),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulSessionOverridePromotedPayloadSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    target_object: NonEmptyStringSchema,
    dimension: NonEmptyStringSchema,
    promotion_outcome: PromotionOutcomeSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGreenGrantedPayloadSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    verification_basis: NonEmptyStringSchema,
    valid_until: IsoDatetimeStringSchema.nullable(),
    bound_scope_class: NonEmptyStringSchema.nullable(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGreenPiercedPayloadSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    revoke_reason: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulVerificationCompletedPayloadSchema = z
  .object({
    target_object_id: NonEmptyStringSchema,
    verdict: z.enum(["go", "no_go"]),
    micro_correction_hint: NonEmptyStringSchema.nullable(),
    consecutive_no_go_count: NonNegativeIntSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGovernanceLeaseAcquiredPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    holder: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    expires_at: IsoDatetimeStringSchema.nullable(),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGovernanceLeaseReleasedPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGovernanceLeasePiercedPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    piercing_condition_kind: GovernanceLeasePiercingConditionKindSchema,
    run_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

const phase3BPayloadSchemas = {
  [Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED]: SoulSessionOverrideAppliedPayloadSchema,
  [Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED]: SoulSessionOverridePromotedPayloadSchema,
  [Phase3BEventType.SOUL_GREEN_GRANTED]: SoulGreenGrantedPayloadSchema,
  [Phase3BEventType.SOUL_GREEN_PIERCED]: SoulGreenPiercedPayloadSchema,
  [Phase3BEventType.SOUL_VERIFICATION_COMPLETED]: SoulVerificationCompletedPayloadSchema,
  [Phase3BEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED]: SoulGovernanceLeaseAcquiredPayloadSchema,
  [Phase3BEventType.SOUL_GOVERNANCE_LEASE_RELEASED]: SoulGovernanceLeaseReleasedPayloadSchema,
  [Phase3BEventType.SOUL_GOVERNANCE_LEASE_PIERCED]: SoulGovernanceLeasePiercedPayloadSchema
} as const;

export function createPhase3BEventObjectSchema<T extends keyof typeof phase3BPayloadSchemas>(
  type: T,
  payloadSchema: (typeof phase3BPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulSessionOverrideAppliedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
  SoulSessionOverrideAppliedPayloadSchema
);
const SoulSessionOverridePromotedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
  SoulSessionOverridePromotedPayloadSchema
);
const SoulGreenGrantedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_GREEN_GRANTED,
  SoulGreenGrantedPayloadSchema
);
const SoulGreenPiercedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_GREEN_PIERCED,
  SoulGreenPiercedPayloadSchema
);
const SoulVerificationCompletedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_VERIFICATION_COMPLETED,
  SoulVerificationCompletedPayloadSchema
);
const SoulGovernanceLeaseAcquiredEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
  SoulGovernanceLeaseAcquiredPayloadSchema
);
const SoulGovernanceLeaseReleasedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_GOVERNANCE_LEASE_RELEASED,
  SoulGovernanceLeaseReleasedPayloadSchema
);
const SoulGovernanceLeasePiercedEventObjectSchema = createPhase3BEventObjectSchema(
  Phase3BEventType.SOUL_GOVERNANCE_LEASE_PIERCED,
  SoulGovernanceLeasePiercedPayloadSchema
);

export const SoulSessionOverrideAppliedEventSchema = SoulSessionOverrideAppliedEventObjectSchema.readonly();
export const SoulSessionOverridePromotedEventSchema = SoulSessionOverridePromotedEventObjectSchema.readonly();
export const SoulGreenGrantedEventSchema = SoulGreenGrantedEventObjectSchema.readonly();
export const SoulGreenPiercedEventSchema = SoulGreenPiercedEventObjectSchema.readonly();
export const SoulVerificationCompletedEventSchema = SoulVerificationCompletedEventObjectSchema.readonly();
export const SoulGovernanceLeaseAcquiredEventSchema = SoulGovernanceLeaseAcquiredEventObjectSchema.readonly();
export const SoulGovernanceLeaseReleasedEventSchema = SoulGovernanceLeaseReleasedEventObjectSchema.readonly();
export const SoulGovernanceLeasePiercedEventSchema = SoulGovernanceLeasePiercedEventObjectSchema.readonly();

export const Phase3BEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulSessionOverrideAppliedEventObjectSchema,
    SoulSessionOverridePromotedEventObjectSchema,
    SoulGreenGrantedEventObjectSchema,
    SoulGreenPiercedEventObjectSchema,
    SoulVerificationCompletedEventObjectSchema,
    SoulGovernanceLeaseAcquiredEventObjectSchema,
    SoulGovernanceLeaseReleasedEventObjectSchema,
    SoulGovernanceLeasePiercedEventObjectSchema
  ])
  .readonly();

export type Phase3BEventPayloadMap = {
  [K in keyof typeof phase3BPayloadSchemas]: z.infer<(typeof phase3BPayloadSchemas)[K]>;
};

export function parsePhase3BEventPayload<T extends keyof typeof phase3BPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): Phase3BEventPayloadMap[T] {
  const schema = phase3BPayloadSchemas[type];
  return schema.parse(payload) as Phase3BEventPayloadMap[T];
}

export type PromotionOutcome = z.infer<typeof PromotionOutcomeSchema>;
export type Phase3BEventTypeValue = z.infer<typeof Phase3BEventTypeSchema>;
export type Phase3BEvent = z.infer<typeof Phase3BEventUnionSchema>;
