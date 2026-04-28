import { z } from "zod";
import { DeferredObligationKindSchema } from "../deferred-obligation.js";
import { DirtyStatePanicTriggerSchema } from "../dirty-state-dossier.js";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import { TrustAssessmentFactorSchema, WorkerTrustLevelSchema } from "../worker-trust.js";

const phaseBEventTypeValues = [
  "obligation.created",
  "obligation.fulfilled",
  "obligation.expired",
  "obligation.violation_blocked",
  "dirty_state.panic",
  "worker.trust_assessed",
  "narrative.budget_exceeded",
  "narrative.consolidation_triggered"
] as const;

export const PhaseBEventType = {
  OBLIGATION_CREATED: "obligation.created",
  OBLIGATION_FULFILLED: "obligation.fulfilled",
  OBLIGATION_EXPIRED: "obligation.expired",
  OBLIGATION_VIOLATION_BLOCKED: "obligation.violation_blocked",
  DIRTY_STATE_PANIC: "dirty_state.panic",
  WORKER_TRUST_ASSESSED: "worker.trust_assessed",
  NARRATIVE_BUDGET_EXCEEDED: "narrative.budget_exceeded",
  NARRATIVE_CONSOLIDATION_TRIGGERED: "narrative.consolidation_triggered"
} as const;

export const PhaseBEventTypeSchema = z.enum(phaseBEventTypeValues);
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

const phaseBPayloadSchemas = {
  [PhaseBEventType.OBLIGATION_CREATED]: ObligationCreatedPayloadSchema,
  [PhaseBEventType.OBLIGATION_FULFILLED]: ObligationFulfilledPayloadSchema,
  [PhaseBEventType.OBLIGATION_EXPIRED]: ObligationExpiredPayloadSchema,
  [PhaseBEventType.OBLIGATION_VIOLATION_BLOCKED]: ObligationViolationBlockedPayloadSchema,
  [PhaseBEventType.DIRTY_STATE_PANIC]: DirtyStatePanicPayloadSchema,
  [PhaseBEventType.WORKER_TRUST_ASSESSED]: WorkerTrustAssessedPayloadSchema,
  [PhaseBEventType.NARRATIVE_BUDGET_EXCEEDED]: NarrativeBudgetExceededPayloadSchema,
  [PhaseBEventType.NARRATIVE_CONSOLIDATION_TRIGGERED]:
    NarrativeConsolidationTriggeredPayloadSchema
} as const;

function createPhaseBEventObjectSchema<T extends keyof typeof phaseBPayloadSchemas>(
  type: T,
  payloadSchema: (typeof phaseBPayloadSchemas)[T]
) {
  return z.object({
    type: z.literal(type),
    payload: payloadSchema
  });
}

const ObligationCreatedEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.OBLIGATION_CREATED,
  ObligationCreatedPayloadSchema
);
const ObligationFulfilledEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.OBLIGATION_FULFILLED,
  ObligationFulfilledPayloadSchema
);
const ObligationExpiredEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.OBLIGATION_EXPIRED,
  ObligationExpiredPayloadSchema
);
const ObligationViolationBlockedEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.OBLIGATION_VIOLATION_BLOCKED,
  ObligationViolationBlockedPayloadSchema
);
const DirtyStatePanicEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.DIRTY_STATE_PANIC,
  DirtyStatePanicPayloadSchema
);
const WorkerTrustAssessedEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.WORKER_TRUST_ASSESSED,
  WorkerTrustAssessedPayloadSchema
);
const NarrativeBudgetExceededEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.NARRATIVE_BUDGET_EXCEEDED,
  NarrativeBudgetExceededPayloadSchema
);
const NarrativeConsolidationTriggeredEventObjectSchema = createPhaseBEventObjectSchema(
  PhaseBEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
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

export const PhaseBEventUnionSchema = z
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

export type PhaseBEventPayloadMap = {
  [K in keyof typeof phaseBPayloadSchemas]: z.infer<(typeof phaseBPayloadSchemas)[K]>;
};

export function parsePhaseBEventPayload<T extends keyof typeof phaseBPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): PhaseBEventPayloadMap[T] {
  const schema = phaseBPayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase B event type: ${String(type)}`);
  }

  return schema.parse(payload) as PhaseBEventPayloadMap[T];
}

export type PhaseBEventTypeValue = z.infer<typeof PhaseBEventTypeSchema>;
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
export type PhaseBEvent = z.infer<typeof PhaseBEventUnionSchema>;
