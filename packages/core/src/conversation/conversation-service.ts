import type {
  ConversationGardenComputeProviderPort,
  ConversationListPageOptions,
  ConversationServiceDependencies,
  ConversationMessage,
  ExecutionStanceModelRef,
  GardenProviderCallTelemetry,
  GardenProviderKind,
  MemoryContextAssemblyInput,
  MemoryContextAssemblyResult,
  MemoryTurnOrchestrationInput,
  MemoryTurnOrchestrationResult,
  Run,
  RunInterruptResult,
  RuntimeModeValue,
  Workspace
} from "./conversation-service-internal.js";

export type {
  ConversationBudgetBankruptcyPort,
  ConversationContextLensAssemblerPort,
  ConversationEventLogRepoPort,
  ConversationGardenComputeProviderPort,
  ConversationGardenComputeProviderResolverPort,
  ConversationGovernanceLeasePort,
  ConversationListPageOptions,
  ConversationRunRepoPort,
  ConversationServiceDependencies,
  ConversationSignalReceiverPort,
  ConversationSessionOverridePromotionPort,
  ConversationWarnPort,
  ConversationWorkspaceRepoPort,
  MemoryContextAssemblyInput,
  MemoryContextAssemblyResult,
  MemoryTurnOrchestrationInput,
  MemoryTurnOrchestrationResult
} from "./conversation-service-internal.js";

import { conversationServiceListMessages, conversationServiceCountMessages, conversationServiceSendMessage, conversationServiceSendMessageStreaming, conversationServiceInterruptRun, conversationServiceAssembleMemoryContext, conversationServiceOrchestrateMemoryTurn } from "./conversation-service-methods-1.js";
import { conversationServiceAssembleContextForTurn, conversationServiceTriggerGardenCompile } from "./conversation-service-methods-2.js";
import { conversationServiceRecordGardenProviderCallStarted, conversationServiceRecordGardenProviderCallCompleted } from "./conversation-service-methods-3.js";
import { conversationServiceRecordGardenProviderCallFailed, conversationServiceRecordGardenProviderCallJournal, conversationServiceResolveGardenComputeProvider, conversationServiceReleaseGovernanceLeaseSafely, conversationServiceRequireRun } from "./conversation-service-methods-4.js";
import { conversationServiceRequireWorkspace } from "./conversation-service-methods-5.js";

export class ConversationService {
public constructor(public readonly dependencies: ConversationServiceDependencies) {}

  public async listMessages(runId: string, page?: ConversationListPageOptions): Promise<readonly ConversationMessage[]> {
    return conversationServiceListMessages(this, runId, page);
  }

  public async countMessages(runId: string): Promise<number> {
    return conversationServiceCountMessages(this, runId);
  }

  public async sendMessage(_runId: string, _input: unknown): Promise<never> {
    return conversationServiceSendMessage(this, _runId, _input);
  }

  public async sendMessageStreaming(_runId: string, _input: unknown): Promise<never> {
    return conversationServiceSendMessageStreaming(this, _runId, _input);
  }

  public async interruptRun(runId: string): Promise<RunInterruptResult> {
    return conversationServiceInterruptRun(this, runId);
  }

  public async assembleMemoryContext(runId: string, input: MemoryContextAssemblyInput = {}): Promise<MemoryContextAssemblyResult> {
    return conversationServiceAssembleMemoryContext(this, runId, input);
  }

  public async orchestrateMemoryTurn(input: MemoryTurnOrchestrationInput): Promise<MemoryTurnOrchestrationResult> {
    return conversationServiceOrchestrateMemoryTurn(this, input);
  }

  private async assembleContextForTurn(input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly displayName?: string;
    readonly runtimeMode?: RuntimeModeValue;
  }): Promise<MemoryContextAssemblyResult> {
    return conversationServiceAssembleContextForTurn(this, input);
  }

  private triggerGardenCompile(input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly modelRef: ExecutionStanceModelRef | null;
    readonly userMessage: ConversationMessage;
    readonly assistantMessage: ConversationMessage;
  }): void {
    return conversationServiceTriggerGardenCompile(this, input);
  }

  private async recordGardenProviderCallStarted(input: {
      readonly run: Run;
      readonly workspace: Workspace;
      readonly modelRef: ExecutionStanceModelRef | null;
    }, gardenComputeProvider: ConversationGardenComputeProviderPort): Promise<GardenProviderCallTelemetry | null> {
    return conversationServiceRecordGardenProviderCallStarted(this, input, gardenComputeProvider);
  }

  private async recordGardenProviderCallCompleted(input: {
      readonly run: Run;
      readonly workspace: Workspace;
    }, providerCall: GardenProviderCallTelemetry | null, gardenComputeProvider: ConversationGardenComputeProviderPort): Promise<void> {
    return conversationServiceRecordGardenProviderCallCompleted(this, input, providerCall, gardenComputeProvider);
  }

  private async recordGardenProviderCallFailed(input: {
      readonly run: Run;
      readonly workspace: Workspace;
    }, providerCall: GardenProviderCallTelemetry | null, gardenComputeProvider: ConversationGardenComputeProviderPort, error: unknown): Promise<void> {
    return conversationServiceRecordGardenProviderCallFailed(this, input, providerCall, gardenComputeProvider, error);
  }

  private async recordGardenProviderCallJournal(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly providerCall: GardenProviderCallTelemetry;
    readonly providerKind: GardenProviderKind;
    readonly status: "completed" | "failed";
    readonly latencyMs: number;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    return conversationServiceRecordGardenProviderCallJournal(this, input);
  }

  private async resolveGardenComputeProvider(modelRef: Readonly<ExecutionStanceModelRef> | null): Promise<ConversationGardenComputeProviderPort> {
    return conversationServiceResolveGardenComputeProvider(this, modelRef);
  }

  private async releaseGovernanceLeaseSafely(runId: string, workspaceId: string, phase: string): Promise<void> {
    return conversationServiceReleaseGovernanceLeaseSafely(this, runId, workspaceId, phase);
  }

  private async requireRun(runId: string): Promise<Run> {
    return conversationServiceRequireRun(this, runId);
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    return conversationServiceRequireWorkspace(this, workspaceId);
  }
}
