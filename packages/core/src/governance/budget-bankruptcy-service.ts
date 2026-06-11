import { randomUUID } from "node:crypto";
import {
  BankruptcyAction,
  BankruptcyDossierSchema,
  BankruptcyKind,
  BankruptcyTriggerKind,
  BudgetBankruptcyStateSchema,
  BudgetSnapshotSchema,
  ControlPlaneObjectKind,
  BudgetEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  RuntimeMode,
  SoulBudgetBankruptcyDeclaredPayloadSchema,
  SoulBudgetBankruptcyResolvedPayloadSchema,
  type BankruptcyAction as BankruptcyActionValue,
  type BankruptcyDossier,
  type BankruptcyKind as BankruptcyKindValue,
  type BankruptcyTriggerKind as BankruptcyTriggerKindValue,
  type BudgetSnapshot,
  type BudgetBankruptcyState,
  type EventLogEntry,
  type Proposal,
  type ProposalOption,
  type ProposalResolutionState as ProposalResolutionStateValue,
  type RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { parseNonEmptyString } from "../shared/validators.js";

type ActiveBankruptcyKind = Exclude<BankruptcyKindValue, "none">;

interface BankruptcyStoreEntry {
  readonly state: Readonly<BudgetBankruptcyState>;
  readonly dossier: Readonly<BankruptcyDossier>;
  readonly proposalId: string;
  readonly pressureRatio: number;
}

export interface BudgetBankruptcyServiceEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface BudgetBankruptcyServiceProposalPort {
  create(params: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly dossierRef: string;
    readonly options: readonly Readonly<ProposalOption>[];
    readonly recommendedOptionId: string | null;
    readonly expiresAt: string | null;
  }): Promise<Readonly<Proposal>>;
  update(
    proposalId: string,
    patch: {
      readonly resolution_state: ProposalResolutionStateValue;
      readonly last_updated_at: string;
    }
  ): Promise<Readonly<Proposal>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null>;
}

export interface BudgetBankruptcyRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface BudgetBankruptcyDeclareParams {
  readonly runId: string;
  readonly workspaceId: string;
  readonly triggerKind: BankruptcyTriggerKindValue;
  readonly triggerSummary: string;
  readonly taskSurfaceRef: string | null;
  readonly taskSurfaceExpiresAt: string | null;
  readonly currentMode: RuntimeModeValue;
  readonly protectedConstraints: readonly string[];
  readonly droppedCandidates: readonly string[];
  readonly unresolvedConflicts: readonly string[];
  readonly requiredActions: readonly BankruptcyActionValue[];
  readonly tokensUsed?: number;
  readonly maxTotalTokens?: number;
}

export interface BudgetBankruptcyDeclareResult {
  readonly state: Readonly<BudgetBankruptcyState>;
  readonly dossier: Readonly<BankruptcyDossier>;
  readonly proposal: Readonly<Proposal>;
}

export interface BudgetBankruptcyResolveParams {
  readonly runId: string;
  readonly workspaceId: string;
  readonly optionId: string;
  readonly action: "accept" | "reject";
}

export interface BudgetBankruptcyServiceDependencies {
  readonly eventLogRepo: BudgetBankruptcyServiceEventLogPort;
  readonly proposalService: BudgetBankruptcyServiceProposalPort;
  readonly runtimeNotifier: BudgetBankruptcyRuntimeNotifierPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
}

export class BudgetBankruptcyService {
  private readonly stateStore = new Map<string, BankruptcyStoreEntry>();
  private readonly inFlightDeclarations = new Map<string, Promise<BudgetBankruptcyDeclareResult>>();
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: BudgetBankruptcyServiceDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async declare(params: BudgetBankruptcyDeclareParams): Promise<BudgetBankruptcyDeclareResult> {
    const runId = parseNonEmptyString(params.runId, "runId");
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const existingDeclaration = this.inFlightDeclarations.get(runId);

    if (existingDeclaration !== undefined) {
      return await existingDeclaration;
    }

    const declaration = this.declareInternal(params, runId, workspaceId);
    this.inFlightDeclarations.set(runId, declaration);

    try {
      return await declaration;
    } finally {
      if (this.inFlightDeclarations.get(runId) === declaration) {
        this.inFlightDeclarations.delete(runId);
      }
    }
  }

