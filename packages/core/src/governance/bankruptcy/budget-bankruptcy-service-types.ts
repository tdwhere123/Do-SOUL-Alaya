import type {
  BankruptcyAction as BankruptcyActionValue,
  BankruptcyDossier,
  BankruptcyKind as BankruptcyKindValue,
  BankruptcyTriggerKind as BankruptcyTriggerKindValue,
  BudgetBankruptcyState,
  EventLogEntry,
  Proposal,
  ProposalOption,
  ProposalResolutionState as ProposalResolutionStateValue,
  RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";

export type ActiveBankruptcyKind = Exclude<BankruptcyKindValue, "none">;

export interface BankruptcyStoreEntry {
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
  readonly stateStoreMaxEntries?: number;
  readonly stateStoreTtlMs?: number;
}
