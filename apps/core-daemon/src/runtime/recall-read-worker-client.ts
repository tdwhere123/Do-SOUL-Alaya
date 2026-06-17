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
  RecallMemoryListPageOptions,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServicePathPlasticityPort,
  RecallServiceSynthesisSearchPort
} from "@do-soul/alaya-core";

export type RecallReadWorkerOperation =
  | "memory.findByWorkspaceId"
  | "memory.findByDimension"
  | "memory.findByScopeClass"
  | "memory.searchByKeyword"
  | "memory.searchByKeywordWithinObjectIds"
  | "memory.findByEvidenceRefs"
  | "memory.findByIds"
  | "evidence.searchByKeyword"
  | "evidence.findByIds"
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
  readonly workerUrl?: URL;
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
  private readonly worker: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
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
    findByEvidenceRefs: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await this.request("memory.findByEvidenceRefs", { workspaceId, evidenceObjectIds }),
    findByIds: async (objectIds: readonly string[]) =>
      await this.request("memory.findByIds", { objectIds })
  };

  public readonly evidenceSearchPort: RecallServiceEvidenceSearchPort = {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("evidence.searchByKeyword", { workspaceId, queryText, limit }),
    findByIds: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await this.request("evidence.findByIds", { workspaceId, evidenceObjectIds })
  };

  public readonly synthesisSearchPort: RecallServiceSynthesisSearchPort = {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await this.request("synthesis.searchByKeyword", { workspaceId, queryText, limit }),
    findByIds: async (objectIds: readonly string[]) =>
      await this.request("synthesis.findByIds", { objectIds })
  };

  public readonly pathExpansionPort: RecallServicePathExpansionPort = {
    findByAnchors: async (workspaceId: string, anchorRefs: readonly PathAnchorRef[]) =>
      await this.request("path.findByAnchors", { workspaceId, anchorRefs }),
    findByTimeConcernWindowDigests: async (
      workspaceId: string,
      windowDigests: readonly string[]
    ) =>
      await this.request("path.findByTimeConcernWindowDigests", {
        workspaceId,
        windowDigests
      })
  };

  public readonly pathPlasticityPort: RecallServicePathPlasticityPort = {
    getStrengthByMemoryId: async (workspaceId: string, memoryIds: readonly string[]) => {
      const entries = await this.request<readonly (readonly [string, number])[]>(
        "pathPlasticity.getStrengthByMemoryId",
        { workspaceId, memoryIds }
      );
      return new Map(entries);
    }
  };

  public constructor(input: {
    readonly databaseFilename: string;
    readonly workerUrl: URL;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  }) {
    this.worker = new Worker(input.workerUrl, {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: {
        databaseFilename: input.databaseFilename
      }
    });
    this.worker.on("message", (message: unknown) => this.handleMessage(message));
    this.worker.on("error", (error) => {
      input.warn?.("recall read worker failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.closed = true;
      this.rejectPending(error);
    });
    this.worker.on("exit", (code) => {
      if (this.closed || code === 0) {
        return;
      }
      const error = new Error(`recall read worker exited with code ${code}`);
      input.warn?.("recall read worker exited unexpectedly", { code });
      this.closed = true;
      this.rejectPending(error);
    });
  }

  public async close(): Promise<void> {
    if (this.closeStarted) {
      return;
    }
    this.closeStarted = true;
    try {
      if (!this.closed) {
        await this.request("close", {});
      }
    } finally {
      this.closed = true;
      this.rejectPending(new Error("recall read worker closed"));
      await this.worker.terminate();
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

  private async dispatch<T>(
    operation: RecallReadWorkerOperation,
    payload: unknown
  ): Promise<T> {
    if (this.closed && operation !== "close") {
      throw new Error("recall read worker is closed");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      try {
        this.worker.postMessage({ id, operation, payload } satisfies RecallReadWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
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
      pending.reject(error);
    }
    this.pending.clear();
  }
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
