import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema
} from "../shared/schema-primitives.js";
import {
  SoulContextObjectIdentitySchema,
  SoulContextPerAnchorUsageSchema,
  SoulContextUsageStateSchema,
  SoulContextUsageTrustModeSchema
} from "./mcp-types.js";

export const TrustStateEventType = {
  MEMORY_DELIVERED: "memory.delivered",
  MEMORY_USAGE_REPORTED: "memory.usage_reported",
  TRUST_STATE_INSTALLED_RECORDED: "trust_state.installed.recorded",
  TRUST_STATE_CONFIGURED_RECORDED: "trust_state.configured.recorded",
  TRUST_STATE_UNVERIFIABLE_RECORDED: "trust_state.unverifiable.recorded"
} as const;

export const TrustStateEventTypeSchema = z.enum([
  TrustStateEventType.MEMORY_DELIVERED,
  TrustStateEventType.MEMORY_USAGE_REPORTED,
  TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED,
  TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED,
  TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED
]);

export const TrustStateSchema = z.enum([
  "installed",
  "configured",
  "delivered",
  "used",
  "skipped",
  "unverifiable",
  "mixed"
]);

export const ContextDeliveryRecordSchema = z
  .object({
    delivery_id: BoundedIdSchema,
    agent_target: BoundedLabelSchema,
    workspace_id: BoundedIdSchema.nullable(),
    run_id: BoundedIdSchema.nullable(),
    delivered_object_ids: z.array(BoundedIdSchema).readonly(),
    delivered_objects: z.array(SoulContextObjectIdentitySchema).readonly().optional(),
    delivered_at: IsoDatetimeStringSchema,
    audit_event_id: BoundedIdSchema
  })
  .strict()
  .readonly();

export const UsageProofRecordSchema = z
  .object({
    delivery_id: BoundedIdSchema,
    usage_state: SoulContextUsageStateSchema,
    used_object_ids: z.array(BoundedIdSchema).readonly(),
    per_anchor_usage: z.array(SoulContextPerAnchorUsageSchema).readonly().optional(),
    trust_mode: SoulContextUsageTrustModeSchema.optional(),
    reason: BoundedReasonSchema.nullable(),
    reported_at: IsoDatetimeStringSchema,
    audit_event_id: BoundedIdSchema
  })
  .strict()
  .readonly();

export const TrustSummarySchema = z
  .object({
    agent_target: BoundedLabelSchema,
    state: TrustStateSchema,
    installed_count: z.number().int().nonnegative(),
    configured_count: z.number().int().nonnegative(),
    delivered_count: z.number().int().nonnegative(),
    used_count: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
    not_applicable_count: z.number().int().nonnegative(),
    unverifiable_count: z.number().int().nonnegative(),
    last_delivery_at: IsoDatetimeStringSchema.nullable(),
    last_usage_report_at: IsoDatetimeStringSchema.nullable()
  })
  .strict()
  .readonly();

export type TrustState = z.infer<typeof TrustStateSchema>;
export type TrustStateEventType = z.infer<typeof TrustStateEventTypeSchema>;
export type ContextDeliveryRecord = z.infer<typeof ContextDeliveryRecordSchema>;
export type UsageProofRecord = z.infer<typeof UsageProofRecordSchema>;
export type TrustSummary = z.infer<typeof TrustSummarySchema>;
