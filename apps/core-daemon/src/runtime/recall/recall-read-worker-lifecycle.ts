import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { CoreError, type RecallReadSnapshotPort } from "@do-soul/alaya-core";
import { isPathAffinityOperation, isRecallReadWorkerResponse } from "../recall-read-worker/client-config.js";
import { parseWorkerOperationResult } from "../recall-read-worker/operation-schemas.js";
import { RECALL_READ_WORKER_PROTOCOL_VERSION, type RecallReadWorkerOperation,
  type RecallReadWorkerRequest } from "../recall-read-worker/protocol.js";
import type { RecallPathReadBind } from "./recall-path-read-bind.js";
import { RecallReadWorkerDeadline } from "./recall-read-worker-deadline.js";

export type SuccessConsumption = Readonly<{ readonly done: boolean; readonly value?: unknown }>;

type Resource = {
  readonly worker: Worker;
  readonly exited: Promise<void>;
  readonly finishExit: () => void;
  readonly invalidated: AbortController;
  state: "active" | "quarantined" | "exited";
  failure?: unknown;
  lease?: symbol;
};
type Lease = { readonly resource: Resource; readonly token: symbol };
type Waiter = {
  readonly deadline: RecallReadWorkerDeadline;
  readonly preferred?: Worker;
  readonly index?: number;
  readonly resolve: (resource: Resource) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
};
type Pending = {
  readonly resource: Resource;
  readonly deadline: RecallReadWorkerDeadline;
  readonly operation: RecallReadWorkerOperation;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly consumeSuccess?: (value: unknown) => SuccessConsumption;
};
type Options = {
  readonly databaseFilename: string;
  readonly workerUrl: URL;
  readonly workerCount: number;
  readonly requestTimeoutMs: number;
  readonly pathReadBind?: RecallPathReadBind;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly onUnavailable: (worker: Worker) => void;
};

/** One slot owns a worker through quarantine and actual exit, including its snapshot lease. */
export class RecallReadWorkerLifecycle {
  private readonly slots: (Resource | undefined)[];
  private readonly resources = new WeakMap<Worker, Resource>();
  private readonly leases = new AsyncLocalStorage<Lease>();
  private readonly deadlines = new AsyncLocalStorage<RecallReadWorkerDeadline>();
  private readonly waiters = new Set<Waiter>();
  private readonly pending = new Map<number, Pending>();
  private nextIndex = 0;
  private nextRequestId = 1;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  public readonly readSnapshot: RecallReadSnapshotPort = {
    beginDeferred: async () => { await this.snapshotOperation("snapshot.beginDeferred"); },
    commit: async () => { await this.snapshotOperation("snapshot.commit"); },
    rollback: async () => { await this.snapshotOperation("snapshot.rollback"); }
  };

  public constructor(private readonly options: Options) {
    this.slots = Array.from({ length: options.workerCount });
    this.spawn(0);
  }

  public isAvailable(worker: Worker): boolean {
    return !this.closed && this.resources.get(worker)?.state === "active";
  }

  public pinnedWorker(): Worker | undefined {
    const lease = this.leases.getStore();
    if (lease === undefined) return undefined;
    this.assertUsable(lease.resource);
    if (lease.resource.lease !== lease.token) throw new CoreError("CONFLICT", "recall read snapshot lease is no longer active");
    return lease.resource.worker;
  }

  public async withinDeadline<T>(operation: string, work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const inherited = this.deadlines.getStore();
    if (inherited !== undefined) return await inherited.run(work);
    const deadline = new RecallReadWorkerDeadline(operation, this.options.requestTimeoutMs);
    try {
      return await this.deadlines.run(deadline, async () => await deadline.run(work));
    } finally {
      deadline.dispose();
    }
  }

