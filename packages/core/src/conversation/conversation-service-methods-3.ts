import { randomUUID } from "node:crypto";

import { ComputeProviderCallCompletedPayloadSchema, ComputeProviderCallStartedPayloadSchema, ComputeRecallGardenEventType, type ExecutionStanceModelRef, type Run, type Workspace } from "@do-soul/alaya-protocol";
import {
  recordGardenProviderCallJournal,
  type ConversationGardenComputeProviderPort,
  type ConversationServiceMethodOwner,
  type GardenProviderCallTelemetry
} from "./conversation-service-internal.js";

export async function conversationServiceRecordGardenProviderCallStarted(owner: ConversationServiceMethodOwner, input: {
      readonly run: Run;
      readonly workspace: Workspace;
      readonly modelRef: ExecutionStanceModelRef | null;
    }, gardenComputeProvider: ConversationGardenComputeProviderPort): Promise<GardenProviderCallTelemetry | null> {
    if (
      gardenComputeProvider.provider_kind !== "official_api" ||
      input.modelRef === null ||
      typeof owner.dependencies.eventLogRepo.append !== "function"
    ) {
      return null;
    }

    const startedAtEpochMs = Date.now();
    const startedAt = new Date(startedAtEpochMs).toISOString();
    const callId = `garden-provider-call-${randomUUID()}`;

    try {
      await owner.dependencies.eventLogRepo.append({
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
      owner.dependencies.warn("Garden provider call start event failed.", {
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

export async function conversationServiceRecordGardenProviderCallCompleted(owner: ConversationServiceMethodOwner, input: {
      readonly run: Run;
      readonly workspace: Workspace;
    }, providerCall: GardenProviderCallTelemetry | null, gardenComputeProvider: ConversationGardenComputeProviderPort): Promise<void> {
    if (providerCall === null || typeof owner.dependencies.eventLogRepo.append !== "function") {
      return;
    }

    const completedAt = new Date().toISOString();
    const latencyMs = Math.max(0, Date.now() - providerCall.startedAtEpochMs);

    try {
      await owner.dependencies.eventLogRepo.append({
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
      owner.dependencies.warn("Garden provider call completion event failed.", {
        workspace_id: input.workspace.workspace_id,
        run_id: input.run.run_id,
        provider_kind: gardenComputeProvider.provider_kind,
        call_id: providerCall.callId,
        error
      });
    }

    await recordGardenProviderCallJournal(owner, {
      workspaceId: input.workspace.workspace_id,
      runId: input.run.run_id,
      providerCall,
      providerKind: gardenComputeProvider.provider_kind,
      status: "completed",
      latencyMs
    });
  }