  private async declareInternal(
    params: BudgetBankruptcyDeclareParams,
    runId: string,
    workspaceId: string
  ): Promise<BudgetBankruptcyDeclareResult> {
    const occurredAt = ensureIsoDatetime(this.now(), "now");
    const effectiveMode = this.getStickyCurrentMode(runId, params.currentMode);
    const existingProposal = await this.getActivePendingProposal(runId);

    if (existingProposal !== null) {
      throw new CoreError("CONFLICT", "A bankruptcy is already pending");
    }

    const bankruptcyId = this.generateRuntimeId();
    const dossierId = this.generateRuntimeId();
    const kind = determineBankruptcyKind(params);
    const pressureRatio = computePressureRatio(params, kind);
    const taskSurfaceRef = normalizeOptionalString(params.taskSurfaceRef);
    const expiresAt = normalizeOptionalTimestamp(params.taskSurfaceExpiresAt, "taskSurfaceExpiresAt");
    // Mirror the originating task surface so restart recovery can trace both control-plane objects to the same source.
    const derivedFromTaskSurface = taskSurfaceRef;
    const dossier = parseDossier({
      runtime_id: dossierId,
      object_kind: ControlPlaneObjectKind.BANKRUPTCY_DOSSIER,
      task_surface_ref: taskSurfaceRef,
      expires_at: expiresAt,
      derived_from: derivedFromTaskSurface,
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
    const initialState = parseState({
      runtime_id: bankruptcyId,
      object_kind: ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE,
      task_surface_ref: taskSurfaceRef,
      expires_at: expiresAt,
      derived_from: derivedFromTaskSurface,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      bankruptcy_id: bankruptcyId,
      bankruptcy_kind: kind,
      current_mode: effectiveMode,
      trigger_summary: parseNonEmptyString(params.triggerSummary, "triggerSummary"),
      dossier_ref: dossier.runtime_id,
      updated_at: occurredAt
    });
    const options = buildProposalOptions(params, kind, dossier);
    const recommendedOptionId =
      options.find((option) => option.preserves_protected_constraints)?.option_id ?? null;
    const declaredEvent = await this.dependencies.eventLogRepo.append({
      event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED,
      entity_type: "bankruptcy_dossier",
      entity_id: dossier.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "system",
      payload_json: SoulBudgetBankruptcyDeclaredPayloadSchema.parse({
        bankruptcy_id: initialState.bankruptcy_id,
        bankruptcy_kind: initialState.bankruptcy_kind,
        trigger_kind: dossier.trigger_kind,
        current_mode: initialState.current_mode,
        trigger_summary: initialState.trigger_summary,
        mode_at_trigger: dossier.mode_at_trigger,
        task_surface_ref: dossier.task_surface_ref,
        protected_constraints_preserved: dossier.protected_constraints_preserved,
        dropped_candidates: dossier.dropped_candidates,
        unresolved_conflicts: dossier.unresolved_conflicts,
        required_actions: dossier.required_actions,
        expires_at: initialState.expires_at,
        run_id: runId,
        workspace_id: workspaceId,
        occurred_at: occurredAt
      })
    });
    let proposal = await this.dependencies.proposalService.create({
      workspaceId,
      runId,
      dossierRef: dossier.runtime_id,
      options,
      recommendedOptionId,
      expiresAt: initialState.expires_at
    });
    let state = initialState;

    if (kind === BankruptcyKind.SOFT) {
      const autoOption = getAutoApplicableOption(proposal);

      if (autoOption === null) {
        throw new CoreError("VALIDATION", "Soft bankruptcy requires an auto-applicable option");
      }

      const resolvedAt = ensureIsoDatetime(this.now(), "now");
      const resolvedEvent = await this.dependencies.eventLogRepo.append({
        event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED,
        entity_type: "bankruptcy_dossier",
        entity_id: dossier.runtime_id,
        workspace_id: workspaceId,
        run_id: runId,
        caused_by: "system",
        payload_json: SoulBudgetBankruptcyResolvedPayloadSchema.parse({
          bankruptcy_id: state.bankruptcy_id,
          proposal_id: proposal.proposal_id,
          resolution_state: ProposalResolutionState.AUTO_APPLIED,
          option_id_applied: autoOption.option_id,
          run_id: runId,
          workspace_id: workspaceId,
          occurred_at: resolvedAt
        })
      });
      proposal = await this.dependencies.proposalService.update(proposal.proposal_id, {
        resolution_state: ProposalResolutionState.AUTO_APPLIED,
        last_updated_at: resolvedAt
      });
      state = parseState({
        ...state,
        current_mode: deriveResolvedMode(state.current_mode, autoOption.option_kind),
        updated_at: resolvedAt
      });
      this.stateStore.set(runId, {
        state,
        dossier,
        proposalId: proposal.proposal_id,
        pressureRatio
      });
      await this.dependencies.runtimeNotifier.notifyEntry(declaredEvent);
      await this.dependencies.runtimeNotifier.notifyEntry(resolvedEvent);

      return { state, dossier, proposal };
    }

    this.stateStore.set(runId, {
      state,
      dossier,
      proposalId: proposal.proposal_id,
      pressureRatio
    });
    await this.dependencies.runtimeNotifier.notifyEntry(declaredEvent);
    return { state, dossier, proposal };
  }

  public async resolve(params: BudgetBankruptcyResolveParams): Promise<Readonly<Proposal>> {
    const occurredAt = ensureIsoDatetime(this.now(), "now");
    const runId = parseNonEmptyString(params.runId, "runId");
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const optionId = parseNonEmptyString(params.optionId, "optionId");
    const action = params.action === "accept" || params.action === "reject" ? params.action : null;

    if (action === null) {
      throw new CoreError("VALIDATION", "action must be accept or reject");
    }

    const entry = await this.getOrRecoverEntry(runId);
    const proposal = await this.dependencies.proposalService.findById(entry.proposalId);

    if (proposal === null) {
      throw new CoreError("NOT_FOUND", "Bankruptcy proposal not found");
    }

    if (proposal.resolution_state !== ProposalResolutionState.PENDING) {
      throw new CoreError("VALIDATION", `Proposal is already ${proposal.resolution_state}`);
    }

    const option = proposal.proposal_options.find((candidate) => candidate.option_id === optionId);

    if (option === undefined) {
      throw new CoreError("VALIDATION", "option_id must belong to the active proposal");
    }

    const resolutionState =
      action === "accept" ? ProposalResolutionState.ACCEPTED : ProposalResolutionState.REJECTED;
    const resolvedEvent = await this.dependencies.eventLogRepo.append({
      event_type: BudgetEventType.SOUL_BUDGET_BANKRUPTCY_RESOLVED,
      entity_type: "bankruptcy_dossier",
      entity_id: entry.dossier.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "user",
      payload_json: SoulBudgetBankruptcyResolvedPayloadSchema.parse({
        bankruptcy_id: entry.state.bankruptcy_id,
        proposal_id: proposal.proposal_id,
        resolution_state: resolutionState,
        option_id_applied: action === "accept" ? option.option_id : null,
        run_id: runId,
        workspace_id: workspaceId,
        occurred_at: occurredAt
      })
    });
    const updatedProposal = await this.dependencies.proposalService.update(proposal.proposal_id, {
      resolution_state: resolutionState,
      last_updated_at: occurredAt
    });
    const updatedState = parseState({
      ...entry.state,
      current_mode:
        action === "accept"
          ? deriveResolvedMode(entry.state.current_mode, option.option_kind)
          : entry.state.current_mode,
      updated_at: occurredAt
    });

    this.stateStore.set(runId, {
      state: updatedState,
      dossier: entry.dossier,
      proposalId: updatedProposal.proposal_id,
      pressureRatio: entry.pressureRatio
    });
    await this.dependencies.runtimeNotifier.notifyEntry(resolvedEvent);

    return updatedProposal;
  }

  public async getSnapshot(runId: string, now: string): Promise<Readonly<BudgetSnapshot>> {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    const snapshotAt = ensureIsoDatetime(now, "now");
    let entry = this.stateStore.get(parsedRunId) ?? null;

    if (entry === null) {
      try {
        entry = await this.getOrRecoverEntry(parsedRunId);
      } catch (error) {
        if (error instanceof CoreError && error.code === "NOT_FOUND") {
          return BudgetSnapshotSchema.parse({
            snapshot_at: snapshotAt,
            run_id: parsedRunId,
            current_mode: RuntimeMode.FULL,
            bankruptcy_kind: BankruptcyKind.NONE,
            pressure_ratio: 0,
            trigger_summary: null,
            active_dossier: null,
            pending_proposal: null
          });
        }

        throw error;
      }
    }

    const proposal = await this.dependencies.proposalService.findById(entry.proposalId);

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
      pending_proposal:
        proposal === null
          ? null
          : {
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
            }
    });
  }

