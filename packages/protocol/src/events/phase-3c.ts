import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import {
  BankruptcyActionSchema,
  BankruptcyTriggerKindSchema,
  DossierBankruptcyKindSchema,
  RuntimeModeSchema
} from "../soul/bankruptcy.js";
import { ProposalResolutionStateSchema } from "../soul/proposal.js";

const phase3CEventTypeValues = [
  "soul.budget.degraded",
  "soul.budget.bankruptcy_declared",
  "soul.budget.bankruptcy_resolved"
] as const;

export const Phase3CEventType = {
  SOUL_BUDGET_DEGRADED: "soul.budget.degraded",
  SOUL_BUDGET_BANKRUPTCY_DECLARED: "soul.budget.bankruptcy_declared",
  SOUL_BUDGET_BANKRUPTCY_RESOLVED: "soul.budget.bankruptcy_resolved"
} as const;

export const Phase3CEventTypeSchema = z.enum(phase3CEventTypeValues);

export const SoulBudgetDegradedPayloadSchema = z
  .object({
    run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    lens_runtime_id: NonEmptyStringSchema,
    steps_applied: z.array(NonEmptyStringSchema).readonly(),
    tokens_before: NonNegativeIntSchema,
    tokens_after: NonNegativeIntSchema,
    budget_limit: NonNegativeIntSchema,
    still_over_budget: z.boolean(),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulBudgetBankruptcyDeclaredPayloadSchema = z
  .object({
    bankruptcy_id: NonEmptyStringSchema,
    bankruptcy_kind: DossierBankruptcyKindSchema,
    trigger_kind: BankruptcyTriggerKindSchema,
    current_mode: RuntimeModeSchema,
    trigger_summary: NonEmptyStringSchema,
    mode_at_trigger: RuntimeModeSchema,
    task_surface_ref: NonEmptyStringSchema.nullable(),
    protected_constraints_preserved: z.array(NonEmptyStringSchema).readonly(),
    dropped_candidates: z.array(NonEmptyStringSchema).readonly(),
    unresolved_conflicts: z.array(NonEmptyStringSchema).readonly(),
    required_actions: z.array(BankruptcyActionSchema).min(1).readonly(),
    expires_at: IsoDatetimeStringSchema.nullable(),
    run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const SoulBudgetBankruptcyResolvedPayloadSchema = z
  .object({
    bankruptcy_id: NonEmptyStringSchema,
    proposal_id: NonEmptyStringSchema,
    resolution_state: ProposalResolutionStateSchema,
    option_id_applied: NonEmptyStringSchema.nullable(),
    run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

const phase3CPayloadSchemas = {
  [Phase3CEventType.SOUL_BUDGET_DEGRADED]: SoulBudgetDegradedPayloadSchema,
  [Phase3CEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED]: SoulBudgetBankruptcyDeclaredPayloadSchema,
  [Phase3CEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED]: SoulBudgetBankruptcyResolvedPayloadSchema
} as const;

export function createPhase3CEventObjectSchema<T extends keyof typeof phase3CPayloadSchemas>(
  type: T,
  payloadSchema: (typeof phase3CPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulBudgetDegradedEventObjectSchema = createPhase3CEventObjectSchema(
  Phase3CEventType.SOUL_BUDGET_DEGRADED,
  SoulBudgetDegradedPayloadSchema
);
const SoulBudgetBankruptcyDeclaredEventObjectSchema = createPhase3CEventObjectSchema(
  Phase3CEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
  SoulBudgetBankruptcyDeclaredPayloadSchema
);
const SoulBudgetBankruptcyResolvedEventObjectSchema = createPhase3CEventObjectSchema(
  Phase3CEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED,
  SoulBudgetBankruptcyResolvedPayloadSchema
);

export const SoulBudgetDegradedEventSchema = SoulBudgetDegradedEventObjectSchema.readonly();
export const SoulBudgetBankruptcyDeclaredEventSchema = SoulBudgetBankruptcyDeclaredEventObjectSchema.readonly();
export const SoulBudgetBankruptcyResolvedEventSchema = SoulBudgetBankruptcyResolvedEventObjectSchema.readonly();

export const Phase3CEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulBudgetDegradedEventObjectSchema,
    SoulBudgetBankruptcyDeclaredEventObjectSchema,
    SoulBudgetBankruptcyResolvedEventObjectSchema
  ])
  .readonly();

export type Phase3CEventPayloadMap = {
  [K in keyof typeof phase3CPayloadSchemas]: z.infer<(typeof phase3CPayloadSchemas)[K]>;
};

export function parsePhase3CEventPayload<T extends keyof typeof phase3CPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): Phase3CEventPayloadMap[T] {
  const schema = phase3CPayloadSchemas[type];
  return schema.parse(payload) as Phase3CEventPayloadMap[T];
}

export type Phase3CEventTypeValue = z.infer<typeof Phase3CEventTypeSchema>;
export type Phase3CEvent = z.infer<typeof Phase3CEventUnionSchema>;
