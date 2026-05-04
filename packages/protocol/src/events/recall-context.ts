import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const recallContextEventTypeValues = [
  "soul.task_surface.created",
  "soul.recall.completed",
  "soul.context_lens.assembled"
] as const;

export const RecallContextEventType = {
  SOUL_TASK_SURFACE_CREATED: "soul.task_surface.created",
  SOUL_RECALL_COMPLETED: "soul.recall.completed",
  SOUL_CONTEXT_LENS_ASSEMBLED: "soul.context_lens.assembled"
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

const recallContextPayloadSchemas = {
  [RecallContextEventType.SOUL_TASK_SURFACE_CREATED]: SoulTaskSurfaceCreatedPayloadSchema,
  [RecallContextEventType.SOUL_RECALL_COMPLETED]: SoulRecallCompletedPayloadSchema,
  [RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED]: SoulContextLensAssembledPayloadSchema
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

export const SoulTaskSurfaceCreatedEventSchema = SoulTaskSurfaceCreatedEventObjectSchema.readonly();
export const SoulRecallCompletedEventSchema = SoulRecallCompletedEventObjectSchema.readonly();
export const SoulContextLensAssembledEventSchema = SoulContextLensAssembledEventObjectSchema.readonly();

export const RecallContextEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulTaskSurfaceCreatedEventObjectSchema,
    SoulRecallCompletedEventObjectSchema,
    SoulContextLensAssembledEventObjectSchema
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