import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { BankruptcyActionSchema, BankruptcyKindSchema, BankruptcyTriggerKindSchema, RuntimeModeSchema } from "./bankruptcy.js";
import { ProposalOptionKindSchema, ProposalResolutionStateSchema } from "./proposal.js";

export const BudgetDossierSummarySchema = z
  .object({
    bankruptcy_id: NonEmptyStringSchema,
    trigger_kind: BankruptcyTriggerKindSchema,
    mode_at_trigger: RuntimeModeSchema,
    dropped_candidates: z.array(NonEmptyStringSchema).readonly(),
    protected_constraints_preserved: z.array(NonEmptyStringSchema).readonly(),
    required_actions: z.array(BankruptcyActionSchema).readonly(),
    created_at: IsoDatetimeStringSchema
  })
  .readonly();

export const BudgetProposalOptionSummarySchema = z
  .object({
    option_id: NonEmptyStringSchema,
    option_kind: ProposalOptionKindSchema,
    preserves_protected_constraints: z.boolean(),
    requires_confirmation: z.boolean()
  })
  .readonly();

export const BudgetProposalSummarySchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    resolution_state: ProposalResolutionStateSchema,
    recommended_option_id: NonEmptyStringSchema.nullable(),
    options: z.array(BudgetProposalOptionSummarySchema).readonly(),
    expires_at: IsoDatetimeStringSchema.nullable()
  })
  .readonly();

export const BudgetSnapshotSchema = z
  .object({
    snapshot_at: IsoDatetimeStringSchema,
    run_id: NonEmptyStringSchema,
    current_mode: RuntimeModeSchema,
    bankruptcy_kind: BankruptcyKindSchema,
    trigger_summary: NonEmptyStringSchema.nullable(),
    active_dossier: BudgetDossierSummarySchema.nullable(),
    pending_proposal: BudgetProposalSummarySchema.nullable()
  })
  .readonly();

export type BudgetDossierSummary = z.infer<typeof BudgetDossierSummarySchema>;
export type BudgetProposalOptionSummary = z.infer<typeof BudgetProposalOptionSummarySchema>;
export type BudgetProposalSummary = z.infer<typeof BudgetProposalSummarySchema>;
export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;
