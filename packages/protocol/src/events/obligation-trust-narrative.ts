import { z } from "zod";
import { DeferredObligationKindSchema } from "../deferred-obligation.js";
import { DirtyStatePanicTriggerSchema } from "../dirty-state-dossier.js";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import { TrustAssessmentFactorSchema, WorkerTrustLevelSchema } from "../worker-trust.js";

const obligationTrustNarrativeEventTypeValues = [
  "obligation.created",
  "obligation.fulfilled",
  "obligation.expired",
  "obligation.violation_blocked",
  "dirty_state.panic",
  "worker.trust_assessed",
  "narrative.budget_exceeded",
  "narrative.consolidation_triggered"
] as const;

export const ObligationTrustNarrativeEventType = {
  OBLIGATION_CREATED: "obligation.created",
  OBLIGATION_FULFILLED: "obligation.fulfilled",
  OBLIGATION_EXPIRED: "obligation.expired",
  OBLIGATION_VIOLATION_BLOCKED: "obligation.violation_blocked",
  DIRTY_STATE_PANIC: "dirty_state.panic",
  WORKER_TRUST_ASSESSED: "worker.trust_assessed",
  NARRATIVE_BUDGET_EXCEEDED: "narrative.budget_exceeded",
  NARRATIVE_CONSOLIDATION_TRIGGERED: "narrative.consolidation_triggered"
} as const;

export const ObligationTrustNarrativeEventTypeSchema = z.enum(obligationTrustNarrativeEventTypeValues);
export const ObligationBlockedOperationSchema = z.enum([
  "run_complete",
  "worker_complete",
  "data_delete"
]);

export const ObligationCreatedPayloadSchema = z
  .object({
    obligation_id: NonEmptyStringSchema,
    kind: DeferredObligationKindSchema,
    state: z.literal("pending"),
    description: NonEmptyStringSchema,
    source_run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    target_entity_id: NonEmptyStringSchema.optional(),
    created_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ObligationFulfilledPayloadSchema = z
  .object({
    obligation_id: NonEmptyStringSchema,
    fulfilled_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ObligationExpiredPayloadSchema = z
  .object({
    obligation_id: NonEmptyStringSchema,
    expired_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ObligationViolationBlockedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    operation: ObligationBlockedOperationSchema,
    active_obligation_ids: z.array(NonEmptyStringSchema).min(1).readonly(),
    blocked_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const DirtyStatePanicPayloadSchema = z
  .object({
    dossier_id: NonEmptyStringSchema,
    worker_run_id: NonEmptyStringSchema,
    principal_run_id: NonEmptyStringSchema,
    trigger: DirtyStatePanicTriggerSchema,
    panic_source: NonEmptyStringSchema,
    panic_summary: NonEmptyStringSchema,
    affected_entity_count: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const WorkerTrustAssessedPayloadSchema = z
  .object({
    assessment_id: NonEmptyStringSchema,
    worker_run_id: NonEmptyStringSchema,
    trust_level: WorkerTrustLevelSchema,
    factors: z.array(TrustAssessmentFactorSchema).readonly()
  })
  .strict()
  .readonly();

export const NarrativeBudgetExceededPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    current_bytes: NonNegativeIntSchema,
    max_bytes: NonNegativeIntSchema,
    current_count: NonNegativeIntSchema,
    max_count: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const NarrativeConsolidationTriggeredPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    trigger_reason: NonEmptyStringSchema,
    digest_count_before: NonNegativeIntSchema
  })
  .strict()
  .readonly();

const obligationTrustNarrativePayloadSchemas = {
  [ObligationTrustNarrativeEventType.OBLIGATION_CREATED]: ObligationCreatedPayloadSchema,
  [ObligationTrustNarrativeEventType.OBLIGATION_FULFILLED]: ObligationFulfilledPayloadSchema,
  [ObligationTrustNarrativeEventType.OBLIGATION_EXPIRED]: ObligationExpiredPayloadSchema,
  [ObligationTrustNarrativeEventType.OBLIGATION_VIOLATION_BLOCKED]: ObligationViolationBlockedPayloadSchema,
  [ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC]: DirtyStatePanicPayloadSchema,
  [ObligationTrustNarrativeEventType.WORKER_TRUST_ASSESSED]: WorkerTrustAssessedPayloadSchema,
  [ObligationTrustNarrativeEventType.NARRATIVE_BUDGET_EXCEEDED]: NarrativeBudgetExceededPayloadSchema,
  [ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED]:
    NarrativeConsolidationTriggeredPayloadSchema
} as const;

function createObligationTrustNarrativeEventObjectSchema<T extends keyof typeof obligationTrustNarrativePayloadSchemas>(
  type: T,
  payloadSchema: (typeof obligationTrustNarrativePayloadSchemas)[T]
) {
  return z.object({
    type: z.literal(type),
    payload: payloadSchema
  });
}

const ObligationCreatedEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.OBLIGATION_CREATED,
  ObligationCreatedPayloadSchema
);
const ObligationFulfilledEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.OBLIGATION_FULFILLED,
  ObligationFulfilledPayloadSchema
);
const ObligationExpiredEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.OBLIGATION_EXPIRED,
  ObligationExpiredPayloadSchema
);
const ObligationViolationBlockedEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.OBLIGATION_VIOLATION_BLOCKED,
  ObligationViolationBlockedPayloadSchema
);
const DirtyStatePanicEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC,
  DirtyStatePanicPayloadSchema
);
const WorkerTrustAssessedEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.WORKER_TRUST_ASSESSED,
  WorkerTrustAssessedPayloadSchema
);
const NarrativeBudgetExceededEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.NARRATIVE_BUDGET_EXCEEDED,
  NarrativeBudgetExceededPayloadSchema
);
const NarrativeConsolidationTriggeredEventObjectSchema = createObligationTrustNarrativeEventObjectSchema(
  ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
  NarrativeConsolidationTriggeredPayloadSchema
);