  public clearRun(runId: string): void {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    this.stateStore.delete(parsedRunId);
    this.inFlightDeclarations.delete(parsedRunId);
  }

  private getStickyCurrentMode(runId: string, fallback: RuntimeModeValue): RuntimeModeValue {
    const existing = this.stateStore.get(runId);
    return existing?.state.current_mode ?? fallback;
  }

  private async getActivePendingProposal(runId: string): Promise<Readonly<Proposal> | null> {
    const existing = this.stateStore.get(runId);

    if (existing !== undefined) {
      const proposal = await this.dependencies.proposalService.findById(existing.proposalId);

      if (proposal !== null && proposal.resolution_state === ProposalResolutionState.PENDING) {
        return proposal;
      }
    }

    return await this.dependencies.proposalService.findPendingByRunId(runId);
  }

  private async getOrRecoverEntry(runId: string): Promise<BankruptcyStoreEntry> {
    const existing = this.stateStore.get(runId);

    if (existing !== undefined) {
      return existing;
    }

    const pendingProposal = await this.dependencies.proposalService.findPendingByRunId(runId);

    if (pendingProposal === null) {
      throw new CoreError("NOT_FOUND", "No active bankruptcy found for run");
    }

    const dossierRef = normalizeOptionalString(pendingProposal.dossier_ref);

    if (dossierRef === null) {
      throw new CoreError("VALIDATION", "Pending bankruptcy proposal is missing dossier_ref");
    }

    const events = await this.dependencies.eventLogRepo.queryByEntity("bankruptcy_dossier", dossierRef);
    const declaredEvent = [...events]
      .reverse()
      .find((event) => event.event_type === BudgetEventType.SOUL_BUDGET_BANKRUPTCY_DECLARED);

    if (declaredEvent === undefined) {
      throw new CoreError("NOT_FOUND", "Bankruptcy declaration audit record was not found");
    }

    const payload = SoulBudgetBankruptcyDeclaredPayloadSchema.parse(declaredEvent.payload_json);
    const derivedFromTaskSurface = payload.task_surface_ref;
    const recovered = {
      state: parseState({
        runtime_id: payload.bankruptcy_id,
        object_kind: ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE,
        task_surface_ref: payload.task_surface_ref,
        expires_at: payload.expires_at,
        derived_from: derivedFromTaskSurface,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        bankruptcy_id: payload.bankruptcy_id,
        bankruptcy_kind: payload.bankruptcy_kind,
        current_mode: payload.current_mode,
        trigger_summary: payload.trigger_summary,
        dossier_ref: dossierRef,
        updated_at: payload.occurred_at
      }),
      dossier: parseDossier({
        runtime_id: dossierRef,
        object_kind: ControlPlaneObjectKind.BANKRUPTCY_DOSSIER,
        task_surface_ref: payload.task_surface_ref,
        expires_at: payload.expires_at,
        derived_from: derivedFromTaskSurface,
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
      proposalId: pendingProposal.proposal_id,
      pressureRatio: pressureRatioForKind(payload.bankruptcy_kind)
    } satisfies BankruptcyStoreEntry;

    this.stateStore.set(runId, recovered);
    return recovered;
  }
}

function parseState(value: BudgetBankruptcyState): Readonly<BudgetBankruptcyState> {
  try {
    return Object.freeze(BudgetBankruptcyStateSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid budget bankruptcy state payload", { cause: error });
  }
}

function parseDossier(value: BankruptcyDossier): Readonly<BankruptcyDossier> {
  try {
    return Object.freeze(BankruptcyDossierSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid bankruptcy dossier payload", { cause: error });
  }
}

function parseRequiredActions(value: readonly BankruptcyActionValue[]): readonly BankruptcyActionValue[] {
  if (value.length === 0) {
    throw new CoreError("VALIDATION", "requiredActions must contain at least one action");
  }

  return Object.freeze(value.map((action) => parseBankruptcyAction(action)));
}

function parseBankruptcyAction(value: BankruptcyActionValue): BankruptcyActionValue {
  switch (value) {
    case BankruptcyAction.COMPRESS:
    case BankruptcyAction.DEFER:
    case BankruptcyAction.VERIFY:
    case BankruptcyAction.ARBITRATE:
    case BankruptcyAction.STOP:
      return value;
    default:
      throw new CoreError("VALIDATION", "Invalid bankruptcy action");
  }
}

function determineBankruptcyKind(params: BudgetBankruptcyDeclareParams): ActiveBankruptcyKind {
  if (
    params.triggerKind === BankruptcyTriggerKind.SAFETY_GUARD ||
    params.triggerKind === BankruptcyTriggerKind.STRICT_CONFLICT
  ) {
    return BankruptcyKind.HARD;
  }

  if (params.droppedCandidates.some((candidate) => params.protectedConstraints.includes(candidate))) {
    return BankruptcyKind.HARD;
  }

  const hasAutoPath =
    params.requiredActions.includes(BankruptcyAction.COMPRESS) ||
    params.requiredActions.includes(BankruptcyAction.DEFER) ||
    params.triggerKind === BankruptcyTriggerKind.TOKEN_OVERFLOW ||
    params.triggerKind === BankruptcyTriggerKind.MISSING_VERIFICATION;

  return hasAutoPath ? BankruptcyKind.SOFT : BankruptcyKind.HARD;
}

function computePressureRatio(
  params: BudgetBankruptcyDeclareParams,
  kind: ActiveBankruptcyKind
): number {
  if (kind === BankruptcyKind.HARD) {
    return 1;
  }

  if (
    typeof params.tokensUsed === "number" &&
    typeof params.maxTotalTokens === "number" &&
    params.maxTotalTokens > 0
  ) {
    return clamp01(params.tokensUsed / params.maxTotalTokens);
  }

  return pressureRatioForKind(kind);
}

function pressureRatioForKind(kind: BankruptcyKindValue): number {
  switch (kind) {
    case BankruptcyKind.NONE:
      return 0;
    case BankruptcyKind.SOFT:
      return 0.5;
    case BankruptcyKind.HARD:
      return 1;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function buildProposalOptions(
  params: BudgetBankruptcyDeclareParams,
  kind: ActiveBankruptcyKind,
  dossier: Readonly<BankruptcyDossier>
): readonly Readonly<ProposalOption>[] {
  const options: ProposalOption[] = [];

  if (params.triggerKind !== BankruptcyTriggerKind.SAFETY_GUARD) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.TRIM_SOFT_CONTEXT,
        false,
        dossier.dropped_candidates,
        dossier.unresolved_conflicts
      )
    );
  }

  if (dossier.unresolved_conflicts.length > 0 && params.triggerKind !== BankruptcyTriggerKind.SAFETY_GUARD) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.FREEZE_LOW_VALUE_COMPETITION,
        false,
        [],
        dossier.unresolved_conflicts
      )
    );
  }

