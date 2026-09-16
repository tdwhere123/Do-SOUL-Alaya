import {
  HealthEventKind,
  type HealthJournalRecordPort,
  type ConversationMessage,
  type ExecutionStanceModelRef,
  type Run,
  type Workspace
} from "@do-soul/alaya-protocol";

import {
  getErrorMessage,
  getGardenProviderFailureKind,
  type ConversationGardenCompileEnqueueResult,
  type ConversationGardenCompileQueuePort,
  type ConversationWarnPort
} from "./conversation-service-ports.js";

type GardenCompileInput = Readonly<{
  readonly run: Run;
  readonly workspace: Workspace;
  readonly modelRef: ExecutionStanceModelRef | null;
  readonly userMessage: ConversationMessage;
  readonly assistantMessage: ConversationMessage;
}>;

type GardenCompileEnqueueOutcome =
  | ConversationGardenCompileEnqueueResult
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly error: unknown };

export interface GardenComputeCoordinatorDependencies {
  readonly gardenCompileQueue?: ConversationGardenCompileQueuePort;
  readonly healthJournalRecorder?: HealthJournalRecordPort;
  readonly warn: ConversationWarnPort;
  readonly releaseGovernanceLeaseSafely: (runId: string, workspaceId: string, phase: string) => Promise<void>;
}

export class GardenComputeCoordinator {
  public constructor(private readonly deps: GardenComputeCoordinatorDependencies) {}

  public triggerCompile(input: GardenCompileInput): void {
    const outcome = this.enqueueCompile(input);
    void this.afterEnqueue(input, outcome).catch((error: unknown) => {
      this.deps.warn("Garden compile enqueue crashed.", { error });
    });
  }

  private enqueueCompile(input: GardenCompileInput): GardenCompileEnqueueOutcome {
    const queue = this.deps.gardenCompileQueue;
    if (queue === undefined) {
      return { status: "unavailable" };
    }
    try {
      return queue.enqueue({
        workspaceId: input.workspace.workspace_id,
        runId: input.run.run_id,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage
      });
    } catch (error) {
      return { status: "failed", error };
    }
  }

  private async afterEnqueue(
    input: GardenCompileInput,
    outcome: GardenCompileEnqueueOutcome
  ): Promise<void> {
    try {
      if (outcome.status === "unavailable" || outcome.status === "failed") {
        await this.recordEnqueueFailure(input, outcome);
      }
    } finally {
      await this.deps.releaseGovernanceLeaseSafely(
        input.run.run_id,
        input.workspace.workspace_id,
        "Garden work"
      );
    }
  }

  private async recordEnqueueFailure(
    input: GardenCompileInput,
    outcome: Extract<GardenCompileEnqueueOutcome, { readonly status: "unavailable" | "failed" }>
  ): Promise<void> {
    const error = outcome.status === "failed" ? outcome.error : undefined;
    await this.recordEnqueueHealth(input, outcome.status, error);
    this.deps.warn(
      outcome.status === "unavailable"
        ? "Garden compile queue unavailable."
        : "Garden compile enqueue failed.",
      {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        ...(error === undefined ? {} : { error })
      }
    );
  }

  private async recordEnqueueHealth(
    input: GardenCompileInput,
    status: "unavailable" | "failed",
    error: unknown
  ): Promise<void> {
    if (this.deps.healthJournalRecorder === undefined) {
      return;
    }

    try {
      await this.deps.healthJournalRecorder.record({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        summary:
          status === "unavailable"
            ? "Garden compile enqueue unavailable."
            : "Garden compile enqueue failed.",
        detail_json: {
          phase: "compile_enqueue",
          status,
          ...(error === undefined
            ? {}
            : {
              error_kind: getGardenProviderFailureKind(error),
              error_message: getErrorMessage(error)
            })
        }
      });
    } catch (journalError) {
      this.deps.warn("Garden compile enqueue journal record failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        error: journalError
      });
    }
  }
}
