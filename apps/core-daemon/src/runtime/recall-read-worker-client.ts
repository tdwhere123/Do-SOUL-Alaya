import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type {
  MemoryDimension,
  PathAnchorRef,
  ScopeClass,
  StorageTier
} from "@do-soul/alaya-protocol";
import type {
  KeywordSearchBatchQuery,
  RecallMemoryListPageOptions,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServicePathPlasticityPort,
  RecallServiceSynthesisSearchPort
} from "@do-soul/alaya-core";
import type { RecallPathProjectionReadOptions } from "./recall-path-readers.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_ENV = "ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS";

export type RecallReadWorkerOperation =
  | "memory.findByWorkspaceId"
  | "memory.findByDimension"
  | "memory.findByScopeClass"
  | "memory.searchByKeyword"
  | "memory.searchByKeywordWithinObjectIds"
  | "memory.searchManyByKeywordWithinObjectIds"
  | "memory.searchByAnchorWithinObjectIds"
  | "memory.findByEvidenceRefs"
  | "memory.findByIds"
  | "evidence.searchByKeyword"
  | "evidence.searchManyByKeyword"
  | "evidence.findByIds"
  | "evidence.findSourceAnchorsByIds"
  | "synthesis.searchByKeyword"
  | "synthesis.findByIds"
  | "path.findByAnchors"
  | "path.findByTimeConcernWindowDigests"
  | "pathPlasticity.getStrengthByMemoryId"
  | "close";

export interface RecallReadWorkerRequest {
  readonly id: number;
  readonly operation: RecallReadWorkerOperation;
  readonly payload: unknown;
}

export type RecallReadWorkerResponse =
  | Readonly<{ readonly id: number; readonly ok: true; readonly result: unknown }>
  | Readonly<{
      readonly id: number;
      readonly ok: false;
      readonly error: Readonly<{
        readonly name: string;
        readonly message: string;
        readonly stack?: string;
      }>;
    }>;

export interface RecallReadWorkerClient {
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly evidenceSearchPort: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort: RecallServiceSynthesisSearchPort;
  readonly pathExpansionPort: RecallServicePathExpansionPort;
  readonly pathPlasticityPort: RecallServicePathPlasticityPort;
  close(): Promise<void>;
}

