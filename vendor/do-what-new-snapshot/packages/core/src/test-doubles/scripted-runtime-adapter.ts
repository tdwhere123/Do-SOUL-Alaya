import {
  RuntimeCapabilitiesSchema,
  RuntimeCancelResultSchema,
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

const DEFAULT_CAPABILITIES: RuntimeCapabilities = RuntimeCapabilitiesSchema.parse({
  supports_resume: true,
  supports_interrupt: true,
  supports_streaming_updates: true,
  supports_tool_events: true,
  supports_permission_requests: true,
  supports_artifact_events: false,
  supports_terminal_events: false
});

export class ScriptedRuntimeAdapter implements AgentRuntimePort {
  public readonly kind = "scripted_runtime";
  private readonly handlers = new Set<(event: RuntimeEvent) => void>();
  private readonly scriptedEvents: readonly RuntimeEvent[];
  private readonly capabilities: RuntimeCapabilities;
  private session: RuntimeSession | null = null;
  private cancelled = false;
  private finished = false;

  public constructor(events: readonly RuntimeEvent[], capabilities: RuntimeCapabilities = DEFAULT_CAPABILITIES) {
    this.scriptedEvents = Object.freeze(events.map((event) => RuntimeEventSchema.parse(event)));
    this.capabilities = RuntimeCapabilitiesSchema.parse(capabilities);
  }

  public getCapabilities(): RuntimeCapabilities {
    return this.capabilities;
  }

  public async createSession(config: RuntimeSessionConfig): Promise<RuntimeSession> {
    RuntimeSessionConfigSchema.parse(config);
    this.session = RuntimeSessionSchema.parse({
      session_id: this.inferSessionId()
    });
    this.cancelled = false;
    this.finished = false;
    return this.session;
  }

  public async prompt(sessionId: string, input: RuntimeTurnInput): Promise<void> {
    this.assertActiveSession(sessionId);
    RuntimeTurnInputSchema.parse(input);
  }

  public async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    this.assertSession(sessionId);

    if (this.finished) {
      return RuntimeCancelResultSchema.parse({
        session_id: sessionId,
        status: "already_finished"
      });
    }

    this.cancelled = true;
    this.finished = true;

    this.emit({
      type: "session_finished",
      session_id: sessionId,
      emitted_at: new Date().toISOString(),
      status: "cancelled",
      result_summary: "cancelled by scripted adapter"
    });

    return RuntimeCancelResultSchema.parse({
      session_id: sessionId,
      status: "cancelled"
    });
  }

  public onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  public async replay(): Promise<void> {
    if (this.session === null) {
      throw new Error("ScriptedRuntimeAdapter requires createSession() before replay().");
    }

    for (const event of this.scriptedEvents) {
      if (this.cancelled) {
        break;
      }

      this.emit({
        ...event,
        session_id: this.session.session_id
      });

      if (event.type === "session_finished") {
        this.finished = true;
      }
    }
  }

  private inferSessionId(): string {
    return this.scriptedEvents[0]?.session_id ?? "scripted-session-1";
  }

  private assertSession(sessionId: string): void {
    if (this.session === null || this.session.session_id !== sessionId) {
      throw new Error(`Unknown scripted runtime session: ${sessionId}`);
    }
  }

  private assertActiveSession(sessionId: string): void {
    this.assertSession(sessionId);
    if (this.finished || this.cancelled) {
      throw new Error(`Scripted runtime session already finished: ${sessionId}`);
    }
  }

  private emit(event: RuntimeEvent): void {
    const parsedEvent = RuntimeEventSchema.parse(event);
    for (const handler of this.handlers) {
      try {
        handler(parsedEvent);
      } catch {
        // Handler errors are isolated so remaining handlers still receive the event.
      }
    }
  }
}
