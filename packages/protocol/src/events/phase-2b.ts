import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { TransitionCausedBySchema } from "./phase-1b.js";
import { BindingStateSchema, SurfaceAnchorKindSchema, SurfaceStatusSchema } from "../soul/surface.js";
import { CrossCuttingStateSchema } from "../soul/cross-cutting.js";

const phase2BEventTypeValues = [
  "soul.surface.created",
  "soul.surface.status_changed",
  "soul.surface_anchor.created",
  "soul.surface_anchor.deleted",
  "soul.surface_binding.created",
  "soul.surface_binding.state_changed",
  "soul.cross_cutting.state_changed"
] as const;

export const Phase2BEventType = {
  SOUL_SURFACE_CREATED: "soul.surface.created",
  SOUL_SURFACE_STATUS_CHANGED: "soul.surface.status_changed",
  SOUL_SURFACE_ANCHOR_CREATED: "soul.surface_anchor.created",
  SOUL_SURFACE_ANCHOR_DELETED: "soul.surface_anchor.deleted",
  SOUL_SURFACE_BINDING_CREATED: "soul.surface_binding.created",
  SOUL_SURFACE_BINDING_STATE_CHANGED: "soul.surface_binding.state_changed",
  SOUL_CROSS_CUTTING_STATE_CHANGED: "soul.cross_cutting.state_changed"
} as const;

export const Phase2BEventTypeSchema = z.enum(phase2BEventTypeValues);

const Phase2BObjectPayloadObjectSchema = z.object({
  object_id: NonEmptyStringSchema,
  object_kind: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable()
});

export const SoulSurfaceCreatedPayloadSchema = Phase2BObjectPayloadObjectSchema.extend({
  surface_id: NonEmptyStringSchema,
  surface_kind: NonEmptyStringSchema,
  surface_status: SurfaceStatusSchema
}).readonly();

export const SoulSurfaceStatusChangedPayloadSchema = Phase2BObjectPayloadObjectSchema.extend({
  surface_id: NonEmptyStringSchema,
  from_status: SurfaceStatusSchema,
  to_status: SurfaceStatusSchema,
  reason_code: NonEmptyStringSchema,
  caused_by: TransitionCausedBySchema,
  occurred_at: IsoDatetimeStringSchema
}).readonly();

export const SoulSurfaceAnchorCreatedPayloadSchema = Phase2BObjectPayloadObjectSchema.extend({
  surface_id: NonEmptyStringSchema,
  anchor_kind: SurfaceAnchorKindSchema,
  anchor_value: NonEmptyStringSchema
}).readonly();