  if (
    params.triggerKind === BankruptcyTriggerKind.MISSING_VERIFICATION ||
    params.requiredActions.includes(BankruptcyAction.DEFER)
  ) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.DEFER_NONCRITICAL_VERIFICATION,
        false,
        dossier.dropped_candidates,
        dossier.unresolved_conflicts
      )
    );
  }

  if (kind === BankruptcyKind.HARD) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.REQUEST_CONFIRMATION,
        true,
        dossier.dropped_candidates,
        dossier.unresolved_conflicts
      )
    );
  }

  if (params.triggerKind === BankruptcyTriggerKind.SAFETY_GUARD) {
    options.push(
      buildProposalOption(ProposalOptionKind.ABORT_HIGH_RISK_WRITE, true, [], dossier.unresolved_conflicts)
    );
  }

  if (options.length === 0) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.REQUEST_CONFIRMATION,
        true,
        dossier.dropped_candidates,
        dossier.unresolved_conflicts
      )
    );
  }

  return Object.freeze(options.map((option) => Object.freeze(option)));
}

function buildProposalOption(
  optionKind: ProposalOption["option_kind"],
  requiresConfirmation: boolean,
  droppedCandidates: readonly string[],
  unresolvedAfterApply: readonly string[]
): ProposalOption {
  return {
    option_id: `${optionKind}_${randomUUID()}`,
    option_kind: optionKind,
    preserves_protected_constraints: true,
    dropped_candidates: Object.freeze([...droppedCandidates]),
    unresolved_after_apply: Object.freeze([...unresolvedAfterApply]),
    requires_confirmation: requiresConfirmation
  };
}

