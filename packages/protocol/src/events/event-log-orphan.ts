import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

export const SoulGardenEventLogOrphanDetectedEventType = {
  SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED: "soul.garden.event_log_orphan_detected"
} as const;

export const SoulGardenEventLogOrphanDetectedEventTypeSchema = z.enum([
  SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED
]);

export const EventLogOrphanExpectedTableSchema = z.enum([
  "trust_context_delivery",
  "trust_usage_proof"
]);

export const SoulGardenEventLogOrphanDetectedPayloadSchema = z
  .object({
    audit_event_id: NonEmptyStringSchema,
    event_type: NonEmptyStringSchema,
    expected_table: EventLogOrphanExpectedTableSchema,
    detected_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulGardenEventLogOrphanDetectedEventSchema = z
  .object({
    type: z.literal(SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED),
    payload: SoulGardenEventLogOrphanDetectedPayloadSchema
  })
  .strict()
  .readonly();

export type SoulGardenEventLogOrphanDetectedEventType = z.infer<
  typeof SoulGardenEventLogOrphanDetectedEventTypeSchema
>;
export type EventLogOrphanExpectedTable = z.infer<typeof EventLogOrphanExpectedTableSchema>;
export type SoulGardenEventLogOrphanDetectedPayload = z.infer<
  typeof SoulGardenEventLogOrphanDetectedPayloadSchema
>;
export type SoulGardenEventLogOrphanDetectedEvent = z.infer<
  typeof SoulGardenEventLogOrphanDetectedEventSchema
>;
