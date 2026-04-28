import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema, IsoDatetimeStringSchema } from "../schema-primitives.js";
import { ClaimKindSchema } from "../soul/claim-form.js";
import { ConflictEdgeTypeSchema } from "../soul/conflict-matrix.js";
import { GovernanceSubjectSchema } from "../soul/governance-subject.js";
import { ScopeClassSchema } from "../soul/object-kind.js";
import { TransitionCausedBySchema } from "./phase-1b.js";

const phase2AEventTypeValues = [
  "soul.slot.created",
  "soul.slot.winner_changed",
  "soul.conflict_matrix_edge.created"
] as const;

export const Phase2AEventType = {
  SOUL_SLOT_CREATED: "soul.slot.created",
  SOUL_SLOT_WINNER_CHANGED: "soul.slot.winner_changed",
  SOUL_CONFLICT_MATRIX_EDGE_CREATED: "soul.conflict_matrix_edge.created"
} as const;

export const Phase2AEventTypeSchema = z.enum(phase2AEventTypeValues);

const Phase2AObjectPayloadObjectSchema = z.object({
  object_id: NonEmptyStringSchema,
  object_kind: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable()
});

export const SoulSlotCreatedPayloadSchema = Phase2AObjectPayloadObjectSchema.extend({
  governance_subject: GovernanceSubjectSchema,
  claim_kind: ClaimKindSchema,
  scope_class: ScopeClassSchema,
  winner_claim_id: NonEmptyStringSchema.nullable()
}).readonly();

export const SoulSlotWinnerChangedPayloadSchema = Phase2AObjectPayloadObjectSchema.extend({
  from_claim_id: NonEmptyStringSchema.nullable(),
  to_claim_id: NonEmptyStringSchema.nullable(),
  reason_code: NonEmptyStringSchema,
  caused_by: TransitionCausedBySchema,
  evidence_refs: z.array(NonEmptyStringSchema).readonly().nullable(),
  occurred_at: IsoDatetimeStringSchema
}).readonly();

export const SoulConflictMatrixEdgeCreatedPayloadSchema = Phase2AObjectPayloadObjectSchema.extend({
  source_claim_id: NonEmptyStringSchema,
  target_claim_id: NonEmptyStringSchema,
  edge_type: ConflictEdgeTypeSchema
}).readonly();

const phase2APayloadSchemas = {
  [Phase2AEventType.SOUL_SLOT_CREATED]: SoulSlotCreatedPayloadSchema,
  [Phase2AEventType.SOUL_SLOT_WINNER_CHANGED]: SoulSlotWinnerChangedPayloadSchema,
  [Phase2AEventType.SOUL_CONFLICT_MATRIX_EDGE_CREATED]: SoulConflictMatrixEdgeCreatedPayloadSchema
} as const;

const Phase2AEventBaseObjectSchema = z.object({
  event_id: NonEmptyStringSchema,
  entity_type: z.string(),
  entity_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  caused_by: z.string().nullable(),
  revision: NonNegativeIntSchema,
  created_at: IsoDatetimeStringSchema
});

export const Phase2AEventBaseSchema = Phase2AEventBaseObjectSchema.readonly();

function createPhase2AEventObjectSchema<T extends keyof typeof phase2APayloadSchemas>(
  eventType: T,
  payloadSchema: (typeof phase2APayloadSchemas)[T]
) {
  return Phase2AEventBaseObjectSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const SoulSlotCreatedEventObjectSchema = createPhase2AEventObjectSchema(
  Phase2AEventType.SOUL_SLOT_CREATED,
  SoulSlotCreatedPayloadSchema
);
const SoulSlotWinnerChangedEventObjectSchema = createPhase2AEventObjectSchema(
  Phase2AEventType.SOUL_SLOT_WINNER_CHANGED,
  SoulSlotWinnerChangedPayloadSchema
);
const SoulConflictMatrixEdgeCreatedEventObjectSchema = createPhase2AEventObjectSchema(
  Phase2AEventType.SOUL_CONFLICT_MATRIX_EDGE_CREATED,
  SoulConflictMatrixEdgeCreatedPayloadSchema
);

export const SoulSlotCreatedEventSchema = SoulSlotCreatedEventObjectSchema.readonly();
export const SoulSlotWinnerChangedEventSchema = SoulSlotWinnerChangedEventObjectSchema.readonly();
export const SoulConflictMatrixEdgeCreatedEventSchema =
  SoulConflictMatrixEdgeCreatedEventObjectSchema.readonly();

const Phase2AEventUnionSchema = z.discriminatedUnion("event_type", [
  SoulSlotCreatedEventObjectSchema,
  SoulSlotWinnerChangedEventObjectSchema,
  SoulConflictMatrixEdgeCreatedEventObjectSchema
]);

export const Phase2AEventSchema = Phase2AEventUnionSchema.readonly();

export type Phase2AEventPayloadMap = {
  [K in keyof typeof phase2APayloadSchemas]: z.infer<(typeof phase2APayloadSchemas)[K]>;
};

export function parsePhase2AEventPayload<T extends keyof typeof phase2APayloadSchemas>(
  eventType: T,
  payload: Record<string, unknown>
): Phase2AEventPayloadMap[T] {
  const schema = phase2APayloadSchemas[eventType];
  return schema.parse(payload) as Phase2AEventPayloadMap[T];
}

export type Phase2AEventType = z.infer<typeof Phase2AEventTypeSchema>;
export type Phase2AEvent = z.infer<typeof Phase2AEventSchema>;
