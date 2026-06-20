import {
  BankruptcyKind,
  BudgetEventType,
  BudgetSnapshotSchema,
  ControlPlaneObjectKind,
  ProposalResolutionState,
  RetentionPolicy,
  SoulBudgetBankruptcyDeclaredPayloadSchema,
  SoulBudgetBankruptcyResolvedPayloadSchema,
  type BankruptcyDossier,
  type BudgetSnapshot,
  type BudgetBankruptcyState,
  type EventLogEntry,
  type Proposal,
  type RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  buildProposalOptions,
  computePressureRatio,
  deriveResolvedMode,
  determineBankruptcyKind,
  ensureIsoDatetime,
  getAutoApplicableOption,
  normalizeOptionalString,
  normalizeOptionalTimestamp,
  parseDossier,
  parseRequiredActions,
  parseState,
} from "./budget-bankruptcy-service-helpers.js";
import {
  buildEmptyBudgetSnapshot,
  buildPendingProposalSnapshot,
  buildRecoveredEntry,
  normalizeProposalDossierRef,
  requireDeclaredEvent
} from "./budget-bankruptcy-service-methods-recovery.js";
import type {
  ActiveBankruptcyKind,
  BankruptcyStoreEntry,
  BudgetBankruptcyDeclareParams,
  BudgetBankruptcyDeclareResult,
  BudgetBankruptcyResolveParams,
  BudgetBankruptcyServiceDependencies
} from "./budget-bankruptcy-service-types.js";

interface BudgetBankruptcyMethodOwner {
  readonly dependencies: BudgetBankruptcyServiceDependencies;
  readonly stateStore: Map<string, BankruptcyStoreEntry>;
  readonly generateRuntimeId: () => string;
  readonly now: () => string;
  getStickyCurrentMode(runId: string, fallback: RuntimeModeValue): RuntimeModeValue;
  getActivePendingProposal(runId: string): Promise<Readonly<Proposal> | null>;
}

interface DeclarationArtifacts {
  readonly kind: ActiveBankruptcyKind;
  readonly pressureRatio: number;
  readonly dossier: Readonly<BankruptcyDossier>;
  readonly initialState: Readonly<BudgetBankruptcyState>;
  readonly options: readonly Readonly<Proposal["proposal_options"][number]>[];
  readonly recommendedOptionId: string | null;
}

export async function budgetBankruptcyServiceDeclareInternal(
  owner: BudgetBankruptcyMethodOwner,
  params: BudgetBankruptcyDeclareParams,
  runId: string,
  workspaceId: string
): Promise<BudgetBankruptcyDeclareResult> {
  const occurredAt = ensureIsoDatetime(owner.now(), "now");
  const effectiveMode = owner.getStickyCurrentMode(runId, params.currentMode);
  const existingProposal = await owner.getActivePendingProposal(runId);
  if (existingProposal !== null) {
    throw new CoreError("CONFLICT", "A bankruptcy is already pending");
  }

  const artifacts = buildDeclarationArtifacts(owner, params, effectiveMode, occurredAt);
  const declaredEvent = await appendDeclaredEvent(
    owner.dependencies,
    artifacts,
    runId,
    workspaceId,
    occurredAt
  );
  const proposal = await owner.dependencies.proposalService.create({
    workspaceId,
    runId,
    dossierRef: artifacts.dossier.runtime_id,
    options: artifacts.options,
    recommendedOptionId: artifacts.recommendedOptionId,
    expiresAt: artifacts.initialState.expires_at
  });
  const entry = createStoreEntry(artifacts.initialState, artifacts.dossier, proposal.proposal_id, artifacts.pressureRatio);

  if (artifacts.kind === BankruptcyKind.SOFT) {
    return await autoResolveSoftDeclaration(
      owner,
      entry,
      proposal,
      runId,
      workspaceId,
      declaredEvent
    );
  }

  owner.stateStore.set(runId, entry);
  await owner.dependencies.runtimeNotifier.notifyEntry(declaredEvent);
  return { state: entry.state, dossier: entry.dossier, proposal };
}

export async function budgetBankruptcyServiceResolve(
  owner: BudgetBankruptcyMethodOwner,
  getOrRecoverEntry: (runId: string) => Promise<BankruptcyStoreEntry>,
  params: BudgetBankruptcyResolveParams
): Promise<Readonly<Proposal>> {
  const occurredAt = ensureIsoDatetime(owner.now(), "now");
  const runId = parseNonEmptyString(params.runId, "runId");
  const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
  const optionId = parseNonEmptyString(params.optionId, "optionId");
  const action = parseResolutionAction(params.action);
  const entry = await getOrRecoverEntry(runId);
  const proposal = await requirePendingProposal(owner.dependencies, entry.proposalId);
  const option = proposal.proposal_options.find((candidate) => candidate.option_id === optionId);
  if (option === undefined) {
    throw new CoreError("VALIDATION", "option_id must belong to the active proposal");
  }

  const resolutionState =
    action === "accept" ? ProposalResolutionState.ACCEPTED : ProposalResolutionState.REJECTED;
  const resolvedEvent = await appendResolvedEvent(
    owner.dependencies,
    entry,
    proposal.proposal_id,
    action === "accept" ? option.option_id : null,
    resolutionState,
    runId,
    workspaceId,
    occurredAt,
    "user"
  );
  const updatedProposal = await owner.dependencies.proposalService.update(proposal.proposal_id, {
    resolution_state: resolutionState,
    last_updated_at: occurredAt
  });
  owner.stateStore.set(
    runId,
    createStoreEntry(
      buildResolvedState(entry.state, option.option_kind, action === "accept", occurredAt),
      entry.dossier,
      updatedProposal.proposal_id,
      entry.pressureRatio
    )
  );
  await owner.dependencies.runtimeNotifier.notifyEntry(resolvedEvent);
  return updatedProposal;
}

