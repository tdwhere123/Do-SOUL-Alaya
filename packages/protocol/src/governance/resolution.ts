import { z } from "zod";
import { GovernanceResolutionPolicyClassificationSchema } from "./governance-policy-classification.js";
import {
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../shared/schema-primitives.js";
import { type StagedWarningResolutionOption } from "./staged-warning.js";

// invariant: closed set of resolution kinds soul.resolve accepts.
// see also: packages/core/src/governance/resolution-service.ts (dispatcher)
// see also: packages/core/src/governance/governance-policy.ts (classifyWarning)
// see also: packages/protocol/src/governance/staged-warning.ts
//   StagedWarningResolutionOptionSchema
const soulResolutionKindValues = [
  "confirm",
  "reject",
  "correct",
  "stale",
  "defer",
  "not_relevant"
] as const;

export const SoulResolutionKind = {
  CONFIRM: "confirm",
  REJECT: "reject",
  CORRECT: "correct",
  STALE: "stale",
  DEFER: "defer",
  NOT_RELEVANT: "not_relevant"
} as const;

export const SoulResolutionKindSchema = z.enum(soulResolutionKindValues);

export type SoulResolutionKind = z.infer<typeof SoulResolutionKindSchema>;

type SoulResolutionFields = Readonly<{
  resolution: SoulResolutionKind;
  correction?: string;
  defer_until?: string;
}>;

type AdmittedSoulResolutionFields =
  | (SoulResolutionFields & { resolution: "correct"; correction: string })
  | (SoulResolutionFields & { resolution: "defer"; defer_until: string })
  | (SoulResolutionFields & { resolution: Exclude<SoulResolutionKind, "correct" | "defer"> });

/** Conditional presence policy shared by MCP parsing and direct core calls.
 * Field syntax/bounds remain the request schema's responsibility; unrelated
 * optional fields are not forbidden, trimmed, or used to change the verb.
 */
export function admitSoulResolutionFields(input: SoulResolutionFields):
  | Readonly<{ valid: true; fields: AdmittedSoulResolutionFields }>
  | Readonly<{ valid: false; field: "correction" | "defer_until"; message: string }> {
  if (input.resolution === SoulResolutionKind.CORRECT) {
    if (input.correction === undefined || input.correction.trim().length === 0) {
      return { valid: false, field: "correction", message: "resolution=correct requires a non-empty correction" };
    }
    return { valid: true, fields: { ...input, resolution: input.resolution, correction: input.correction } };
  }
  if (input.resolution === SoulResolutionKind.DEFER) {
    if (input.defer_until === undefined || input.defer_until.trim().length === 0) {
      return { valid: false, field: "defer_until", message: "resolution=defer requires a defer_until ISO datetime" };
    }
    return { valid: true, fields: { ...input, resolution: input.resolution, defer_until: input.defer_until } };
  }
  return { valid: true, fields: { ...input, resolution: input.resolution } };
}

// invariant: agent-facing request shape. workspace_id / run_id /
// agent_target are bound from trusted MCP call context
// (invariants §29 Default Scope). Do NOT include them in the
// schema.
// invariant: resolution === "correct" requires `correction`.
// invariant: resolution === "defer" requires `defer_until`.
// invariant: policy_classification is agent-supplied. GovernancePolicy
// is an agent-side helper (per-turn ask_now budget); the daemon
// echoes the classification onto the resolution audit event without
// re-classifying.
// see also: packages/core/src/governance/governance-policy.ts
export const SoulResolveRequestSchema = z
  .object({
    target_object_id: BoundedIdSchema,
    resolution: SoulResolutionKindSchema,
    delivery_id: BoundedIdSchema,
    reviewer_identity: BoundedIdSchema.optional(),
    reviewer_token: BoundedIdSchema.optional(),
    policy: BoundedLabelSchema.optional(),
    policy_classification: GovernanceResolutionPolicyClassificationSchema.optional(),
    correction: BoundedReasonSchema.optional(),
    reason: BoundedReasonSchema.optional(),
    defer_until: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    // invariant §25 patch: both runtime entries call the conditional policy.
    // JSON Schema cannot represent this refinement; runtime parsing is authoritative.
    const admission = admitSoulResolutionFields(value);
    if (!admission.valid) {
      context.addIssue({ code: "custom", path: [admission.field], message: admission.message });
    }
  });

// invariant: maps the agent-facing StagedWarningResolutionOption
// (recall sidecar surface) to the soul.resolve verb's SoulResolutionKind.
// Returns null for options that have no direct resolve correspondent;
// agents fall back to their own resolution choice in that case.
// see also: packages/protocol/src/governance/staged-warning.ts
export function mapResolutionOptionToKind(
  option: StagedWarningResolutionOption
): SoulResolutionKind | null {
  switch (option) {
    case "accept_pending":
      return SoulResolutionKind.CONFIRM;
    case "reject_pending":
      return SoulResolutionKind.REJECT;
    case "defer":
      return SoulResolutionKind.DEFER;
    case "request_evidence":
    case "escalate_human":
      return null;
  }
}

export const SoulResolveResponseSchema = z
  .object({
    target_object_id: NonEmptyStringSchema,
    resolution: SoulResolutionKindSchema,
    status: z.enum(["applied", "deferred", "noop"]),
    audit_event_type: NonEmptyStringSchema,
    audit_event_id: NonEmptyStringSchema,
    usage_recording_status: z.enum(["recorded", "failed", "unavailable", "not_applicable"]).optional(),
    election_status: z.enum(["completed", "failed", "pending"]).optional(),
    obligation_id: NonEmptyStringSchema.optional(),
    activated_claim_id: NonEmptyStringSchema.optional()
  })
  .strict()
  .readonly();

export type SoulResolveRequest = z.infer<typeof SoulResolveRequestSchema>;
export type SoulResolveResponse = z.infer<typeof SoulResolveResponseSchema>;
