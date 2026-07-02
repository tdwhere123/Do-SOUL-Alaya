import { CoreError } from "../shared/errors.js";

import { GardenComputeCoordinator } from "./garden-compute-coordinator.js";
import { rebuildConversationMessages } from "./message-history.js";
import {
  RuntimeMode,
  buildRecalledContextSection,
  queryConversationMessageEvents,
  queryRunEventLog,
  type ConversationListPageOptions,
  type ConversationMessage,
  type ConversationServiceDependencies,
  type MemoryContextAssemblyInput,
  type MemoryContextAssemblyResult,
  type MemoryTurnOrchestrationInput,
  type MemoryTurnOrchestrationResult,
  type Run,
  type RunInterruptResult,
  type RuntimeModeValue,
  type Workspace
} from "./conversation-service-ports.js";

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
} from "./conversation-service-ports.js";

export class ConversationService {
  private readonly gardenComputeCoordinator: GardenComputeCoordinator;

  public constructor(public readonly dependencies: ConversationServiceDependencies) {
    this.gardenComputeCoordinator = new GardenComputeCoordinator({
      eventLogRepo: dependencies.eventLogRepo,
      gardenComputeProvider: dependencies.gardenComputeProvider,
      resolveGardenComputeProvider: dependencies.resolveGardenComputeProvider,
      signalReceiver: dependencies.signalReceiver,
      sessionOverridePromotion: dependencies.sessionOverridePromotion,
      healthJournalRecorder: dependencies.healthJournalRecorder,
      warn: dependencies.warn,
      releaseGovernanceLeaseSafely: (runId, workspaceId, phase) =>
        this.releaseGovernanceLeaseSafely(runId, workspaceId, phase)
    });
  }

  public async listMessages(runId: string, page?: ConversationListPageOptions): Promise<readonly ConversationMessage[]> {
    const run = await this.requireRun(runId);
    const events = await queryConversationMessageEvents(this.dependencies.eventLogRepo, run.run_id, page);
    return rebuildConversationMessages(events);
  }

  public async countMessages(runId: string): Promise<number> {
    const run = await this.requireRun(runId);
    const counter = this.dependencies.eventLogRepo.countConversationMessageEventsByRun;
    if (counter !== undefined) {
      return await counter.call(this.dependencies.eventLogRepo, run.run_id);
    }
    return rebuildConversationMessages(await queryRunEventLog(this.dependencies.eventLogRepo, run.run_id)).length;
  }

  public async sendMessage(_runId: string, _input: unknown): Promise<never> {
    throw new CoreError(
      "CONFLICT",
      "Alaya ConversationService does not execute chat turns; use MCP memory tools."
    );
  }

  public async sendMessageStreaming(_runId: string, _input: unknown): Promise<never> {
    throw new CoreError(
      "CONFLICT",
      "Alaya ConversationService does not expose chat streaming; use MCP request/response tools."
    );
  }

  public async interruptRun(runId: string): Promise<RunInterruptResult> {
    await this.requireRun(runId);
    return {
      run_id: runId,
      status: "unsupported",
      message: "Alaya does not own an interrupt-capable chat runtime session."
    };
  }

  public async assembleMemoryContext(
    runId: string,
    input: MemoryContextAssemblyInput = {}
  ): Promise<MemoryContextAssemblyResult> {
    const run = await this.requireRun(runId);
    const workspace = await this.requireWorkspace(run.workspace_id);
    return this.assembleContextForTurn({
      run,
      workspace,
      displayName: input.displayName,
      runtimeMode: input.runtimeMode
    });
  }

  public async orchestrateMemoryTurn(input: MemoryTurnOrchestrationInput): Promise<MemoryTurnOrchestrationResult> {
    const run = await this.requireRun(input.runId);
    const workspace = await this.requireWorkspace(run.workspace_id);

    await this.dependencies.governanceLeaseService?.acquire({
      runId: run.run_id,
      workspaceId: workspace.workspace_id
    });

    let gardenTakesLease = false;
    try {
      const memoryContext = await this.assembleContextForTurn({
        run,
        workspace,
        displayName: input.displayName ?? input.userMessage.content.slice(0, 80)
      });

      gardenTakesLease = true;
      this.gardenComputeCoordinator.triggerCompile({
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
        await this.releaseGovernanceLeaseSafely(run.run_id, workspace.workspace_id, "memory turn processing");
      }
    }
  }

  private async assembleContextForTurn(input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly displayName?: string;
    readonly runtimeMode?: RuntimeModeValue;
  }): Promise<MemoryContextAssemblyResult> {
    if (this.dependencies.contextLensAssembler === undefined) {
      return {
        contextLens: null,
        workingProjection: null,
        recalledContextSection: ""
      };
    }

    const runtimeMode = await this.resolveRuntimeMode(input);

    try {
      const assembled = await this.dependencies.contextLensAssembler.assemble({
        run: input.run,
        surfaceId: input.run.current_surface_id ?? null,
        displayName: input.displayName,
        runtimeMode
      });

      return {
        contextLens: assembled.contextLens,
        workingProjection: assembled.workingProjection,
        recalledContextSection: buildRecalledContextSection(assembled.workingProjection)
      };
    } catch (error) {
      this.dependencies.warn("[ConversationService] ContextLens assembly failed, proceeding without lens", {
        run_id: input.run.run_id,
        workspace_id: input.workspace.workspace_id,
        error
      });

      return {
        contextLens: null,
        workingProjection: null,
        recalledContextSection: ""
      };
    }
  }

  private async resolveRuntimeMode(input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly runtimeMode?: RuntimeModeValue;
  }): Promise<RuntimeModeValue> {
    if (input.runtimeMode !== undefined || this.dependencies.budgetBankruptcyService === undefined) {
      return input.runtimeMode ?? RuntimeMode.FULL;
    }

    try {
      const snapshot = await this.dependencies.budgetBankruptcyService.getSnapshot(
        input.run.run_id,
        new Date().toISOString()
      );
      return snapshot.current_mode;
    } catch (error) {
      this.dependencies.warn(
        "[ConversationService] Budget bankruptcy snapshot lookup failed; using minimal runtime mode",
        {
          run_id: input.run.run_id,
          workspace_id: input.workspace.workspace_id,
          error
        }
      );
      return RuntimeMode.MINIMAL;
    }
  }

  private async releaseGovernanceLeaseSafely(runId: string, workspaceId: string, phase: string): Promise<void> {
    try {
      await this.dependencies.governanceLeaseService?.release(runId);
    } catch (error) {
      this.dependencies.warn(`Failed to release governance lease after ${phase}`, {
        run_id: runId,
        workspace_id: workspaceId,
        error
      });
    }
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.dependencies.runRepo.getById(runId);

    if (run === null) {
      throw new CoreError("NOT_FOUND", "Run not found");
    }

    return run;
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.dependencies.workspaceRepo.getById(workspaceId);

    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }

    return workspace;
  }
}