export async function budgetBankruptcyServiceGetSnapshot(
  owner: BudgetBankruptcyMethodOwner,
  getOrRecoverEntry: (runId: string) => Promise<BankruptcyStoreEntry>,
  runId: string,
  now: string
): Promise<Readonly<BudgetSnapshot>> {
  const parsedRunId = parseNonEmptyString(runId, "runId");
  const snapshotAt = ensureIsoDatetime(now, "now");
  const entry = await resolveSnapshotEntry(owner, getOrRecoverEntry, parsedRunId);
  if (entry === null) {
    return buildEmptyBudgetSnapshot(parsedRunId, snapshotAt);
  }

  const proposal = await owner.dependencies.proposalService.findById(entry.proposalId);
  return BudgetSnapshotSchema.parse({
    snapshot_at: snapshotAt,
    run_id: parsedRunId,
    current_mode: entry.state.current_mode,
    bankruptcy_kind: entry.state.bankruptcy_kind,
    pressure_ratio: entry.pressureRatio,
    trigger_summary: entry.state.trigger_summary,
    active_dossier: {
      bankruptcy_id: entry.dossier.bankruptcy_id,
      trigger_kind: entry.dossier.trigger_kind,
      mode_at_trigger: entry.dossier.mode_at_trigger,
      dropped_candidates: entry.dossier.dropped_candidates,
      protected_constraints_preserved: entry.dossier.protected_constraints_preserved,
      required_actions: entry.dossier.required_actions,
      created_at: entry.dossier.created_at
    },
    pending_proposal: buildPendingProposalSnapshot(proposal)
  });
}

export async function budgetBankruptcyServiceGetOrRecoverEntry(
  owner: BudgetBankruptcyMethodOwner,
  runId: string
): Promise<BankruptcyStoreEntry> {
  const existing = owner.stateStore.get(runId);
  if (existing !== undefined) {
    return existing;
  }

  const pendingProposal = await owner.dependencies.proposalService.findPendingByRunId(runId);
  if (pendingProposal === null) {
    throw new CoreError("NOT_FOUND", "No active bankruptcy found for run");
  }

  const dossierRef = normalizeProposalDossierRef(pendingProposal.dossier_ref);
  if (dossierRef === null) {
    throw new CoreError("VALIDATION", "Pending bankruptcy proposal is missing dossier_ref");
  }

  const declaredEvent = await requireDeclaredEvent(owner.dependencies, dossierRef);
  const recovered = buildRecoveredEntry(
    dossierRef,
    pendingProposal.proposal_id,
    declaredEvent,
    createStoreEntry
  );
  owner.stateStore.set(runId, recovered);
  return recovered;
}

function buildDeclarationArtifacts(
  owner: BudgetBankruptcyMethodOwner,
  params: BudgetBankruptcyDeclareParams,
  effectiveMode: RuntimeModeValue,
  occurredAt: string
): DeclarationArtifacts {
  const bankruptcyId = owner.generateRuntimeId();
  const dossierId = owner.generateRuntimeId();
  const kind = determineBankruptcyKind(params);
  const taskSurfaceRef = normalizeOptionalString(params.taskSurfaceRef);
  const expiresAt = normalizeOptionalTimestamp(params.taskSurfaceExpiresAt, "taskSurfaceExpiresAt");
  const dossier = buildBankruptcyDossier(params, bankruptcyId, dossierId, effectiveMode, taskSurfaceRef, expiresAt, occurredAt, kind);
  const initialState = buildBankruptcyState(params, bankruptcyId, dossier.runtime_id, effectiveMode, taskSurfaceRef, expiresAt, occurredAt, kind);
  const options = buildProposalOptions(params, kind, dossier);
  return {
    kind,
    pressureRatio: computePressureRatio(params, kind),
    dossier,
    initialState,
    options,
    recommendedOptionId:
      options.find((option) => option.preserves_protected_constraints)?.option_id ?? null
  };
}