  public async isolate<T>(work: () => Promise<T>, preferred?: Worker, index?: number): Promise<T> {
    return await this.withinDeadline("snapshot", async () => {
      const pinned = this.pinnedWorker();
      if (pinned !== undefined) {
        if (preferred !== undefined && preferred !== pinned) {
          throw new CoreError("VALIDATION", "preparation handle belongs to another snapshot worker");
        }
        return await work();
      }
      const deadline = this.deadlines.getStore()!;
      const resource = await this.acquire(deadline, preferred, index);
      const token = resource.lease!;
      const expire = () => this.quarantine(resource, deadline.signal.reason);
      let invalidate: () => void = () => undefined;
      deadline.signal.addEventListener("abort", expire, { once: true });
      try {
        deadline.check();
        this.assertUsable(resource);
        const unavailable = new Promise<never>((_resolve, reject) => {
          invalidate = () => reject(resource.failure);
          resource.invalidated.signal.addEventListener("abort", invalidate, { once: true });
        });
        const running = new Promise<T>((resolve) => resolve(this.leases.run({ resource, token }, work)));
        const result = await Promise.race([running, unavailable]);
        deadline.check();
        return result;
      } finally {
        deadline.signal.removeEventListener("abort", expire);
        resource.invalidated.signal.removeEventListener("abort", invalidate);
        if (resource.lease === token) {
          if ([...this.pending.values()].some((pending) => pending.resource === resource)) {
            this.quarantine(resource, new Error("recall read snapshot ended with requests still running"));
          }
          resource.lease = undefined;
        }
        this.drain();
      }
    });
  }

  public async request<T>(operation: RecallReadWorkerOperation, payload: unknown,
    consumeSuccess?: (value: unknown) => SuccessConsumption, preferred?: Worker): Promise<T> {
    return await this.withinDeadline(operation, async () => await this.isolate(async () => {
      const resource = this.resources.get(this.pinnedWorker()!)!;
      return await this.send<T>(resource, operation, payload, consumeSuccess);
    }, preferred, isPathAffinityOperation(operation) || operation.startsWith("conditionalField.") || operation === "ready" ? 0 : undefined));
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const error = new Error("recall read worker is closed");
    for (const waiter of this.waiters) this.finishWaiter(waiter, error);
    const resources = this.slots.filter((resource): resource is Resource => resource !== undefined);
    for (const resource of resources) this.quarantine(resource, error);
    // Worker.terminate() cannot promptly interrupt synchronous native SQLite. Only exit
    // frees a slot, and shutdown stays pending until every live/quarantined worker exits.
    await Promise.all(resources.map((resource) => resource.exited));
  }

  private async snapshotOperation(operation: RecallReadWorkerOperation): Promise<void> {
    if (this.pinnedWorker() === undefined) throw new CoreError("OBLIGATION_VIOLATION", "recall read snapshot is not isolated onto a worker");
    await this.request(operation, {});
  }

  private assertOpen(): void {
    if (this.closed) throw new CoreError("CONFLICT", "recall read worker is closed");
  }

  private assertUsable(resource: Resource): void {
    if (resource.state !== "active") throw resource.failure;
    this.assertOpen();
  }

