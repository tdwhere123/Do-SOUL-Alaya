import { CoreError } from "../shared/errors.js";

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
  type Run,
  type RunInterruptResult,
  type RuntimeModeValue,
  type Workspace
} from "./conversation-service-ports.js";

export type {
  ConversationBudgetBankruptcyPort,
  ConversationContextLensAssemblerPort,
  ConversationEventLogRepoPort,
  ConversationListPageOptions,
  ConversationRunRepoPort,
  ConversationServiceDependencies,
  ConversationSignalReceiverPort,
  ConversationWarnPort,
  ConversationWorkspaceRepoPort,
  MemoryContextAssemblyInput,
  MemoryContextAssemblyResult
} from "./conversation-service-ports.js";
export { GARDEN_COMPILE_ENQUEUE_HEALTH_PHASE } from "./conversation-service-ports.js";

export class ConversationService {
  public constructor(public readonly dependencies: ConversationServiceDependencies) {}

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