function getAutoApplicableOption(proposal: Readonly<Proposal>): Readonly<ProposalOption> | null {
  return (
    proposal.proposal_options.find(
      (option) => option.preserves_protected_constraints && option.requires_confirmation === false
    ) ?? null
  );
}

function deriveResolvedMode(
  currentMode: RuntimeModeValue,
  optionKind: ProposalOption["option_kind"]
): RuntimeModeValue {
  switch (optionKind) {
    case ProposalOptionKind.TRIM_SOFT_CONTEXT:
    case ProposalOptionKind.FREEZE_LOW_VALUE_COMPETITION:
    case ProposalOptionKind.DEFER_NONCRITICAL_VERIFICATION:
      return currentMode === RuntimeMode.MINIMAL ? RuntimeMode.MINIMAL : RuntimeMode.LEAN;
    case ProposalOptionKind.REQUEST_CONFIRMATION:
    case ProposalOptionKind.ABORT_HIGH_RISK_WRITE:
      return RuntimeMode.MINIMAL;
  }
}

function ensureIsoDatetime(value: string, fieldName: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", `${fieldName} must return a valid ISO timestamp`);
  }

  return new Date(epoch).toISOString();
}

function normalizeOptionalTimestamp(value: string | null | undefined, fieldName: string): string | null {
  const parsed = normalizeOptionalString(value);
  return parsed === null ? null : ensureIsoDatetime(parsed, fieldName);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
