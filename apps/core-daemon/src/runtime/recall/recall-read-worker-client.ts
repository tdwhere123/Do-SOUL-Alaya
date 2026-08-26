import { Worker } from "node:worker_threads";
import type { PathAnchorRef } from "@do-soul/alaya-protocol";
import type {
  RecallReadSnapshotPort,
  RecallServiceActiveConstraintsPort,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServicePathPlasticityPort,
  RecallServiceSynthesisSearchPort
} from "@do-soul/alaya-core";
import type { RecallPathProjectionReadOptions } from "./recall-path-readers.js";
import type { RecallTemporalProjectionEnsurer } from "./recall-path-readers.js";
import type { RecallPathReadBind } from "./recall-path-read-bind.js";
import type {
  RecallReadWorkerOperation,
  RecallReadWorkerRequest,
  RecallReadWorkerResponse
} from "../recall-read-worker/protocol.js";
import {
  isPathAffinityOperation,
  isRecallReadWorkerResponse,
  normalizeRequestTimeoutMs,
  normalizeWorkerCount,
  resolveDefaultWorkerUrl
} from "../recall-read-worker/client-config.js";
import { createTierWindowChunkConsumer } from "../recall-read-worker/tier-window-client.js";
import {
  createWorkerMemoryRepo,
  type WorkerTierWindowResult
} from "../recall-read-worker/memory-client.js";
import { createRecallReadSnapshotSession } from "../recall-read-worker/snapshot-session.js";
type SuccessConsumption = Readonly<{ readonly done: boolean; readonly value?: unknown }>;

export interface RecallReadWorkerClient {
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly evidenceSearchPort: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort: RecallServiceSynthesisSearchPort;
  readonly pathExpansionPort: RecallServicePathExpansionPort;
  readonly pathPlasticityPort: RecallServicePathPlasticityPort;
  readonly activeConstraintsPort: RecallServiceActiveConstraintsPort;
  readonly readSnapshot: RecallReadSnapshotPort;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function createRecallReadWorkerClient(input: {
  readonly databaseFilename: string;
  readonly pathReadBind?: RecallPathReadBind;
  readonly workerUrl?: URL;
  readonly workerCount?: number;
  readonly requestTimeoutMs?: number;
  readonly prepareTemporalProjection?: RecallTemporalProjectionEnsurer;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}): RecallReadWorkerClient | null {
  if (input.databaseFilename === ":memory:") {
    return null;
  }

  const workerUrl = input.workerUrl ?? resolveDefaultWorkerUrl();
  if (workerUrl === null) {
    if (isSourceRuntimeUrl(import.meta.url)) {
      input.warn?.(
        "recall read worker script unavailable in source runtime; using direct sqlite recall reads",
        { reason: "worker_script_missing" }
      );
      return null;
    }
    throw new Error("recall read worker script is missing");
  }

  return new WorkerBackedRecallReadClient({ ...input, workerUrl });
}

class WorkerBackedRecallReadClient implements RecallReadWorkerClient {
  private readonly workers: (Worker | null)[];
  private readonly databaseFilename: string;
  private readonly requestTimeoutMs: number;
  private readonly pathReadBind: RecallPathReadBind | undefined;
  private readonly prepareTemporalProjection?: RecallTemporalProjectionEnsurer;
  private readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  private readonly workerUrl: URL;
  private nextWorkerIndex = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
      readonly worker: Worker;
      readonly consumeSuccess?: (value: unknown) => SuccessConsumption;
    }
  >();
  private closed = false;
  private closeStarted = false;
  private closePromise: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly snapshotSession: ReturnType<typeof createRecallReadSnapshotSession>;
  public readonly readSnapshot: RecallReadSnapshotPort;

  public readonly memoryRepo: RecallServiceMemoryRepoPort = createWorkerMemoryRepo({
    request: async (operation, payload) => await this.request(operation, payload),
    readTierWindow: async (query) =>
      await this.dispatch<WorkerTierWindowResult>(
        "memory.findRecallTierWindow",
        query,
        createTierWindowChunkConsumer()
      )
  });

  public readonly evidenceSearchPort: RecallServiceEvidenceSearchPort = {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("evidence.searchByKeyword", { workspaceId, queryText, limit }),
    searchByKeywordField: async (workspaceId, queryText, limit, refinementDepths) =>
      await this.request("evidence.searchByKeywordField", {
        workspaceId, queryText, limit,
        ...(refinementDepths === undefined ? {} : { refinementDepths })
      }),
    searchManyByKeywordField: async (workspaceId, queries) =>
      await this.request("evidence.searchManyByKeywordField", { workspaceId, queries }),
    findByIds: async (workspaceId, evidenceObjectIds) =>
      await this.request("evidence.findByIds", { workspaceId, evidenceObjectIds }),
    findRecallQualifiedByIds: async (workspaceId, matches) =>
      await this.request("evidence.findRecallQualifiedByIds", { workspaceId, matches }),
    findRecallQualifiedFactKeysByIds: async (workspaceId, evidenceObjectIds) =>
      await this.request("evidence.findRecallQualifiedFactKeysByIds", {
        workspaceId,
        evidenceObjectIds
      }),
    findSourceAnchorsByIds: async (workspaceId, evidenceObjectIds) =>
      await this.request("evidence.findSourceAnchorsByIds", { workspaceId, evidenceObjectIds })
  };

