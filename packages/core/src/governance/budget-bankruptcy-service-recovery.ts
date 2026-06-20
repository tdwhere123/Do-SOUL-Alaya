import {
  BankruptcyKind,
  BudgetEventType,
  BudgetSnapshotSchema,
  ControlPlaneObjectKind,
  RetentionPolicy,
  RuntimeMode,
  SoulBudgetBankruptcyDeclaredPayloadSchema,
  type BudgetSnapshot,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { createStoreEntry } from "./budget-bankruptcy-service-artifacts.js";
import {
  normalizeOptionalString,
  parseDossier,
  parseState,
  pressureRatioForKind
} from "./budget-bankruptcy-service-helpers.js";
import type {
  BankruptcyStoreEntry,
  BudgetBankruptcyServiceDependencies
} from "./budget-bankruptcy-service-types.js";

export function buildEmptyBudgetSnapshot(
  runId: string,
  snapshotAt: string
): Readonly<BudgetSnapshot> {
  return BudgetSnapshotSchema.parse({
    snapshot_at: snapshotAt,
    run_id: runId,
    current_mode: RuntimeMode.FULL,
    bankruptcy_kind: BankruptcyKind.NONE,
    pressure_ratio: 0,
    trigger_summary: null,
    active_dossier: null,
    pending_proposal: null
  });
}

export function buildPendingProposalSnapshot(proposal: Readonly<Proposal> | null) {
  if (proposal === null) {
    return null;
  }

  return {
    proposal_id: proposal.proposal_id,
    resolution_state: proposal.resolution_state,
    recommended_option_id: proposal.recommended_option_id,
    options: proposal.proposal_options.map((option) => ({
      option_id: option.option_id,
      option_kind: option.option_kind,
      preserves_protected_constraints: option.preserves_protected_constraints,
      requires_confirmation: option.requires_confirmation
    })),
    expires_at: proposal.expires_at
  };
}

export async function requireDeclaredEvent(
  dependencies: BudgetBankruptcyServiceDependencies,
  dossierRef: string
): Promise<Readonly<EventLogEntry>> {
  const events = await dependencies.eventLogRepo.queryByEntity("bankruptcy_dossier", dossierRef);
  const declaredEvent = [...events]
    .reverse()
    .find((event) => event.event_type === BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED);
  if (declaredEvent === undefined) {
    throw new CoreError("NOT_FOUND", "Bankruptcy declaration audit record was not found");
  }
  return declaredEvent;
}

export function buildRecoveredEntry(
  dossierRef: string,
  proposalId: string,
  declaredEvent: Readonly<EventLogEntry>
): BankruptcyStoreEntry {
  const payload = SoulBudgetBankruptcyDeclaredPayloadSchema.parse(declaredEvent.payload_json);
  return createStoreEntry(
    parseState({
      runtime_id: payload.bankruptcy_id,
      object_kind: ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE,
      task_surface_ref: payload.task_surface_ref,
      expires_at: payload.expires_at,
      derived_from: payload.task_surface_ref,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      bankruptcy_id: payload.bankruptcy_id,
      bankruptcy_kind: payload.bankruptcy_kind,
      current_mode: payload.current_mode,
      trigger_summary: payload.trigger_summary,
      dossier_ref: dossierRef,
      updated_at: payload.occurred_at
    }),
    parseDossier({
      runtime_id: dossierRef,
      object_kind: ControlPlaneObjectKind.BANKRUPTCY_DOSSIER,
      task_surface_ref: payload.task_surface_ref,
      expires_at: payload.expires_at,
      derived_from: payload.task_surface_ref,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      bankruptcy_id: payload.bankruptcy_id,
      bankruptcy_kind: payload.bankruptcy_kind,
      trigger_kind: payload.trigger_kind,
      mode_at_trigger: payload.mode_at_trigger,
      protected_constraints_preserved: payload.protected_constraints_preserved,
      dropped_candidates: payload.dropped_candidates,
      unresolved_conflicts: payload.unresolved_conflicts,
      required_actions: payload.required_actions,
      created_at: payload.occurred_at
    }),
    proposalId,
    pressureRatioForKind(payload.bankruptcy_kind)
  );
}

export function normalizeProposalDossierRef(dossierRef: string | null | undefined): string | null {
  return normalizeOptionalString(dossierRef);
}
