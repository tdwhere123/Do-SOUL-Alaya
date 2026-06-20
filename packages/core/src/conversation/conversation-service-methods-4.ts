import { ComputeProviderCallFailedPayloadSchema, ComputeRecallGardenEventType, type ExecutionStanceModelRef, type GardenProviderKind, type Run, type Workspace } from "@do-soul/alaya-protocol";
import {
  getErrorMessage,
  getGardenProviderFailureKind,
  recordGardenProviderCallJournal,
  releaseGovernanceLeaseSafely,
  requireRun,
  resolveGardenComputeProvider,
  type ConversationGardenComputeProviderPort,
  type ConversationServiceMethodOwner,
  type GardenProviderCallTelemetry
} from "./conversation-service-internal.js";

export async function conversationServiceRecordGardenProviderCallFailed(owner: ConversationServiceMethodOwner, input: {
      readonly run: Run;
      readonly workspace: Workspace;
    }, providerCall: GardenProviderCallTelemetry | null, gardenComputeProvider: ConversationGardenComputeProviderPort, error: unknown): Promise<void> {
    if (providerCall === null || typeof owner.dependencies.eventLogRepo.append !== "function") {
      return;
    }

    const failedAt = new Date().toISOString();
    const latencyMs = Math.max(0, Date.now() - providerCall.startedAtEpochMs);
    const errorKind = getGardenProviderFailureKind(error);
    const errorMessage = getErrorMessage(error);

    try {
      await owner.dependencies.eventLogRepo.append({
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
      owner.dependencies.warn("Garden provider call failure event failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        call_id: providerCall.callId,
        error: appendError
      });
    }

    await recordGardenProviderCallJournal(owner, {
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

export async function conversationServiceRecordGardenProviderCallJournal(owner: ConversationServiceMethodOwner, input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly providerCall: GardenProviderCallTelemetry;
    readonly providerKind: GardenProviderKind;
    readonly status: "completed" | "failed";
    readonly latencyMs: number;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    return recordGardenProviderCallJournal(owner, input);
  }

export async function conversationServiceResolveGardenComputeProvider(owner: ConversationServiceMethodOwner, modelRef: Readonly<ExecutionStanceModelRef> | null): Promise<ConversationGardenComputeProviderPort> {
    return resolveGardenComputeProvider(owner, modelRef);
  }

export async function conversationServiceReleaseGovernanceLeaseSafely(owner: ConversationServiceMethodOwner, runId: string, workspaceId: string, phase: string): Promise<void> {
    return releaseGovernanceLeaseSafely(owner, runId, workspaceId, phase);
  }

export async function conversationServiceRequireRun(owner: ConversationServiceMethodOwner, runId: string): Promise<Run> {
    return requireRun(owner, runId);
  }
