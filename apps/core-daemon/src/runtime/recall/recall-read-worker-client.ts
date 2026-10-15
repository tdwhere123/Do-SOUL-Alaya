import type { Worker } from "node:worker_threads";
import { indexEntryCacheKey, type SourceInterpretationReasoningResult, type SourceSemanticWorkerResult, type PathAnchorRef } from "@do-soul/alaya-protocol";
import type {
  ConditionalFieldRecallPort,
  ConditionalFieldRecallPortResult,
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
import type { RecallReadWorkerOperation } from "../recall-read-worker/protocol.js";
import { type WorkerOperationPayload, parseWorkerOperationPayload } from "../recall-read-worker/operation-schemas.js";
import {
  isPathAffinityOperation,
  normalizeRequestTimeoutMs,
  normalizeWorkerCount,
  resolveDefaultWorkerUrl
} from "../recall-read-worker/client-config.js";
import { encodeAuthorizedScopesAdmission } from "@do-soul/alaya-core";
import { readRecallTierWindowOverIpc } from "../recall-read-worker/tier-window-client.js";
import {
  createWorkerMemoryRepo,
  type WorkerTierWindowResult
} from "../recall-read-worker/memory-client.js";
import { RecallReadWorkerLifecycle, type SuccessConsumption } from "./recall-read-worker-lifecycle.js";

export interface RecallReadWorkerClient {
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly evidenceSearchPort: RecallServiceEvidenceSearchPort;
  readonly synthesisSearchPort: RecallServiceSynthesisSearchPort;
  readonly pathExpansionPort: RecallServicePathExpansionPort;
  readonly pathPlasticityPort: RecallServicePathPlasticityPort;
  readonly activeConstraintsPort: RecallServiceActiveConstraintsPort;
  readonly readSnapshot: RecallReadSnapshotPort;
  readonly conditionalFieldPort: ConditionalFieldRecallPort;
  readonly sourceInterpretationPort?: Readonly<{ reason: (input: WorkerOperationPayload<"conditionalField.interpretation">) => Promise<SourceInterpretationReasoningResult> }>;
  readonly sourceSemanticsPort?: Readonly<{ execute: (input: WorkerOperationPayload<"conditionalField.sourceSemantics">) => Promise<SourceSemanticWorkerResult> }>;
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
  readonly allowDirectSqliteRecallReads?: boolean;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}): RecallReadWorkerClient | null {
  const allowDirect = input.allowDirectSqliteRecallReads === true;
  if (input.databaseFilename === ":memory:") {
    if (!allowDirect) {
      throw new Error("recall read worker cannot use :memory:; set allowDirectSqliteRecallReads");
    }
    input.warn?.(
      "recall read worker degraded to direct sqlite because allowDirectSqliteRecallReads is set",
      { reason: "direct_sqlite_recall_reads", database: ":memory:" }
    );
    return null;
  }

  const workerUrl = input.workerUrl ?? resolveDefaultWorkerUrl();
  if (workerUrl === null) {
    if (!allowDirect) {
      throw new Error("recall read worker script is missing");
    }
    input.warn?.(
      "recall read worker degraded to direct sqlite because allowDirectSqliteRecallReads is set",
      { reason: "direct_sqlite_recall_reads", cause: "worker_script_missing" }
    );
    return null;
  }

  return new WorkerBackedRecallReadClient({ ...input, workerUrl });
}

class WorkerBackedRecallReadClient implements RecallReadWorkerClient {
  private readonly lifecycle: RecallReadWorkerLifecycle;
  private readonly pathReadBind: RecallPathReadBind | undefined;
  private readonly prepareTemporalProjection?: RecallTemporalProjectionEnsurer;
  private readonly deliveryOwners = new Map<string, Worker>();
  private readyPromise: Promise<void> | null = null;
  public readonly readSnapshot: RecallReadSnapshotPort;

