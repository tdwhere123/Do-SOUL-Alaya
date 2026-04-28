import {
  RuntimeCancelResultSchema,
  RuntimeCapabilitiesSchema,
  RuntimeEventSchema,
  RuntimeSessionConfigSchema,
  RuntimeSessionSchema,
  RuntimeTurnInputSchema,
  type AgentRuntimePort,
  type RuntimeCapabilities,
  type RuntimeCancelResult,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionConfig,
  type RuntimeTurnInput
} from "@do-what/protocol";
import { CoreError } from "../errors.js";
import { mapClaudeEventToRuntimeEvent } from "./claude-event-mapper.js";
import {
  ClaudeRuntimeSessionState,
  type PendingCancelRequest
} from "./claude-runtime-session-state.js";
import type { ClaudeSDKClientFactory, ClaudeSDKMessage, ClaudeSDKTurnHandle } from "./claude-sdk-client.js";

const VERIFIED_CAPABILITIES: RuntimeCapabilities = RuntimeCapabilitiesSchema.parse({
  supports_resume: false,
  supports_interrupt: true,
  supports_streaming_updates: true,
  supports_tool_events: false,
  supports_permission_requests: false,
  supports_artifact_events: true,
  supports_terminal_events: false
});

interface ClaudeRuntimeAdapterDependencies {
  readonly clientFactory: ClaudeSDKClientFactory;
  readonly now?: () => string;
}

export class ClaudeRuntimeAdapter implements AgentRuntimePort {
  public readonly kind = "claude_code";
  private readonly handlers = new Set<(event: RuntimeEvent) => void>();
  private sessionState: ClaudeRuntimeSessionState | null = null;

  public constructor(private readonly dependencies: ClaudeRuntimeAdapterDependencies) {}

  public getCapabilities(): RuntimeCapabilities {
    return VERIFIED_CAPABILITIES;
  }

  public async createSession(config: RuntimeSessionConfig): Promise<RuntimeSession> {
    const parsedConfig = RuntimeSessionConfigSchema.parse(config);

    if (this.sessionState !== null && !this.sessionState.hasFinished()) {
      throw new CoreError("CONFLICT", "Claude runtime session already active.");
    }

    const session = RuntimeSessionSchema.parse({
      session_id: crypto.randomUUID()
    });

    this.sessionState = new ClaudeRuntimeSessionState(parsedConfig, session.session_id);

    return session;
  }

  public async prompt(sessionId: string, input: RuntimeTurnInput): Promise<void> {
    const session = this.requireActiveSession(sessionId);
    RuntimeTurnInputSchema.parse(input);

    if (session.hasActiveTurn()) {
      throw new CoreError("CONFLICT", "Claude runtime turn already active.");
    }

    this.consumeTurn(session, input).catch(() => {
      // Observable errors are already emitted as runtime_error + session_finished events.
      // This catch prevents Node.js UnhandledPromiseRejection if the outer catch block
      // itself throws (e.g. RuntimeEventSchema.parse failure inside emit()).
    });
    session.beginTurn();
  }

  public async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    const session = this.requireSession(sessionId);

    if (session.hasFinished()) {
      return RuntimeCancelResultSchema.parse({
        session_id: sessionId,
        status: "already_finished"
      });
    }

    if (!session.hasActiveTurn()) {
      return this.finishCancelledSession(session);
    }

    const cancel = session.getCancel();
    if (cancel !== undefined) {
      return this.runInterruptCancel(session, cancel);
    }

