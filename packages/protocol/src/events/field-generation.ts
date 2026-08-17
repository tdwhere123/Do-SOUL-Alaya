import { z } from "zod";
import {
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteNumberSchema
} from "../shared/schema-primitives.js";
import { FieldContractDigestSchema } from "../soul/field-contract/canonical-identity.js";
import { ProjectionEraseSubjectKindSchema } from "../soul/field-contract/projection-generation.js";
import { EffectDecisionSchema } from "../soul/field-contract/proof-effect.js";

const fieldGenerationEventTypeValues = [
  "soul.field.source_record.admitted",
  "soul.field.generation.rebuild_started",
  "soul.field.generation.activated",
  "soul.field.erase.barrier",
  "soul.field.effect.decided",
  "soul.field.usage.causal_recorded"
] as const;

export const FieldGenerationEventType = {
  SOUL_FIELD_SOURCE_RECORD_ADMITTED: "soul.field.source_record.admitted",
  SOUL_FIELD_GENERATION_REBUILD_STARTED: "soul.field.generation.rebuild_started",
  SOUL_FIELD_GENERATION_ACTIVATED: "soul.field.generation.activated",
  SOUL_FIELD_ERASE_BARRIER: "soul.field.erase.barrier",
  SOUL_FIELD_EFFECT_DECIDED: "soul.field.effect.decided",
  SOUL_FIELD_USAGE_CAUSAL_RECORDED: "soul.field.usage.causal_recorded"
} as const;

export const FieldGenerationEventTypeSchema = z.enum(fieldGenerationEventTypeValues);

export const SoulFieldSourceRecordAdmittedPayloadSchema = z.object({
  workspace_id: BoundedIdSchema,
  record_id: FieldContractDigestSchema,
  source_id: NonEmptyStringSchema.max(256),
  source_version: NonEmptyStringSchema.max(128),
  content_digest: FieldContractDigestSchema,
  evidence_object_id: BoundedIdSchema.nullable(),
  recorded_at: IsoDatetimeStringSchema,
  event_time: IsoDatetimeStringSchema.nullable(),
  valid_from: IsoDatetimeStringSchema.nullable(),
  valid_to: IsoDatetimeStringSchema.nullable(),
  operator_id: NonEmptyStringSchema.max(128)
}).strict().superRefine((payload, context) => {
  if (payload.valid_from === null && payload.valid_to !== null) {
    context.addIssue({ code: "custom", message: "valid_to requires valid_from" });
  }
  if (payload.valid_from !== null && payload.valid_to !== null &&
      payload.valid_to <= payload.valid_from) {
    context.addIssue({ code: "custom", message: "valid interval must be half-open" });
  }
}).readonly();

export const SoulFieldGenerationRebuildStartedPayloadSchema = z.object({
  workspace_id: BoundedIdSchema,
  generation_id: FieldContractDigestSchema,
  operator_manifest_digest: FieldContractDigestSchema,
  schema_version: NonEmptyStringSchema.max(32),
  input_event_frontier: NonEmptyStringSchema.max(256),
  governance_frontier: NonEmptyStringSchema.max(256),
  occurred_at: IsoDatetimeStringSchema
}).strict().readonly();

export const SoulFieldGenerationActivatedPayloadSchema = z.object({
  workspace_id: BoundedIdSchema,
  generation_id: FieldContractDigestSchema,
  previous_generation_id: FieldContractDigestSchema.nullable(),
  activated_at: IsoDatetimeStringSchema
}).strict().readonly();

export const SoulFieldEraseBarrierPayloadSchema = z.object({
  workspace_id: BoundedIdSchema,
  receipt_identity: FieldContractDigestSchema,
  barrier_id: BoundedIdSchema,
  generation_id: FieldContractDigestSchema.nullable(),
  subject_kind: ProjectionEraseSubjectKindSchema,
  subject_id: NonEmptyStringSchema.max(256),
  erased_at: IsoDatetimeStringSchema
}).strict().readonly();

export const SoulFieldEffectDecidedPayloadSchema = z.object({
  workspace_id: BoundedIdSchema,
  request_digest: FieldContractDigestSchema,
  action: NonEmptyStringSchema.max(128),
  target: NonEmptyStringSchema.max(256),
  scope: NonEmptyStringSchema.max(256),
  effective_as_of: IsoDatetimeStringSchema,
  decision: EffectDecisionSchema,
  occurred_at: IsoDatetimeStringSchema
}).strict().readonly();

export const SoulFieldUsageCausalRecordedPayloadSchema = z.object({
  workspace_id: BoundedIdSchema,
  identity: FieldContractDigestSchema,
  causal_key: NonEmptyStringSchema.max(256),
  occurred_at: IsoDatetimeStringSchema,
  downstream_ref: NonEmptyStringSchema.max(256),
  weight: NonNegativeFiniteNumberSchema,
  scope: NonEmptyStringSchema.max(256),
  usage_kind: z.literal("causal"),
  operator_id: NonEmptyStringSchema.max(128)
}).strict().readonly();

export const fieldGenerationPayloadSchemas = {
  [FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED]:
    SoulFieldSourceRecordAdmittedPayloadSchema,
  [FieldGenerationEventType.SOUL_FIELD_GENERATION_REBUILD_STARTED]:
    SoulFieldGenerationRebuildStartedPayloadSchema,
  [FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED]:
    SoulFieldGenerationActivatedPayloadSchema,
  [FieldGenerationEventType.SOUL_FIELD_ERASE_BARRIER]: SoulFieldEraseBarrierPayloadSchema,
  [FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED]: SoulFieldEffectDecidedPayloadSchema,
  [FieldGenerationEventType.SOUL_FIELD_USAGE_CAUSAL_RECORDED]:
    SoulFieldUsageCausalRecordedPayloadSchema
} as const;

export type FieldGenerationEventPayloadMap = {
  [K in keyof typeof fieldGenerationPayloadSchemas]:
    z.infer<(typeof fieldGenerationPayloadSchemas)[K]>;
};

export function parseFieldGenerationEventPayload<
  T extends keyof typeof fieldGenerationPayloadSchemas
>(
  type: T,
  payload: Record<string, unknown>
): FieldGenerationEventPayloadMap[T] {
  const schema = fieldGenerationPayloadSchemas[type];
  return schema.parse(payload) as FieldGenerationEventPayloadMap[T];
}

export type FieldGenerationEventType = z.infer<typeof FieldGenerationEventTypeSchema>;
export type SoulFieldSourceRecordAdmittedPayload =
  z.infer<typeof SoulFieldSourceRecordAdmittedPayloadSchema>;
export type SoulFieldGenerationRebuildStartedPayload =
  z.infer<typeof SoulFieldGenerationRebuildStartedPayloadSchema>;
export type SoulFieldGenerationActivatedPayload =
  z.infer<typeof SoulFieldGenerationActivatedPayloadSchema>;
export type SoulFieldEraseBarrierPayload = z.infer<typeof SoulFieldEraseBarrierPayloadSchema>;
export type SoulFieldEffectDecidedPayload = z.infer<typeof SoulFieldEffectDecidedPayloadSchema>;
export type SoulFieldUsageCausalRecordedPayload =
  z.infer<typeof SoulFieldUsageCausalRecordedPayloadSchema>;
