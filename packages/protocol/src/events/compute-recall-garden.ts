import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import { GardenBacklogQueueDepthByTierSchema } from "../soul/garden-backlog-snapshot.js";

const computeRecallGardenEventTypeValues = [
  "compute.provider.call_started",
  "compute.provider.call_completed",
  "compute.provider.call_failed",
  "recall.embedding.supplement_queried",
  "recall.embedding.supplement_merged",
  "recall.embedding.supplement_degraded",
  "garden.backlog.telemetry_snapshot",
  "garden.backlog.warning"
] as const;

export const ComputeRecallGardenEventType = {
  COMPUTE_PROVIDER_CALL_STARTED: "compute.provider.call_started",
  COMPUTE_PROVIDER_CALL_COMPLETED: "compute.provider.call_completed",
  COMPUTE_PROVIDER_CALL_FAILED: "compute.provider.call_failed",
  RECALL_EMBEDDING_SUPPLEMENT_QUERIED: "recall.embedding.supplement_queried",
  RECALL_EMBEDDING_SUPPLEMENT_MERGED: "recall.embedding.supplement_merged",
  RECALL_EMBEDDING_SUPPLEMENT_DEGRADED: "recall.embedding.supplement_degraded",
  GARDEN_BACKLOG_TELEMETRY_SNAPSHOT: "garden.backlog.telemetry_snapshot",
  GARDEN_BACKLOG_WARNING: "garden.backlog.warning"
} as const;

export const ComputeRecallGardenEventTypeSchema = z.enum(computeRecallGardenEventTypeValues);

const WorkspaceScopedEventContextSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable()
  })
  .strict();

const BacklogEventContextSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable()
  })
  .strict();

const ComputeProviderCallBasePayloadSchema = WorkspaceScopedEventContextSchema.extend({
  provider_kind: NonEmptyStringSchema,
  model_id: NonEmptyStringSchema,
  operation: NonEmptyStringSchema,
  call_id: NonEmptyStringSchema
}).strict();

export const ComputeProviderCallStartedPayloadSchema = ComputeProviderCallBasePayloadSchema.extend({
  started_at: IsoDatetimeStringSchema
})
  .strict()
  .readonly();

export const ComputeProviderCallCompletedPayloadSchema = ComputeProviderCallBasePayloadSchema.extend({
  latency_ms: NonNegativeIntSchema,
  completed_at: IsoDatetimeStringSchema
})
  .strict()
  .readonly();

export const ComputeProviderCallFailedPayloadSchema = ComputeProviderCallBasePayloadSchema.extend({
  latency_ms: NonNegativeIntSchema,
  error_kind: NonEmptyStringSchema,
  error_message: z.string(),
  failed_at: IsoDatetimeStringSchema
})
  .strict()
  .readonly();

const EmbeddingSupplementBasePayloadSchema = WorkspaceScopedEventContextSchema.extend({
  query_id: NonEmptyStringSchema
}).strict();

export const RecallEmbeddingSupplementQueriedPayloadSchema =
  EmbeddingSupplementBasePayloadSchema.extend({
    requested_limit: NonNegativeIntSchema,
    returned_candidate_count: NonNegativeIntSchema,
    latency_ms: NonNegativeIntSchema,
    queried_at: IsoDatetimeStringSchema
  })
    .strict()
    .readonly();

export const RecallEmbeddingSupplementMergedPayloadSchema =
  EmbeddingSupplementBasePayloadSchema.extend({
    base_candidate_count: NonNegativeIntSchema,
    supplement_candidate_count: NonNegativeIntSchema,
    merged_candidate_count: NonNegativeIntSchema,
    merged_at: IsoDatetimeStringSchema
  })
    .strict()
    .readonly();

export const RecallEmbeddingSupplementDegradedPayloadSchema =
  EmbeddingSupplementBasePayloadSchema.extend({
    degradation_reason: NonEmptyStringSchema,
    base_candidate_count: NonNegativeIntSchema,
    fallback_candidate_count: NonNegativeIntSchema,
    degraded_at: IsoDatetimeStringSchema
  })
    .strict()
    .readonly();

const GardenBacklogBasePayloadSchema = BacklogEventContextSchema.extend({
  queue_depth_total: NonNegativeIntSchema,
  queue_depth_by_tier: GardenBacklogQueueDepthByTierSchema,
  in_flight_total: NonNegativeIntSchema,
  warning_active: z.boolean(),
  observed_at: IsoDatetimeStringSchema
}).strict();

export const GardenBacklogTelemetrySnapshotPayloadSchema = GardenBacklogBasePayloadSchema.strict().readonly();

export const GardenBacklogWarningTransitionSchema = z.enum(["arm", "clear"]);

export const GardenBacklogWarningPayloadSchema = GardenBacklogBasePayloadSchema.extend({
  warning_queue_depth: NonNegativeIntSchema,
  warning_rearm_depth: NonNegativeIntSchema,
  transition: GardenBacklogWarningTransitionSchema
})
  .strict()
  .readonly();

const computeRecallGardenPayloadSchemas = {
  [ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED]:
    ComputeProviderCallStartedPayloadSchema,
  [ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_COMPLETED]:
    ComputeProviderCallCompletedPayloadSchema,
  [ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_FAILED]:
    ComputeProviderCallFailedPayloadSchema,
  [ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED]:
    RecallEmbeddingSupplementQueriedPayloadSchema,
  [ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED]:
    RecallEmbeddingSupplementMergedPayloadSchema,
  [ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED]:
    RecallEmbeddingSupplementDegradedPayloadSchema,
  [ComputeRecallGardenEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT]:
    GardenBacklogTelemetrySnapshotPayloadSchema,
  [ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING]: GardenBacklogWarningPayloadSchema
} as const;

