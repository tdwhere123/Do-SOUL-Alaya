import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../schema-primitives.js";

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
export const SoulResolveRequestSchema = z
  .object({
    target_object_id: BoundedIdSchema,
    resolution: SoulResolutionKindSchema,
    delivery_id: BoundedIdSchema,
    policy: BoundedLabelSchema.optional(),
    correction: BoundedReasonSchema.optional(),
    reason: BoundedReasonSchema.optional(),
    defer_until: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

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
