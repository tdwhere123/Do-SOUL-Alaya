import { randomUUID } from "node:crypto";
import {
  BankruptcyKind,
  BudgetEventType,
  BudgetSnapshotSchema,
  ProposalResolutionState,
  SoulBudgetBankruptcyDeclaredPayloadSchema,
  SoulBudgetBankruptcyResolvedPayloadSchema,
  type BankruptcyDossier,
  type BudgetBankruptcyState,
  type BudgetSnapshot,
  type EventLogEntry,
  type Proposal,
  type RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { parseNonEmptyString } from "../../shared/validators.js";
import {
  buildBankruptcyDossier,
  buildBankruptcyState,
  buildResolvedState,
  createStoreEntry,
  parseResolutionAction
} from "./budget-bankruptcy-service-artifacts.js";
import {
  buildProposalOptions,
  computePressureRatio,
  determineBankruptcyKind,
  ensureIsoDatetime,
  getAutoApplicableOption,
  normalizeOptionalString,
  normalizeOptionalTimestamp
} from "./budget-bankruptcy-service-helpers.js";
import {
  buildEmptyBudgetSnapshot,
  buildPendingProposalSnapshot,
  buildRecoveredEntry,
  normalizeProposalDossierRef,
  requireDeclaredEvent
} from "./budget-bankruptcy-service-recovery.js";
import type {
  ActiveBankruptcyKind,
  BankruptcyStoreEntry,
  BudgetBankruptcyDeclareParams,
  BudgetBankruptcyDeclareResult,
  BudgetBankruptcyResolveParams,
  BudgetBankruptcyServiceDependencies
} from "./budget-bankruptcy-service-types.js";

export type {
  ActiveBankruptcyKind,
  BankruptcyStoreEntry,
  BudgetBankruptcyDeclareParams,
  BudgetBankruptcyDeclareResult,
  BudgetBankruptcyResolveParams,
  BudgetBankruptcyRuntimeNotifierPort,
  BudgetBankruptcyServiceDependencies,
  BudgetBankruptcyServiceEventLogPort,
  BudgetBankruptcyServiceProposalPort
} from "./budget-bankruptcy-service-types.js";

interface DeclarationArtifacts {
  readonly kind: ActiveBankruptcyKind;
  readonly pressureRatio: number;
  readonly dossier: Readonly<BankruptcyDossier>;
  readonly initialState: Readonly<BudgetBankruptcyState>;
  readonly options: readonly Readonly<Proposal["proposal_options"][number]>[];
  readonly recommendedOptionId: string | null;
}

const DEFAULT_STATE_STORE_MAX_ENTRIES = 1024;
const DEFAULT_STATE_STORE_TTL_MS = 24 * 60 * 60 * 1000;

export class BudgetBankruptcyService {
  private readonly stateStore = new Map<string, BankruptcyStoreEntry>();
  private readonly inFlightDeclarations = new Map<string, Promise<BudgetBankruptcyDeclareResult>>();
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly stateStoreMaxEntries: number;
  private readonly stateStoreTtlMs: number;

  public constructor(private readonly dependencies: BudgetBankruptcyServiceDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.stateStoreMaxEntries = normalizePositiveInteger(
      dependencies.stateStoreMaxEntries,
      DEFAULT_STATE_STORE_MAX_ENTRIES
    );
    this.stateStoreTtlMs = normalizePositiveInteger(
      dependencies.stateStoreTtlMs,
      DEFAULT_STATE_STORE_TTL_MS
    );
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

  public async resolve(params: BudgetBankruptcyResolveParams): Promise<Readonly<Proposal>> {
    const occurredAt = ensureIsoDatetime(this.now(), "now");
    const runId = parseNonEmptyString(params.runId, "runId");
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const optionId = parseNonEmptyString(params.optionId, "optionId");
    const action = parseResolutionAction(params.action);
    const entry = await this.getOrRecoverEntry(runId);
    const proposal = await this.requirePendingProposal(entry.proposalId);
    const option = proposal.proposal_options.find((candidate) => candidate.option_id === optionId);
    if (option === undefined) {
      throw new CoreError("VALIDATION", "option_id must belong to the active proposal");
    }

    const resolutionState =
      action === "accept" ? ProposalResolutionState.ACCEPTED : ProposalResolutionState.REJECTED;
    const resolvedEvent = await this.appendResolvedEvent(
      entry,
      proposal.proposal_id,
      action === "accept" ? option.option_id : null,
      resolutionState,
      runId,
      workspaceId,
      occurredAt,
      "user"
    );
    const updatedProposal = await this.dependencies.proposalService.update(proposal.proposal_id, {
      resolution_state: resolutionState,
      last_updated_at: occurredAt
    });
    this.setStateStoreEntry(
      runId,
      createStoreEntry(
        buildResolvedState(entry.state, option.option_kind, action === "accept", occurredAt),
        entry.dossier,
        updatedProposal.proposal_id,
        entry.pressureRatio
      )
    );
    await this.dependencies.runtimeNotifier.notifyEntry(resolvedEvent);
    return updatedProposal;
  }

  public async getSnapshot(runId: string, now: string): Promise<Readonly<BudgetSnapshot>> {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    const snapshotAt = ensureIsoDatetime(now, "now");
    const entry = await this.resolveSnapshotEntry(parsedRunId);
    if (entry === null) {
      return buildEmptyBudgetSnapshot(parsedRunId, snapshotAt);
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
      pending_proposal: buildPendingProposalSnapshot(proposal)
    });
  }

  public clearRun(runId: string): void {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    this.stateStore.delete(parsedRunId);
    this.inFlightDeclarations.delete(parsedRunId);
  }

  private getStateStoreEntry(runId: string): BankruptcyStoreEntry | undefined {
    this.pruneExpiredStateStoreEntries();
    const existing = this.stateStore.get(runId);
    if (existing === undefined) {
      return undefined;
    }
    this.stateStore.delete(runId);
    this.stateStore.set(runId, existing);
    return existing;
  }

  private setStateStoreEntry(runId: string, entry: BankruptcyStoreEntry): void {
    this.pruneExpiredStateStoreEntries();
    if (this.stateStore.has(runId)) {
      this.stateStore.delete(runId);
    }
    this.stateStore.set(runId, entry);
    this.pruneStateStoreToMax();
  }

  private pruneExpiredStateStoreEntries(): void {
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) {
      return;
    }
    for (const [runId, entry] of this.stateStore.entries()) {
      const updatedMs = Date.parse(entry.state.updated_at);
      if (Number.isFinite(updatedMs) && nowMs - updatedMs > this.stateStoreTtlMs) {
        this.stateStore.delete(runId);
      }
    }
  }

  private pruneStateStoreToMax(): void {
    while (this.stateStore.size > this.stateStoreMaxEntries) {
      const oldestRunId = this.stateStore.keys().next().value;
      if (typeof oldestRunId !== "string") {
        return;
      }
      this.stateStore.delete(oldestRunId);
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

    const artifacts = this.buildDeclarationArtifacts(params, effectiveMode, occurredAt);
    const declaredEvent = await this.appendDeclaredEvent(artifacts, runId, workspaceId, occurredAt);
    const proposal = await this.dependencies.proposalService.create({
      workspaceId,
      runId,
      dossierRef: artifacts.dossier.runtime_id,
      options: artifacts.options,
      recommendedOptionId: artifacts.recommendedOptionId,
      expiresAt: artifacts.initialState.expires_at
    });
    const entry = createStoreEntry(artifacts.initialState, artifacts.dossier, proposal.proposal_id, artifacts.pressureRatio);

    if (artifacts.kind === BankruptcyKind.SOFT) {
      return await this.autoResolveSoftDeclaration(entry, proposal, runId, workspaceId, declaredEvent);
    }

    this.setStateStoreEntry(runId, entry);
    await this.dependencies.runtimeNotifier.notifyEntry(declaredEvent);
    return { state: entry.state, dossier: entry.dossier, proposal };
  }

  private getStickyCurrentMode(runId: string, fallback: RuntimeModeValue): RuntimeModeValue {
    const existing = this.getStateStoreEntry(runId);
    return existing?.state.current_mode ?? fallback;
  }

  private async getActivePendingProposal(runId: string): Promise<Readonly<Proposal> | null> {
    const existing = this.getStateStoreEntry(runId);
    if (existing !== undefined) {
      const proposal = await this.dependencies.proposalService.findById(existing.proposalId);
      if (proposal !== null && proposal.resolution_state === ProposalResolutionState.PENDING) {
        return proposal;
      }
    }
    return await this.dependencies.proposalService.findPendingByRunId(runId);
  }

  private buildDeclarationArtifacts(
    params: BudgetBankruptcyDeclareParams,
    effectiveMode: RuntimeModeValue,
    occurredAt: string
  ): DeclarationArtifacts {
    const bankruptcyId = this.generateRuntimeId();
    const dossierId = this.generateRuntimeId();
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

  private async autoResolveSoftDeclaration(
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

    const resolvedAt = ensureIsoDatetime(this.now(), "now");
    const resolvedEvent = await this.appendResolvedEvent(
      entry,
      proposal.proposal_id,
      autoOption.option_id,
      ProposalResolutionState.AUTO_APPLIED,
      runId,
      workspaceId,
      resolvedAt,
      "system"
    );
    const updatedProposal = await this.dependencies.proposalService.update(proposal.proposal_id, {
      resolution_state: ProposalResolutionState.AUTO_APPLIED,
      last_updated_at: resolvedAt
    });
    const updatedEntry = createStoreEntry(
      buildResolvedState(entry.state, autoOption.option_kind, true, resolvedAt),
      entry.dossier,
      updatedProposal.proposal_id,
      entry.pressureRatio
    );
    this.setStateStoreEntry(runId, updatedEntry);
    await this.dependencies.runtimeNotifier.notifyEntry(declaredEvent);
    await this.dependencies.runtimeNotifier.notifyEntry(resolvedEvent);
    return { state: updatedEntry.state, dossier: updatedEntry.dossier, proposal: updatedProposal };
  }

  private async resolveSnapshotEntry(runId: string): Promise<BankruptcyStoreEntry | null> {
    const existing = this.getStateStoreEntry(runId) ?? null;
    if (existing !== null) {
      return existing;
    }

    try {
      return await this.getOrRecoverEntry(runId);
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  private async getOrRecoverEntry(runId: string): Promise<BankruptcyStoreEntry> {
    const existing = this.getStateStoreEntry(runId);
    if (existing !== undefined) {
      return existing;
    }

    const pendingProposal = await this.dependencies.proposalService.findPendingByRunId(runId);
    if (pendingProposal === null) {
      throw new CoreError("NOT_FOUND", "No active bankruptcy found for run");
    }

    const dossierRef = normalizeProposalDossierRef(pendingProposal.dossier_ref);
    if (dossierRef === null) {
      throw new CoreError("VALIDATION", "Pending bankruptcy proposal is missing dossier_ref");
    }

    const declaredEvent = await requireDeclaredEvent(this.dependencies, dossierRef);
    const recovered = buildRecoveredEntry(dossierRef, pendingProposal.proposal_id, declaredEvent);
    this.setStateStoreEntry(runId, recovered);
    return recovered;
  }

  private async requirePendingProposal(proposalId: string): Promise<Readonly<Proposal>> {
    const proposal = await this.dependencies.proposalService.findById(proposalId);
    if (proposal === null) {
      throw new CoreError("NOT_FOUND", "Bankruptcy proposal not found");
    }
    if (proposal.resolution_state !== ProposalResolutionState.PENDING) {
      throw new CoreError("VALIDATION", `Proposal is already ${proposal.resolution_state}`);
    }
    return proposal;
  }

  private async appendDeclaredEvent(
    artifacts: DeclarationArtifacts,
    runId: string,
    workspaceId: string,
    occurredAt: string
  ): Promise<EventLogEntry> {
    return await this.dependencies.eventLogRepo.append({
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

  private async appendResolvedEvent(
    entry: BankruptcyStoreEntry,
    proposalId: string,
    optionIdApplied: string | null,
    resolutionState: ProposalResolutionState,
    runId: string,
    workspaceId: string,
    occurredAt: string,
    causedBy: "system" | "user"
  ): Promise<EventLogEntry> {
    return await this.dependencies.eventLogRepo.append({
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
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