  public readonly synthesisSearchPort: RecallServiceSynthesisSearchPort = {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("synthesis.searchByKeyword", { workspaceId, queryText, limit }),
    searchByKeywordField: async (workspaceId, queryText, limit, refinementDepths) =>
      await this.request("synthesis.searchByKeywordField", {
        workspaceId, queryText, limit,
        ...(refinementDepths === undefined ? {} : { refinementDepths })
      }),
    searchManyByKeywordField: async (workspaceId, queries) =>
      await this.request("synthesis.searchManyByKeywordField", { workspaceId, queries }),
    findByIds: async (workspaceId: string, objectIds: readonly string[]) =>
      await this.request("synthesis.findByIds", { workspaceId, objectIds })
  };

  public readonly pathExpansionPort: RecallServicePathExpansionPort = {
    findByAnchors: async (
      workspaceId: string,
      anchorRefs: readonly PathAnchorRef[],
      options?: RecallPathProjectionReadOptions
    ) =>
      await this.request("path.findByAnchors", {
        workspaceId,
        anchorRefs,
        ...this.pathReadOptions(options)
      }),
    findByTimeConcernWindowDigests: async (
      workspaceId: string,
      windowDigests: readonly string[],
      options?: RecallPathProjectionReadOptions
    ) =>
      await this.request("path.findByTimeConcernWindowDigests", {
        workspaceId,
        windowDigests,
        ...this.pathReadOptions(options)
      })
  };

  public readonly pathPlasticityPort: RecallServicePathPlasticityPort = {
    getStrengthByMemoryId: async (
      workspaceId: string,
      memoryIds: readonly string[],
      options?: RecallPathProjectionReadOptions
    ) => {
      const entries = await this.request<readonly (readonly [string, number])[]>(
        "pathPlasticity.getStrengthByMemoryId",
        { workspaceId, memoryIds, ...this.pathReadOptions(options) }
      );
      return new Map(entries);
    }
  };

  public readonly activeConstraintsPort: RecallServiceActiveConstraintsPort = {
    findActiveConstraints: async ({ workspaceId, cap, asOf }) =>
      await this.request("constraints.findActive", { workspaceId, cap, asOf })
  };

  public constructor(input: {
    readonly databaseFilename: string;
    readonly pathReadBind?: RecallPathReadBind;
    readonly workerUrl: URL;
    readonly workerCount?: number;
    readonly requestTimeoutMs?: number;
    readonly prepareTemporalProjection?: RecallTemporalProjectionEnsurer;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  }) {
    this.databaseFilename = input.databaseFilename;
    this.requestTimeoutMs = normalizeRequestTimeoutMs(input.requestTimeoutMs);
    this.pathReadBind = input.pathReadBind;
    if (this.pathReadBind === "temporal" && input.prepareTemporalProjection === undefined) {
      throw new Error("selected temporal recall worker requires parent projection preparation");
    }
    this.prepareTemporalProjection = input.prepareTemporalProjection;
    this.warn = input.warn;
    this.workerUrl = input.workerUrl;
    const workerCount = normalizeWorkerCount(input.workerCount);
    this.workers = Array.from({ length: workerCount }, () => null);
    this.workers[0] = this.spawnWorker(0);
    this.snapshotSession = createRecallReadSnapshotSession({
      workerCount,
      getWorker: (index) => this.workerAt(index),
      dispatch: async (worker, operation) =>
        await this.dispatchToWorker(worker, operation, {})
    });
    this.readSnapshot = this.snapshotSession.port;
  }

  public async ready(): Promise<void> {
    if (this.readyPromise === null) {
      const worker = this.workers[0] ?? this.requireWorker("ready");
      this.readyPromise = this.dispatchToWorker(worker, "ready", {}).then(() => undefined);
    }
    await this.readyPromise;
  }

