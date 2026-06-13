import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import {
  BankruptcyActionSchema,
  BankruptcyTriggerKindSchema,
  DossierBankruptcyKindSchema,
  RuntimeModeSchema
} from "../soul/bankruptcy.js";
import { ProposalResolutionStateSchema } from "../soul/proposal.js";

const budgetEventTypeValues = [
  "soul.budget.degraded",
  "soul.budget.bankruptcy_declared",
  "soul.budget.bankruptcy_resolved"
] as const;

export const BudgetEventType = {
  SOUL_BUDGET_DEGRADED: "soul.budget.degraded",
  SOUL_BUDGET_BANKRUPTCY_DECLARED: "soul.budget.bankruptcy_declared",
  SOUL_BUDGET_BANKRUPTCY_RESOLVED: "soul.budget.bankruptcy_resolved"
} as const;

export const BudgetEventTypeSchema = z.enum(budgetEventTypeValues);

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

const budgetPayloadSchemas = {
  [BudgetEventType.SOUL_BUDGET_DEGRADED]: SoulBudgetDegradedPayloadSchema,
  [BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED]: SoulBudgetBankruptcyDeclaredPayloadSchema,
  [BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED]: SoulBudgetBankruptcyResolvedPayloadSchema
} as const;

export function createBudgetEventObjectSchema<T extends keyof typeof budgetPayloadSchemas>(
  type: T,
  payloadSchema: (typeof budgetPayloadSchemas)[T]
) {
  return z.object({ type: z.literal(type), payload: payloadSchema });
}

const SoulBudgetDegradedEventObjectSchema = createBudgetEventObjectSchema(
  BudgetEventType.SOUL_BUDGET_DEGRADED,
  SoulBudgetDegradedPayloadSchema
);
const SoulBudgetBankruptcyDeclaredEventObjectSchema = createBudgetEventObjectSchema(
  BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
  SoulBudgetBankruptcyDeclaredPayloadSchema
);
const SoulBudgetBankruptcyResolvedEventObjectSchema = createBudgetEventObjectSchema(
  BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED,
  SoulBudgetBankruptcyResolvedPayloadSchema
);

export const SoulBudgetDegradedEventSchema = SoulBudgetDegradedEventObjectSchema.readonly();
export const SoulBudgetBankruptcyDeclaredEventSchema = SoulBudgetBankruptcyDeclaredEventObjectSchema.readonly();
export const SoulBudgetBankruptcyResolvedEventSchema = SoulBudgetBankruptcyResolvedEventObjectSchema.readonly();

export const BudgetEventUnionSchema = z
  .discriminatedUnion("type", [
    SoulBudgetDegradedEventObjectSchema,
    SoulBudgetBankruptcyDeclaredEventObjectSchema,
    SoulBudgetBankruptcyResolvedEventObjectSchema
  ])
  .readonly();

export type BudgetEventPayloadMap = {
  [K in keyof typeof budgetPayloadSchemas]: z.infer<(typeof budgetPayloadSchemas)[K]>;
};

export function parseBudgetEventPayload<T extends keyof typeof budgetPayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): BudgetEventPayloadMap[T] {
  const schema = budgetPayloadSchemas[type];
  return schema.parse(payload) as BudgetEventPayloadMap[T];
}

export type BudgetEventTypeValue = z.infer<typeof BudgetEventTypeSchema>;
export type BudgetEvent = z.infer<typeof BudgetEventUnionSchema>;
