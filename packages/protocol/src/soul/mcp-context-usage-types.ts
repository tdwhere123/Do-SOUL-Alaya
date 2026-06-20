import { z } from "zod";
import { BOUNDED_DEFAULT_ARRAY_MAX, BoundedIdSchema, BoundedLabelSchema, BoundedReasonSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";

export const SoulContextUsageStateSchema = z.enum(["used", "skipped", "not_applicable"]);
export const SoulContextUsageTrustModeSchema = z.enum(["manual", "automatic"]);

// object_kind is an open BoundedLabel, not a closed enum, on purpose: it is
// the same open vocabulary as SoulActiveConstraint.object_kind and must admit
// kinds the wire does not yet model. Consumers fail closed — an unknown kind
// simply never tuple-matches a delivered/expected (object_id, object_kind).
export const SoulContextObjectIdentitySchema = z
  .object({
    object_id: BoundedIdSchema,
    object_kind: BoundedLabelSchema
  })
  .strict()
  .readonly();

export const SoulContextUsageAnchorRoleSchema = z.enum(["source", "target"]);

export const SoulContextPerAnchorUsageSchema = z
  .object({
    object_id: BoundedIdSchema,
    object_kind: BoundedLabelSchema.optional(),
    anchor_role: SoulContextUsageAnchorRoleSchema
  })
  .strict()
  .readonly();

export const SoulContextDeliveredObjectUsageSchema = z
  .object({
    object_id: BoundedIdSchema,
    object_kind: BoundedLabelSchema.optional(),
    usage_status: SoulContextUsageStateSchema
  })
  .strict()
  .readonly();

export const SoulContextUsageTurnMessageSchema = z
  .object({
    role: BoundedLabelSchema,
    content_excerpt: BoundedReasonSchema
  })
  .strict()
  .readonly();

export const SoulContextUsageTurnDigestSchema = z
  .object({
    last_messages: z.array(SoulContextUsageTurnMessageSchema).max(50).readonly().default([])
  })
  .strict()
  .readonly();

export const SoulReportContextUsageRequestSchema = z
  .object({
    delivery_id: BoundedIdSchema,
    usage_state: SoulContextUsageStateSchema,
    used_object_ids: z.array(BoundedIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    delivered_objects: z
      .array(SoulContextDeliveredObjectUsageSchema)
      .max(BOUNDED_DEFAULT_ARRAY_MAX)
      .readonly()
      .optional(),
    turn_index: NonNegativeIntSchema.optional(),
    turn_digest: SoulContextUsageTurnDigestSchema.optional(),
    per_anchor_usage: z.array(SoulContextPerAnchorUsageSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    // invariant (agents propose, Alaya decides): trust_mode is NOT a
    // request field. Usage trust weight is server-derived — an MCP usage
    // report is an unverified agent self-report, always recorded as
    // `automatic` (lower path-plasticity weight). A caller cannot
    // self-declare `manual` to claim full reinforcement weight. The
    // SoulContextUsageTrustModeSchema enum still types the durable
    // UsageProofRecord, where the server sets the mode.
    reason: BoundedReasonSchema.nullable().optional()
  })
  .strict()
  .readonly();

export const SoulReportContextUsageResponseSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    status: z.literal("recorded")
  })
  .strict()
  .readonly();
