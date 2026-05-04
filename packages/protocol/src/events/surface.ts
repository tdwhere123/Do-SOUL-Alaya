import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { TransitionCausedBySchema } from "./memory-governance.js";
import { BindingStateSchema, SurfaceAnchorKindSchema, SurfaceStatusSchema } from "../soul/surface.js";
import { CrossCuttingStateSchema } from "../soul/cross-cutting.js";

const surfaceEventTypeValues = [
  "soul.surface.created",
  "soul.surface.status_changed",
  "soul.surface_anchor.created",
  "soul.surface_anchor.deleted",
  "soul.surface_binding.created",
  "soul.surface_binding.state_changed",
  "soul.cross_cutting.state_changed"
] as const;

export const SurfaceEventType = {
  SOUL_SURFACE_CREATED: "soul.surface.created",
  SOUL_SURFACE_STATUS_CHANGED: "soul.surface.status_changed",
  SOUL_SURFACE_ANCHOR_CREATED: "soul.surface_anchor.created",
  SOUL_SURFACE_ANCHOR_DELETED: "soul.surface_anchor.deleted",
  SOUL_SURFACE_BINDING_CREATED: "soul.surface_binding.created",
  SOUL_SURFACE_BINDING_STATE_CHANGED: "soul.surface_binding.state_changed",
  SOUL_CROSS_CUTTING_STATE_CHANGED: "soul.cross_cutting.state_changed"
} as const;

export const SurfaceEventTypeSchema = z.enum(surfaceEventTypeValues);

const SurfaceObjectPayloadObjectSchema = z.object({
  object_id: NonEmptyStringSchema,
  object_kind: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable()
});

export const SoulSurfaceCreatedPayloadSchema = SurfaceObjectPayloadObjectSchema.extend({
  surface_id: NonEmptyStringSchema,
  surface_kind: NonEmptyStringSchema,
  surface_status: SurfaceStatusSchema
}).readonly();

export const SoulSurfaceStatusChangedPayloadSchema = SurfaceObjectPayloadObjectSchema.extend({
  surface_id: NonEmptyStringSchema,
  from_status: SurfaceStatusSchema,
  to_status: SurfaceStatusSchema,
  reason_code: NonEmptyStringSchema,
  caused_by: TransitionCausedBySchema,
  occurred_at: IsoDatetimeStringSchema
}).readonly();

export const SoulSurfaceAnchorCreatedPayloadSchema = SurfaceObjectPayloadObjectSchema.extend({
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

export const SoulSurfaceBindingCreatedPayloadSchema = SurfaceObjectPayloadObjectSchema.extend({
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

const surfacePayloadSchemas = {
  [SurfaceEventType.SOUL_SURFACE_CREATED]: SoulSurfaceCreatedPayloadSchema,
  [SurfaceEventType.SOUL_SURFACE_STATUS_CHANGED]: SoulSurfaceStatusChangedPayloadSchema,
  [SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED]: SoulSurfaceAnchorCreatedPayloadSchema,
  [SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED]: SoulSurfaceAnchorDeletedPayloadSchema,
  [SurfaceEventType.SOUL_SURFACE_BINDING_CREATED]: SoulSurfaceBindingCreatedPayloadSchema,
  [SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED]: SoulSurfaceBindingStateChangedPayloadSchema,
  [SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED]: SoulCrossCuttingStateChangedPayloadSchema
} as const;

const SurfaceEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const SurfaceEventBaseSchema = SurfaceEventBaseObjectSchema.readonly();

export function createSurfaceEventObjectSchema<T extends keyof typeof surfacePayloadSchemas>(
  eventType: T,
  payloadSchema: (typeof surfacePayloadSchemas)[T]
) {
  return SurfaceEventBaseObjectSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const SoulSurfaceCreatedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_SURFACE_CREATED,
  SoulSurfaceCreatedPayloadSchema
);
const SoulSurfaceStatusChangedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_SURFACE_STATUS_CHANGED,
  SoulSurfaceStatusChangedPayloadSchema
);
const SoulSurfaceAnchorCreatedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED,
  SoulSurfaceAnchorCreatedPayloadSchema
);
const SoulSurfaceAnchorDeletedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED,
  SoulSurfaceAnchorDeletedPayloadSchema
);
const SoulSurfaceBindingCreatedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_SURFACE_BINDING_CREATED,
  SoulSurfaceBindingCreatedPayloadSchema
);
const SoulSurfaceBindingStateChangedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED,
  SoulSurfaceBindingStateChangedPayloadSchema
);
const SoulCrossCuttingStateChangedEventObjectSchema = createSurfaceEventObjectSchema(
  SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
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

const SurfaceEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulSurfaceCreatedEventObjectSchema,
  SoulSurfaceStatusChangedEventObjectSchema,
  SoulSurfaceAnchorCreatedEventObjectSchema,
  SoulSurfaceAnchorDeletedEventObjectSchema,
  SoulSurfaceBindingCreatedEventObjectSchema,
  SoulSurfaceBindingStateChangedEventObjectSchema,
  SoulCrossCuttingStateChangedEventObjectSchema
]);

export const SurfaceEventSchema = SurfaceEventUnionSchema.readonly();

export type SurfaceEventPayloadMap = {
  [K in keyof typeof surfacePayloadSchemas]: z.infer<(typeof surfacePayloadSchemas)[K]>;
};

export function parseSurfaceEventPayload<T extends keyof typeof surfacePayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): SurfaceEventPayloadMap[T] {
  const schema = surfacePayloadSchemas[eventType];
  return schema.parse(payload) as SurfaceEventPayloadMap[T];
}

export type SurfaceEventType = z.infer<typeof SurfaceEventTypeSchema>;
export type SurfaceEvent = z.infer<typeof SurfaceEventSchema>;
