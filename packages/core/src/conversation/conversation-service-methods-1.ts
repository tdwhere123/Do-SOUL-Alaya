import { CoreError } from "../shared/errors.js";
import { rebuildConversationMessages } from "./message-history.js";
import {
  applyMessagePage,
  queryConversationMessageEvents,
  queryRunEventLog,
  requireRun,
  requireWorkspace,
  releaseGovernanceLeaseSafely,
  type ConversationListPageOptions,
  type ConversationMessage,
  type ConversationServiceMethodOwner,
  type MemoryContextAssemblyInput,
  type MemoryContextAssemblyResult,
  type MemoryTurnOrchestrationInput,
  type MemoryTurnOrchestrationResult,
  type RunInterruptResult
} from "./conversation-service-internal.js";
import { conversationServiceAssembleContextForTurn, conversationServiceTriggerGardenCompile } from "./conversation-service-methods-2.js";

export async function conversationServiceListMessages(owner: ConversationServiceMethodOwner, runId: string, page?: ConversationListPageOptions): Promise<readonly ConversationMessage[]> {
    const run = await requireRun(owner, runId);
    const pagedReader = owner.dependencies.eventLogRepo.queryConversationMessageEventsByRun;
    if (pagedReader === undefined) {
      const messages = rebuildConversationMessages(await queryRunEventLog(owner.dependencies.eventLogRepo, run.run_id));
      return applyMessagePage(messages, page);
    }
    const events = await queryConversationMessageEvents(owner.dependencies.eventLogRepo, run.run_id, page);
    return rebuildConversationMessages(events);
  }

export async function conversationServiceCountMessages(owner: ConversationServiceMethodOwner, runId: string): Promise<number> {
    const run = await requireRun(owner, runId);
    const counter = owner.dependencies.eventLogRepo.countConversationMessageEventsByRun;
    if (counter !== undefined) {
      return await counter.call(owner.dependencies.eventLogRepo, run.run_id);
    }
    return rebuildConversationMessages(await queryRunEventLog(owner.dependencies.eventLogRepo, run.run_id)).length;
  }

export async function conversationServiceSendMessage(owner: ConversationServiceMethodOwner, _runId: string, _input: unknown): Promise<never> {
    throw new CoreError(
      "CONFLICT",
      "Alaya ConversationService does not execute chat turns; use MCP memory tools."
    );
  }

export async function conversationServiceSendMessageStreaming(owner: ConversationServiceMethodOwner, _runId: string, _input: unknown): Promise<never> {
    throw new CoreError(
      "CONFLICT",
      "Alaya ConversationService does not expose chat streaming; use MCP request/response tools."
    );
  }

export async function conversationServiceInterruptRun(owner: ConversationServiceMethodOwner, runId: string): Promise<RunInterruptResult> {
    await requireRun(owner, runId);
    return {
      run_id: runId,
      status: "unsupported",
      message: "Alaya does not own an interrupt-capable chat runtime session."
    };
  }

export async function conversationServiceAssembleMemoryContext(owner: ConversationServiceMethodOwner, runId: string, input: MemoryContextAssemblyInput = {}): Promise<MemoryContextAssemblyResult> {
    const run = await requireRun(owner, runId);
    const workspace = await requireWorkspace(owner, run.workspace_id);
    return conversationServiceAssembleContextForTurn(owner, {
      run,
      workspace,
      displayName: input.displayName,
      runtimeMode: input.runtimeMode
    });
  }

export async function conversationServiceOrchestrateMemoryTurn(owner: ConversationServiceMethodOwner, input: MemoryTurnOrchestrationInput): Promise<MemoryTurnOrchestrationResult> {
    const run = await requireRun(owner, input.runId);
    const workspace = await requireWorkspace(owner, run.workspace_id);

    await owner.dependencies.governanceLeaseService?.acquire({
      runId: run.run_id,
      workspaceId: workspace.workspace_id
    });

    let gardenTakesLease = false;
    try {
      const memoryContext = await conversationServiceAssembleContextForTurn(owner, {
        run,
        workspace,
        displayName: input.displayName ?? input.userMessage.content.slice(0, 80)
      });

      gardenTakesLease = true;
      conversationServiceTriggerGardenCompile(owner, {
        run,
        workspace,
        modelRef: input.modelRef ?? null,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage
      });

      return {
        run,
        workspace,
        ...memoryContext
      };
    } finally {
      if (!gardenTakesLease) {
        await releaseGovernanceLeaseSafely(owner, run.run_id, workspace.workspace_id, "memory turn processing");
      }
    }
  }
