import {
  RuntimeMode,
  type CandidateMemorySignal,
  type ContextLens,
  type ConversationMessage,
  type EventLogEntry,
  type ExecutionStanceModelRef,
  type GardenProviderKind,
  type HealthJournalRecordPort,
  type Run,
  type RunInterruptResult,
  type RuntimeMode as RuntimeModeValue,
  type Workspace,
  type WorkingProjection
} from "@do-soul/alaya-protocol";

import type { SignalServiceReceiveResult } from "../memory/signal-service.js";

export { RuntimeMode };
export type {
  CandidateMemorySignal,
  ContextLens,
  ConversationMessage,
  EventLogEntry,
  ExecutionStanceModelRef,
  GardenProviderKind,
  HealthJournalRecordPort,
  Run,
  RunInterruptResult,
  RuntimeModeValue,
  Workspace,
  WorkingProjection
};

export interface ConversationRunRepoPort {
  getById(id: string): Promise<Run | null>;
}

export interface ConversationWorkspaceRepoPort {
  getById(id: string): Promise<Workspace | null>;
}

export interface ConversationEventLogRepoPort {
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
  queryByRunAll(runId: string): Promise<readonly EventLogEntry[]>;
  queryConversationMessageEventsByRun?(
    runId: string,
    page?: ConversationListPageOptions
  ): Promise<readonly EventLogEntry[]>;
  countConversationMessageEventsByRun?(runId: string): Promise<number>;
  append?(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface ConversationListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface ConversationGardenComputeProviderPort {
  readonly provider_kind: GardenProviderKind;
  compile(
    turnContent: string,
    context: {
      readonly workspace_id: string;
      readonly run_id: string;
      readonly surface_id: string | null;
      readonly turn_messages: readonly ConversationMessage[];
    }
  ): Promise<readonly CandidateMemorySignal[]>;
}

export interface ConversationGardenComputeProviderResolverPort {
  resolve(
    modelRef: Readonly<ExecutionStanceModelRef> | null
  ): Promise<ConversationGardenComputeProviderPort | null> | ConversationGardenComputeProviderPort | null;
}

export interface ConversationSignalReceiverPort {
  receiveSignal(signal: CandidateMemorySignal): Promise<SignalServiceReceiveResult | unknown>;
}

export interface ConversationWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export interface ConversationGovernanceLeasePort {
  acquire(params: {
    readonly runId: string;
    readonly workspaceId: string;
  }): Promise<unknown>;
  release(runId: string): Promise<void>;
}

export interface ConversationSessionOverridePromotionPort {
  evaluateActiveForRun(params: {
    readonly runId: string;
    readonly workspaceId: string;
  }): Promise<void>;
}

export interface ConversationContextLensAssemblerPort {
  assemble(params: {
    readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
    readonly surfaceId: string | null;
    readonly displayName?: string;
    readonly runtimeMode: RuntimeModeValue;
  }): Promise<{
    readonly contextLens: Readonly<ContextLens>;
    readonly workingProjection: Readonly<WorkingProjection>;
  }>;
}

export interface ConversationBudgetBankruptcyPort {
  getSnapshot(runId: string, now: string): Promise<{ readonly current_mode: RuntimeModeValue }>;
}

export interface ConversationServiceDependencies {
  readonly runRepo: ConversationRunRepoPort;
  readonly workspaceRepo: ConversationWorkspaceRepoPort;
  readonly eventLogRepo: ConversationEventLogRepoPort;
  readonly gardenComputeProvider: ConversationGardenComputeProviderPort;
  readonly resolveGardenComputeProvider?: ConversationGardenComputeProviderResolverPort;
  readonly signalReceiver: ConversationSignalReceiverPort;
  readonly governanceLeaseService?: ConversationGovernanceLeasePort;
  readonly sessionOverridePromotion?: ConversationSessionOverridePromotionPort;
  readonly contextLensAssembler?: ConversationContextLensAssemblerPort;
  readonly budgetBankruptcyService?: ConversationBudgetBankruptcyPort;
  readonly healthJournalRecorder?: HealthJournalRecordPort;
  readonly warn: ConversationWarnPort;
}

export interface MemoryContextAssemblyInput {
  readonly displayName?: string;
  readonly runtimeMode?: RuntimeModeValue;
}

export interface MemoryContextAssemblyResult {
  readonly contextLens: Readonly<ContextLens> | null;
  readonly workingProjection: Readonly<WorkingProjection> | null;
  readonly recalledContextSection: string;
}

export interface MemoryTurnOrchestrationInput {
  readonly runId: string;
  readonly userMessage: ConversationMessage;
  readonly assistantMessage: ConversationMessage;
  readonly modelRef?: ExecutionStanceModelRef | null;
  readonly displayName?: string;
}

export interface MemoryTurnOrchestrationResult extends MemoryContextAssemblyResult {
  readonly run: Readonly<Run>;
  readonly workspace: Readonly<Workspace>;
}

export interface GardenMaterializationBatchStats {
  readonly total_signals: number;
  readonly memory_and_claim: number;
  readonly synthesis: number;
  readonly handoff_gap: number;
  readonly evidence_only: number;
  readonly deferred: number;
}

export interface GardenProviderCallTelemetry {
  readonly callId: string;
  readonly startedAt: string;
  readonly startedAtEpochMs: number;
  readonly modelId: string;
}

export const MAX_RECALLED_CONTEXT_CHARS = 4_000;

export const CONVERSATION_EVENT_SCAN_PAGE_LIMIT = 500;

export function buildRecalledContextSection(workingProjection: Readonly<WorkingProjection>): string {
  if (workingProjection.entries.length === 0) {
    return "";
  }

  let recalledBody = workingProjection.entries
    .map((entry) => `- ${entry.content_snapshot}`)
    .join("\n");

  if (recalledBody.length > MAX_RECALLED_CONTEXT_CHARS) {
    recalledBody = `${recalledBody.slice(0, MAX_RECALLED_CONTEXT_CHARS)}\n...(truncated)`;
  }

  return `<recalled_context>\n${recalledBody}\n</recalled_context>`;
}

export function createGardenMaterializationBatchStats(): GardenMaterializationBatchStats {
  return {
    total_signals: 0,
    memory_and_claim: 0,
    synthesis: 0,
    handoff_gap: 0,
    evidence_only: 0,
    deferred: 0
  };
}

export function recordSignalResult(
  stats: GardenMaterializationBatchStats,
  result: SignalServiceReceiveResult | unknown
): GardenMaterializationBatchStats {
  const next = {
    ...stats,
    total_signals: stats.total_signals + 1
  };

  if (!isSignalServiceReceiveResult(result)) {
    return {
      ...next,
      deferred: next.deferred + 1
    };
  }

  if (result.triage_result === "dropped" || result.triage_result === "deferred") {
    return {
      ...next,
      deferred: next.deferred + 1
    };
  }

  switch (result.materialization?.target_kind) {
    case "memory_and_claim":
      return {
        ...next,
        memory_and_claim: next.memory_and_claim + 1
      };
    case "synthesis":
      return {
        ...next,
        synthesis: next.synthesis + 1
      };
    case "handoff_gap":
      return {
        ...next,
        handoff_gap: next.handoff_gap + 1
      };
    case "evidence_only":
      return {
        ...next,
        evidence_only: next.evidence_only + 1
      };
    default:
      return {
        ...next,
        deferred: next.deferred + 1
      };
  }
}

export function getGardenProviderFailureKind(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "unknown_error";
}

export function applyMessagePage(
  messages: readonly ConversationMessage[],
  page: ConversationListPageOptions | undefined
): readonly ConversationMessage[] {
  if (page === undefined) {
    return messages;
  }
  return messages.slice(page.offset, page.offset + page.limit);
}

export async function queryConversationMessageEvents(
  repo: ConversationEventLogRepoPort,
  runId: string,
  page: ConversationListPageOptions | undefined
): Promise<readonly EventLogEntry[]> {
  const pagedReader = repo.queryConversationMessageEventsByRun;
  if (pagedReader === undefined) {
    return queryRunEventLog(repo, runId);
  }
  if (page !== undefined) {
    return await pagedReader.call(repo, runId, page);
  }
  const rows: EventLogEntry[] = [];
  for (let offset = 0; ; offset += CONVERSATION_EVENT_SCAN_PAGE_LIMIT) {
    const pageRows = await pagedReader.call(repo, runId, {
      limit: CONVERSATION_EVENT_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...pageRows);
    if (pageRows.length < CONVERSATION_EVENT_SCAN_PAGE_LIMIT) {
      return rows;
    }
  }
}

export async function queryRunEventLog(
  repo: ConversationEventLogRepoPort,
  runId: string
): Promise<readonly EventLogEntry[]> {
  return repo.queryByRunAll(runId);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isSignalServiceReceiveResult(value: unknown): value is SignalServiceReceiveResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly triage_result?: unknown;
    readonly signal?: { readonly signal_id?: unknown };
  };

  return (
    (candidate.triage_result === "accepted" ||
      candidate.triage_result === "dropped" ||
      candidate.triage_result === "deferred") &&
    typeof candidate.signal?.signal_id === "string"
  );
}
