import type { Worker } from "node:worker_threads";
import { RECALL_RETENTION_TTL_MS } from "@do-soul/alaya-core";

/** Child retention owns admission and revocation. Parent affinity adds an idle
 * ceiling for legacy source handles, never a count eviction of live executions. */
export class RecallDeliveryRoutes {
  private readonly routes = new Map<string, { worker: Worker; deadline: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  set(handle: string, worker: Worker, deadline = Date.now() + RECALL_RETENTION_TTL_MS): void {
    this.routes.set(handle, { worker, deadline });
    this.schedule();
  }
  get(handle: string): Worker | undefined { this.sweep(); return this.routes.get(handle)?.worker; }
  delete(handle: string): void { this.routes.delete(handle); this.schedule(); }
  *[Symbol.iterator](): IterableIterator<readonly [string, Worker]> {
    this.sweep();
    for (const [handle, row] of this.routes) yield [handle, row.worker];
  }
  clear(): void {
    this.routes.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private sweep(): void {
    for (const [handle, row] of this.routes) if (row.deadline <= Date.now()) this.routes.delete(handle);
  }
  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.routes.size === 0) return;
    let deadline = Number.POSITIVE_INFINITY;
    for (const row of this.routes.values()) deadline = Math.min(deadline, row.deadline);
    this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); this.schedule(); }, Math.max(1, deadline - Date.now()));
    this.timer.unref?.();
  }
}
