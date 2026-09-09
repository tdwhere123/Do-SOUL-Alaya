import { z } from "zod";
import { UsageReportSchema } from "../recall/conditional-field/feedback.js";
import { RecallTargetRefSchema } from "../recall/conditional-field/product-identity.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

export const SoulContextUsageStateSchema = z.enum(["used", "skipped", "not_applicable"]);
export const SoulContextUsageTrustModeSchema = z.enum(["manual", "automatic"]);

// Tagged target is the Recall usage identity. Permissive object_kind strings
// are not sufficient validation; source-record-only rows omit object_id.
export const SoulContextObjectIdentitySchema = z
  .object({
    object_id: BoundedIdSchema.optional(),
    object_kind: BoundedLabelSchema.optional(),
    target: RecallTargetRefSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target === undefined && value.object_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "usage identity requires target or object_id"
      });
    }
    if (value.target?.kind === "memory_entry") {
      if (value.object_id !== value.target.object_id) {
        context.addIssue({
          code: "custom",
          path: ["object_id"],
          message: "memory_entry object_id must match target.object_id"
        });
      }
      return;
    }
    if (value.target?.kind === "source_evidence" && value.object_id !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["object_id"],
        message: "source_evidence must not fill object_id"
      });
    }
  })
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
    object_id: BoundedIdSchema.optional(),
    object_kind: BoundedLabelSchema.optional(),
    target: RecallTargetRefSchema.optional(),
    usage_status: SoulContextUsageStateSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.target === undefined && value.object_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "delivered usage requires target or object_id"
      });
    }
    if (value.target?.kind === "source_evidence" && value.object_id !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["object_id"],
        message: "source_evidence usage must not fill object_id"
      });
    }
  })
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
    witness_reports: z.array(UsageReportSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    used_object_ids: z.array(BoundedIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    delivered_objects: z
      .array(SoulContextDeliveredObjectUsageSchema)
      .max(BOUNDED_DEFAULT_ARRAY_MAX)
      .readonly()
      .optional(),
    turn_index: NonNegativeIntSchema.optional(),
    turn_digest: SoulContextUsageTurnDigestSchema.optional(),
    // Host wall-clock for the reported turn. When present, Garden post-turn
    // extract uses it as source_observed_at; otherwise the enqueue clock wins.
    source_observed_at: IsoDatetimeStringSchema.optional(),
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
