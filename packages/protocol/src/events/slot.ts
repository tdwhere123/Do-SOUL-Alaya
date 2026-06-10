import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema, IsoDatetimeStringSchema } from "../shared/schema-primitives.js";
import { ClaimKindSchema } from "../soul/claim-form.js";
import { ConflictEdgeTypeSchema } from "../soul/conflict-matrix.js";
import { GovernanceSubjectSchema } from "../soul/governance-subject.js";
import { ScopeClassSchema } from "../soul/object-kind.js";
import { TransitionCausedBySchema } from "./memory-governance.js";

const slotEventTypeValues = [
  "soul.slot.created",
  "soul.slot.winner_changed",
  "soul.conflict_matrix_edge.created"
] as const;

export const SlotEventType = {
  SOUL_SLOT_CREATED: "soul.slot.created",
  SOUL_SLOT_WINNER_CHANGED: "soul.slot.winner_changed",
  SOUL_CONFLICT_MATRIX_EDGE_CREATED: "soul.conflict_matrix_edge.created"
} as const;

export const SlotEventTypeSchema = z.enum(slotEventTypeValues);

const SlotObjectPayloadObjectSchema = z.object({
  object_id: NonEmptyStringSchema,
  object_kind: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable()
});

export const SoulSlotCreatedPayloadSchema = SlotObjectPayloadObjectSchema.extend({
  governance_subject: GovernanceSubjectSchema,
  claim_kind: ClaimKindSchema,
  scope_class: ScopeClassSchema,
  winner_claim_id: NonEmptyStringSchema.nullable()
}).readonly();

export const SoulSlotWinnerChangedPayloadSchema = SlotObjectPayloadObjectSchema.extend({
  from_claim_id: NonEmptyStringSchema.nullable(),
  to_claim_id: NonEmptyStringSchema.nullable(),
  reason_code: NonEmptyStringSchema,
  caused_by: TransitionCausedBySchema,
  evidence_refs: z.array(NonEmptyStringSchema).readonly().nullable(),
  occurred_at: IsoDatetimeStringSchema
}).readonly();

export const SoulConflictMatrixEdgeCreatedPayloadSchema = SlotObjectPayloadObjectSchema.extend({
  source_claim_id: NonEmptyStringSchema,
  target_claim_id: NonEmptyStringSchema,
  edge_type: ConflictEdgeTypeSchema
}).readonly();

const slotPayloadSchemas = {
  [SlotEventType.SOUL_SLOT_CREATED]: SoulSlotCreatedPayloadSchema,
  [SlotEventType.SOUL_SLOT_WINNER_CHANGED]: SoulSlotWinnerChangedPayloadSchema,
  [SlotEventType.SOUL_CONFLICT_MATRIX_EDGE_CREATED]: SoulConflictMatrixEdgeCreatedPayloadSchema
} as const;

const SlotEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const SlotEventBaseSchema = SlotEventBaseObjectSchema.readonly();

function createSlotEventObjectSchema<T extends keyof typeof slotPayloadSchemas>(
  eventType: T,
  payloadSchema: (typeof slotPayloadSchemas)[T]
) {
  return SlotEventBaseObjectSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const SoulSlotCreatedEventObjectSchema = createSlotEventObjectSchema(
  SlotEventType.SOUL_SLOT_CREATED,
  SoulSlotCreatedPayloadSchema
);
const SoulSlotWinnerChangedEventObjectSchema = createSlotEventObjectSchema(
  SlotEventType.SOUL_SLOT_WINNER_CHANGED,
  SoulSlotWinnerChangedPayloadSchema
);
const SoulConflictMatrixEdgeCreatedEventObjectSchema = createSlotEventObjectSchema(
  SlotEventType.SOUL_CONFLICT_MATRIX_EDGE_CREATED,
  SoulConflictMatrixEdgeCreatedPayloadSchema
);

export const SoulSlotCreatedEventSchema = SoulSlotCreatedEventObjectSchema.readonly();
export const SoulSlotWinnerChangedEventSchema = SoulSlotWinnerChangedEventObjectSchema.readonly();
export const SoulConflictMatrixEdgeCreatedEventSchema =
  SoulConflictMatrixEdgeCreatedEventObjectSchema.readonly();

const SlotEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulSlotCreatedEventObjectSchema,
  SoulSlotWinnerChangedEventObjectSchema,
  SoulConflictMatrixEdgeCreatedEventObjectSchema
]);

export const SlotEventSchema = SlotEventUnionSchema.readonly();

export type SlotEventPayloadMap = {
  [K in keyof typeof slotPayloadSchemas]: z.infer<(typeof slotPayloadSchemas)[K]>;
};

export function parseSlotEventPayload<T extends keyof typeof slotPayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): SlotEventPayloadMap[T] {
  const schema = slotPayloadSchemas[eventType];
  return schema.parse(payload) as SlotEventPayloadMap[T];
}

export type SlotEventType = z.infer<typeof SlotEventTypeSchema>;
export type SlotEvent = z.infer<typeof SlotEventSchema>;
