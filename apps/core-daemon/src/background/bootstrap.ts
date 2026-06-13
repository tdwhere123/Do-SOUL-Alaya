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

export class BackgroundServiceManager {
  private readonly services: readonly BackgroundServiceConfig[];
  private readonly logger: BackgroundServiceLogger;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private executionLocks: Map<string, boolean> = new Map();
  private started = false;

  public constructor(services: BackgroundServiceConfig[], options: BackgroundServiceManagerOptions = {}) {
    this.services = services;
    this.logger = options.logger ?? defaultBackgroundServiceLogger;
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
                error: err instanceof Error ? err.message : String(err)
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

  public async stop(options: BackgroundServiceStopOptions = {}): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const drainPromise = Promise.allSettled([...this.inFlight]).then(() => undefined);
    if (options.timeoutMs === null) {
      await drainPromise;
    } else {
      const timeoutMs = options.timeoutMs ?? 10_000;
      await Promise.race([drainPromise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    }
    this.inFlight.clear();
    this.started = false;
  }
}

const defaultBackgroundServiceLogger: BackgroundServiceLogger = Object.freeze({
  warn(message: string, meta: Record<string, unknown>) {
    console.warn(message, meta);
  }
});
