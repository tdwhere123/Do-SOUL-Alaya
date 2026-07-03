import { z } from "zod";
import {
  CandidateMemorySignalMemoryRefsSchema,
  SignalKindSchema,
  SignalSourceSchema
} from "../signals/candidate-memory-signal.js";
import {
  BoundedIdSchema,
  BoundedJsonObjectSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  BoundedString,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

const signalEventTypeValues = [
  "soul.signal.emitted",
  "soul.signal.normalized",
  "soul.signal.triaged",
  "soul.signal.materialized",
  "soul.signal.materialization_failed"
] as const;

const triageResultValues = ["accepted", "dropped", "deferred"] as const;
const SourceDeliveryIdsSchema = z.array(BoundedIdSchema).min(1).max(32).readonly();

export const SignalEventType = {
  SOUL_SIGNAL_EMITTED: "soul.signal.emitted",
  SOUL_SIGNAL_NORMALIZED: "soul.signal.normalized",
  SOUL_SIGNAL_TRIAGED: "soul.signal.triaged",
  SOUL_SIGNAL_MATERIALIZED: "soul.signal.materialized",
  SOUL_SIGNAL_MATERIALIZATION_FAILED: "soul.signal.materialization_failed"
} as const;

export const SignalEventTypeSchema = z.enum(signalEventTypeValues);

export const SoulSignalEmittedPayloadSchema = z.object({
  signal_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  source: SignalSourceSchema,
  signal_kind: SignalKindSchema,
  source_delivery_ids: SourceDeliveryIdsSchema.optional(),
  source_memory_refs: CandidateMemorySignalMemoryRefsSchema,
  supersedes_refs: CandidateMemorySignalMemoryRefsSchema,
  exception_to_refs: CandidateMemorySignalMemoryRefsSchema,
  contradicts_refs: CandidateMemorySignalMemoryRefsSchema,
  incompatible_with_refs: CandidateMemorySignalMemoryRefsSchema,
  raw_payload: BoundedJsonObjectSchema
}).strict().readonly();

export const SoulSignalNormalizedPayloadSchema = z.object({
  signal_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  normalized_fields: BoundedJsonObjectSchema
}).strict().readonly();

export const SoulSignalTriagedPayloadSchema = z.object({
  signal_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  triage_result: z.enum(triageResultValues),
  dropped_content: BoundedString(500).optional(),
  surviving_object_id: BoundedIdSchema.optional(),
  best_similarity: z.number().min(0).max(1).optional()
}).strict().readonly();

export const SoulSignalMaterializedPayloadSchema = z
  .object({
    signal_id: BoundedIdSchema,
    workspace_id: BoundedIdSchema,
    run_id: BoundedIdSchema,
    created_objects: z
      .array(
        z
          .object({
            object_kind: BoundedLabelSchema,
            object_id: BoundedIdSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    success: z.boolean(),
    error: BoundedReasonSchema.optional()
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
  event_id: BoundedIdSchema,
  entity_type: BoundedLabelSchema,
  entity_id: BoundedIdSchema,
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema.nullable(),
  caused_by: BoundedIdSchema.nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
}).strict();

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
