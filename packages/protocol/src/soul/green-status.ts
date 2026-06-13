import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { MemoryDimensionSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";

const greenStateValues = ["eligible", "grace", "revoked"] as const;
const verificationBasisValues = [
  "passive_stable",
  "active_verification",
  "deterministic_check",
  "user_reconfirm"
] as const;
const revokeReasonValues = [
  "correction_open",
  "contested",
  "verification_fail",
  "external_invalidation",
  "security_hit",
  "surface_detached",
  "mapping_revoked",
  "review_overdue",
  "none"
] as const;
const verifiedByValues = ["auditor", "deterministic_checker", "user", "review"] as const;

export const GreenState = {
  ELIGIBLE: "eligible",
  GRACE: "grace",
  REVOKED: "revoked"
} as const;

export const VerificationBasis = {
  PASSIVE_STABLE: "passive_stable",
  ACTIVE_VERIFICATION: "active_verification",
  DETERMINISTIC_CHECK: "deterministic_check",
  USER_RECONFIRM: "user_reconfirm"
} as const;

export const RevokeReason = {
  CORRECTION_OPEN: "correction_open",
  CONTESTED: "contested",
  VERIFICATION_FAIL: "verification_fail",
  EXTERNAL_INVALIDATION: "external_invalidation",
  SECURITY_HIT: "security_hit",
  SURFACE_DETACHED: "surface_detached",
  MAPPING_REVOKED: "mapping_revoked",
  REVIEW_OVERDUE: "review_overdue",
  NONE: "none"
} as const;

export const VerifiedBy = {
  AUDITOR: "auditor",
  DETERMINISTIC_CHECKER: "deterministic_checker",
  USER: "user",
  REVIEW: "review"
} as const;

export const GreenStateValues = greenStateValues;
export const VerificationBasisValues = verificationBasisValues;
export const RevokeReasonValues = revokeReasonValues;
export const VerifiedByValues = verifiedByValues;

export const GreenStateSchema = z.enum(greenStateValues);
export const VerificationBasisSchema = z.enum(verificationBasisValues);
export const RevokeReasonSchema = z.enum(revokeReasonValues);
export const VerifiedBySchema = z.enum(verifiedByValues);

export const GreenStatusSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal("green_status"),
    target_object_id: NonEmptyStringSchema,
    target_object_kind: z.literal("memory_entry"),
    green_state: GreenStateSchema,
    verification_basis: VerificationBasisSchema,
    verified_by: VerifiedBySchema,
    verified_at: IsoDatetimeStringSchema.nullable(),
    valid_until: IsoDatetimeStringSchema.nullable(),
    bound_surfaces: z.array(NonEmptyStringSchema).readonly().nullable(),
    bound_scope_class: ScopeClassSchema.nullable(),
    revoke_reason: RevokeReasonSchema,
    last_transition_at: IsoDatetimeStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export const VERIFICATION_VALID_UNTIL_BY_DIMENSION = Object.freeze({
  preference: null,
  constraint: 14,
  decision: null,
  procedure: 14,
  fact: 30,
  hazard: 7,
  glossary: 30,
  episode: null
} satisfies Record<z.infer<typeof MemoryDimensionSchema>, number | null>);

export type GreenState = z.infer<typeof GreenStateSchema>;
export type VerificationBasis = z.infer<typeof VerificationBasisSchema>;
export type RevokeReason = z.infer<typeof RevokeReasonSchema>;
export type VerifiedBy = z.infer<typeof VerifiedBySchema>;
export type GreenStatus = z.infer<typeof GreenStatusSchema>;