  public readonly memoryRepo: RecallServiceMemoryRepoPort = createWorkerMemoryRepo({
    request: async (operation, payload) => await this.request(operation, payload),
    readTierWindow: async (query) =>
      await readRecallTierWindowOverIpc(query, async (pageQuery, consumePage) =>
        await this.dispatch<WorkerTierWindowResult>(
          "memory.findRecallTierWindow",
          pageQuery,
          consumePage
        )
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
    readBounded: async (params) => await this.request("constraints.readBounded", params),
    findActiveConstraints: async ({ workspaceId, cap, asOf }) =>
      await this.request("constraints.findActive", { workspaceId, cap, asOf })
  };

  public readonly conditionalFieldPort: ConditionalFieldRecallPort = {
    acknowledge: async (preparationId, index, previews) => {
      return await this.lifecycle.request("conditionalField.acknowledge", {
        preparation_id: preparationId,
        issued_entry_ids: index.entries.map(indexEntryCacheKey),
        previews: Object.fromEntries(previews)
      }, undefined, this.deliveryOwner(preparationId));
    },
    discard: async (preparationId) => {
      const owner = this.deliveryOwners.get(preparationId);
      if (owner !== undefined && this.lifecycle.isAvailable(owner)) {
        await this.lifecycle.request("conditionalField.discard", { preparation_id: preparationId }, undefined, owner);
      }
      this.deliveryOwners.delete(preparationId);
    },
    recall: async (input) => {
      const preferred = input.continuation == null ? undefined : this.deliveryOwners.get(input.continuation.continuation_id);
      return await this.lifecycle.withinDeadline("conditionalField.recall", async () =>
        await this.lifecycle.isolate(async () => {
          const worker = this.lifecycle.pinnedWorker()!;
          const parsed = await this.lifecycle.request<ConditionalFieldRecallPortResult>("conditionalField.recall", {
            ...input,
            authorized_scopes: encodeAuthorizedScopesAdmission(input.authorized_scopes)
          });
          for (const key of [parsed.preparation_id, parsed.index.continuation?.continuation_id]) {
            if (key !== undefined) this.deliveryOwners.set(key, worker);
          }
          while (this.deliveryOwners.size > 256) this.deliveryOwners.delete(this.deliveryOwners.keys().next().value!);
          return parsed;
        }, preferred, 0));
    }
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
    this.pathReadBind = input.pathReadBind;
    if (this.pathReadBind === "temporal" && input.prepareTemporalProjection === undefined) {
      throw new Error("selected temporal recall worker requires parent projection preparation");
    }
    this.prepareTemporalProjection = input.prepareTemporalProjection;
    this.lifecycle = new RecallReadWorkerLifecycle({
      ...input,
      workerCount: normalizeWorkerCount(input.workerCount),
      requestTimeoutMs: normalizeRequestTimeoutMs(input.requestTimeoutMs),
      onUnavailable: (worker) => {
        for (const [handle, owner] of this.deliveryOwners) {
          if (owner === worker) this.deliveryOwners.delete(handle);
        }
        this.readyPromise = null;
      }
    });
    this.readSnapshot = {
      ...this.lifecycle.readSnapshot,
      isolate: async (work, affinity) => await this.lifecycle.isolate(work,
        affinity === undefined ? undefined : this.deliveryOwner(affinity))
    };
  }

  public readonly sourceInterpretationPort = {
    reason: async (input: WorkerOperationPayload<"conditionalField.interpretation">): Promise<SourceInterpretationReasoningResult> => {
      const run = async () => await this.request<SourceInterpretationReasoningResult>("conditionalField.interpretation", input);
      return await this.lifecycle.withinDeadline("conditionalField.interpretation", async () =>
        await this.lifecycle.isolate(run));
    }
  };

  public readonly sourceSemanticsPort = {
    execute: async (input: WorkerOperationPayload<"conditionalField.sourceSemantics">): Promise<SourceSemanticWorkerResult> =>
      await this.lifecycle.withinDeadline("conditionalField.sourceSemantics", async () => {
        // Capture all schema-owned data before acquisition can wait. Parsing readonly
        // schemas must never freeze caller data; the actual snapshot lease stays in ALS.
        const captured = parseWorkerOperationPayload("conditionalField.sourceSemantics", structuredClone(input));
        const request = captured.request;
        const handle = request.kind === "reason" ? request.query_handle
          : request.kind === "recall" ? request.continuation?.continuation_id ?? request.query_handle
          : request.kind === "prepare_query" ? request.continuation_handle ?? request.source_handle
          : request.kind === "validate_source" ? request.source_handle : undefined;
        const owner = handle === undefined ? undefined : this.deliveryOwner(handle);
        return await this.lifecycle.isolate(async () => {
          const worker = this.lifecycle.pinnedWorker()!;
          const parsed = await this.lifecycle.request<SourceSemanticWorkerResult>(
            "conditionalField.sourceSemantics", captured);
          const issued = parsed.kind === "prepare_source" ? parsed.source_handle
            : parsed.kind === "prepare_query" ? parsed.query_handle : undefined;
          if (issued !== undefined) this.deliveryOwners.set(issued, worker);
          if (parsed.kind === "prepare_query" && parsed.continuation_handle !== undefined) this.deliveryOwners.set(parsed.continuation_handle, worker);
          if (parsed.kind === "recall") {
            this.deliveryOwners.set(parsed.delivery_id, worker);
            if (parsed.index.continuation !== null) this.deliveryOwners.set(parsed.index.continuation.continuation_id, worker);
          }
          while (this.deliveryOwners.size > 256) this.deliveryOwners.delete(this.deliveryOwners.keys().next().value!);
          return parsed;
        }, owner);
      })
  };

  public async ready(): Promise<void> {
    if (this.readyPromise === null) {
      const pending = this.lifecycle.request("ready", {}).then(() => undefined);
      this.readyPromise = pending;
      pending.catch(() => {
        if (this.readyPromise === pending) this.readyPromise = null;
      });
    }
    await this.readyPromise;
  }

  public async close(): Promise<void> {
    await this.lifecycle.close();
  }

  private async request<T = unknown>(
    operation: RecallReadWorkerOperation,
    payload: unknown
  ): Promise<T> {
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
    return await this.lifecycle.withinDeadline(operation, async () => {
      if (this.pathReadBind === "temporal" && isPathAffinityOperation(operation)) {
        const asOf = (payload as { readonly asOf?: string }).asOf;
        await this.prepareTemporalProjection?.(asOf === undefined ? {} : { asOf });
      }
      return await this.lifecycle.request<T>(operation, payload, consumeSuccess);
    });
  }

  private deliveryOwner(preparationId: string): Worker {
    const owner = this.deliveryOwners.get(preparationId);
    if (owner === undefined || !this.lifecycle.isAvailable(owner)) throw new Error("Recall delivery worker unavailable");
    return owner;
  }
}


