import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  type BankruptcyDossier,
  type BudgetBankruptcyState,
  type Proposal,
  type RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { parseNonEmptyString } from "../../shared/validators.js";
import {
  deriveResolvedMode,
  parseDossier,
  parseRequiredActions,
  parseState
} from "./budget-bankruptcy-service-helpers.js";
import type {
  ActiveBankruptcyKind,
  BankruptcyStoreEntry,
  BudgetBankruptcyDeclareParams,
  BudgetBankruptcyResolveParams
} from "./budget-bankruptcy-service-types.js";

export function createStoreEntry(
  state: Readonly<BudgetBankruptcyState>,
  dossier: Readonly<BankruptcyDossier>,
  proposalId: string,
  pressureRatio: number
): BankruptcyStoreEntry {
  return {
    state,
    dossier,
    proposalId,
    pressureRatio
  };
}

export function buildBankruptcyDossier(
  params: BudgetBankruptcyDeclareParams,
  bankruptcyId: string,
  dossierId: string,
  effectiveMode: RuntimeModeValue,
  taskSurfaceRef: string | null,
  expiresAt: string | null,
  occurredAt: string,
  kind: ActiveBankruptcyKind
): Readonly<BankruptcyDossier> {
  return parseDossier({
    runtime_id: dossierId,
    object_kind: ControlPlaneObjectKind.BANKRUPTCY_DOSSIER,
    task_surface_ref: taskSurfaceRef,
    expires_at: expiresAt,
    derived_from: taskSurfaceRef,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    bankruptcy_id: bankruptcyId,
    bankruptcy_kind: kind,
    trigger_kind: params.triggerKind,
    mode_at_trigger: effectiveMode,
    protected_constraints_preserved: Object.freeze([...new Set(params.protectedConstraints)]),
    dropped_candidates: Object.freeze([...new Set(params.droppedCandidates)]),
    unresolved_conflicts: Object.freeze([...new Set(params.unresolvedConflicts)]),
    required_actions: parseRequiredActions(params.requiredActions),
    created_at: occurredAt
  });
}

export function buildBankruptcyState(
  params: BudgetBankruptcyDeclareParams,
  bankruptcyId: string,
  dossierRef: string,
  effectiveMode: RuntimeModeValue,
  taskSurfaceRef: string | null,
  expiresAt: string | null,
  occurredAt: string,
  kind: ActiveBankruptcyKind
): Readonly<BudgetBankruptcyState> {
  return parseState({
    runtime_id: bankruptcyId,
    object_kind: ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE,
    task_surface_ref: taskSurfaceRef,
    expires_at: expiresAt,
    derived_from: taskSurfaceRef,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    bankruptcy_id: bankruptcyId,
    bankruptcy_kind: kind,
    current_mode: effectiveMode,
    trigger_summary: parseNonEmptyString(params.triggerSummary, "triggerSummary"),
    dossier_ref: dossierRef,
    updated_at: occurredAt
  });
}

export function buildResolvedState(
  state: Readonly<BudgetBankruptcyState>,
  optionKind: Proposal["proposal_options"][number]["option_kind"],
  shouldDeriveMode: boolean,
  occurredAt: string
): Readonly<BudgetBankruptcyState> {
  return parseState({
    ...state,
    current_mode: shouldDeriveMode ? deriveResolvedMode(state.current_mode, optionKind) : state.current_mode,
    updated_at: occurredAt
  });
}

export function parseResolutionAction(
  action: BudgetBankruptcyResolveParams["action"]
): "accept" | "reject" {
  if (action === "accept" || action === "reject") {
    return action;
  }
  throw new CoreError("VALIDATION", "action must be accept or reject");
}