export function createRecallReadWorkerClient(input: {
  readonly databaseFilename: string;
  readonly temporalProjectionSelected?: boolean;
  readonly workerUrl?: URL;
  readonly requestTimeoutMs?: number;
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
  private worker: Worker | null = null;
  private readonly databaseFilename: string;
  private readonly requestTimeoutMs: number;
  private readonly temporalProjectionSelected: boolean;
  private readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  private readonly workerUrl: URL;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private requestTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closeStarted = false;

  public readonly memoryRepo: RecallServiceMemoryRepoPort = {
    findByWorkspaceId: async (
      workspaceId: string,
      tier?: StorageTier,
      page?: RecallMemoryListPageOptions
    ) =>
      await this.request("memory.findByWorkspaceId", {
        workspaceId,
        tier,
        page
      }),
    findByDimension: async (workspaceId: string, dimension: MemoryDimension) =>
      await this.request("memory.findByDimension", { workspaceId, dimension }),
    findByScopeClass: async (workspaceId: string, scopeClass: ScopeClass) =>
      await this.request("memory.findByScopeClass", { workspaceId, scopeClass }),
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("memory.searchByKeyword", { workspaceId, queryText, limit }),
    searchByKeywordWithinObjectIds: async (
      workspaceId: string,
      queryText: string,
      limit: number,
      objectIds: readonly string[]
    ) =>
      await this.request("memory.searchByKeywordWithinObjectIds", {
        workspaceId,
        queryText,
        limit,
        objectIds
      }),
    searchManyByKeywordWithinObjectIds: async (
      workspaceId: string,
      queries: readonly Readonly<KeywordSearchBatchQuery>[],
      objectIds: readonly string[]
    ) =>
      await this.request("memory.searchManyByKeywordWithinObjectIds", {
        workspaceId,
        queries,
        objectIds
      }),
    searchByAnchorWithinObjectIds: async (
      workspaceId: string,
      anchorTokens: readonly string[],
      optionalTokens: readonly string[],
      limit: number,
      objectIds: readonly string[]
    ) =>
      await this.request("memory.searchByAnchorWithinObjectIds", {
        workspaceId,
        anchorTokens,
        optionalTokens,
        limit,
        objectIds
      }),
    findByEvidenceRefs: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await this.request("memory.findByEvidenceRefs", { workspaceId, evidenceObjectIds }),
    findByIds: async (workspaceId: string, objectIds: readonly string[]) =>
      await this.request("memory.findByIds", { workspaceId, objectIds })
  };

  public readonly evidenceSearchPort: RecallServiceEvidenceSearchPort = {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("evidence.searchByKeyword", { workspaceId, queryText, limit }),
    searchManyByKeyword: async (
      workspaceId: string,
      queries: readonly Readonly<KeywordSearchBatchQuery>[]
    ) => await this.request("evidence.searchManyByKeyword", { workspaceId, queries }),
    findByIds: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await this.request("evidence.findByIds", { workspaceId, evidenceObjectIds }),
    findSourceAnchorsByIds: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await this.request("evidence.findSourceAnchorsByIds", { workspaceId, evidenceObjectIds })
  };

  public readonly synthesisSearchPort: RecallServiceSynthesisSearchPort = {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("synthesis.searchByKeyword", { workspaceId, queryText, limit }),
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

  public constructor(input: {
    readonly databaseFilename: string;
    readonly temporalProjectionSelected?: boolean;
    readonly workerUrl: URL;
    readonly requestTimeoutMs?: number;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  }) {
    this.databaseFilename = input.databaseFilename;
    this.requestTimeoutMs = normalizeRequestTimeoutMs(input.requestTimeoutMs);
    this.temporalProjectionSelected = input.temporalProjectionSelected === true;
    this.warn = input.warn;
    this.workerUrl = input.workerUrl;
    this.worker = this.spawnWorker();
  }

  private spawnWorker(): Worker {
    const worker = new Worker(this.workerUrl, {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: {
        databaseFilename: this.databaseFilename,
        temporalProjectionSelected: this.temporalProjectionSelected
      }
    });
    worker.on("message", (message: unknown) => {
      if (this.worker === worker) {
        this.handleMessage(message);
      }
    });
    worker.on("error", (error) => {
      this.warn?.("recall read worker failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.recoverWorker(worker, error);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker || this.closeStarted) {
        return;
      }
      const error = new Error(`recall read worker exited with code ${code}`);
      this.warn?.("recall read worker exited unexpectedly", { code });
      this.recoverWorker(worker, error);
    });
    return worker;
  }

  public async close(): Promise<void> {
    if (this.closeStarted) {
      return;
    }
    this.closeStarted = true;
    try {
      if (!this.closed && this.worker !== null) {
        try {
          await this.request("close", {});
        } catch {
          // close is best-effort; terminate below is the bounded cleanup path.
        }
      }
    } finally {
      this.closed = true;
      this.rejectPending(new Error("recall read worker closed"));
      const worker = this.worker;
      this.worker = null;
      if (worker !== null) await worker.terminate();
    }
  }

  private async request<T = unknown>(
    operation: RecallReadWorkerOperation,
    payload: unknown
  ): Promise<T> {
    if (this.closed) {
      throw new Error("recall read worker is closed");
    }
    const run = this.requestTail
      .catch(() => undefined)
      .then(async () => await this.dispatch<T>(operation, payload));
    this.requestTail = run.catch(() => undefined);
    return await run;
  }

  private pathReadOptions(
    options: RecallPathProjectionReadOptions | undefined
  ): Readonly<{ readonly asOf?: string }> {
    if (!this.temporalProjectionSelected || options?.asOf === undefined) {
      return Object.freeze({});
    }
    return Object.freeze({ asOf: options.asOf });
  }

  private async dispatch<T>(
    operation: RecallReadWorkerOperation,
    payload: unknown
  ): Promise<T> {
    if (this.closed && operation !== "close") {
      throw new Error("recall read worker is closed");
    }
    const worker = this.requireWorker();
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
        this.recoverWorker(worker, error);
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
        timeout
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
        this.recoverWorker(worker, error);
      }
    });
  }

  private requireWorker(): Worker {
    if (this.worker !== null) return this.worker;
    if (this.closed || this.closeStarted) {
      throw new Error("recall read worker is closed");
    }
    const worker = this.spawnWorker();
    this.worker = worker;
    return worker;
  }

  private recoverWorker(worker: Worker, error: unknown): void {
    if (this.worker !== worker || this.closed) return;
    this.worker = null;
    this.rejectPending(error);
    void worker.terminate().catch(() => undefined);
  }

  private handleMessage(message: unknown): void {
    if (!isRecallReadWorkerResponse(message)) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
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
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  const fromEnv = value ?? Number(process.env[REQUEST_TIMEOUT_ENV]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.trunc(fromEnv);
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function resolveDefaultWorkerUrl(): URL | null {
  const sibling = new URL("./recall-read-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }

  const builtFromSource = new URL("../../dist/runtime/recall-read-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(builtFromSource))) {
    return builtFromSource;
  }

  return null;
}

function isSourceRuntimeUrl(url: string): boolean {
  return url.includes("/src/runtime/");
}

function isRecallReadWorkerResponse(value: unknown): value is RecallReadWorkerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { readonly id?: unknown; readonly ok?: unknown };
  return typeof record.id === "number" && typeof record.ok === "boolean";
}
