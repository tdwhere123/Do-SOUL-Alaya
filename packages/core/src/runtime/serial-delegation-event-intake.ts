import type { RuntimeEvent } from "@do-soul/alaya-protocol";

type SessionFinishedEvent = Extract<RuntimeEvent, { readonly type: "session_finished" }>;

export class SerialDelegationEventIntake {
  // After cancel/recovery we allow a tiny observation window for an in-flight
  // terminal event to land before forcing the queue to settle without it.
  private static readonly SESSION_FINISHED_GRACE_PERIOD_MS = 25;
  private static readonly MAX_QUEUED_OPERATIONS = 4096;
  private acceptsEvents = true;
  private readonly queuedOperations: Array<() => Promise<void>> = [];
  private readonly drainWaiters = new Set<() => void>();
  private consumerRunning = false;
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
      timeoutId.unref?.();

      this.pendingSessionFinishedWaiters.add(settle);
    });
  }

  public async drain(): Promise<void> {
    while (this.consumerRunning || this.queuedOperations.length > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.add(resolve);
      });
    }

    if (this.drainError !== null) {
      const error = this.drainError;
      this.drainError = null;
      throw error;
    }
  }

  public enqueue(operation: () => Promise<void>): void {
    if (this.queuedOperations.length >= SerialDelegationEventIntake.MAX_QUEUED_OPERATIONS) {
      const error = new Error(
        `Serial delegation event queue capacity exceeded (${SerialDelegationEventIntake.MAX_QUEUED_OPERATIONS})`
      );
      this.drainError ??= error;
      process.emitWarning("[SerialDelegationEventIntake] Queued runtime event operation rejected", {
        code: "ALAYA_SERIAL_DELEGATION_QUEUE_CAPACITY_EXCEEDED",
        detail: JSON.stringify({
          capacity: SerialDelegationEventIntake.MAX_QUEUED_OPERATIONS
        })
      });
      this.resolveDrainWaitersIfIdle();
      return;
    }

    this.queuedOperations.push(operation);
    this.startConsumer();
  }

  private startConsumer(): void {
    if (this.consumerRunning) {
      return;
    }
    this.consumerRunning = true;
    void this.consumeQueue();
  }

  private async consumeQueue(): Promise<void> {
    try {
      while (this.queuedOperations.length > 0) {
        const operation = this.queuedOperations.shift();
        if (operation === undefined) {
          continue;
        }
        try {
          await operation();
        } catch (error) {
          // Runtime-event handlers are expected to route recoverable failures
          // through SerialDelegationRecovery. Keep the queue live if one
          // operation unexpectedly rejects so later events can still settle,
          // but preserve the failure for drain() so callers still observe it.
          this.drainError ??= error;
          process.emitWarning("[SerialDelegationEventIntake] Queued runtime event operation failed", {
            code: "ALAYA_SERIAL_DELEGATION_QUEUE_FAILED",
            detail: JSON.stringify({
              error: error instanceof Error ? error.message : String(error)
            })
          });
        }
      }
    } finally {
      this.consumerRunning = false;
      if (this.queuedOperations.length > 0) {
        this.startConsumer();
        return;
      }
      this.resolveDrainWaitersIfIdle();
    }
  }

  private resolvePendingSessionFinishedWaiters(event: SessionFinishedEvent): void {
    for (const waiter of this.pendingSessionFinishedWaiters) {
      waiter(event);
    }
  }

  private resolveDrainWaitersIfIdle(): void {
    if (this.consumerRunning || this.queuedOperations.length > 0) {
      return;
    }
    for (const waiter of this.drainWaiters) {
      waiter();
    }
    this.drainWaiters.clear();
  }
}
