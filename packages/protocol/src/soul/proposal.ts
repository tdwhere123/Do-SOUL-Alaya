import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

const proposalOptionKindValues = [
  "trim_soft_context",
  "freeze_low_value_competition",
  "defer_noncritical_verification",
  "request_confirmation",
  "abort_high_risk_write"
] as const;

const proposalResolutionStateValues = [
  "pending",
  "auto_applied",
  "accepted",
  "rejected",
  "expired",
  "superseded"
] as const;

export const ProposalOptionKind = {
  TRIM_SOFT_CONTEXT: "trim_soft_context",
  FREEZE_LOW_VALUE_COMPETITION: "freeze_low_value_competition",
  DEFER_NONCRITICAL_VERIFICATION: "defer_noncritical_verification",
  REQUEST_CONFIRMATION: "request_confirmation",
  ABORT_HIGH_RISK_WRITE: "abort_high_risk_write"
} as const;

export const ProposalResolutionState = {
  PENDING: "pending",
  AUTO_APPLIED: "auto_applied",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  EXPIRED: "expired",
  SUPERSEDED: "superseded"
} as const;

export const ProposalOptionKindSchema = z.enum(proposalOptionKindValues);
export const ProposalResolutionStateSchema = z.enum(proposalResolutionStateValues);

export const ProposalOptionSchema = z
  .object({
    option_id: NonEmptyStringSchema,
    option_kind: ProposalOptionKindSchema,
    preserves_protected_constraints: z.boolean(),
    dropped_candidates: z.array(NonEmptyStringSchema).readonly(),
    unresolved_after_apply: z.array(NonEmptyStringSchema).readonly(),
    requires_confirmation: z.boolean()
  })
  .readonly();

export const ProposalSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.PROPOSAL),
    proposal_id: NonEmptyStringSchema,
    dossier_ref: NonEmptyStringSchema.nullable(),
    recommended_option_id: NonEmptyStringSchema.nullable(),
    proposal_options: z.array(ProposalOptionSchema).min(1).readonly(),
    resolution_state: ProposalResolutionStateSchema,
    expires_at: IsoDatetimeStringSchema.nullable(),
    last_updated_at: IsoDatetimeStringSchema
  })
  .readonly();

export type ProposalOptionKind = z.infer<typeof ProposalOptionKindSchema>;
export type ProposalResolutionState = z.infer<typeof ProposalResolutionStateSchema>;
export type ProposalOption = z.infer<typeof ProposalOptionSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
