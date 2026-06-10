import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { GovernanceLeasePiercingConditionKindSchema } from "../soul/governance-lease.js";
import { GreenStateSchema } from "../soul/green-status.js";

const greenGovernanceEventTypeValues = [
  "soul.session_override.applied",
  "soul.session_override.promoted",
  "soul.green.granted",
  "soul.green.pierced",
  "soul.green.grace_entered",
  // Green-status writes by the Auditor (revoke, passive-stable renewal,
  // active-verification grace request) must be represented in EventLog
  // so subscribers see Green state changes in the canonical append-only
  // log per §8/§10.
  "soul.green.revoked",
  "soul.green.renewed",
  "soul.green.grace_requested",
  "soul.verification.completed",
  "soul.governance_lease.acquired",
  "soul.governance_lease.released",
  "soul.governance_lease.pierced"
] as const;

export const GreenGovernanceEventType = {
  SOUL_SESSION_OVERRIDE_APPLIED: "soul.session_override.applied",
  SOUL_SESSION_OVERRIDE_PROMOTED: "soul.session_override.promoted",
  SOUL_GREEN_GRANTED: "soul.green.granted",
  SOUL_GREEN_PIERCED: "soul.green.pierced",
  SOUL_GREEN_GRACE_ENTERED: "soul.green.grace_entered",
  SOUL_GREEN_REVOKED: "soul.green.revoked",
  SOUL_GREEN_RENEWED: "soul.green.renewed",
  SOUL_GREEN_GRACE_REQUESTED: "soul.green.grace_requested",
  SOUL_VERIFICATION_COMPLETED: "soul.verification.completed",
  SOUL_GOVERNANCE_LEASE_ACQUIRED: "soul.governance_lease.acquired",
  SOUL_GOVERNANCE_LEASE_RELEASED: "soul.governance_lease.released",
  SOUL_GOVERNANCE_LEASE_PIERCED: "soul.governance_lease.pierced"
} as const;

export const GreenGovernanceEventTypeSchema = z.enum(greenGovernanceEventTypeValues);

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

export const SoulGreenGraceEnteredPayloadSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    valid_until: IsoDatetimeStringSchema,
    prior_green_state: GreenStateSchema,
    prior_valid_until: IsoDatetimeStringSchema.nullable(),
    reason: z.enum(["valid_until_expired", "manual"]),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

// Green-state mutation events emitted by the Auditor alongside the SQL
// UPDATE so the audit log records every Green transition, not just
// granted/pierced/grace_entered.
export const SoulGreenRevokedPayloadSchema = z
  .object({
    target_object_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    revoke_reason: NonEmptyStringSchema,
    task_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGreenRenewedPayloadSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    verification_basis: NonEmptyStringSchema,
    task_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGreenGraceRequestedPayloadSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    valid_until: IsoDatetimeStringSchema,
    task_id: NonEmptyStringSchema,
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

const greenGovernancePayloadSchemas = {
  [GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED]: SoulSessionOverrideAppliedPayloadSchema,
  [GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED]: SoulSessionOverridePromotedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GREEN_GRANTED]: SoulGreenGrantedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GREEN_PIERCED]: SoulGreenPiercedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GREEN_GRACE_ENTERED]: SoulGreenGraceEnteredPayloadSchema,
  [GreenGovernanceEventType.SOUL_GREEN_REVOKED]: SoulGreenRevokedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GREEN_RENEWED]: SoulGreenRenewedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GREEN_GRACE_REQUESTED]: SoulGreenGraceRequestedPayloadSchema,
  [GreenGovernanceEventType.SOUL_VERIFICATION_COMPLETED]: SoulVerificationCompletedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED]: SoulGovernanceLeaseAcquiredPayloadSchema,
  [GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED]: SoulGovernanceLeaseReleasedPayloadSchema,
  [GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED]: SoulGovernanceLeasePiercedPayloadSchema
} as const;