  private acquire(deadline: RecallReadWorkerDeadline, preferred?: Worker, index?: number): Promise<Resource> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { deadline, resolve, reject,
        ...(preferred === undefined ? {} : { preferred }),
        ...(index === undefined ? {} : { index }),
        abort: () => this.finishWaiter(waiter, deadline.signal.reason) };
      this.waiters.add(waiter);
      deadline.signal.addEventListener("abort", waiter.abort, { once: true });
      this.drain();
    });
  }

  private finishWaiter(waiter: Waiter, error: unknown, resource?: Resource): void {
    if (!this.waiters.delete(waiter)) return;
    waiter.deadline.signal.removeEventListener("abort", waiter.abort);
    if (resource === undefined) waiter.reject(error);
    else waiter.resolve(resource);
  }

  private drain(): void {
    if (this.closed) return;
    for (const waiter of this.waiters) {
      try {
        waiter.deadline.check();
        const resource = this.availableResource(waiter);
        if (resource === undefined) continue;
        resource.lease = Symbol("recall snapshot lease");
        this.finishWaiter(waiter, undefined, resource);
      } catch (error) {
        this.finishWaiter(waiter, error);
      }
    }
  }

  private availableResource(waiter: Waiter): Resource | undefined {
    if (waiter.preferred !== undefined) {
      const resource = this.resources.get(waiter.preferred);
      if (resource === undefined) throw new CoreError("CONFLICT", "Recall delivery worker unavailable");
      this.assertUsable(resource);
      return resource.lease === undefined ? resource : undefined;
    }
    for (let offset = 0; offset < this.slots.length; offset += 1) {
      const index = waiter.index ?? (this.nextIndex + offset) % this.slots.length;
      const resource = this.slots[index] ?? this.spawn(index);
      if (resource.state === "active" && resource.lease === undefined) {
        this.nextIndex = (index + 1) % this.slots.length;
        return resource;
      }
      if (waiter.index !== undefined) break;
    }
    return undefined;
  }

  private spawn(index: number): Resource {
    const worker = new Worker(this.options.workerUrl, {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: { databaseFilename: this.options.databaseFilename,
        ...(this.options.pathReadBind === undefined ? {} : { pathReadBind: this.options.pathReadBind }) }
    });
    let finishExit!: () => void;
    const resource: Resource = { worker, state: "active", invalidated: new AbortController(),
      exited: new Promise<void>((resolve) => { finishExit = resolve; }),
      finishExit: () => finishExit() };
    this.slots[index] = resource;
    this.resources.set(worker, resource);
    worker.on("message", (message: unknown) => this.handleMessage(resource, message));
    worker.on("error", (error) => {
      this.quarantine(resource, error);
      this.options.warn?.("recall read worker failed", { error: error.message });
    });
    worker.once("exit", (code) => {
      if (resource.state === "active") {
        this.quarantine(resource, new Error(`recall read worker exited with code ${code}`), false);
        this.options.warn?.("recall read worker exited unexpectedly", { code });
      }
      resource.state = "exited";
      if (this.slots[index] === resource) this.slots[index] = undefined;
      resource.finishExit();
      this.drain();
    });
    return resource;
  }

  private quarantine(resource: Resource, error: unknown, terminate = true): void {
    if (resource.state !== "active") return;
    resource.state = "quarantined";
    resource.failure = error;
    resource.invalidated.abort(error);
    this.options.onUnavailable(resource.worker);
    for (const [id, pending] of this.pending) {
      if (pending.resource !== resource) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
    // Do not clear the slot or create a replacement here. Termination is only a
    // request; native work can continue, with unknown execution, until actual exit.
    if (terminate) void resource.worker.terminate().catch(() => undefined);
    this.drain();
  }

  private send<T>(resource: Resource, operation: RecallReadWorkerOperation, payload: unknown,
    consumeSuccess?: (value: unknown) => SuccessConsumption): Promise<T> {
    const deadline = this.deadlines.getStore()!;
    deadline.check();
    this.assertUsable(resource);
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resource, deadline, operation, reject,
        resolve: (value) => resolve(value as T),
        ...(consumeSuccess === undefined ? {} : { consumeSuccess }) });
      try {
        resource.worker.postMessage({ protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION,
          id, operation, payload } satisfies RecallReadWorkerRequest);
      } catch (error) {
        this.quarantine(resource, error);
      }
    });
  }

  private handleMessage(resource: Resource, message: unknown): void {
    if (resource.state !== "active" || !isRecallReadWorkerResponse(message)) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined || pending.resource !== resource) return;
    try {
      pending.deadline.check();
      if (message.ok) {
        const parsed = parseWorkerOperationResult(pending.operation, message.result);
        const consumed = pending.consumeSuccess?.(parsed);
        pending.deadline.check();
        if (consumed !== undefined && !consumed.done) return;
        this.pending.delete(message.id);
        pending.resolve(consumed?.value ?? parsed);
      } else {
        const error = message.error.core === undefined ? new Error(message.error.message)
          : new CoreError(message.error.core.code, message.error.message,
            { subCode: message.error.core.subCode, details: message.error.core.details });
        error.name = message.error.name;
        if (message.error.stack !== undefined) error.stack = message.error.stack;
        this.pending.delete(message.id);
        // A worker-reported domain rejection is known failure, not a broken transport.
        pending.reject(error);
      }
    } catch (error) {
      this.quarantine(resource, error);
    }
  }
}
