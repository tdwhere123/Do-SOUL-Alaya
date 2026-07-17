import { randomUUID } from "node:crypto";

import {
  CandidateMemorySignalSchema,
  ComputeProviderCallCompletedPayloadSchema,
  ComputeProviderCallFailedPayloadSchema,
  ComputeProviderCallStartedPayloadSchema,
  ComputeRecallGardenEventType,
  HealthEventKind,
  type CandidateMemorySignal,
  type ConversationMessage,
  type EventLogEntry,
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

type TrustedGardenSourceObservation = NonNullable<CandidateMemorySignal["source_observation"]>;

type GardenCompileInput = Readonly<{
  readonly run: Run;
  readonly workspace: Workspace;
  readonly modelRef: ExecutionStanceModelRef | null;
  readonly userMessage: ConversationMessage;
  readonly assistantMessage: ConversationMessage;
}>;

interface CompletedProviderCallEvent {
  readonly entry: EventLogEntry | null;
  readonly latencyMs: number;
}

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

// Fire-and-forget Garden compile: errors are swallowed to warn, never propagated to the caller.
export class GardenComputeCoordinator {
  public constructor(private readonly deps: GardenComputeCoordinatorDependencies) {}

  public triggerCompile(input: GardenCompileInput): void {
    void this.runCompile(input);
  }

  private async runCompile(input: GardenCompileInput): Promise<void> {
    let gardenComputeProvider: ConversationGardenComputeProviderPort | null = null;
    let providerCall: GardenProviderCallTelemetry | null = null;
    try {
      gardenComputeProvider = await this.resolveProvider(input.modelRef);
      providerCall = await this.recordProviderCallStarted(input, gardenComputeProvider);
      const compiled = await this.compileSignals(input, gardenComputeProvider, providerCall);
      const stats = await this.deliverSignals(input, compiled.signals, compiled.sourceObservation);
      await this.promoteSessionOverrides(input);
      this.deps.warn("Garden materialization batch processed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        ...stats
      });
    } catch (error) {
      await this.handleCompileFailure(input, gardenComputeProvider, providerCall, error);
    } finally {
      await this.deps.releaseGovernanceLeaseSafely(input.run.run_id, input.workspace.workspace_id, "Garden work");
    }
  }

  private async compileSignals(
    input: GardenCompileInput,
    provider: ConversationGardenComputeProviderPort,
    providerCall: GardenProviderCallTelemetry | null
  ): Promise<Readonly<{
    readonly signals: readonly CandidateMemorySignal[];
    readonly sourceObservation: TrustedGardenSourceObservation | null;
  }>> {
    const signals = await provider.compile(input.userMessage.content, {
      workspace_id: input.workspace.workspace_id,
      run_id: input.run.run_id,
      surface_id: input.run.current_surface_id ?? null,
      turn_messages: [input.userMessage, input.assistantMessage]
    });
    const sourceObservation = await this.recordProviderCallCompleted(input, providerCall, provider);
    return Object.freeze({ signals, sourceObservation });
  }

  private async deliverSignals(
    input: GardenCompileInput,
    signals: readonly CandidateMemorySignal[],
    sourceObservation: TrustedGardenSourceObservation | null
  ) {
    let stats = createGardenMaterializationBatchStats();
    for (const signal of signals) {
      const parsedSignal = bindTrustedGardenSourceObservation(signal, sourceObservation);
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
    return stats;
  }

  private async promoteSessionOverrides(input: GardenCompileInput): Promise<void> {
    const promotion = this.deps.sessionOverridePromotion;
    if (promotion === undefined) return;
    try {
      await promotion.evaluateActiveForRun({
        runId: input.run.run_id,
        workspaceId: input.workspace.workspace_id
      });
    } catch (error) {
      this.deps.warn("Session override promotion failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        error
      });
    }
  }

  private async handleCompileFailure(
    input: GardenCompileInput,
    provider: ConversationGardenComputeProviderPort | null,
    providerCall: GardenProviderCallTelemetry | null,
    error: unknown
  ): Promise<void> {
    if (provider !== null) {
      await this.recordProviderCallFailed(input, providerCall, provider, error);
    }
    this.deps.warn("Garden compile failed.", {
      workspace_id: input.workspace.workspace_id,
      run_id: input.run.run_id,
      provider_kind: provider?.provider_kind ?? "unresolved",
      error
    });
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
    if (typeof this.deps.eventLogRepo.append !== "function") {
      return null;
    }

    const startedAtEpochMs = Date.now();
    const startedAt = new Date(startedAtEpochMs).toISOString();
    const callId = `garden-provider-call-${randomUUID()}`;
    const modelId = resolveGardenProviderModelId(gardenComputeProvider.provider_kind, input.modelRef);

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
          model_id: modelId,
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
      modelId
    };
  }

  private async recordProviderCallCompleted(
    input: {
      readonly run: Run;
      readonly workspace: Workspace;
    },
    providerCall: GardenProviderCallTelemetry | null,
    gardenComputeProvider: ConversationGardenComputeProviderPort
  ): Promise<TrustedGardenSourceObservation | null> {
    if (providerCall === null || typeof this.deps.eventLogRepo.append !== "function") {
      return null;
    }

    const completed = await this.appendProviderCallCompleted(input, providerCall, gardenComputeProvider);
    await this.recordProviderCallJournal({
      workspaceId: input.workspace.workspace_id,
      runId: input.run.run_id,
      providerCall,
      providerKind: gardenComputeProvider.provider_kind,
      status: "completed",
      latencyMs: completed.latencyMs
    });
    const sourceObservation = createTrustedGardenSourceObservation({
      entry: completed.entry,
      input,
      providerCall,
      providerKind: gardenComputeProvider.provider_kind
    });
    if (completed.entry !== null && sourceObservation === null) {
      this.deps.warn("Garden provider completion receipt was unverifiable.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        call_id: providerCall.callId
      });
    }
    return sourceObservation;
  }

  private async appendProviderCallCompleted(
    input: { readonly run: Run; readonly workspace: Workspace },
    providerCall: GardenProviderCallTelemetry,
    gardenComputeProvider: ConversationGardenComputeProviderPort
  ): Promise<CompletedProviderCallEvent> {
    const completedAt = new Date().toISOString();
    const latencyMs = Math.max(0, Date.now() - providerCall.startedAtEpochMs);

    try {
      const entry = await this.deps.eventLogRepo.append!({
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
      return { entry, latencyMs };
    } catch (error) {
      this.deps.warn("Garden provider call completion event failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        call_id: providerCall.callId,
        error
      });
      return { entry: null, latencyMs };
    }
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

function bindTrustedGardenSourceObservation(
  signal: CandidateMemorySignal,
  sourceObservation: TrustedGardenSourceObservation | null
): CandidateMemorySignal {
  const parsed = CandidateMemorySignalSchema.parse(signal);
  return CandidateMemorySignalSchema.parse({
    ...parsed,
    source_observation: sourceObservation
  });
}

function resolveGardenProviderModelId(
  providerKind: GardenProviderKind,
  modelRef: ExecutionStanceModelRef | null
): string {
  // A receipt names the daemon-owned implementation when no external model identity exists.
  return providerKind === "official_api"
    ? (modelRef?.model_id ?? "configured-default")
    : "local-heuristics";
}

function createTrustedGardenSourceObservation(input: {
  readonly entry: EventLogEntry | null;
  readonly input: { readonly run: Run; readonly workspace: Workspace };
  readonly providerCall: GardenProviderCallTelemetry;
  readonly providerKind: GardenProviderKind;
}): TrustedGardenSourceObservation | null {
  if (input.entry === null) return null;
  try {
    const payload = ComputeProviderCallCompletedPayloadSchema.parse(input.entry.payload_json);
    if (
      input.entry.event_type !== ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_COMPLETED ||
      input.entry.entity_type !== "compute_provider_call" ||
      input.entry.entity_id !== input.providerCall.callId ||
      input.entry.workspace_id !== input.input.workspace.workspace_id ||
      input.entry.run_id !== input.input.run.run_id ||
      input.entry.caused_by !== "system" ||
      payload.workspace_id !== input.input.workspace.workspace_id ||
      payload.run_id !== input.input.run.run_id ||
      payload.provider_kind !== input.providerKind ||
      payload.model_id !== input.providerCall.modelId ||
      payload.operation !== "garden.compile" ||
      payload.call_id !== input.providerCall.callId
    ) {
      return null;
    }
    return {
      observed_at: payload.completed_at,
      authority: "trusted_host_event",
      source_event_id: input.entry.event_id
    };
  } catch {
    return null;
  }
}
