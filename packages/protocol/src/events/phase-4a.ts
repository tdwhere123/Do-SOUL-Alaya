import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { GardenRoleSchema, GardenTaskKindSchema, GardenTierSchema } from "../soul/garden-tier.js";
import { HealthEventKindSchema } from "../soul/health-journal.js";

const phase4AEventTypeValues = [
  "soul.garden.task_dispatched",
  "soul.garden.task_completed",
  "soul.garden.tier_violation_rejected",
  "soul.health_journal.recorded"
] as const;

export const Phase4AEventType = {
  SOUL_GARDEN_TASK_DISPATCHED: "soul.garden.task_dispatched",
  SOUL_GARDEN_TASK_COMPLETED: "soul.garden.task_completed",
  SOUL_GARDEN_TIER_VIOLATION_REJECTED: "soul.garden.tier_violation_rejected",
  SOUL_HEALTH_JOURNAL_RECORDED: "soul.health_journal.recorded"
} as const;

export const Phase4AEventTypeSchema = z.enum(phase4AEventTypeValues);

export const SoulGardenTaskDispatchedPayloadSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    role: GardenRoleSchema,
    tier: GardenTierSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGardenTaskCompletedPayloadSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    role: GardenRoleSchema,
    tier: GardenTierSchema,
    success: z.boolean(),
    objects_affected: z.array(NonEmptyStringSchema).readonly(),
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGardenTierViolationRejectedPayloadSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    required_tier: GardenTierSchema,
    role_tier: GardenTierSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulHealthJournalRecordedPayloadSchema = z
  .object({
    entry_id: NonEmptyStringSchema,
    event_kind: HealthEventKindSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema,
    change_summary: z
      .object({
        fields_changed: z.array(NonEmptyStringSchema).readonly(),
        secret_ref_kind: z.enum(["env", "file"]).nullable().optional()
      })
      .readonly()
      .optional()
  })
  .readonly();

const phase4APayloadSchemas = {
  [Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED]: SoulGardenTaskDispatchedPayloadSchema,
  [Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED]: SoulGardenTaskCompletedPayloadSchema,
  [Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED]: SoulGardenTierViolationRejectedPayloadSchema,
  [Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED]: SoulHealthJournalRecordedPayloadSchema
} as const;

export function createPhase4AEventObjectSchema<T extends keyof typeof phase4APayloadSchemas>(
  type: T,
  payloadSchema: (typeof phase4APayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulGardenTaskDispatchedEventObjectSchema = createPhase4AEventObjectSchema(
  Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED,
  SoulGardenTaskDispatchedPayloadSchema
);
const SoulGardenTaskCompletedEventObjectSchema = createPhase4AEventObjectSchema(
  Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED,
  SoulGardenTaskCompletedPayloadSchema
);
const SoulGardenTierViolationRejectedEventObjectSchema = createPhase4AEventObjectSchema(
  Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
  SoulGardenTierViolationRejectedPayloadSchema
);
const SoulHealthJournalRecordedEventObjectSchema = createPhase4AEventObjectSchema(
  Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
  SoulHealthJournalRecordedPayloadSchema
);

export const SoulGardenTaskDispatchedEventSchema = SoulGardenTaskDispatchedEventObjectSchema.readonly();
export const SoulGardenTaskCompletedEventSchema = SoulGardenTaskCompletedEventObjectSchema.readonly();
export const SoulGardenTierViolationRejectedEventSchema = SoulGardenTierViolationRejectedEventObjectSchema.readonly();
export const SoulHealthJournalRecordedEventSchema = SoulHealthJournalRecordedEventObjectSchema.readonly();

export const Phase4AEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulGardenTaskDispatchedEventObjectSchema,
    SoulGardenTaskCompletedEventObjectSchema,
    SoulGardenTierViolationRejectedEventObjectSchema,
    SoulHealthJournalRecordedEventObjectSchema
  ])
  .readonly();

export type Phase4AEventPayloadMap = {
  [K in keyof typeof phase4APayloadSchemas]: z.infer<(typeof phase4APayloadSchemas)[K]>;
};

export function parsePhase4AEventPayload<T extends keyof typeof phase4APayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): Phase4AEventPayloadMap[T] {
  const schema = phase4APayloadSchemas[type];
  return schema.parse(payload) as Phase4AEventPayloadMap[T];
}

export type Phase4AEventTypeValue = z.infer<typeof Phase4AEventTypeSchema>;
export type Phase4AEvent = z.infer<typeof Phase4AEventUnionSchema>;
