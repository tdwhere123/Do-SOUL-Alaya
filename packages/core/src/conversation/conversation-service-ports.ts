import {
  RuntimeMode,
  type CandidateMemorySignal,
  type ContextLens,
  type ConversationMessage,
  type EventLogEntry,
  type Run,
  type RunInterruptResult,
  type RuntimeMode as RuntimeModeValue,
  type Workspace,
  type WorkingProjection
} from "@do-soul/alaya-protocol";

import type { SignalServiceReceiveResult } from "../memory/signal-service.js";
import type { EventPublisher } from "../runtime/event-publisher.js";

export { RuntimeMode };
export type {
  CandidateMemorySignal,
  ContextLens,
  ConversationMessage,
  EventLogEntry,
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
  queryConversationMessageEventsByRun(
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

export interface ConversationSignalReceiverPort {
  receiveSignal(signal: CandidateMemorySignal): Promise<SignalServiceReceiveResult | unknown>;
}

export interface ConversationWarnPort {
  (message: string, meta: Record<string, unknown>): void;
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
  readonly eventPublisher?: EventPublisher;
  readonly signalReceiver: ConversationSignalReceiverPort;
  readonly contextLensAssembler?: ConversationContextLensAssemblerPort;
  readonly budgetBankruptcyService?: ConversationBudgetBankruptcyPort;
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
  if (page !== undefined) {
    return await repo.queryConversationMessageEventsByRun(runId, page);
  }
  const rows: EventLogEntry[] = [];
  for (let offset = 0; ; offset += CONVERSATION_EVENT_SCAN_PAGE_LIMIT) {
    const pageRows = await repo.queryConversationMessageEventsByRun(runId, {
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
  return queryConversationMessageEvents(repo, runId, undefined);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
