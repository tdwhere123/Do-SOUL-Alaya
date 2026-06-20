import { randomUUID } from "node:crypto";
import {
  ProposalResolutionState,
  type BudgetSnapshot,
  type Proposal,
  type RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  budgetBankruptcyServiceDeclareInternal,
  budgetBankruptcyServiceGetOrRecoverEntry,
  budgetBankruptcyServiceGetSnapshot,
  budgetBankruptcyServiceResolve
} from "./budget-bankruptcy-service-methods.js";
import type {
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

    const declaration = budgetBankruptcyServiceDeclareInternal(this.createMethodOwner(), params, runId, workspaceId);
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
    return await budgetBankruptcyServiceResolve(
      this.createMethodOwner(),
      (runId) => this.getOrRecoverEntry(runId),
      params
    );
  }

  public async getSnapshot(runId: string, now: string): Promise<Readonly<BudgetSnapshot>> {
    return await budgetBankruptcyServiceGetSnapshot(
      this.createMethodOwner(),
      (recoveryRunId) => this.getOrRecoverEntry(recoveryRunId),
      runId,
      now
    );
  }

  public clearRun(runId: string): void {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    this.stateStore.delete(parsedRunId);
    this.inFlightDeclarations.delete(parsedRunId);
  }

  private createMethodOwner() {
    return {
      dependencies: this.dependencies,
      stateStore: this.stateStore,
      generateRuntimeId: this.generateRuntimeId,
      now: this.now,
      getStickyCurrentMode: (runId: string, fallback: RuntimeModeValue) =>
        this.getStickyCurrentMode(runId, fallback),
      getActivePendingProposal: (runId: string) => this.getActivePendingProposal(runId)
    };
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
    return await budgetBankruptcyServiceGetOrRecoverEntry(this.createMethodOwner(), runId);
  }
}
