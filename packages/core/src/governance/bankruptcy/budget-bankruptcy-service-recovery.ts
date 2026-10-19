import {
  BankruptcyKind,
  BudgetEventType,
  BudgetSnapshotSchema,
  ControlPlaneObjectKind,
  ProposalResolutionState,
  RetentionPolicy,
  RuntimeMode,
  SoulBudgetBankruptcyDeclaredPayloadSchema,
  SoulBudgetBankruptcyResolvedPayloadSchema,
  type BudgetSnapshot,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { buildResolvedState, createStoreEntry } from "./budget-bankruptcy-service-artifacts.js";
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

export async function recoverBankruptcyEntry(
  dependencies: BudgetBankruptcyServiceDependencies,
  proposal: Readonly<Proposal>,
  existing?: BankruptcyStoreEntry
): Promise<BankruptcyStoreEntry> {
  const dossierRef = normalizeOptionalString(proposal.dossier_ref);
  if (dossierRef === null) {
    throw new CoreError("VALIDATION", "Bankruptcy proposal is missing dossier_ref");
  }
  const events = await dependencies.eventLogRepo.queryByEntityAll("bankruptcy_dossier", dossierRef);
  const declaredEvent = events.find((event) => event.event_type === BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED);
  if (declaredEvent === undefined) {
    throw new CoreError("CONFLICT", "Bankruptcy declaration audit record was not found");
  }
  const entry = existing ?? buildRecoveredEntry(dossierRef, proposal.proposal_id, declaredEvent);
  // A committed resolution is terminal, even if the old writer failed before updating the proposal.
  const resolution = events
    .filter((event) => event.event_type === BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED)
    .map((event) => SoulBudgetBankruptcyResolvedPayloadSchema.parse(event.payload_json))
    .find((payload) => payload.proposal_id === proposal.proposal_id);
  if (resolution === undefined) return entry;
  if (resolution.bankruptcy_id !== entry.state.bankruptcy_id) {
    throw new CoreError("CONFLICT", "Bankruptcy resolution does not match its declaration");
  }
  if (resolution.resolution_state === ProposalResolutionState.PENDING) {
    throw new CoreError("VALIDATION", "Committed bankruptcy resolution must be terminal");
  }
  const accepted = resolution.resolution_state === ProposalResolutionState.ACCEPTED
    || resolution.resolution_state === ProposalResolutionState.AUTO_APPLIED;
  const option = proposal.proposal_options.find((candidate) => candidate.option_id === resolution.option_id_applied);
  if (accepted && option === undefined) {
    throw new CoreError("VALIDATION", "Committed bankruptcy resolution is missing its applied option");
  }
  if (proposal.resolution_state === ProposalResolutionState.PENDING) {
    await dependencies.proposalService.update(proposal.proposal_id, {
      resolution_state: resolution.resolution_state,
      last_updated_at: resolution.occurred_at
    });
  } else if (proposal.resolution_state !== resolution.resolution_state) {
    throw new CoreError("CONFLICT", "Bankruptcy proposal conflicts with its committed resolution");
  }
  return createStoreEntry(
    option === undefined
      ? parseState({ ...entry.state, updated_at: resolution.occurred_at })
      : buildResolvedState(entry.state, option.option_kind, accepted, resolution.occurred_at),
    entry.dossier, entry.proposalId, entry.pressureRatio
  );
}

function buildRecoveredEntry(
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
