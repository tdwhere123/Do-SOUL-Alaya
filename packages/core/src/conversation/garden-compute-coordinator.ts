import { randomUUID } from "node:crypto";

import {
  CandidateMemorySignalSchema,
  ComputeProviderCallCompletedPayloadSchema,
  ComputeProviderCallFailedPayloadSchema,
  ComputeProviderCallStartedPayloadSchema,
  ComputeRecallGardenEventType,
  HealthEventKind,
  type ConversationMessage,
  type ExecutionStanceModelRef,
  type GardenProviderKind,
  type HealthJournalRecordPort,
  type Run,
  type Workspace
} from "@do-soul/alaya-protocol";

import {
  createGardenMaterializationBatchStats,
  getErrorMessage,
  getGardenProviderFailureKind,
  recordSignalResult,
  type ConversationEventLogRepoPort,
  type ConversationGardenComputeProviderPort,
  type ConversationGardenComputeProviderResolverPort,
  type ConversationSessionOverridePromotionPort,
  type ConversationSignalReceiverPort,
  type ConversationWarnPort,
  type GardenProviderCallTelemetry
} from "./conversation-service-ports.js";

export interface GardenComputeCoordinatorDependencies {
  readonly eventLogRepo: ConversationEventLogRepoPort;
  readonly gardenComputeProvider: ConversationGardenComputeProviderPort;
  readonly resolveGardenComputeProvider?: ConversationGardenComputeProviderResolverPort;
  readonly signalReceiver: ConversationSignalReceiverPort;
  readonly sessionOverridePromotion?: ConversationSessionOverridePromotionPort;
  readonly healthJournalRecorder?: HealthJournalRecordPort;
  readonly warn: ConversationWarnPort;
  readonly releaseGovernanceLeaseSafely: (runId: string, workspaceId: string, phase: string) => Promise<void>;
}

// Fire-and-forget Garden compile: provider resolution, telemetry, signal materialization, lease release.
export class GardenComputeCoordinator {
  public constructor(private readonly deps: GardenComputeCoordinatorDependencies) {}

  public triggerCompile(input: {
    readonly run: Run;
    readonly workspace: Workspace;
    readonly modelRef: ExecutionStanceModelRef | null;
    readonly userMessage: ConversationMessage;
    readonly assistantMessage: ConversationMessage;
  }): void {
    const turnMessages = [input.userMessage, input.assistantMessage] as const;
    const turnContent = input.userMessage.content;

    void (async () => {
      let gardenComputeProvider: ConversationGardenComputeProviderPort | null = null;
      let providerCall: GardenProviderCallTelemetry | null = null;

      try {
        const resolvedGardenComputeProvider = await this.resolveProvider(input.modelRef);
        gardenComputeProvider = resolvedGardenComputeProvider;
        providerCall = await this.recordProviderCallStarted(input, resolvedGardenComputeProvider);

        const signals = await resolvedGardenComputeProvider.compile(turnContent, {
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          surface_id: input.run.current_surface_id ?? null,
          turn_messages: turnMessages
        });
        await this.recordProviderCallCompleted(input, providerCall, resolvedGardenComputeProvider);
        let stats = createGardenMaterializationBatchStats();

        for (const signal of signals) {
          const parsedSignal = CandidateMemorySignalSchema.parse(signal);

          try {
            const result = await this.deps.signalReceiver.receiveSignal(parsedSignal);
            stats = recordSignalResult(stats, result);
          } catch (error) {
            this.deps.warn("Garden signal delivery failed.", {
              workspace_id: input.workspace.workspace_id,
              run_id: input.run.run_id,
              signal_id: parsedSignal.signal_id,
              error
            });
          }
        }

        await this.deps.sessionOverridePromotion
          ?.evaluateActiveForRun({
            runId: input.run.run_id,
            workspaceId: input.workspace.workspace_id
          })
          .catch((error) => {
            this.deps.warn("Session override promotion failed.", {
              workspace_id: input.workspace.workspace_id,
              run_id: input.run.run_id,
              error
            });
          });

        this.deps.warn("Garden materialization batch processed.", {
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: resolvedGardenComputeProvider.provider_kind,
          ...stats
        });
      } catch (error) {
        if (gardenComputeProvider !== null) {
          await this.recordProviderCallFailed(input, providerCall, gardenComputeProvider, error);
        }
        this.deps.warn("Garden compile failed.", {
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: gardenComputeProvider?.provider_kind ?? "unresolved",
          error
        });
      } finally {
        await this.deps.releaseGovernanceLeaseSafely(input.run.run_id, input.workspace.workspace_id, "Garden work");
      }
    })();
  }

  public async resolveProvider(
    modelRef: Readonly<ExecutionStanceModelRef> | null
  ): Promise<ConversationGardenComputeProviderPort> {
    const resolvedProvider = (await this.deps.resolveGardenComputeProvider?.resolve(modelRef)) ?? null;
    if (resolvedProvider !== null) {
      return resolvedProvider;
    }

    const currentDefaultProvider = (await this.deps.resolveGardenComputeProvider?.resolve(null)) ?? null;
    return currentDefaultProvider ?? this.deps.gardenComputeProvider;
  }

