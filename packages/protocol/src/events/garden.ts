import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { GardenRoleSchema, GardenTaskKindSchema, GardenTierSchema } from "../soul/garden-tier.js";
import { HealthEventKindSchema } from "../soul/health-journal.js";

const gardenEventTypeValues = [
  "soul.garden.task_dispatched",
  "soul.garden.task_completed",
  "soul.garden.tier_violation_rejected",
  "soul.health_journal.recorded"
] as const;

export const GardenEventType = {
  SOUL_GARDEN_TASK_DISPATCHED: "soul.garden.task_dispatched",
  SOUL_GARDEN_TASK_COMPLETED: "soul.garden.task_completed",
  SOUL_GARDEN_TIER_VIOLATION_REJECTED: "soul.garden.tier_violation_rejected",
  SOUL_HEALTH_JOURNAL_RECORDED: "soul.health_journal.recorded"
} as const;

export const GardenEventTypeSchema = z.enum(gardenEventTypeValues);

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
    candidate_signals_count: NonNegativeIntSchema.optional(),
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

const gardenPayloadSchemas = {
  [GardenEventType.SOUL_GARDEN_TASK_DISPATCHED]: SoulGardenTaskDispatchedPayloadSchema,
  [GardenEventType.SOUL_GARDEN_TASK_COMPLETED]: SoulGardenTaskCompletedPayloadSchema,
  [GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED]: SoulGardenTierViolationRejectedPayloadSchema,
  [GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED]: SoulHealthJournalRecordedPayloadSchema
} as const;

export function createGardenEventObjectSchema<T extends keyof typeof gardenPayloadSchemas>(
  type: T,
  payloadSchema: (typeof gardenPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulGardenTaskDispatchedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
  SoulGardenTaskDispatchedPayloadSchema
);
const SoulGardenTaskCompletedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
  SoulGardenTaskCompletedPayloadSchema
);
const SoulGardenTierViolationRejectedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
  SoulGardenTierViolationRejectedPayloadSchema
);
const SoulHealthJournalRecordedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
  SoulHealthJournalRecordedPayloadSchema
);

export const SoulGardenTaskDispatchedEventSchema = SoulGardenTaskDispatchedEventObjectSchema.readonly();
export const SoulGardenTaskCompletedEventSchema = SoulGardenTaskCompletedEventObjectSchema.readonly();
export const SoulGardenTierViolationRejectedEventSchema = SoulGardenTierViolationRejectedEventObjectSchema.readonly();
export const SoulHealthJournalRecordedEventSchema = SoulHealthJournalRecordedEventObjectSchema.readonly();

export const GardenEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulGardenTaskDispatchedEventObjectSchema,
    SoulGardenTaskCompletedEventObjectSchema,
    SoulGardenTierViolationRejectedEventObjectSchema,
    SoulHealthJournalRecordedEventObjectSchema
  ])
  .readonly();

export type GardenEventPayloadMap = {
  [K in keyof typeof gardenPayloadSchemas]: z.infer<(typeof gardenPayloadSchemas)[K]>;
};

export function parseGardenEventPayload<T extends keyof typeof gardenPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): GardenEventPayloadMap[T] {
  const schema = gardenPayloadSchemas[type];
  return schema.parse(payload) as GardenEventPayloadMap[T];
}

export type GardenEventTypeValue = z.infer<typeof GardenEventTypeSchema>;
export type GardenEvent = z.infer<typeof GardenEventUnionSchema>;
