export interface BackgroundServiceConfig {
  readonly name: string;
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
}

export interface BackgroundServiceStopOptions {
  readonly timeoutMs?: number | null;
}

export class BackgroundServiceManager {
  private readonly services: readonly BackgroundServiceConfig[];
  private timers: ReturnType<typeof setInterval>[] = [];
  private inFlight: Promise<void>[] = [];
  private executionLocks: Map<string, boolean> = new Map();
  private started = false;

  public constructor(services: BackgroundServiceConfig[]) {
    this.services = services;
  }

  public start(): void {
    if (this.started) return; // idempotent
    this.started = true;
    for (const svc of this.services) {
      console.warn(`[daemon] Background service started: ${svc.name} (interval: ${svc.intervalMs}ms)`);
      this.executionLocks.set(svc.name, false);
      this.timers.push(
        setInterval(() => {
          // Skip if previous execution still running
          if (this.executionLocks.get(svc.name)) {
            console.warn(`[daemon] Background service "${svc.name}" skipped (previous execution still running)`);
            return;
          }

          this.executionLocks.set(svc.name, true);
          const p = svc.task()
            .catch((err) => {
              console.warn(`[daemon] Background service "${svc.name}" task error:`, err);
            })
            .finally(() => {
              this.executionLocks.set(svc.name, false);
            });
          this.inFlight.push(p);
          void p.finally(() => {
            this.inFlight = this.inFlight.filter((x) => x !== p);
          });
        }, svc.intervalMs)
      );
    }
  }

  public async stop(options: BackgroundServiceStopOptions = {}): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const drainPromise = Promise.allSettled(this.inFlight).then(() => undefined);
    if (options.timeoutMs === null) {
      await drainPromise;
    } else {
      const timeoutMs = options.timeoutMs ?? 10_000;
      await Promise.race([
        drainPromise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    }
    this.inFlight = [];
    this.started = false;
  }
}
