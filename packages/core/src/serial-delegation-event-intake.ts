import type { RuntimeEvent } from "@do-soul/alaya-protocol";

type SessionFinishedEvent = Extract<RuntimeEvent, { readonly type: "session_finished" }>;

export class SerialDelegationEventIntake {
  // After cancel/recovery we allow a tiny observation window for an in-flight
  // terminal event to land before forcing the queue to settle without it.
  private static readonly SESSION_FINISHED_GRACE_PERIOD_MS = 25;
  private acceptsEvents = true;
  private eventQueue: Promise<void> = Promise.resolve();
  private drainError: unknown = null;
  private pendingSessionFinishedEvent: SessionFinishedEvent | null = null;
  private readonly pendingSessionFinishedWaiters = new Set<
    (event: SessionFinishedEvent | null) => void
  >();

  public accepts(event: RuntimeEvent, sessionId: string): boolean {
    return this.acceptsEvents && event.session_id === sessionId;
  }

  public stop(): void {
    this.acceptsEvents = false;
  }

  public resume(): void {
    this.acceptsEvents = true;
  }

  public isAcceptingEvents(): boolean {
    return this.acceptsEvents;
  }

  public note(event: RuntimeEvent): void {
    if (event.type === "session_finished") {
      this.pendingSessionFinishedEvent = event;
      this.resolvePendingSessionFinishedWaiters(event);
    }
  }

  public clearPendingIfCurrent(event: SessionFinishedEvent): void {
    if (this.pendingSessionFinishedEvent === event) {
      this.pendingSessionFinishedEvent = null;
    }
  }

  public getPendingSessionFinishedEvent(): SessionFinishedEvent | null {
    return this.pendingSessionFinishedEvent;
  }

  public async awaitPendingSessionFinishedEvent(): Promise<SessionFinishedEvent | null> {
    if (this.pendingSessionFinishedEvent !== null) {
      return this.pendingSessionFinishedEvent;
    }

    return await new Promise<SessionFinishedEvent | null>((resolve) => {
      const settle = (event: SessionFinishedEvent | null) => {
        clearTimeout(timeoutId);
        this.pendingSessionFinishedWaiters.delete(settle);
        resolve(event);
      };
      const timeoutId = setTimeout(() => {
        settle(this.pendingSessionFinishedEvent);
      }, SerialDelegationEventIntake.SESSION_FINISHED_GRACE_PERIOD_MS);

      this.pendingSessionFinishedWaiters.add(settle);
    });
  }

  public async drain(): Promise<void> {
    await this.eventQueue;

    if (this.drainError !== null) {
      const error = this.drainError;
      this.drainError = null;
      throw error;
    }
  }

  public enqueue(operation: () => Promise<void>): void {
    this.eventQueue = this.eventQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await operation();
        } catch (error) {
          // Runtime-event handlers are expected to route recoverable failures
          // through SerialDelegationRecovery. Keep the queue live if one
          // operation unexpectedly rejects so later events can still settle,
          // but preserve the failure for drain() so callers still observe it.
          this.drainError ??= error;
        }
      });
  }

  private resolvePendingSessionFinishedWaiters(event: SessionFinishedEvent): void {
    for (const waiter of this.pendingSessionFinishedWaiters) {
      waiter(event);
    }
  }
}
