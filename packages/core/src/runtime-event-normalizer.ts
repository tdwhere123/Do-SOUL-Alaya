import type { EventLogEntry, RuntimeEvent } from "@do-soul/alaya-protocol";
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
} from "@do-soul/alaya-protocol";
import { RuntimeEventNormalizerState } from "./runtime-event-normalizer-state.js";

export interface NormalizerEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface NormalizerRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface RuntimeEventNormalizerDependencies {
  readonly eventLogRepo: NormalizerEventLogRepoPort;
  readonly runtimeNotifier: NormalizerRuntimeNotifierPort;
}

export interface NormalizerContext {
  readonly workspaceId: string;
  readonly principalRunId: string;
  readonly workerRunId: string;
}

interface PendingNormalizedNotification {
  readonly entry: EventLogEntry;
  readonly sessionId: string;
  readonly retry?: Promise<Readonly<EventLogEntry>>;
}

export class RuntimeEventNormalizerPropagationError extends Error {
  public readonly entry: EventLogEntry;

  public constructor(entry: EventLogEntry, cause: unknown) {
    super(`Runtime event ${entry.event_type} was appended but notification failed.`, {
      cause: cause instanceof Error ? cause : undefined
    });
    this.name = "RuntimeEventNormalizerPropagationError";
    this.entry = entry;
  }
}

export class RuntimeEventNormalizer {
  private readonly state: RuntimeEventNormalizerState;
  private readonly pendingNotifications = new Map<string, PendingNormalizedNotification>();

  public constructor(private readonly dependencies: RuntimeEventNormalizerDependencies) {
    this.state = new RuntimeEventNormalizerState();
  }

  public async normalize(
    event: RuntimeEvent,
    context: NormalizerContext
  ): Promise<Readonly<EventLogEntry> | null> {
    const pendingKey = this.getPendingNotificationKey(event);
    const pending = this.pendingNotifications.get(pendingKey);

    if (pending !== undefined) {
      return await this.notifyPendingEntry(pendingKey, pending, event);
    }

    if (event.type === "message_delta" && !this.state.reserveMessageDelta(event.session_id, event.sequence)) {
      return null;
    }

    if (event.type === "session_finished" && !this.state.reserveSessionFinished(event.session_id)) {
      return null;
    }

    let entry: EventLogEntry;
    try {
      entry = await this.dependencies.eventLogRepo.append(this.buildEntry(event, context));
    } catch (error) {
      if (event.type === "message_delta") {
        this.state.releaseMessageDelta(event.session_id, event.sequence);
      }

      if (event.type === "session_finished") {
        this.state.clearSessionState(event.session_id);
      }

      throw error;
    }

    if (event.type === "session_finished") {
      this.state.markSessionFinishedAppended(event.session_id);
    }

    try {
      await this.dependencies.runtimeNotifier.notifyEntry(entry);
    } catch (error) {
      this.pendingNotifications.set(pendingKey, {
        entry,
        sessionId: event.session_id
      });
      throw new RuntimeEventNormalizerPropagationError(entry, error);
    }

    if (event.type === "session_finished") {
      this.state.clearSessionState(event.session_id);
    }

    return entry;
  }

  public clearSessionState(sessionId: string): void {
    this.state.clearSessionState(sessionId);
    for (const [key, pending] of this.pendingNotifications) {
      if (pending.sessionId === sessionId) {
        this.pendingNotifications.delete(key);
      }
    }
  }

  private async notifyPendingEntry(
    pendingKey: string,
    pending: PendingNormalizedNotification,
    event: RuntimeEvent
  ): Promise<Readonly<EventLogEntry>> {
    if (pending.retry !== undefined) {
      return await pending.retry;
    }

    const retry = this.runPendingNotification(pendingKey, pending.entry, event);
    this.pendingNotifications.set(pendingKey, {
      ...pending,
      retry
    });

    try {
      return await retry;
    } catch (error) {
      const current = this.pendingNotifications.get(pendingKey);
      if (current?.retry === retry) {
        this.pendingNotifications.set(pendingKey, {
          entry: pending.entry,
          sessionId: pending.sessionId
        });
      }
      throw error;
    }
  }

  private async runPendingNotification(
    pendingKey: string,
    entry: EventLogEntry,
    event: RuntimeEvent
  ): Promise<Readonly<EventLogEntry>> {
    try {
      await this.dependencies.runtimeNotifier.notifyEntry(entry);
    } catch (error) {
      throw new RuntimeEventNormalizerPropagationError(entry, error);
    }

    this.pendingNotifications.delete(pendingKey);

    if (event.type === "session_finished") {
      this.state.clearSessionState(event.session_id);
    }

    return entry;
  }

  private getPendingNotificationKey(event: RuntimeEvent): string {
    switch (event.type) {
      case "session_started":
      case "session_finished":
        return `${event.type}:${event.session_id}`;
      case "message_delta":
        return `${event.type}:${event.session_id}:${event.sequence}`;
      case "tool_call_started":
      case "tool_call_finished":
        return `${event.type}:${event.session_id}:${event.call_id}`;
      case "permission_requested":
        return `${event.type}:${event.session_id}:${event.request_id}`;
      case "patch_emitted":
        return `${event.type}:${event.session_id}:${event.patch_id}`;
      case "runtime_error":
        return `${event.type}:${event.session_id}:${event.error_code}:${event.message}:${event.emitted_at}`;
      default:
        return assertNever(event);
    }
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
