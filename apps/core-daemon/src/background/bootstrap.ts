import { createWarnLogger } from "../runtime/daemon/lifecycle/daemon-runtime-helpers.js";

const defaultBackgroundWarnLogger = createWarnLogger();

export interface BackgroundServiceConfig {
  readonly name: string;
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
}

export interface BackgroundServiceStopOptions {
  readonly timeoutMs?: number | null;
}

export interface BackgroundServiceLogger {
  warn(message: string, meta: Record<string, unknown>): void;
}

export interface BackgroundServiceManagerOptions {
  readonly logger?: BackgroundServiceLogger;
}

export type BackgroundServiceStopResult = "drained" | "timed_out";

export class BackgroundServiceManager {
  private readonly services: BackgroundServiceConfig[];
  private readonly logger: BackgroundServiceLogger;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private executionLocks: Map<string, boolean> = new Map();
  private started = false;
  private drainAfterStop: Promise<void> | null = null;

  public constructor(services: BackgroundServiceConfig[], options: BackgroundServiceManagerOptions = {}) {
    this.services = [...services];
    this.logger = options.logger ?? defaultBackgroundServiceLogger;
  }

  public addService(service: BackgroundServiceConfig): void {
    if (this.started) {
      throw new Error("background services cannot be added after start");
    }
    this.services.push(service);
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    for (const svc of this.services) {
      this.logger.warn("background service started", {
        service: svc.name,
        intervalMs: svc.intervalMs
      });
      this.executionLocks.set(svc.name, false);
      this.timers.push(
        setInterval(() => {
          if (this.executionLocks.get(svc.name)) {
            this.logger.warn("background service skipped because previous execution is still running", {
              service: svc.name
            });
            return;
          }

          this.executionLocks.set(svc.name, true);
          const p = svc.task()
            .catch((err) => {
              this.logger.warn("background service task failed", {
                service: svc.name,
                ...summarizeBackgroundTaskError(err)
              });
            })
            .finally(() => {
              this.executionLocks.set(svc.name, false);
            });
          this.inFlight.add(p);
          void p.finally(() => {
            this.inFlight.delete(p);
          });
        }, svc.intervalMs)
      );
    }
  }

  public async stop(options: BackgroundServiceStopOptions = {}): Promise<BackgroundServiceStopResult> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
    const drainPromise = Promise.allSettled([...this.inFlight]).then(() => undefined);
    this.drainAfterStop = drainPromise.then(() => {
      this.inFlight.clear();
    });
    if (options.timeoutMs === null) {
      await this.drainAfterStop;
      return "drained";
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (timeoutMs <= 0) {
      await this.drainAfterStop;
      return "drained";
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.logger.warn("background service stop draining timed out", {
          inFlight: this.inFlight.size
        });
        resolve();
      }, timeoutMs);
    });
    await Promise.race([this.drainAfterStop, timeoutPromise]);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    return timedOut ? "timed_out" : "drained";
  }

  public whenIdle(): Promise<void> {
    return this.drainAfterStop ?? Promise.resolve();
  }
}

const defaultBackgroundServiceLogger: BackgroundServiceLogger = Object.freeze({
  warn(message: string, meta: Record<string, unknown>) {
    defaultBackgroundWarnLogger.warn(message, meta);
  }
});

function summarizeBackgroundTaskError(error: unknown): {
  readonly errorName: string;
  readonly errorMessageRedacted: true;
} {
  return {
    errorName: error instanceof Error ? error.name : "NonError",
    errorMessageRedacted: true
  };
}
