import { performance } from "node:perf_hooks";

/** Caller latency is bounded; this does not interrupt synchronous worker SQLite. */
export class RecallReadWorkerDeadline {
  private readonly expiresAt: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly error: Error;

  public constructor(operation: string, timeoutMs: number) {
    this.expiresAt = performance.now() + timeoutMs;
    this.error = new Error(`recall read worker ${operation} timed out after ${timeoutMs}ms`);
    this.timer = setTimeout(() => this.controller.abort(this.error), timeoutMs);
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public remainingMs(): number {
    this.check();
    return Math.max(0, this.expiresAt - performance.now());
  }

  public check(): void {
    // Check the clock as well as the timer: a queued message can beat an overdue timer.
    if (!this.signal.aborted && performance.now() >= this.expiresAt) {
      this.controller.abort(this.error);
    }
    this.signal.throwIfAborted();
  }

  public async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let abort: () => void = () => undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      // Invoke synchronously for payload capture, but consume a synchronous throw
      // alongside expiration just like an asynchronous rejection.
      const running = new Promise<T>((resolve) => resolve(work()));
      const value = await Promise.race([running, expired]);
      this.check();
      return value;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }

  public dispose(): void {
    clearTimeout(this.timer);
  }
}
