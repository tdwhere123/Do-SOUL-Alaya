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
// see also: packages/core/src/resolution-service.ts (dispatcher)
// see also: packages/core/src/governance-policy.ts (classifyWarning)
// see also: packages/protocol/src/soul/staged-warning.ts
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
// see also: packages/core/src/governance-policy.ts
export const SoulResolveRequestSchema = z
  .object({
    target_object_id: BoundedIdSchema,
    resolution: SoulResolutionKindSchema,
    delivery_id: BoundedIdSchema,
    policy: BoundedLabelSchema.optional(),
    policy_classification: GovernanceResolutionPolicyClassificationSchema.optional(),
    correction: BoundedReasonSchema.optional(),
    reason: BoundedReasonSchema.optional(),
    defer_until: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

// invariant: maps the agent-facing StagedWarningResolutionOption
// (recall sidecar surface) to the soul.resolve verb's SoulResolutionKind.
// Returns null for options that have no direct resolve correspondent;
// agents fall back to their own resolution choice in that case.
// see also: packages/protocol/src/soul/staged-warning.ts
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
    obligation_id: NonEmptyStringSchema.optional(),
    activated_claim_id: NonEmptyStringSchema.optional()
  })
  .strict()
  .readonly();

export type SoulResolveRequest = z.infer<typeof SoulResolveRequestSchema>;
export type SoulResolveResponse = z.infer<typeof SoulResolveResponseSchema>;