    return session.ensurePendingCancel().promise;
  }

  public onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private async consumeTurn(session: ClaudeRuntimeSessionState, input: RuntimeTurnInput): Promise<void> {
    try {
      const handle = await this.dependencies.clientFactory.startTurn({
        sessionConfig: session.config,
        input
      });

      if (session.hasFinished()) {
        try {
          await handle.cancel?.();
        } catch (_error) {
          // The session already reached a terminal state on the do-what side.
        }
        return;
      }

      if (session.hasActiveTurn()) {
        session.setCancel(handle.cancel);

        const pendingCancel = session.getPendingCancel();
        if (pendingCancel !== null) {
          if (handle.cancel === undefined) {
            this.rejectPendingCancel(session, pendingCancel, "Claude SDK turn did not expose interrupt support.");
            return;
          }

          await this.completePendingCancel(session, pendingCancel, handle.cancel);
          return;
        }
      }

      if (VERIFIED_CAPABILITIES.supports_interrupt && handle.cancel === undefined) {
        throw new Error("Claude SDK turn did not expose interrupt support.");
      }

      this.emit({
        type: "session_started",
        session_id: session.sessionId,
        emitted_at: this.resolveNow()
      });

      await this.consumeMessages(session, handle);

      if (!session.hasFinished()) {
        this.finishSession(session, "completed", null);
      }
    } catch (error) {
      if (!session.hasFinished()) {
        this.emit({
          type: "runtime_error",
          session_id: session.sessionId,
          emitted_at: this.resolveNow(),
          error_code: "sdk_query_failed",
          message: normalizeErrorMessage(error)
        });
        this.finishSession(session, "failed", null);
      }

      const pendingCancel = session.getPendingCancel();

      if (pendingCancel !== null) {
        pendingCancel.reject(
          new Error("Claude runtime interrupt failed.", {
            cause: error
          })
        );
      }
    } finally {
      session.clearActiveTurn();
    }
  }

  private async consumeMessages(session: ClaudeRuntimeSessionState, handle: ClaudeSDKTurnHandle): Promise<void> {
    for await (const message of handle.messages) {
      if (session.hasFinished()) {
        break;
      }

      const turnOutcome = mapClaudeResultToOutcome(message);
      if (turnOutcome !== null) {
        this.finishSession(session, turnOutcome.status, turnOutcome.resultSummary);
        break;
      }

      const mapped = mapClaudeEventToRuntimeEvent({
        emittedAt: this.resolveNow(),
        message,
        nextSequence: session.currentSequence(),
        sessionId: session.sessionId
      });

      session.updateSequence(mapped.nextSequence);

      if (mapped.event === null) {
        continue;
      }

      this.emit(mapped.event);
    }
  }

  private requireSession(sessionId: string): ClaudeRuntimeSessionState {
    if (this.sessionState === null || this.sessionState.sessionId !== sessionId) {
      throw new CoreError("NOT_FOUND", `Unknown Claude runtime session: ${sessionId}`);
    }

    return this.sessionState;
  }

  private requireActiveSession(sessionId: string): ClaudeRuntimeSessionState {
    const session = this.requireSession(sessionId);

    if (session.hasFinished()) {
      throw new CoreError("CONFLICT", `Claude runtime session already finished: ${sessionId}`);
    }

    return session;
  }

  private finishSession(
    session: ClaudeRuntimeSessionState,
    status: "completed" | "cancelled" | "failed",
    resultSummary: string | null
  ): void {
    if (!session.markFinished()) {
      return;
    }

    this.emit({
      type: "session_finished",
      session_id: session.sessionId,
      emitted_at: this.resolveNow(),
      status,
      result_summary: resultSummary
    });
  }

  private emit(event: RuntimeEvent): void {
    const parsedEvent = RuntimeEventSchema.parse(event);

    for (const handler of this.handlers) {
      try {
        handler(parsedEvent);
      } catch (_error) {
        // Handler failures are isolated so later subscribers still receive the event.
      }
    }
  }

  private finishCancelledSession(session: ClaudeRuntimeSessionState): RuntimeCancelResult {
    this.finishSession(session, "cancelled", "cancelled by claude runtime adapter");

    return RuntimeCancelResultSchema.parse({
      session_id: session.sessionId,
      status: "cancelled"
    });
  }

  private async runInterruptCancel(
    session: ClaudeRuntimeSessionState,
    cancel: () => Promise<void>
  ): Promise<RuntimeCancelResult> {
    try {
      await cancel();
    } catch (error) {
      if (!session.hasFinished()) {
        this.emit({
          type: "runtime_error",
          session_id: session.sessionId,
          emitted_at: this.resolveNow(),
          error_code: "sdk_interrupt_failed",
          message: normalizeErrorMessage(error)
        });
        this.finishSession(session, "failed", null);
      }

      throw new Error("Claude runtime interrupt failed.", {
        cause: error
      });
    }

    return this.finishCancelledSession(session);
  }

  private async completePendingCancel(
    session: ClaudeRuntimeSessionState,
    pendingCancel: PendingCancelRequest,
    cancel: () => Promise<void>
  ): Promise<void> {
    try {
      const result = await this.runInterruptCancel(session, cancel);
      pendingCancel.resolve(result);
    } catch (error) {
      pendingCancel.reject(error instanceof Error ? error : new Error("Claude runtime interrupt failed."));
    }
  }

  private rejectPendingCancel(session: ClaudeRuntimeSessionState, pendingCancel: PendingCancelRequest, message: string): void {
    this.emit({
      type: "runtime_error",
      session_id: session.sessionId,
      emitted_at: this.resolveNow(),
      error_code: "sdk_interrupt_failed",
      message
    });
    this.finishSession(session, "failed", null);
    pendingCancel.reject(
      new Error("Claude runtime interrupt failed.", {
        cause: new Error(message)
      })
    );
  }

  private resolveNow(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unknown Claude SDK runtime error";
}

function mapClaudeResultToOutcome(
  message: ClaudeSDKMessage
):
  | {
      readonly status: "completed" | "failed";
      readonly resultSummary: string | null;
    }
  | null {
  if (isClaudeResultSuccess(message)) {
    return {
      status: "completed",
      resultSummary: typeof message.result === "string" ? message.result : null
    };
  }

  if (isClaudeResultFailure(message)) {
    return {
      status: "failed",
      resultSummary: normalizeClaudeErrors(message.errors)
    };
  }

  return null;
}

function isClaudeResultSuccess(
  message: ClaudeSDKMessage
): message is {
  readonly type: "result";
  readonly subtype: "success";
  readonly result?: string;
} {
  return message.type === "result" && message.subtype === "success";
}

function isClaudeResultFailure(
  message: ClaudeSDKMessage
): message is {
  readonly type: "result";
  readonly subtype: ClaudeResultFailureSubtype;
  readonly errors?: readonly string[];
} {
  return (
    message.type === "result" &&
    typeof message.subtype === "string" &&
    RESULT_FAILURE_SUBTYPES.includes(message.subtype as ClaudeResultFailureSubtype)
  );
}

type ClaudeResultFailureSubtype =
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

const RESULT_FAILURE_SUBTYPES: readonly ClaudeResultFailureSubtype[] = [
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries"
];

function normalizeClaudeErrors(value: unknown): string | null {
  if (!Array.isArray(value)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    return null;
  }

  const normalized = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return normalized.length === 0 ? null : normalized.join("; ");
}