function buildBankruptcyDossier(
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

function buildBankruptcyState(
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

function createStoreEntry(
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

async function appendDeclaredEvent(
  dependencies: BudgetBankruptcyServiceDependencies,
  artifacts: DeclarationArtifacts,
  runId: string,
  workspaceId: string,
  occurredAt: string
): Promise<EventLogEntry> {
  return await dependencies.eventLogRepo.append({
    event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
    entity_type: "bankruptcy_dossier",
    entity_id: artifacts.dossier.runtime_id,
    workspace_id: workspaceId,
    run_id: runId,
    caused_by: "system",
    payload_json: SoulBudgetBankruptcyDeclaredPayloadSchema.parse({
      bankruptcy_id: artifacts.initialState.bankruptcy_id,
      bankruptcy_kind: artifacts.initialState.bankruptcy_kind,
      trigger_kind: artifacts.dossier.trigger_kind,
      current_mode: artifacts.initialState.current_mode,
      trigger_summary: artifacts.initialState.trigger_summary,
      mode_at_trigger: artifacts.dossier.mode_at_trigger,
      task_surface_ref: artifacts.dossier.task_surface_ref,
      protected_constraints_preserved: artifacts.dossier.protected_constraints_preserved,
      dropped_candidates: artifacts.dossier.dropped_candidates,
      unresolved_conflicts: artifacts.dossier.unresolved_conflicts,
      required_actions: artifacts.dossier.required_actions,
      expires_at: artifacts.initialState.expires_at,
      run_id: runId,
      workspace_id: workspaceId,
      occurred_at: occurredAt
    })
  });
}

async function autoResolveSoftDeclaration(
  owner: BudgetBankruptcyMethodOwner,
  entry: BankruptcyStoreEntry,
  proposal: Readonly<Proposal>,
  runId: string,
  workspaceId: string,
  declaredEvent: EventLogEntry
): Promise<BudgetBankruptcyDeclareResult> {
  const autoOption = getAutoApplicableOption(proposal);
  if (autoOption === null) {
    throw new CoreError("VALIDATION", "Soft bankruptcy requires an auto-applicable option");
  }

  const resolvedAt = ensureIsoDatetime(owner.now(), "now");
  const resolvedEvent = await appendResolvedEvent(
    owner.dependencies,
    entry,
    proposal.proposal_id,
    autoOption.option_id,
    ProposalResolutionState.AUTO_APPLIED,
    runId,
    workspaceId,
    resolvedAt,
    "system"
  );
  const updatedProposal = await owner.dependencies.proposalService.update(proposal.proposal_id, {
    resolution_state: ProposalResolutionState.AUTO_APPLIED,
    last_updated_at: resolvedAt
  });
  const updatedEntry = createStoreEntry(
    buildResolvedState(entry.state, autoOption.option_kind, true, resolvedAt),
    entry.dossier,
    updatedProposal.proposal_id,
    entry.pressureRatio
  );
  owner.stateStore.set(runId, updatedEntry);
  await owner.dependencies.runtimeNotifier.notifyEntry(declaredEvent);
  await owner.dependencies.runtimeNotifier.notifyEntry(resolvedEvent);
  return { state: updatedEntry.state, dossier: updatedEntry.dossier, proposal: updatedProposal };
}

async function requirePendingProposal(
  dependencies: BudgetBankruptcyServiceDependencies,
  proposalId: string
): Promise<Readonly<Proposal>> {
  const proposal = await dependencies.proposalService.findById(proposalId);
  if (proposal === null) {
    throw new CoreError("NOT_FOUND", "Bankruptcy proposal not found");
  }
  if (proposal.resolution_state !== ProposalResolutionState.PENDING) {
    throw new CoreError("VALIDATION", `Proposal is already ${proposal.resolution_state}`);
  }
  return proposal;
}

function parseResolutionAction(
  action: BudgetBankruptcyResolveParams["action"]
): "accept" | "reject" {
  if (action === "accept" || action === "reject") {
    return action;
  }
  throw new CoreError("VALIDATION", "action must be accept or reject");
}

async function appendResolvedEvent(
  dependencies: BudgetBankruptcyServiceDependencies,
  entry: BankruptcyStoreEntry,
  proposalId: string,
  optionIdApplied: string | null,
  resolutionState: ProposalResolutionState,
  runId: string,
  workspaceId: string,
  occurredAt: string,
  causedBy: "system" | "user"
): Promise<EventLogEntry> {
  return await dependencies.eventLogRepo.append({
    event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED,
    entity_type: "bankruptcy_dossier",
    entity_id: entry.dossier.runtime_id,
    workspace_id: workspaceId,
    run_id: runId,
    caused_by: causedBy,
    payload_json: SoulBudgetBankruptcyResolvedPayloadSchema.parse({
      bankruptcy_id: entry.state.bankruptcy_id,
      proposal_id: proposalId,
      resolution_state: resolutionState,
      option_id_applied: optionIdApplied,
      run_id: runId,
      workspace_id: workspaceId,
      occurred_at: occurredAt
    })
  });
}

function buildResolvedState(
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

async function resolveSnapshotEntry(
  owner: BudgetBankruptcyMethodOwner,
  getOrRecoverEntry: (runId: string) => Promise<BankruptcyStoreEntry>,
  runId: string
): Promise<BankruptcyStoreEntry | null> {
  const existing = owner.stateStore.get(runId) ?? null;
  if (existing !== null) {
    return existing;
  }

  try {
    return await getOrRecoverEntry(runId);
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}