export function createGreenGovernanceEventObjectSchema<T extends keyof typeof greenGovernancePayloadSchemas>(
  type: T,
  payloadSchema: (typeof greenGovernancePayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulSessionOverrideAppliedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
  SoulSessionOverrideAppliedPayloadSchema
);
const SoulSessionOverridePromotedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
  SoulSessionOverridePromotedPayloadSchema
);
const SoulGreenGrantedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GREEN_GRANTED,
  SoulGreenGrantedPayloadSchema
);
const SoulGreenPiercedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GREEN_PIERCED,
  SoulGreenPiercedPayloadSchema
);
const SoulGreenGraceEnteredEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GREEN_GRACE_ENTERED,
  SoulGreenGraceEnteredPayloadSchema
);
const SoulGreenRevokedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GREEN_REVOKED,
  SoulGreenRevokedPayloadSchema
);
const SoulGreenRenewedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GREEN_RENEWED,
  SoulGreenRenewedPayloadSchema
);
const SoulGreenGraceRequestedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GREEN_GRACE_REQUESTED,
  SoulGreenGraceRequestedPayloadSchema
);
const SoulVerificationCompletedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_VERIFICATION_COMPLETED,
  SoulVerificationCompletedPayloadSchema
);
const SoulGovernanceLeaseAcquiredEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
  SoulGovernanceLeaseAcquiredPayloadSchema
);
const SoulGovernanceLeaseReleasedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED,
  SoulGovernanceLeaseReleasedPayloadSchema
);
const SoulGovernanceLeasePiercedEventObjectSchema = createGreenGovernanceEventObjectSchema(
  GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED,
  SoulGovernanceLeasePiercedPayloadSchema
);

export const SoulSessionOverrideAppliedEventSchema = SoulSessionOverrideAppliedEventObjectSchema.readonly();
export const SoulSessionOverridePromotedEventSchema = SoulSessionOverridePromotedEventObjectSchema.readonly();
export const SoulGreenGrantedEventSchema = SoulGreenGrantedEventObjectSchema.readonly();
export const SoulGreenPiercedEventSchema = SoulGreenPiercedEventObjectSchema.readonly();
export const SoulGreenGraceEnteredEventSchema = SoulGreenGraceEnteredEventObjectSchema.readonly();
export const SoulGreenRevokedEventSchema = SoulGreenRevokedEventObjectSchema.readonly();
export const SoulGreenRenewedEventSchema = SoulGreenRenewedEventObjectSchema.readonly();
export const SoulGreenGraceRequestedEventSchema = SoulGreenGraceRequestedEventObjectSchema.readonly();
export const SoulVerificationCompletedEventSchema = SoulVerificationCompletedEventObjectSchema.readonly();
export const SoulGovernanceLeaseAcquiredEventSchema = SoulGovernanceLeaseAcquiredEventObjectSchema.readonly();
export const SoulGovernanceLeaseReleasedEventSchema = SoulGovernanceLeaseReleasedEventObjectSchema.readonly();
export const SoulGovernanceLeasePiercedEventSchema = SoulGovernanceLeasePiercedEventObjectSchema.readonly();

export const GreenGovernanceEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulSessionOverrideAppliedEventObjectSchema,
    SoulSessionOverridePromotedEventObjectSchema,
    SoulGreenGrantedEventObjectSchema,
    SoulGreenPiercedEventObjectSchema,
    SoulGreenGraceEnteredEventObjectSchema,
    SoulGreenRevokedEventObjectSchema,
    SoulGreenRenewedEventObjectSchema,
    SoulGreenGraceRequestedEventObjectSchema,
    SoulVerificationCompletedEventObjectSchema,
    SoulGovernanceLeaseAcquiredEventObjectSchema,
    SoulGovernanceLeaseReleasedEventObjectSchema,
    SoulGovernanceLeasePiercedEventObjectSchema
  ])
  .readonly();

export type GreenGovernanceEventPayloadMap = {
  [K in keyof typeof greenGovernancePayloadSchemas]: z.infer<(typeof greenGovernancePayloadSchemas)[K]>;
};

export function parseGreenGovernanceEventPayload<T extends keyof typeof greenGovernancePayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): GreenGovernanceEventPayloadMap[T] {
  const schema = greenGovernancePayloadSchemas[type];
  return schema.parse(payload) as GreenGovernanceEventPayloadMap[T];
}

export type PromotionOutcome = z.infer<typeof PromotionOutcomeSchema>;
export type GreenGovernanceEventTypeValue = z.infer<typeof GreenGovernanceEventTypeSchema>;
export type GreenGovernanceEvent = z.infer<typeof GreenGovernanceEventUnionSchema>;
