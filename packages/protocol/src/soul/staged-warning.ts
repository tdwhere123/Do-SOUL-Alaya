import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  BoundedReasonSchema,
  NonEmptyStringSchema
} from "../shared/schema-primitives.js";

// invariant: each value names a distinct reason a memory pointer is
// staged. The set is closed so consumers (soul.resolve, Inspector
// Health Inbox) can branch on it without re-parsing free text.
const stagedWarningKindValues = [
  "low_confidence",
  "contradiction_pending",
  "supersede_candidate",
  "evidence_missing",
  "policy_violation"
] as const;

// invariant: severity is the agent's stop-time pressure level.
// `info` = surface only; `warning` = caller should disclose; `blocking`
// = caller must resolve (via soul.resolve) before citing as durable
// truth.
const stagedWarningSeverityValues = ["info", "warning", "blocking"] as const;

// invariant: each value names a resolution action the soul.resolve
// verb accepts. Listing options on the warning lets agents pick a
// resolution without a second round-trip to enumerate them.
const stagedWarningResolutionOptionValues = [
  "accept_pending",
  "reject_pending",
  "request_evidence",
  "escalate_human",
  "defer"
] as const;

export const StagedWarningKind = {
  LOW_CONFIDENCE: "low_confidence",
  CONTRADICTION_PENDING: "contradiction_pending",
  SUPERSEDE_CANDIDATE: "supersede_candidate",
  EVIDENCE_MISSING: "evidence_missing",
  POLICY_VIOLATION: "policy_violation"
} as const;

export const StagedWarningSeverity = {
  INFO: "info",
  WARNING: "warning",
  BLOCKING: "blocking"
} as const;

export const StagedWarningResolutionOption = {
  ACCEPT_PENDING: "accept_pending",
  REJECT_PENDING: "reject_pending",
  REQUEST_EVIDENCE: "request_evidence",
  ESCALATE_HUMAN: "escalate_human",
  DEFER: "defer"
} as const;

export const StagedWarningKindSchema = z.enum(stagedWarningKindValues);
export const StagedWarningSeveritySchema = z.enum(stagedWarningSeverityValues);
export const StagedWarningResolutionOptionSchema = z.enum(
  stagedWarningResolutionOptionValues
);

export const StagedWarningSchema = z
  .object({
    // kind: discriminator — what kind of staging the row is in.
    kind: StagedWarningKindSchema,
    // severity: stop-time pressure level for the attached agent.
    severity: StagedWarningSeveritySchema,
    // policy: the governance policy id that raised the warning, so the
    // resolver routes the resolution back to the producing policy.
    policy: BoundedLabelSchema,
    // summary: bounded one-line digest the agent or Inspector can echo
    // to the user without opening the underlying object.
    summary: BoundedReasonSchema,
    // target_object_id: typed target for the warning. Optional so
    // older recall payloads remain valid; daemon recall formatting fills
    // it from the containing candidate when a producer omits it.
    target_object_id: NonEmptyStringSchema.optional(),
    // resolution_options: canonical actions soul.resolve accepts for
    // this warning. May be empty when only human inbox review applies.
    resolution_options: z
      .array(StagedWarningResolutionOptionSchema)
      .max(BOUNDED_DEFAULT_ARRAY_MAX)
      .readonly()
  })
  .strict()
  .readonly();

export const StagedWarningArraySchema = z
  .array(StagedWarningSchema)
  .max(BOUNDED_DEFAULT_ARRAY_MAX)
  .readonly();

export type StagedWarningKind = z.infer<typeof StagedWarningKindSchema>;
export type StagedWarningSeverity = z.infer<typeof StagedWarningSeveritySchema>;
export type StagedWarningResolutionOption = z.infer<
  typeof StagedWarningResolutionOptionSchema
>;
export type StagedWarning = z.infer<typeof StagedWarningSchema>;
// invariant: not exported as a single primitive — consumers should
// always wrap StagedWarning[] through the bounded array schema. The
// type export below mirrors the readonly array shape so handlers can
// pass it through without losing readonly.
export type StagedWarningArray = z.infer<typeof StagedWarningArraySchema>;