export const ObligationCreatedEventSchema = ObligationCreatedEventObjectSchema.readonly();
export const ObligationFulfilledEventSchema = ObligationFulfilledEventObjectSchema.readonly();
export const ObligationExpiredEventSchema = ObligationExpiredEventObjectSchema.readonly();
export const ObligationViolationBlockedEventSchema =
  ObligationViolationBlockedEventObjectSchema.readonly();
export const DirtyStatePanicEventSchema = DirtyStatePanicEventObjectSchema.readonly();
export const WorkerTrustAssessedEventSchema = WorkerTrustAssessedEventObjectSchema.readonly();
export const NarrativeBudgetExceededEventSchema = NarrativeBudgetExceededEventObjectSchema.readonly();
export const NarrativeConsolidationTriggeredEventSchema =
  NarrativeConsolidationTriggeredEventObjectSchema.readonly();

export const ObligationTrustNarrativeEventUnionSchema = z
  .discriminatedUnion("type", [
    ObligationCreatedEventObjectSchema,
    ObligationFulfilledEventObjectSchema,
    ObligationExpiredEventObjectSchema,
    ObligationViolationBlockedEventObjectSchema,
    DirtyStatePanicEventObjectSchema,
    WorkerTrustAssessedEventObjectSchema,
    NarrativeBudgetExceededEventObjectSchema,
    NarrativeConsolidationTriggeredEventObjectSchema
  ])
  .readonly();

export type ObligationTrustNarrativeEventPayloadMap = {
  [K in keyof typeof obligationTrustNarrativePayloadSchemas]: z.infer<(typeof obligationTrustNarrativePayloadSchemas)[K]>;
};

export function parseObligationTrustNarrativeEventPayload<T extends keyof typeof obligationTrustNarrativePayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): ObligationTrustNarrativeEventPayloadMap[T] {
  const schema = obligationTrustNarrativePayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase B event type: ${String(type)}`);
  }

  return schema.parse(payload) as ObligationTrustNarrativeEventPayloadMap[T];
}

export type ObligationTrustNarrativeEventTypeValue = z.infer<typeof ObligationTrustNarrativeEventTypeSchema>;
export type ObligationBlockedOperation = z.infer<typeof ObligationBlockedOperationSchema>;
export type ObligationCreatedPayload = z.infer<typeof ObligationCreatedPayloadSchema>;
export type ObligationFulfilledPayload = z.infer<typeof ObligationFulfilledPayloadSchema>;
export type ObligationExpiredPayload = z.infer<typeof ObligationExpiredPayloadSchema>;
export type ObligationViolationBlockedPayload = z.infer<
  typeof ObligationViolationBlockedPayloadSchema
>;
export type DirtyStatePanicPayload = z.infer<typeof DirtyStatePanicPayloadSchema>;
export type WorkerTrustAssessedPayload = z.infer<typeof WorkerTrustAssessedPayloadSchema>;
export type NarrativeBudgetExceededPayload = z.infer<typeof NarrativeBudgetExceededPayloadSchema>;
export type NarrativeConsolidationTriggeredPayload = z.infer<
  typeof NarrativeConsolidationTriggeredPayloadSchema
>;
export type ObligationTrustNarrativeEvent = z.infer<typeof ObligationTrustNarrativeEventUnionSchema>;
