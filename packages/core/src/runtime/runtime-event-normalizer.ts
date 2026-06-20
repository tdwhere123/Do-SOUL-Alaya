import type { EventLogEntry, RuntimeEvent } from "@do-soul/alaya-protocol";
import {
  WorkerRuntimeEventType,
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
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface NormalizerRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface RuntimeEventNormalizerDependencies {
  readonly eventLogRepo: NormalizerEventLogRepoPort;
  readonly runtimeNotifier: NormalizerRuntimeNotifierPort;
  readonly maxPendingNotifications?: number;
  readonly warn?: (message: string, meta: Readonly<Record<string, unknown>>) => void;
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
  private readonly maxPendingNotifications: number;

  public constructor(private readonly dependencies: RuntimeEventNormalizerDependencies) {
    this.state = new RuntimeEventNormalizerState();
    this.maxPendingNotifications = Math.max(
      1,
      Math.floor(dependencies.maxPendingNotifications ?? DEFAULT_MAX_PENDING_NOTIFICATIONS)
    );
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

    if (!this.reserveEvent(event)) {
      return null;
    }

    const entry = await this.appendNormalizedEntry(event, context);
    await this.notifyNormalizedEntry(pendingKey, event, entry);
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
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    switch (event.type) {
      case "session_started":
        return this.buildSessionStartedEntry(event, context);
      case "session_finished":
        return this.buildSessionFinishedEntry(event, context);
      case "message_delta":
        return this.buildMessageDeltaEntry(event, context);
      case "tool_call_started":
        return this.buildToolCallStartedEntry(event, context);
      case "tool_call_finished":
        return this.buildToolCallFinishedEntry(event, context);
      case "permission_requested":
        return this.buildPermissionRequestedEntry(event, context);
      case "patch_emitted":
        return this.buildPatchEmittedEntry(event, context);
      case "runtime_error":
        return this.buildRuntimeErrorEntry(event, context);
      default:
        return assertNever(event);
    }
  }

  private reserveEvent(event: RuntimeEvent): boolean {
    if (event.type === "message_delta") {
      return this.state.reserveMessageDelta(event.session_id, event.sequence);
    }

    if (event.type === "session_finished") {
      return this.state.reserveSessionFinished(event.session_id);
    }

    return true;
  }

  private async appendNormalizedEntry(
    event: RuntimeEvent,
    context: NormalizerContext
  ): Promise<EventLogEntry> {
    try {
      const entry = await this.dependencies.eventLogRepo.append(this.buildEntry(event, context));
      if (event.type === "session_finished") {
        this.state.markSessionFinishedAppended(event.session_id);
      }
      return entry;
    } catch (error) {
      this.releaseReservedEvent(event);
      throw error;
    }
  }

  private releaseReservedEvent(event: RuntimeEvent): void {
    if (event.type === "message_delta") {
      this.state.releaseMessageDelta(event.session_id, event.sequence);
      return;
    }

    if (event.type === "session_finished") {
      this.state.clearSessionState(event.session_id);
    }
  }

  private async notifyNormalizedEntry(
    pendingKey: string,
    event: RuntimeEvent,
    entry: EventLogEntry
  ): Promise<void> {
    try {
      await this.dependencies.runtimeNotifier.notifyEntry(entry);
    } catch (error) {
      this.retainPendingNotification(pendingKey, event, entry);
      throw new RuntimeEventNormalizerPropagationError(entry, error);
    }

    if (event.type === "session_finished") {
      this.state.clearSessionState(event.session_id);
    }
  }

  private retainPendingNotification(
    pendingKey: string,
    event: RuntimeEvent,
    entry: EventLogEntry
  ): void {
    if (this.pendingNotifications.size < this.maxPendingNotifications) {
      this.pendingNotifications.set(pendingKey, {
        entry,
        sessionId: event.session_id
      });
      return;
    }

    this.warn(
      "Runtime event normalizer pending-notification cap reached; new pending notification will not be retained for retry.",
      {
        max_pending_notifications: this.maxPendingNotifications,
        pending_key: pendingKey,
        event_type: entry.event_type
      }
    );
  }

  private buildSessionStartedEntry(
    event: Extract<RuntimeEvent, { readonly type: "session_started" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_SESSION_STARTED,
      WorkerSessionStartedPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at
      })
    );
  }

  private buildSessionFinishedEntry(
    event: Extract<RuntimeEvent, { readonly type: "session_finished" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_SESSION_FINISHED,
      WorkerSessionFinishedPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at,
        status: event.status,
        resultSummary: event.result_summary
      })
    );
  }

  private buildMessageDeltaEntry(
    event: Extract<RuntimeEvent, { readonly type: "message_delta" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_MESSAGE_DELTA,
      WorkerMessageDeltaPayloadSchema.parse({
        sessionId: event.session_id,
        workerRunId: context.workerRunId,
        emittedAt: event.emitted_at,
        delta: event.delta,
        sequence: event.sequence
      })
    );
  }

  private buildToolCallStartedEntry(
    event: Extract<RuntimeEvent, { readonly type: "tool_call_started" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_TOOL_CALL_STARTED,
      WorkerToolCallStartedPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at,
        callId: event.call_id,
        toolId: event.tool_id
      })
    );
  }

  private buildToolCallFinishedEntry(
    event: Extract<RuntimeEvent, { readonly type: "tool_call_finished" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_TOOL_CALL_FINISHED,
      WorkerToolCallFinishedPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at,
        callId: event.call_id,
        toolId: event.tool_id,
        outcome: event.outcome,
        resultSummary: event.result_summary
      })
    );
  }

  private buildPermissionRequestedEntry(
    event: Extract<RuntimeEvent, { readonly type: "permission_requested" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_PERMISSION_REQUESTED,
      WorkerPermissionRequestedPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at,
        requestId: event.request_id,
        toolId: event.tool_id,
        reason: event.reason
      })
    );
  }

  private buildPatchEmittedEntry(
    event: Extract<RuntimeEvent, { readonly type: "patch_emitted" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_PATCH_EMITTED,
      WorkerPatchEmittedPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at,
        patchId: event.patch_id,
        pathHints: event.path_hints
      })
    );
  }

  private buildRuntimeErrorEntry(
    event: Extract<RuntimeEvent, { readonly type: "runtime_error" }>,
    context: NormalizerContext
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return this.createEntry(
      context,
      WorkerRuntimeEventType.WORKER_RUNTIME_ERROR,
      WorkerRuntimeErrorPayloadSchema.parse({
        sessionId: event.session_id,
        emittedAt: event.emitted_at,
        errorCode: event.error_code,
        message: event.message
      })
    );
  }

  private createEntry(
    context: NormalizerContext,
    eventType: EventLogEntry["event_type"],
    payload: Record<string, unknown>
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    return {
      event_type: eventType,
      entity_type: "worker_run",
      entity_id: context.workerRunId,
      workspace_id: context.workspaceId,
      run_id: context.principalRunId,
      caused_by: "worker",
      payload_json: payload
    };
  }

  private warn(message: string, meta: Readonly<Record<string, unknown>>): void {
    this.dependencies.warn?.(message, meta);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime event: ${JSON.stringify(value)}`);
}

const DEFAULT_MAX_PENDING_NOTIFICATIONS = 1_000;
