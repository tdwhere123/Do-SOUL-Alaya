import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { SoulContextUsageTrustModeSchema } from "../soul/mcp-types.js";

const recallContextEventTypeValues = [
  "soul.task_surface.created",
  "soul.recall.completed",
  "soul.context_lens.assembled",
  "soul.recall.weight_transfer",
  "soul.recall.delivered",
  "soul.context_usage.reported",
  "soul.single_used_anchor"
] as const;

export const RecallContextEventType = {
  SOUL_TASK_SURFACE_CREATED: "soul.task_surface.created",
  SOUL_RECALL_COMPLETED: "soul.recall.completed",
  SOUL_CONTEXT_LENS_ASSEMBLED: "soul.context_lens.assembled",
  SOUL_RECALL_WEIGHT_TRANSFER: "soul.recall.weight_transfer",
  SOUL_RECALL_DELIVERED: "soul.recall.delivered",
  SOUL_CONTEXT_USAGE_REPORTED: "soul.context_usage.reported",
  // invariant: this event is a passive telemetry signal; emitters MUST NOT
  // advance PathRelation counters from this code path. PathPlasticityService
  // owns counter advancement; this signal is read by recall-utilization
  // bucket consumers and the karma `reuse_gain` producer.
  SOUL_SINGLE_USED_ANCHOR: "soul.single_used_anchor"
} as const;

export const RecallContextEventTypeSchema = z.enum(recallContextEventTypeValues);

export const SoulTaskSurfaceCreatedPayloadSchema = z
  .object({
    runtime_id: NonEmptyStringSchema,
    object_kind: z.literal("task_object_surface"),
    surface_kind: NonEmptyStringSchema,
    display_name: NonEmptyStringSchema,
    node_strategy: z.enum(["chat", "analyze", "build", "govern"]),
    run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    expires_at: IsoDatetimeStringSchema.nullable(),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulRecallCompletedPayloadSchema = z
  .object({
    task_surface_ref: NonEmptyStringSchema,
    node_strategy: z.enum(["chat", "analyze", "build", "govern"]),
    total_scanned: NonNegativeIntSchema,
    coarse_filter_count: NonNegativeIntSchema,
    fine_assessment_count: NonNegativeIntSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulContextLensAssembledPayloadSchema = z
  .object({
    runtime_id: NonEmptyStringSchema,
    task_surface_ref: NonEmptyStringSchema.nullable(),
    lens_entry_count: NonNegativeIntSchema,
    total_token_estimate: NonNegativeIntSchema,
    run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulRecallWeightTransferPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    cold_score: z.number().min(0).max(1),
    recalls_edge_count: NonNegativeIntSchema,
    recalls_threshold: NonNegativeIntSchema,
    transferred_amount: z.number().min(0).max(1),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulRecallDeliveredPayloadSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    agent_target: NonEmptyStringSchema,
    query_hash: NonEmptyStringSchema,
    pointer_count: NonNegativeIntSchema,
    latency_ms: NonNegativeIntSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const ContextUsageStateSchema = z.enum(["used", "skipped", "not_applicable"]);

export const SoulContextUsageReportedPayloadSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    agent_target: NonEmptyStringSchema,
    usage_state: ContextUsageStateSchema,
    trust_mode: SoulContextUsageTrustModeSchema.optional(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

// see also: apps/core-daemon/src/routes/recall-utilization.ts — the
// recall-utilization route emits this signal when it observes a usage
// report whose linked delivery carried exactly one pointer (the reuse
// signal the `reuse_gain` karma producer keys on).
export const SoulSingleUsedAnchorPayloadSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    agent_target: NonEmptyStringSchema,
    used_anchor_object_id: NonEmptyStringSchema.nullable(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

const recallContextPayloadSchemas = {
  [RecallContextEventType.SOUL_TASK_SURFACE_CREATED]: SoulTaskSurfaceCreatedPayloadSchema,
  [RecallContextEventType.SOUL_RECALL_COMPLETED]: SoulRecallCompletedPayloadSchema,
  [RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED]: SoulContextLensAssembledPayloadSchema,
  [RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER]: SoulRecallWeightTransferPayloadSchema,
  [RecallContextEventType.SOUL_RECALL_DELIVERED]: SoulRecallDeliveredPayloadSchema,
  [RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED]: SoulContextUsageReportedPayloadSchema,
  [RecallContextEventType.SOUL_SINGLE_USED_ANCHOR]: SoulSingleUsedAnchorPayloadSchema
} as const;

export function createRecallContextEventObjectSchema<T extends keyof typeof recallContextPayloadSchemas>(
  type: T,
  payloadSchema: (typeof recallContextPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulTaskSurfaceCreatedEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_TASK_SURFACE_CREATED,
  SoulTaskSurfaceCreatedPayloadSchema
);
const SoulRecallCompletedEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_RECALL_COMPLETED,
  SoulRecallCompletedPayloadSchema
);
const SoulContextLensAssembledEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
  SoulContextLensAssembledPayloadSchema
);
const SoulRecallWeightTransferEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER,
  SoulRecallWeightTransferPayloadSchema
);
const SoulRecallDeliveredEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_RECALL_DELIVERED,
  SoulRecallDeliveredPayloadSchema
);
const SoulContextUsageReportedEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
  SoulContextUsageReportedPayloadSchema
);
const SoulSingleUsedAnchorEventObjectSchema = createRecallContextEventObjectSchema(
  RecallContextEventType.SOUL_SINGLE_USED_ANCHOR,
  SoulSingleUsedAnchorPayloadSchema
);

export const SoulTaskSurfaceCreatedEventSchema = SoulTaskSurfaceCreatedEventObjectSchema.readonly();
export const SoulRecallCompletedEventSchema = SoulRecallCompletedEventObjectSchema.readonly();
export const SoulContextLensAssembledEventSchema = SoulContextLensAssembledEventObjectSchema.readonly();
export const SoulRecallWeightTransferEventSchema = SoulRecallWeightTransferEventObjectSchema.readonly();
export const SoulRecallDeliveredEventSchema = SoulRecallDeliveredEventObjectSchema.readonly();
export const SoulContextUsageReportedEventSchema = SoulContextUsageReportedEventObjectSchema.readonly();
export const SoulSingleUsedAnchorEventSchema = SoulSingleUsedAnchorEventObjectSchema.readonly();

export const RecallContextEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulTaskSurfaceCreatedEventObjectSchema,
    SoulRecallCompletedEventObjectSchema,
    SoulContextLensAssembledEventObjectSchema,
    SoulRecallWeightTransferEventObjectSchema,
    SoulRecallDeliveredEventObjectSchema,
    SoulContextUsageReportedEventObjectSchema,
    SoulSingleUsedAnchorEventObjectSchema
  ])
  .readonly();

export type RecallContextEventPayloadMap = {
  [K in keyof typeof recallContextPayloadSchemas]: z.infer<(typeof recallContextPayloadSchemas)[K]>;
};

export function parseRecallContextEventPayload<T extends keyof typeof recallContextPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): RecallContextEventPayloadMap[T] {
  const schema = recallContextPayloadSchemas[type];
  return schema.parse(payload) as RecallContextEventPayloadMap[T];
}

export type RecallContextEventTypeValue = z.infer<typeof RecallContextEventTypeSchema>;
export type RecallContextEvent = z.infer<typeof RecallContextEventUnionSchema>;
export type SoulRecallWeightTransferPayload = z.infer<typeof SoulRecallWeightTransferPayloadSchema>;
