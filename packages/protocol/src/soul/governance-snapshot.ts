import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { GreenStateSchema, RevokeReasonSchema, VerificationBasisSchema } from "./green-status.js";

export const GreenStatusSummaryItemSchema = z
  .object({
    target_object_id: NonEmptyStringSchema,
    green_state: GreenStateSchema,
    verification_basis: VerificationBasisSchema,
    valid_until: IsoDatetimeStringSchema.nullable(),
    revoke_reason: RevokeReasonSchema,
    last_transition_at: IsoDatetimeStringSchema
  })
  .readonly();

export const ActiveOverrideSummaryItemSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    target_object: NonEmptyStringSchema,
    correction: NonEmptyStringSchema,
    priority: NonNegativeIntSchema,
    expires_at: IsoDatetimeStringSchema.nullable()
  })
  .readonly();

export const GovernanceLeaseSummarySchema = z
  .object({
    held: z.boolean(),
    lease_id: NonEmptyStringSchema.nullable(),
    holder: NonEmptyStringSchema.nullable(),
    expires_at: IsoDatetimeStringSchema.nullable()
  })
  .readonly();

export const GovernanceSnapshotSchema = z
  .object({
    run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    green_summary: z
      .object({
        eligible_count: NonNegativeIntSchema,
        grace_count: NonNegativeIntSchema,
        revoked_count: NonNegativeIntSchema
      })
      .readonly(),
    green_statuses: z.array(GreenStatusSummaryItemSchema).readonly(),
    active_overrides: z.array(ActiveOverrideSummaryItemSchema).readonly(),
    governance_lease: GovernanceLeaseSummarySchema,
    snapshot_at: IsoDatetimeStringSchema
  })
  .readonly();

export type GreenStatusSummaryItem = z.infer<typeof GreenStatusSummaryItemSchema>;
export type ActiveOverrideSummaryItem = z.infer<typeof ActiveOverrideSummaryItemSchema>;
export type GovernanceLeaseSummary = z.infer<typeof GovernanceLeaseSummarySchema>;
export type GovernanceSnapshot = z.infer<typeof GovernanceSnapshotSchema>;
