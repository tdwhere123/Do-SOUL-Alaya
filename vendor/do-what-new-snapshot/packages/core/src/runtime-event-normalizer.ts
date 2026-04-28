import type { EventLogEntry, RuntimeEvent } from "@do-what/protocol";
import {
  PhaseA3EventType,
  WorkerMessageDeltaPayloadSchema,
  WorkerPatchEmittedPayloadSchema,
  WorkerPermissionRequestedPayloadSchema,
  WorkerRuntimeErrorPayloadSchema,
  WorkerSessionFinishedPayloadSchema,
  WorkerSessionStartedPayloadSchema,
  WorkerToolCallFinishedPayloadSchema,
  WorkerToolCallStartedPayloadSchema
} from "@do-what/protocol";
import { RuntimeEventNormalizerState } from "./runtime-event-normalizer-state.js";

export interface NormalizerEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface NormalizerSseBroadcasterPort {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface RuntimeEventNormalizerDependencies {
  readonly eventLogRepo: NormalizerEventLogRepoPort;
  readonly sseBroadcaster: NormalizerSseBroadcasterPort;
}

export interface NormalizerContext {
  readonly workspaceId: string;
  readonly principalRunId: string;
  readonly workerRunId: string;
}

export class RuntimeEventNormalizer {
  private readonly state: RuntimeEventNormalizerState;

  public constructor(private readonly dependencies: RuntimeEventNormalizerDependencies) {
    this.state = new RuntimeEventNormalizerState();
  }

  public async normalize(
    event: RuntimeEvent,
    context: NormalizerContext
  ): Promise<Readonly<EventLogEntry> | null> {
    let appended = false;

    if (event.type === "message_delta" && !this.state.reserveMessageDelta(event.session_id, event.sequence)) {
      return null;
    }

    if (event.type === "session_finished" && !this.state.reserveSessionFinished(event.session_id)) {
      return null;
    }

    try {
      const entry = await this.dependencies.eventLogRepo.append(this.buildEntry(event, context));
      appended = true;

      if (event.type === "session_finished") {
        this.state.markSessionFinishedAppended(event.session_id);
      }

      await this.dependencies.sseBroadcaster.broadcastEntry(entry);

      if (event.type === "session_finished") {
        this.state.clearSessionState(event.session_id);
      }

      return entry;
    } catch (error) {
      if (event.type === "message_delta" && !appended) {
        this.state.releaseMessageDelta(event.session_id, event.sequence);
      }

      if (event.type === "session_finished" && !appended) {
        this.state.clearSessionState(event.session_id);
      }

      throw error;
    }
  }

  public clearSessionState(sessionId: string): void {
    this.state.clearSessionState(sessionId);
  }

  private buildEntry(
    event: RuntimeEvent,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at"> {
    switch (event.type) {
      case "session_started":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_SESSION_STARTED,
          WorkerSessionStartedPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at
          })
        );
      case "session_finished":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_SESSION_FINISHED,
          WorkerSessionFinishedPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at,
            status: event.status,
            resultSummary: event.result_summary
          })
        );
      case "message_delta":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_MESSAGE_DELTA,
          WorkerMessageDeltaPayloadSchema.parse({
            sessionId: event.session_id,
            workerRunId: context.workerRunId,
            emittedAt: event.emitted_at,
            delta: event.delta,
            sequence: event.sequence
          })
        );
      case "tool_call_started":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_TOOL_CALL_STARTED,
          WorkerToolCallStartedPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at,
            callId: event.call_id,
            toolId: event.tool_id
          })
        );
      case "tool_call_finished":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_TOOL_CALL_FINISHED,
          WorkerToolCallFinishedPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at,
            callId: event.call_id,
            toolId: event.tool_id,
            outcome: event.outcome,
            resultSummary: event.result_summary
          })
        );
      case "permission_requested":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_PERMISSION_REQUESTED,
          WorkerPermissionRequestedPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at,
            requestId: event.request_id,
            toolId: event.tool_id,
            reason: event.reason
          })
        );
      case "patch_emitted":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_PATCH_EMITTED,
          WorkerPatchEmittedPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at,
            patchId: event.patch_id,
            pathHints: event.path_hints
          })
        );
      case "runtime_error":
        return this.createEntry(
          context,
          PhaseA3EventType.WORKER_RUNTIME_ERROR,
          WorkerRuntimeErrorPayloadSchema.parse({
            sessionId: event.session_id,
            emittedAt: event.emitted_at,
            errorCode: event.error_code,
            message: event.message
          })
        );
      default:
        return assertNever(event);
    }
  }

  private createEntry(
    context: NormalizerContext,
    eventType: EventLogEntry["event_type"],
    payload: Record<string, unknown>
  ): Omit<EventLogEntry, "event_id" | "created_at"> {
    return {
      event_type: eventType,
      entity_type: "worker_run",
      entity_id: context.workerRunId,
      workspace_id: context.workspaceId,
      run_id: context.principalRunId,
      caused_by: "worker",
      revision: 0,
      payload_json: payload
    };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime event: ${JSON.stringify(value)}`);
}
