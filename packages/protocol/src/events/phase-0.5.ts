import { z } from "zod";
import { SignalKindSchema, SignalSourceSchema } from "../candidate-memory-signal.js";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const phase05EventTypeValues = [
  "soul.signal.emitted",
  "soul.signal.normalized",
  "soul.signal.triaged",
  "soul.signal.materialized",
  "soul.signal.materialization_failed"
] as const;

const triageResultValues = ["accepted", "dropped", "deferred"] as const;

export const Phase05EventType = {
  SOUL_SIGNAL_EMITTED: "soul.signal.emitted",
  SOUL_SIGNAL_NORMALIZED: "soul.signal.normalized",
  SOUL_SIGNAL_TRIAGED: "soul.signal.triaged",
  SOUL_SIGNAL_MATERIALIZED: "soul.signal.materialized",
  SOUL_SIGNAL_MATERIALIZATION_FAILED: "soul.signal.materialization_failed"
} as const;

export const Phase05EventTypeSchema = z.enum(phase05EventTypeValues);

export const SoulSignalEmittedPayloadSchema = z.object({
  signal_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema,
  source: SignalSourceSchema,
  signal_kind: SignalKindSchema,
  raw_payload: z.record(z.unknown()).readonly()
}).readonly();

export const SoulSignalNormalizedPayloadSchema = z.object({
  signal_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema,
  normalized_fields: z.record(z.unknown()).readonly()
}).readonly();

export const SoulSignalTriagedPayloadSchema = z.object({
  signal_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema,
  triage_result: z.enum(triageResultValues)
}).readonly();

export const SoulSignalMaterializedPayloadSchema = z
  .object({
    signal_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    created_objects: z
      .array(
        z
          .object({
            object_kind: NonEmptyStringSchema,
            object_id: NonEmptyStringSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    success: z.boolean(),
    error: z.string().optional()
  })
  .strict()
  .readonly();

const phase05PayloadSchemas = {
  [Phase05EventType.SOUL_SIGNAL_EMITTED]: SoulSignalEmittedPayloadSchema,
  [Phase05EventType.SOUL_SIGNAL_NORMALIZED]: SoulSignalNormalizedPayloadSchema,
  [Phase05EventType.SOUL_SIGNAL_TRIAGED]: SoulSignalTriagedPayloadSchema,
  [Phase05EventType.SOUL_SIGNAL_MATERIALIZED]: SoulSignalMaterializedPayloadSchema,
  [Phase05EventType.SOUL_SIGNAL_MATERIALIZATION_FAILED]: SoulSignalMaterializedPayloadSchema
} as const;

const Phase05EventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const Phase05EventBaseSchema = Phase05EventBaseObjectSchema.readonly();

const SoulSignalEmittedEventObjectSchema = Phase05EventBaseObjectSchema.extend({
  event_type: z.literal(Phase05EventType.SOUL_SIGNAL_EMITTED),
  payload: SoulSignalEmittedPayloadSchema
});

const SoulSignalNormalizedEventObjectSchema = Phase05EventBaseObjectSchema.extend({
  event_type: z.literal(Phase05EventType.SOUL_SIGNAL_NORMALIZED),
  payload: SoulSignalNormalizedPayloadSchema
});

const SoulSignalTriagedEventObjectSchema = Phase05EventBaseObjectSchema.extend({
  event_type: z.literal(Phase05EventType.SOUL_SIGNAL_TRIAGED),
  payload: SoulSignalTriagedPayloadSchema
});

const SoulSignalMaterializedEventObjectSchema = Phase05EventBaseObjectSchema.extend({
  event_type: z.literal(Phase05EventType.SOUL_SIGNAL_MATERIALIZED),
  payload: SoulSignalMaterializedPayloadSchema
});

const SoulSignalMaterializationFailedEventObjectSchema = Phase05EventBaseObjectSchema.extend({
  event_type: z.literal(Phase05EventType.SOUL_SIGNAL_MATERIALIZATION_FAILED),
  payload: SoulSignalMaterializedPayloadSchema
});

export const SoulSignalEmittedEventSchema = SoulSignalEmittedEventObjectSchema.readonly();
export const SoulSignalNormalizedEventSchema = SoulSignalNormalizedEventObjectSchema.readonly();
export const SoulSignalTriagedEventSchema = SoulSignalTriagedEventObjectSchema.readonly();
export const SoulSignalMaterializedEventSchema = SoulSignalMaterializedEventObjectSchema.readonly();
export const SoulSignalMaterializationFailedEventSchema = SoulSignalMaterializationFailedEventObjectSchema.readonly();

const Phase05EventUnionSchema = z.discriminatedUnion("event_type", [
  SoulSignalEmittedEventObjectSchema,
  SoulSignalNormalizedEventObjectSchema,
  SoulSignalTriagedEventObjectSchema,
  SoulSignalMaterializedEventObjectSchema,
  SoulSignalMaterializationFailedEventObjectSchema
]);

export const Phase05EventSchema = Phase05EventUnionSchema.readonly();

export type Phase05EventPayloadMap = {
  [K in keyof typeof phase05PayloadSchemas]: z.infer<(typeof phase05PayloadSchemas)[K]>;
};

export function parsePhase05EventPayload<T extends keyof typeof phase05PayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): Phase05EventPayloadMap[T] {
  const schema = phase05PayloadSchemas[eventType];
  return schema.parse(payload) as Phase05EventPayloadMap[T];
}

export type Phase05EventType = z.infer<typeof Phase05EventTypeSchema>;
export type Phase05Event = z.infer<typeof Phase05EventSchema>;
