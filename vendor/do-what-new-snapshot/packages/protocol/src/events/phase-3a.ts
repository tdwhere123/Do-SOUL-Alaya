import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const phase3AEventTypeValues = [
  "soul.task_surface.created",
  "soul.recall.completed",
  "soul.context_lens.assembled"
] as const;

export const Phase3AEventType = {
  SOUL_TASK_SURFACE_CREATED: "soul.task_surface.created",
  SOUL_RECALL_COMPLETED: "soul.recall.completed",
  SOUL_CONTEXT_LENS_ASSEMBLED: "soul.context_lens.assembled"
} as const;

export const Phase3AEventTypeSchema = z.enum(phase3AEventTypeValues);

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

const phase3APayloadSchemas = {
  [Phase3AEventType.SOUL_TASK_SURFACE_CREATED]: SoulTaskSurfaceCreatedPayloadSchema,
  [Phase3AEventType.SOUL_RECALL_COMPLETED]: SoulRecallCompletedPayloadSchema,
  [Phase3AEventType.SOUL_CONTEXT_LENS_ASSEMBLED]: SoulContextLensAssembledPayloadSchema
} as const;

export function createPhase3AEventObjectSchema<T extends keyof typeof phase3APayloadSchemas>(
  type: T,
  payloadSchema: (typeof phase3APayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulTaskSurfaceCreatedEventObjectSchema = createPhase3AEventObjectSchema(
  Phase3AEventType.SOUL_TASK_SURFACE_CREATED,
  SoulTaskSurfaceCreatedPayloadSchema
);
const SoulRecallCompletedEventObjectSchema = createPhase3AEventObjectSchema(
  Phase3AEventType.SOUL_RECALL_COMPLETED,
  SoulRecallCompletedPayloadSchema
);
const SoulContextLensAssembledEventObjectSchema = createPhase3AEventObjectSchema(
  Phase3AEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
  SoulContextLensAssembledPayloadSchema
);

export const SoulTaskSurfaceCreatedEventSchema = SoulTaskSurfaceCreatedEventObjectSchema.readonly();
export const SoulRecallCompletedEventSchema = SoulRecallCompletedEventObjectSchema.readonly();
export const SoulContextLensAssembledEventSchema = SoulContextLensAssembledEventObjectSchema.readonly();

export const Phase3AEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulTaskSurfaceCreatedEventObjectSchema,
    SoulRecallCompletedEventObjectSchema,
    SoulContextLensAssembledEventObjectSchema
  ])
  .readonly();

export type Phase3AEventPayloadMap = {
  [K in keyof typeof phase3APayloadSchemas]: z.infer<(typeof phase3APayloadSchemas)[K]>;
};

export function parsePhase3AEventPayload<T extends keyof typeof phase3APayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): Phase3AEventPayloadMap[T] {
  const schema = phase3APayloadSchemas[type];
  return schema.parse(payload) as Phase3AEventPayloadMap[T];
}

export type Phase3AEventTypeValue = z.infer<typeof Phase3AEventTypeSchema>;
export type Phase3AEvent = z.infer<typeof Phase3AEventUnionSchema>;