  private spawnWorker(index: number): Worker {
    const worker = new Worker(this.workerUrl, {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: {
        databaseFilename: this.databaseFilename,
        ...(this.pathReadBind === undefined
          ? {}
          : { pathReadBind: this.pathReadBind })
      }
    });
    worker.on("message", (message: unknown) => {
      if (this.workers[index] === worker) {
        this.handleMessage(worker, message);
      }
    });
    worker.on("error", (error) => {
      this.warn?.("recall read worker failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.recoverWorker(index, worker, error);
    });
    worker.on("exit", (code) => {
      if (this.workers[index] !== worker || this.closeStarted) {
        return;
      }
      const error = new Error(`recall read worker exited with code ${code}`);
      this.warn?.("recall read worker exited unexpectedly", { code });
      this.recoverWorker(index, worker, error);
    });
    return worker;
  }

  public async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closeStarted = true;
    try {
      if (!this.closed) {
        await Promise.all(this.workers.map(async (worker) => {
          if (worker === null) return;
          try {
            await this.dispatchToWorker(worker, "close", {});
          } catch {
            // close is best-effort; terminate below is the bounded cleanup path.
          }
        }));
      }
    } finally {
      this.closed = true;
      this.rejectPending(new Error("recall read worker closed"));
      const workers = this.workers.splice(0, this.workers.length);
      await Promise.all(workers.map(async (worker) => await worker?.terminate()));
    }
  }

  private async request<T = unknown>(
    operation: RecallReadWorkerOperation,
    payload: unknown
  ): Promise<T> {
    if (this.closed) {
      throw new Error("recall read worker is closed");
    }
    return await this.dispatch<T>(operation, payload);
  }

  private pathReadOptions(
    options: RecallPathProjectionReadOptions | undefined
  ): Readonly<{ readonly asOf?: string }> {
    if (this.pathReadBind !== "temporal" || options?.asOf === undefined) {
      return Object.freeze({});
    }
    return Object.freeze({ asOf: options.asOf });
  }

  private async dispatch<T>(
    operation: RecallReadWorkerOperation,
    payload: unknown,
    consumeSuccess?: (value: unknown) => SuccessConsumption
  ): Promise<T> {
    if (this.closed && operation !== "close") {
      throw new Error("recall read worker is closed");
    }
    if (this.pathReadBind === "temporal" && isPathAffinityOperation(operation)) {
      const asOf = (payload as { readonly asOf?: string }).asOf;
      await this.prepareTemporalProjection?.(asOf === undefined ? {} : { asOf });
    }
    const worker = this.requireWorker(operation);
    return await this.dispatchToWorker<T>(worker, operation, payload, consumeSuccess);
  }

  private async dispatchToWorker<T>(
    worker: Worker,
    operation: RecallReadWorkerOperation,
    payload: unknown,
    consumeSuccess?: (value: unknown) => SuccessConsumption
  ): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(id);
        const error = new Error(
          `recall read worker ${operation} timed out after ${this.requestTimeoutMs}ms`
        );
        pending.reject(error);
        this.recoverWorker(this.workers.indexOf(worker), worker, error);
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
        worker,
        ...(consumeSuccess === undefined ? {} : { consumeSuccess })
      });
      try {
        worker.postMessage({ id, operation, payload } satisfies RecallReadWorkerRequest);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending === undefined) {
          reject(error);
        } else {
          pending.reject(error);
        }
        this.recoverWorker(this.workers.indexOf(worker), worker, error);
      }
    });
  }

  private requireWorker(operation: RecallReadWorkerOperation): Worker {
    if (this.closed || this.closeStarted) {
      throw new Error("recall read worker is closed");
    }
    const pinned = this.snapshotSession.pinnedWorker();
    if (pinned !== undefined) return pinned;
    const index = isPathAffinityOperation(operation)
      ? 0
      : this.nextWorkerIndex++ % this.workers.length;
    return this.workerAt(index);
  }

  private workerAt(index: number): Worker {
    const existing = this.workers[index] ?? null;
    if (existing !== null) return existing;
    const worker = this.spawnWorker(index);
    this.workers[index] = worker;
    return worker;
  }

  private recoverWorker(index: number, worker: Worker, error: unknown): void {
    if (index < 0 || this.workers[index] !== worker || this.closed) return;
    this.workers[index] = null;
    this.rejectPendingForWorker(worker, error);
    void worker.terminate().catch(() => undefined);
  }

  private handleMessage(worker: Worker, message: unknown): void {
    if (!isRecallReadWorkerResponse(message)) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined || pending.worker !== worker) {
      return;
    }
    if (message.ok) {
      let consumed: SuccessConsumption | undefined;
      try {
        consumed = pending.consumeSuccess?.(message.result);
      } catch (error) {
        this.pending.delete(message.id);
        pending.reject(error);
        this.recoverWorker(this.workers.indexOf(worker), worker, error);
        return;
      }
      if (consumed !== undefined && !consumed.done) return;
      this.pending.delete(message.id);
      pending.resolve(consumed?.value ?? message.result);
      return;
    }
    this.pending.delete(message.id);
    const error = new Error(message.error.message);
    error.name = message.error.name;
    if (message.error.stack !== undefined) {
      error.stack = message.error.stack;
    }
    pending.reject(error);
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPendingForWorker(worker: Worker, error: unknown): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.worker !== worker) continue;
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isSourceRuntimeUrl(url: string): boolean {
  return url.includes("/src/runtime/");
}