export const SoulSurfaceAnchorDeletedPayloadSchema = z
  .object({
    anchor_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export const SoulSurfaceBindingCreatedPayloadSchema = Phase2BObjectPayloadObjectSchema.extend({
  binding_id: NonEmptyStringSchema,
  surface_id: NonEmptyStringSchema,
  is_primary: z.boolean(),
  binding_state: BindingStateSchema
}).readonly();

export const SoulSurfaceBindingStateChangedPayloadSchema = z
  .object({
    binding_id: NonEmptyStringSchema,
    object_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema,
    from_state: BindingStateSchema,
    to_state: BindingStateSchema,
    reason: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export const SoulCrossCuttingStateChangedPayloadSchema = z
  .object({
    permission_id: NonEmptyStringSchema,
    object_id: NonEmptyStringSchema,
    from_state: CrossCuttingStateSchema.nullable(),
    to_state: CrossCuttingStateSchema,
    allowed_surfaces: z.array(NonEmptyStringSchema).readonly(),
    reason: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

const phase2BPayloadSchemas = {
  [Phase2BEventType.SOUL_SURFACE_CREATED]: SoulSurfaceCreatedPayloadSchema,
  [Phase2BEventType.SOUL_SURFACE_STATUS_CHANGED]: SoulSurfaceStatusChangedPayloadSchema,
  [Phase2BEventType.SOUL_SURFACE_ANCHOR_CREATED]: SoulSurfaceAnchorCreatedPayloadSchema,
  [Phase2BEventType.SOUL_SURFACE_ANCHOR_DELETED]: SoulSurfaceAnchorDeletedPayloadSchema,
  [Phase2BEventType.SOUL_SURFACE_BINDING_CREATED]: SoulSurfaceBindingCreatedPayloadSchema,
  [Phase2BEventType.SOUL_SURFACE_BINDING_STATE_CHANGED]: SoulSurfaceBindingStateChangedPayloadSchema,
  [Phase2BEventType.SOUL_CROSS_CUTTING_STATE_CHANGED]: SoulCrossCuttingStateChangedPayloadSchema
} as const;

const Phase2BEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const Phase2BEventBaseSchema = Phase2BEventBaseObjectSchema.readonly();

export function createPhase2BEventObjectSchema<T extends keyof typeof phase2BPayloadSchemas>(
  eventType: T,
  payloadSchema: (typeof phase2BPayloadSchemas)[T]
) {
  return Phase2BEventBaseObjectSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const SoulSurfaceCreatedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_SURFACE_CREATED,
  SoulSurfaceCreatedPayloadSchema
);
const SoulSurfaceStatusChangedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_SURFACE_STATUS_CHANGED,
  SoulSurfaceStatusChangedPayloadSchema
);
const SoulSurfaceAnchorCreatedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_SURFACE_ANCHOR_CREATED,
  SoulSurfaceAnchorCreatedPayloadSchema
);
const SoulSurfaceAnchorDeletedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_SURFACE_ANCHOR_DELETED,
  SoulSurfaceAnchorDeletedPayloadSchema
);
const SoulSurfaceBindingCreatedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_SURFACE_BINDING_CREATED,
  SoulSurfaceBindingCreatedPayloadSchema
);
const SoulSurfaceBindingStateChangedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_SURFACE_BINDING_STATE_CHANGED,
  SoulSurfaceBindingStateChangedPayloadSchema
);
const SoulCrossCuttingStateChangedEventObjectSchema = createPhase2BEventObjectSchema(
  Phase2BEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
  SoulCrossCuttingStateChangedPayloadSchema
);

export const SoulSurfaceCreatedEventSchema = SoulSurfaceCreatedEventObjectSchema.readonly();
export const SoulSurfaceStatusChangedEventSchema = SoulSurfaceStatusChangedEventObjectSchema.readonly();
export const SoulSurfaceAnchorCreatedEventSchema = SoulSurfaceAnchorCreatedEventObjectSchema.readonly();
export const SoulSurfaceAnchorDeletedEventSchema = SoulSurfaceAnchorDeletedEventObjectSchema.readonly();
export const SoulSurfaceBindingCreatedEventSchema = SoulSurfaceBindingCreatedEventObjectSchema.readonly();
export const SoulSurfaceBindingStateChangedEventSchema =
  SoulSurfaceBindingStateChangedEventObjectSchema.readonly();
export const SoulCrossCuttingStateChangedEventSchema =
  SoulCrossCuttingStateChangedEventObjectSchema.readonly();

const Phase2BEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulSurfaceCreatedEventObjectSchema,
  SoulSurfaceStatusChangedEventObjectSchema,
  SoulSurfaceAnchorCreatedEventObjectSchema,
  SoulSurfaceAnchorDeletedEventObjectSchema,
  SoulSurfaceBindingCreatedEventObjectSchema,
  SoulSurfaceBindingStateChangedEventObjectSchema,
  SoulCrossCuttingStateChangedEventObjectSchema
]);

export const Phase2BEventSchema = Phase2BEventUnionSchema.readonly();

export type Phase2BEventPayloadMap = {
  [K in keyof typeof phase2BPayloadSchemas]: z.infer<(typeof phase2BPayloadSchemas)[K]>;
};

export function parsePhase2BEventPayload<T extends keyof typeof phase2BPayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): Phase2BEventPayloadMap[T] {
  const schema = phase2BPayloadSchemas[eventType];
  return schema.parse(payload) as Phase2BEventPayloadMap[T];
}

export type Phase2BEventType = z.infer<typeof Phase2BEventTypeSchema>;
export type Phase2BEvent = z.infer<typeof Phase2BEventSchema>;
