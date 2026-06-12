import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { GardenRoleSchema, GardenTaskKindSchema, GardenTierSchema } from "../soul/garden-tier.js";
import { HealthEventKindSchema } from "../soul/health-journal.js";

const gardenEventTypeValues = [
  "soul.garden.task_dispatched",
  "soul.garden.task_completed",
  "soul.garden.task_claim_reclaimed",
  "soul.garden.task_expired",
  "soul.garden.tier_violation_rejected",
  "soul.garden.enrich_abandoned",
  "soul.health_journal.recorded"
] as const;

export const GardenEventType = {
  SOUL_GARDEN_TASK_DISPATCHED: "soul.garden.task_dispatched",
  SOUL_GARDEN_TASK_COMPLETED: "soul.garden.task_completed",
  SOUL_GARDEN_TASK_CLAIM_RECLAIMED: "soul.garden.task_claim_reclaimed",
  // invariant: a never-claimed pending Garden task that outlived its kind TTL is
  // removed so a no-agent deployment's host-worker queue (EDGE_CLASSIFY /
  // POST_TURN_EXTRACT) cannot grow unbounded. The removal is audited here rather
  // than left a silent DELETE. Distinct from CLAIM_RECLAIMED: CLAIM_RECLAIMED
  // re-arms a claimed-but-abandoned task back to pending; TASK_EXPIRED discards
  // a pending task no worker ever claimed.
  // see also: storage/src/repos/garden/garden-task-repo.ts expireUnclaimedByKind;
  //   apps/core-daemon/src/garden-runtime.ts expireUnclaimedHostWorkerTasks.
  SOUL_GARDEN_TASK_EXPIRED: "soul.garden.task_expired",
  SOUL_GARDEN_TIER_VIOLATION_REJECTED: "soul.garden.tier_violation_rejected",
  // invariant: governance/runtime drops must be auditable. A BULK_ENRICH marker
  // that exhausts its transient-retry budget is dead-lettered, never silently
  // dropped — this event records the abandon with the owed-work identity.
  SOUL_ENRICH_ABANDONED: "soul.garden.enrich_abandoned",
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

export const SoulGardenTaskClaimReclaimedPayloadSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    role: GardenRoleSchema,
    tier: GardenTierSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    previous_claimed_by: NonEmptyStringSchema,
    claimed_at: IsoDatetimeStringSchema,
    stale_after_ms: NonNegativeIntSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulGardenTaskExpiredPayloadSchema = z
  .object({
    task_id: NonEmptyStringSchema,
    task_kind: GardenTaskKindSchema,
    role: GardenRoleSchema,
    tier: GardenTierSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    // age of the unclaimed task at removal and the kind TTL it crossed, so the
    // operator can audit the expiry policy without re-deriving it.
    enqueued_at: IsoDatetimeStringSchema,
    ttl_ms: NonNegativeIntSchema,
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

export const SoulEnrichAbandonedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    // The owed-work identity. memory_id is always present; source_signal_id is
    // the signal-ref-replay owed work when the marker carried one (null when the
    // owed work was edge-production / conflict-detection only).
    memory_id: NonEmptyStringSchema,
    source_signal_id: NonEmptyStringSchema.nullable(),
    run_id: NonEmptyStringSchema.nullable(),
    attempt_count: NonNegativeIntSchema,
    // The last transient failure that drove the marker over the cap, captured
    // for audit (an Error message string).
    last_failure_kind: z.string(),
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
        secret_ref_kind: z.enum(["env", "file", "keychain"]).nullable().optional(),
        provider_url: z.string().nullable().optional(),
        model_id: z.string().nullable().optional()
      })
      .readonly()
      .optional()
  })
  .readonly();

const gardenPayloadSchemas = {
  [GardenEventType.SOUL_GARDEN_TASK_DISPATCHED]: SoulGardenTaskDispatchedPayloadSchema,
  [GardenEventType.SOUL_GARDEN_TASK_COMPLETED]: SoulGardenTaskCompletedPayloadSchema,
  [GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED]: SoulGardenTaskClaimReclaimedPayloadSchema,
  [GardenEventType.SOUL_GARDEN_TASK_EXPIRED]: SoulGardenTaskExpiredPayloadSchema,
  [GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED]: SoulGardenTierViolationRejectedPayloadSchema,
  [GardenEventType.SOUL_ENRICH_ABANDONED]: SoulEnrichAbandonedPayloadSchema,
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
const SoulGardenTaskClaimReclaimedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
  SoulGardenTaskClaimReclaimedPayloadSchema
);
const SoulGardenTaskExpiredEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_GARDEN_TASK_EXPIRED,
  SoulGardenTaskExpiredPayloadSchema
);
const SoulGardenTierViolationRejectedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
  SoulGardenTierViolationRejectedPayloadSchema
);
const SoulEnrichAbandonedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_ENRICH_ABANDONED,
  SoulEnrichAbandonedPayloadSchema
);
const SoulHealthJournalRecordedEventObjectSchema = createGardenEventObjectSchema(
  GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
  SoulHealthJournalRecordedPayloadSchema
);

export const SoulGardenTaskDispatchedEventSchema = SoulGardenTaskDispatchedEventObjectSchema.readonly();
export const SoulGardenTaskCompletedEventSchema = SoulGardenTaskCompletedEventObjectSchema.readonly();
export const SoulGardenTaskClaimReclaimedEventSchema = SoulGardenTaskClaimReclaimedEventObjectSchema.readonly();
export const SoulGardenTaskExpiredEventSchema = SoulGardenTaskExpiredEventObjectSchema.readonly();
export const SoulGardenTierViolationRejectedEventSchema = SoulGardenTierViolationRejectedEventObjectSchema.readonly();
export const SoulEnrichAbandonedEventSchema = SoulEnrichAbandonedEventObjectSchema.readonly();
export const SoulHealthJournalRecordedEventSchema = SoulHealthJournalRecordedEventObjectSchema.readonly();

export const GardenEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulGardenTaskDispatchedEventObjectSchema,
    SoulGardenTaskCompletedEventObjectSchema,
    SoulGardenTaskClaimReclaimedEventObjectSchema,
    SoulGardenTaskExpiredEventObjectSchema,
    SoulGardenTierViolationRejectedEventObjectSchema,
    SoulEnrichAbandonedEventObjectSchema,
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