  private async recordProviderCallStarted(
    input: {
      readonly run: Run;
      readonly workspace: Workspace;
      readonly modelRef: ExecutionStanceModelRef | null;
    },
    gardenComputeProvider: ConversationGardenComputeProviderPort
  ): Promise<GardenProviderCallTelemetry | null> {
    if (
      gardenComputeProvider.provider_kind !== "official_api" ||
      input.modelRef === null ||
      typeof this.deps.eventLogRepo.append !== "function"
    ) {
      return null;
    }

    const startedAtEpochMs = Date.now();
    const startedAt = new Date(startedAtEpochMs).toISOString();
    const callId = `garden-provider-call-${randomUUID()}`;

    try {
      await this.deps.eventLogRepo.append({
        event_type: ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED,
        entity_type: "compute_provider_call",
        entity_id: callId,
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        caused_by: "system",
        payload_json: ComputeProviderCallStartedPayloadSchema.parse({
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: gardenComputeProvider.provider_kind,
          model_id: input.modelRef.model_id,
          operation: "garden.compile",
          call_id: callId,
          started_at: startedAt
        })
      });
    } catch (error) {
      this.deps.warn("Garden provider call start event failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        error
      });
      return null;
    }

    return {
      callId,
      startedAt,
      startedAtEpochMs,
      modelId: input.modelRef.model_id
    };
  }

  private async recordProviderCallCompleted(
    input: {
      readonly run: Run;
      readonly workspace: Workspace;
    },
    providerCall: GardenProviderCallTelemetry | null,
    gardenComputeProvider: ConversationGardenComputeProviderPort
  ): Promise<void> {
    if (providerCall === null || typeof this.deps.eventLogRepo.append !== "function") {
      return;
    }

    const completedAt = new Date().toISOString();
    const latencyMs = Math.max(0, Date.now() - providerCall.startedAtEpochMs);

    try {
      await this.deps.eventLogRepo.append({
        event_type: ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_COMPLETED,
        entity_type: "compute_provider_call",
        entity_id: providerCall.callId,
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        caused_by: "system",
        payload_json: ComputeProviderCallCompletedPayloadSchema.parse({
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: gardenComputeProvider.provider_kind,
          model_id: providerCall.modelId,
          operation: "garden.compile",
          call_id: providerCall.callId,
          completed_at: completedAt,
          latency_ms: latencyMs
        })
      });
    } catch (error) {
      this.deps.warn("Garden provider call completion event failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        call_id: providerCall.callId,
        error
      });
    }

    await this.recordProviderCallJournal({
      workspaceId: input.workspace.workspace_id,
      runId: input.run.run_id,
      providerCall,
      providerKind: gardenComputeProvider.provider_kind,
      status: "completed",
      latencyMs
    });
  }

  private async recordProviderCallFailed(
    input: {
      readonly run: Run;
      readonly workspace: Workspace;
    },
    providerCall: GardenProviderCallTelemetry | null,
    gardenComputeProvider: ConversationGardenComputeProviderPort,
    error: unknown
  ): Promise<void> {
    if (providerCall === null || typeof this.deps.eventLogRepo.append !== "function") {
      return;
    }

    const failedAt = new Date().toISOString();
    const latencyMs = Math.max(0, Date.now() - providerCall.startedAtEpochMs);
    const errorKind = getGardenProviderFailureKind(error);
    const errorMessage = getErrorMessage(error);

    try {
      await this.deps.eventLogRepo.append({
        event_type: ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_FAILED,
        entity_type: "compute_provider_call",
        entity_id: providerCall.callId,
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        caused_by: "system",
        payload_json: ComputeProviderCallFailedPayloadSchema.parse({
          workspace_id: input.workspace.workspace_id,
          run_id: input.run.run_id,
          provider_kind: gardenComputeProvider.provider_kind,
          model_id: providerCall.modelId,
          operation: "garden.compile",
          call_id: providerCall.callId,
          failed_at: failedAt,
          latency_ms: latencyMs,
          error_kind: errorKind,
          error_message: errorMessage
        })
      });
    } catch (appendError) {
      this.deps.warn("Garden provider call failure event failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        call_id: providerCall.callId,
        error: appendError
      });
    }

    await this.recordProviderCallJournal({
      workspaceId: input.workspace.workspace_id,
      runId: input.run.run_id,
      providerCall,
      providerKind: gardenComputeProvider.provider_kind,
      status: "failed",
      latencyMs,
      errorKind,
      errorMessage
    });
  }

  private async recordProviderCallJournal(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly providerCall: GardenProviderCallTelemetry;
    readonly providerKind: GardenProviderKind;
    readonly status: "completed" | "failed";
    readonly latencyMs: number;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    if (this.deps.healthJournalRecorder === undefined) {
      return;
    }

    try {
      await this.deps.healthJournalRecorder.record({
        event_kind: HealthEventKind.PROVIDER_CALL,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        summary:
          input.status === "completed"
            ? "Garden provider call completed."
            : "Garden provider call failed.",
        detail_json: {
          status: input.status,
          call_id: input.providerCall.callId,
          provider_kind: input.providerKind,
          model_id: input.providerCall.modelId,
          operation: "garden.compile",
          started_at: input.providerCall.startedAt,
          latency_ms: input.latencyMs,
          ...(input.errorKind === undefined ? {} : { error_kind: input.errorKind }),
          ...(input.errorMessage === undefined ? {} : { error_message: input.errorMessage })
        }
      });
    } catch (error) {
      this.deps.warn("Garden provider call journal record failed.", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        provider_kind: input.providerKind,
        call_id: input.providerCall.callId,
        error
      });
    }
  }
}
