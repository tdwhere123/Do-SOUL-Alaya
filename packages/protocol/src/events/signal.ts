import { z } from "zod";
import { SignalKindSchema, SignalSourceSchema } from "../candidate-memory-signal.js";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const signalEventTypeValues = [
  "soul.signal.emitted",
  "soul.signal.normalized",
  "soul.signal.triaged",
  "soul.signal.materialized",
  "soul.signal.materialization_failed"
] as const;

const triageResultValues = ["accepted", "dropped", "deferred"] as const;

export const SignalEventType = {
  SOUL_SIGNAL_EMITTED: "soul.signal.emitted",
  SOUL_SIGNAL_NORMALIZED: "soul.signal.normalized",
  SOUL_SIGNAL_TRIAGED: "soul.signal.triaged",
  SOUL_SIGNAL_MATERIALIZED: "soul.signal.materialized",
  SOUL_SIGNAL_MATERIALIZATION_FAILED: "soul.signal.materialization_failed"
} as const;

export const SignalEventTypeSchema = z.enum(signalEventTypeValues);

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

const signalPayloadSchemas = {
  [SignalEventType.SOUL_SIGNAL_EMITTED]: SoulSignalEmittedPayloadSchema,
  [SignalEventType.SOUL_SIGNAL_NORMALIZED]: SoulSignalNormalizedPayloadSchema,
  [SignalEventType.SOUL_SIGNAL_TRIAGED]: SoulSignalTriagedPayloadSchema,
  [SignalEventType.SOUL_SIGNAL_MATERIALIZED]: SoulSignalMaterializedPayloadSchema,
  [SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED]: SoulSignalMaterializedPayloadSchema
} as const;

const SignalEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const SignalEventBaseSchema = SignalEventBaseObjectSchema.readonly();

const SoulSignalEmittedEventObjectSchema = SignalEventBaseObjectSchema.extend({
  event_type: z.literal(SignalEventType.SOUL_SIGNAL_EMITTED),
  payload: SoulSignalEmittedPayloadSchema
});

const SoulSignalNormalizedEventObjectSchema = SignalEventBaseObjectSchema.extend({
  event_type: z.literal(SignalEventType.SOUL_SIGNAL_NORMALIZED),
  payload: SoulSignalNormalizedPayloadSchema
});

const SoulSignalTriagedEventObjectSchema = SignalEventBaseObjectSchema.extend({
  event_type: z.literal(SignalEventType.SOUL_SIGNAL_TRIAGED),
  payload: SoulSignalTriagedPayloadSchema
});

const SoulSignalMaterializedEventObjectSchema = SignalEventBaseObjectSchema.extend({
  event_type: z.literal(SignalEventType.SOUL_SIGNAL_MATERIALIZED),
  payload: SoulSignalMaterializedPayloadSchema
});

const SoulSignalMaterializationFailedEventObjectSchema = SignalEventBaseObjectSchema.extend({
  event_type: z.literal(SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED),
  payload: SoulSignalMaterializedPayloadSchema
});

export const SoulSignalEmittedEventSchema = SoulSignalEmittedEventObjectSchema.readonly();
export const SoulSignalNormalizedEventSchema = SoulSignalNormalizedEventObjectSchema.readonly();
export const SoulSignalTriagedEventSchema = SoulSignalTriagedEventObjectSchema.readonly();
export const SoulSignalMaterializedEventSchema = SoulSignalMaterializedEventObjectSchema.readonly();
export const SoulSignalMaterializationFailedEventSchema = SoulSignalMaterializationFailedEventObjectSchema.readonly();

const SignalEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulSignalEmittedEventObjectSchema,
  SoulSignalNormalizedEventObjectSchema,
  SoulSignalTriagedEventObjectSchema,
  SoulSignalMaterializedEventObjectSchema,
  SoulSignalMaterializationFailedEventObjectSchema
]);

export const SignalEventSchema = SignalEventUnionSchema.readonly();

export type SignalEventPayloadMap = {
  [K in keyof typeof signalPayloadSchemas]: z.infer<(typeof signalPayloadSchemas)[K]>;
};

export function parseSignalEventPayload<T extends keyof typeof signalPayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): SignalEventPayloadMap[T] {
  const schema = signalPayloadSchemas[eventType];
  return schema.parse(payload) as SignalEventPayloadMap[T];
}

export type SignalEventType = z.infer<typeof SignalEventTypeSchema>;
export type SignalEvent = z.infer<typeof SignalEventSchema>;