export function createComputeRecallGardenEventObjectSchema<
  T extends keyof typeof computeRecallGardenPayloadSchemas
>(type: T, payloadSchema: (typeof computeRecallGardenPayloadSchemas)[T]) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const ComputeProviderCallStartedEventObjectSchema =
  createComputeRecallGardenEventObjectSchema(
    ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED,
    ComputeProviderCallStartedPayloadSchema
  );
const ComputeProviderCallCompletedEventObjectSchema =
  createComputeRecallGardenEventObjectSchema(
    ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_COMPLETED,
    ComputeProviderCallCompletedPayloadSchema
  );
const ComputeProviderCallFailedEventObjectSchema = createComputeRecallGardenEventObjectSchema(
  ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_FAILED,
  ComputeProviderCallFailedPayloadSchema
);
const RecallEmbeddingSupplementQueriedEventObjectSchema =
  createComputeRecallGardenEventObjectSchema(
    ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
    RecallEmbeddingSupplementQueriedPayloadSchema
  );
const RecallEmbeddingSupplementMergedEventObjectSchema =
  createComputeRecallGardenEventObjectSchema(
    ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED,
    RecallEmbeddingSupplementMergedPayloadSchema
  );
const RecallEmbeddingSupplementDegradedEventObjectSchema =
  createComputeRecallGardenEventObjectSchema(
    ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
    RecallEmbeddingSupplementDegradedPayloadSchema
  );
const GardenBacklogTelemetrySnapshotEventObjectSchema =
  createComputeRecallGardenEventObjectSchema(
    ComputeRecallGardenEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT,
    GardenBacklogTelemetrySnapshotPayloadSchema
  );
const GardenBacklogWarningEventObjectSchema = createComputeRecallGardenEventObjectSchema(
  ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
  GardenBacklogWarningPayloadSchema
);

export const ComputeProviderCallStartedEventSchema =
  ComputeProviderCallStartedEventObjectSchema.readonly();
export const ComputeProviderCallCompletedEventSchema =
  ComputeProviderCallCompletedEventObjectSchema.readonly();
export const ComputeProviderCallFailedEventSchema =
  ComputeProviderCallFailedEventObjectSchema.readonly();
export const RecallEmbeddingSupplementQueriedEventSchema =
  RecallEmbeddingSupplementQueriedEventObjectSchema.readonly();
export const RecallEmbeddingSupplementMergedEventSchema =
  RecallEmbeddingSupplementMergedEventObjectSchema.readonly();
export const RecallEmbeddingSupplementDegradedEventSchema =
  RecallEmbeddingSupplementDegradedEventObjectSchema.readonly();
export const GardenBacklogTelemetrySnapshotEventSchema =
  GardenBacklogTelemetrySnapshotEventObjectSchema.readonly();
export const GardenBacklogWarningEventSchema = GardenBacklogWarningEventObjectSchema.readonly();

export const ComputeRecallGardenEventUnionSchema = z
  .discriminatedUnion("type", [
    ComputeProviderCallStartedEventObjectSchema,
    ComputeProviderCallCompletedEventObjectSchema,
    ComputeProviderCallFailedEventObjectSchema,
    RecallEmbeddingSupplementQueriedEventObjectSchema,
    RecallEmbeddingSupplementMergedEventObjectSchema,
    RecallEmbeddingSupplementDegradedEventObjectSchema,
    GardenBacklogTelemetrySnapshotEventObjectSchema,
    GardenBacklogWarningEventObjectSchema
  ])
  .readonly();

export type ComputeRecallGardenEventPayloadMap = {
  [K in keyof typeof computeRecallGardenPayloadSchemas]: z.infer<
    (typeof computeRecallGardenPayloadSchemas)[K]
  >;
};

export function parseComputeRecallGardenEventPayload<
  T extends keyof typeof computeRecallGardenPayloadSchemas
>(type: T, payload: Record<string, unknown>): ComputeRecallGardenEventPayloadMap[T] {
  const schema = computeRecallGardenPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase C extension event type: ${String(type)}`);
  }

  return schema.parse(payload) as ComputeRecallGardenEventPayloadMap[T];
}

export type ComputeProviderCallStartedPayload = z.infer<
  typeof ComputeProviderCallStartedPayloadSchema
>;
export type ComputeProviderCallCompletedPayload = z.infer<
  typeof ComputeProviderCallCompletedPayloadSchema
>;
export type ComputeProviderCallFailedPayload = z.infer<
  typeof ComputeProviderCallFailedPayloadSchema
>;
export type RecallEmbeddingSupplementQueriedPayload = z.infer<
  typeof RecallEmbeddingSupplementQueriedPayloadSchema
>;
export type RecallEmbeddingSupplementMergedPayload = z.infer<
  typeof RecallEmbeddingSupplementMergedPayloadSchema
>;
export type RecallEmbeddingSupplementDegradedPayload = z.infer<
  typeof RecallEmbeddingSupplementDegradedPayloadSchema
>;
export type GardenBacklogTelemetrySnapshotPayload = z.infer<
  typeof GardenBacklogTelemetrySnapshotPayloadSchema
>;
export type GardenBacklogWarningTransition = z.infer<
  typeof GardenBacklogWarningTransitionSchema
>;
export type GardenBacklogWarningPayload = z.infer<
  typeof GardenBacklogWarningPayloadSchema
>;
export type ComputeRecallGardenEventTypeValue = z.infer<typeof ComputeRecallGardenEventTypeSchema>;
export type ComputeRecallGardenEvent = z.infer<typeof ComputeRecallGardenEventUnionSchema>;
