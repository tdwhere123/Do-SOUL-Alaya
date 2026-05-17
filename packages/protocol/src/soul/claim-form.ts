import { z } from "zod";
import { NonEmptyStringSchema } from "../schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { GovernanceSubjectSchema } from "./governance-subject.js";
import { ObjectKind, ScopeClassSchema } from "./object-kind.js";

const claimKindValues = ["constraint", "preference", "procedure", "exception", "factual_policy"] as const;

const enforcementLevelValues = ["strict", "preferred"] as const;

const originTierValues = ["user_explicit", "compiler_extracted", "review_accepted", "seed", "imported"] as const;

const precedenceBasisValues = ["recency", "authority", "evidence_strength", "user_override"] as const;

const claimLifecycleStateValues = ["draft", "active", "contested", "winner", "superseded", "rejected", "archived"] as const;

export const ClaimKind = {
  CONSTRAINT: "constraint",
  PREFERENCE: "preference",
  PROCEDURE: "procedure",
  EXCEPTION: "exception",
  FACTUAL_POLICY: "factual_policy"
} as const;

export const EnforcementLevel = {
  STRICT: "strict",
  PREFERRED: "preferred"
} as const;

export const OriginTier = {
  USER_EXPLICIT: "user_explicit",
  COMPILER_EXTRACTED: "compiler_extracted",
  REVIEW_ACCEPTED: "review_accepted",
  SEED: "seed",
  IMPORTED: "imported"
} as const;

export const PrecedenceBasis = {
  RECENCY: "recency",
  AUTHORITY: "authority",
  EVIDENCE_STRENGTH: "evidence_strength",
  USER_OVERRIDE: "user_override"
} as const;

export const ClaimLifecycleState = {
  DRAFT: "draft",
  ACTIVE: "active",
  CONTESTED: "contested",
  WINNER: "winner",
  SUPERSEDED: "superseded",
  REJECTED: "rejected",
  ARCHIVED: "archived"
} as const;

export const ClaimKindSchema = z.enum(claimKindValues);
export const EnforcementLevelSchema = z.enum(enforcementLevelValues);
export const OriginTierSchema = z.enum(originTierValues);
export const PrecedenceBasisSchema = z.enum(precedenceBasisValues);
export const ClaimLifecycleStateSchema = z.enum(claimLifecycleStateValues);

export const CLAIM_KIND_PRIORITY: Readonly<Record<ClaimKind, number>> = Object.freeze({
  exception: 5,
  constraint: 4,
  procedure: 3,
  preference: 2,
  factual_policy: 1
});

const claimTransitions: Readonly<Record<ClaimLifecycleState, readonly ClaimLifecycleState[]>> = {
  // invariant: draft -> archived directly so soul.resolve.reject on a
  // draft claim has a terminal sink. The intermediate "rejected"
  // state is reserved for contested-then-rejected arbitration.
  draft: ["active", "archived"],
  active: ["contested", "superseded", "archived"],
  contested: ["winner", "rejected", "archived"],
  winner: ["superseded", "archived"],
  superseded: ["archived"],
  rejected: ["archived"],
  archived: []
};

export function isValidClaimTransition(from: ClaimLifecycleState, to: ClaimLifecycleState): boolean {
  return claimTransitions[from].includes(to);
}

export const ClaimFormSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.CLAIM_FORM),
    governance_subject: GovernanceSubjectSchema,
    claim_kind: ClaimKindSchema,
    scope_class: ScopeClassSchema,
    enforcement_level: EnforcementLevelSchema,
    origin_tier: OriginTierSchema,
    precedence_basis: PrecedenceBasisSchema,
    proposition_digest: NonEmptyStringSchema,
    evidence_refs: z.array(NonEmptyStringSchema).readonly(),
    source_object_refs: z.array(NonEmptyStringSchema).readonly(),
    workspace_id: NonEmptyStringSchema,
    claim_status: ClaimLifecycleStateSchema
  })
  .readonly();

export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export type EnforcementLevel = z.infer<typeof EnforcementLevelSchema>;
export type OriginTier = z.infer<typeof OriginTierSchema>;
export type PrecedenceBasis = z.infer<typeof PrecedenceBasisSchema>;
export type ClaimLifecycleState = z.infer<typeof ClaimLifecycleStateSchema>;
export type ClaimForm = z.infer<typeof ClaimFormSchema>;
