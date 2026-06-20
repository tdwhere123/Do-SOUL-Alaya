import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

const bankruptcyKindValues = ["soft", "hard", "none"] as const;
const dossierBankruptcyKindValues = ["soft", "hard"] as const;
const runtimeModeValues = ["full", "lean", "minimal"] as const;
const bankruptcyTriggerKindValues = [
  "token_overflow",
  "strict_conflict",
  "missing_verification",
  "safety_guard",
  "arbitration_block",
  "garden_backlog"
] as const;
const bankruptcyActionValues = ["compress", "defer", "verify", "arbitrate", "stop"] as const;

export const BankruptcyKind = {
  SOFT: "soft",
  HARD: "hard",
  NONE: "none"
} as const;

export const RuntimeMode = {
  FULL: "full",
  LEAN: "lean",
  MINIMAL: "minimal"
} as const;

export const BankruptcyTriggerKind = {
  TOKEN_OVERFLOW: "token_overflow",
  STRICT_CONFLICT: "strict_conflict",
  MISSING_VERIFICATION: "missing_verification",
  SAFETY_GUARD: "safety_guard",
  ARBITRATION_BLOCK: "arbitration_block",
  GARDEN_BACKLOG: "garden_backlog"
} as const;

export const BankruptcyAction = {
  COMPRESS: "compress",
  DEFER: "defer",
  VERIFY: "verify",
  ARBITRATE: "arbitrate",
  STOP: "stop"
} as const;

export const BankruptcyKindSchema = z.enum(bankruptcyKindValues);
export const DossierBankruptcyKindSchema = z.enum(dossierBankruptcyKindValues);
export const RuntimeModeSchema = z.enum(runtimeModeValues);
export const BankruptcyTriggerKindSchema = z.enum(bankruptcyTriggerKindValues);
export const BankruptcyActionSchema = z.enum(bankruptcyActionValues);

export const BudgetBankruptcyStateSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE),
    bankruptcy_id: NonEmptyStringSchema,
    bankruptcy_kind: BankruptcyKindSchema,
    current_mode: RuntimeModeSchema,
    trigger_summary: NonEmptyStringSchema,
    dossier_ref: NonEmptyStringSchema.nullable(),
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const BankruptcyDossierSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.BANKRUPTCY_DOSSIER),
    bankruptcy_id: NonEmptyStringSchema,
    bankruptcy_kind: DossierBankruptcyKindSchema,
    trigger_kind: BankruptcyTriggerKindSchema,
    mode_at_trigger: RuntimeModeSchema,
    task_surface_ref: NonEmptyStringSchema.nullable(),
    protected_constraints_preserved: z.array(NonEmptyStringSchema).readonly(),
    dropped_candidates: z.array(NonEmptyStringSchema).readonly(),
    unresolved_conflicts: z.array(NonEmptyStringSchema).readonly(),
    required_actions: z.array(BankruptcyActionSchema).min(1).readonly(),
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type BankruptcyKind = z.infer<typeof BankruptcyKindSchema>;
export type DossierBankruptcyKind = z.infer<typeof DossierBankruptcyKindSchema>;
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;
export type BankruptcyTriggerKind = z.infer<typeof BankruptcyTriggerKindSchema>;
export type BankruptcyAction = z.infer<typeof BankruptcyActionSchema>;
export type BudgetBankruptcyState = z.infer<typeof BudgetBankruptcyStateSchema>;
export type BankruptcyDossier = z.infer<typeof BankruptcyDossierSchema>;
