import { type GardenTaskDescriptor, type MemoryEntry } from "@do-soul/alaya-protocol";
import { toErrorMessage } from "../recall/recall-service-helpers.js";
import { resolveEmbedText } from "./embed-text-resolver.js";
import { resolveEmbeddingRecallTiers } from "./tier-config.js";
import {
  BACKFILL_BATCH_CONCURRENCY_ENV,
  BACKFILL_ITEM_RETRY_ATTEMPTS,
  BACKFILL_ITEM_RETRY_DELAY_MS,
  BACKFILL_TIMEOUT_MS,
  EmbeddingBackfillPartialFailureError,
  buildEmbeddingBackfillBatches,
  collectBackfillMemories,
  hashMemoryContent,
  resolveBackfillBatchConcurrency,
  sleepBackfillRetry,
  type ConcurrentBatchResult,
  type EmbeddedBackfillCandidate,
  type EmbeddingBackfillCandidate,
  type EmbeddingBackfillHandleResult,
  type EmbeddingBackfillHandlerDependencies,
  type EmbeddingBackfillMetadata
} from "./embedding-backfill-handler-shared.js";
export {
  BACKFILL_BATCH_CONCURRENCY_DEFAULT,
  BACKFILL_BATCH_CONCURRENCY_ENV,
  BACKFILL_BATCH_CONCURRENCY_MAX,
  EmbeddingBackfillPartialFailureError,
  isEmbeddingBackfillPartialFailureError,
  resolveBackfillBatchConcurrency
} from "./embedding-backfill-handler-shared.js";
export type {
  ConcurrentBatchResult,
  EmbeddedBackfillCandidate,
  EmbeddingBackfillCandidate,
  EmbeddingBackfillHandleResult,
  EmbeddingBackfillHandlerDependencies,
  EmbeddingBackfillMemoryRepoPort,
  EmbeddingBackfillMetadata,
  EmbeddingBackfillPartialFailureInput,
  EmbeddingBackfillRepoPort
} from "./embedding-backfill-handler-shared.js";

interface BackfillCandidateSelection {
  readonly memoriesToEmbed: readonly EmbeddingBackfillCandidate[];
  readonly auditEntries: readonly string[];
}

const EMPTY_HQS: readonly string[] = Object.freeze([]);
const EMPTY_HQ_MAP: ReadonlyMap<string, readonly string[]> = new Map();

function emptyBackfillResult(auditEntries: readonly string[]): EmbeddingBackfillHandleResult {
  return Object.freeze({
    objectsAffected: Object.freeze([]),
    auditEntries: Object.freeze([...auditEntries])
  });
}

export class EmbeddingBackfillHandler {
  private readonly now: () => string;
  private readonly retryDelayMs: number;
  private readonly warn: (message: string, meta: Record<string, unknown>) => void;
  private readonly batchConcurrency: number;

  public constructor(private readonly dependencies: EmbeddingBackfillHandlerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.retryDelayMs =
      dependencies.retryDelayMs === undefined ? BACKFILL_ITEM_RETRY_DELAY_MS : Math.max(0, dependencies.retryDelayMs);
    this.warn = dependencies.warn ?? (() => undefined);
    this.batchConcurrency = resolveBackfillBatchConcurrency(
      dependencies.batchConcurrency ?? process.env[BACKFILL_BATCH_CONCURRENCY_ENV]
    );
  }

  public async handle(task: Pick<GardenTaskDescriptor, "workspace_id">): Promise<EmbeddingBackfillHandleResult> {
    if (!this.dependencies.provider.isAvailable) {
      return emptyBackfillResult(["embedding_backfill_skipped:provider_unavailable"]);
    }

    const initialMemories = await this.collectInitialBackfillMemories(task.workspace_id);
    if (initialMemories.length === 0) {
      return emptyBackfillResult(["embedding_backfill_skipped:no_memories"]);
    }

    const selection = await this.selectBackfillCandidates(initialMemories);
    if (selection.memoriesToEmbed.length === 0) {
      return emptyBackfillResult(selection.auditEntries);
    }

    const objectsAffected: string[] = [];
    const auditEntries = [...selection.auditEntries];
    await this.drainBackfillBatches(
      task.workspace_id,
      initialMemories,
      selection.memoriesToEmbed,
      objectsAffected,
      auditEntries
    );

    return Object.freeze({
      objectsAffected: Object.freeze(objectsAffected),
      auditEntries: Object.freeze(auditEntries)
    });
  }

  private async collectInitialBackfillMemories(workspaceId: string): Promise<readonly MemoryEntry[]> {
    const tierMemoryLists = await Promise.all(
      resolveEmbeddingRecallTiers().map((tier) =>
        collectBackfillMemories(this.dependencies.memoryRepo, workspaceId, tier)
      )
    );
    return tierMemoryLists.flat();
  }

  private async selectBackfillCandidates(
    initialMemories: readonly MemoryEntry[]
  ): Promise<BackfillCandidateSelection> {
    const existingById = await this.findExistingBackfillMetadata(initialMemories);
    const auditEntries: string[] = [];
    const memoriesToEmbed = initialMemories.flatMap((memory) =>
      this.selectMemoryForEmbedding(memory, existingById, auditEntries)
    );

    return { memoriesToEmbed, auditEntries };
  }

  private async findExistingBackfillMetadata(
    memories: readonly MemoryEntry[]
  ): Promise<ReadonlyMap<string, Readonly<EmbeddingBackfillMetadata>>> {
    const existingMetadata = await this.dependencies.memoryEmbeddingRepo.findMetadataByObjectIds(
      memories.map((memory) => memory.object_id)
    );
    return new Map(existingMetadata.map((record) => [record.object_id, record] as const));
  }

  private selectMemoryForEmbedding(
    memory: Readonly<MemoryEntry>,
    existingById: ReadonlyMap<string, Readonly<EmbeddingBackfillMetadata>>,
    auditEntries: string[]
  ): readonly EmbeddingBackfillCandidate[] {
    const contentHash = hashMemoryContent(memory.content);
    const existing = existingById.get(memory.object_id) ?? null;

    if (this.isEmbeddingMetadataFresh(existing, contentHash)) {
      auditEntries.push(`embedding_skipped:unchanged:${memory.object_id}`);
      return Object.freeze([]);
    }

    return Object.freeze([Object.freeze({ memory, contentHash, existing })]);
  }

  private isEmbeddingMetadataFresh(
    existing: Readonly<EmbeddingBackfillMetadata> | null,
    contentHash: string
  ): boolean {
    return (
      existing !== null &&
      existing.content_hash === contentHash &&
      existing.provider_kind === this.dependencies.provider.providerKind &&
      existing.model_id === this.dependencies.provider.modelId &&
      existing.schema_version === this.dependencies.provider.schemaVersion
    );
  }

  private async drainBackfillBatches(
    workspaceId: string,
    initialMemories: readonly MemoryEntry[],
    memoriesToEmbed: readonly EmbeddingBackfillCandidate[],
    objectsAffected: string[],
    auditEntries: string[]
  ): Promise<void> {
    const snapshotMemories = new Map(initialMemories.map((memory) => [memory.object_id, memory] as const));
    const batches = buildEmbeddingBackfillBatches(memoriesToEmbed);
    const concurrencyWindow = Math.max(1, Math.min(this.batchConcurrency, batches.length));
    const inFlight: (Promise<ConcurrentBatchResult> | null)[] = [];
    const startBatch = (batch: readonly EmbeddingBackfillCandidate[]): Promise<ConcurrentBatchResult> => {
      const auditFragments: string[] = [];
      return this.embedBatchWithFallback(workspaceId, batch, auditFragments).then((embedded) => ({
        embedded,
        auditFragments
      }));
    };

    let nextToStart = 0;
    for (; nextToStart < concurrencyWindow; nextToStart += 1) {
      inFlight.push(startBatch(batches[nextToStart]!));
    }

    for (let head = 0; head < batches.length; head += 1) {
      const ready = await inFlight[head]!;
      // Release the resolved promise (and the vectors it holds) before sliding
      // the window forward, so peak retained vector memory stays ~`concurrencyWindow`.
      inFlight[head] = null;
      if (nextToStart < batches.length) {
        inFlight.push(startBatch(batches[nextToStart]!));
        nextToStart += 1;
      }
      try {
        await this.persistEmbeddedBatch(workspaceId, ready, snapshotMemories, objectsAffected, auditEntries);
      } catch (error) {
        await Promise.allSettled(inFlight.filter((entry) => entry !== null));
        throw error;
      }
    }
  }

  // Deterministic, event-loop-serialized persistence for one already-embedded
  // batch. Called strictly in batch order from handle(); appends the batch's
  // private audit fragments first, then runs the CAS upserts. better-sqlite3 is
  // synchronous so each guardedUpsert transaction completes before the next.
  private async persistEmbeddedBatch(
    workspaceId: string,
    result: ConcurrentBatchResult,
    snapshotMemories: ReadonlyMap<string, Readonly<MemoryEntry>>,
    objectsAffected: string[],
    auditEntries: string[]
  ): Promise<void> {
    auditEntries.push(...result.auditFragments);
    for (const { entry, embedding } of result.embedded) {
      const latestMemory = snapshotMemories.get(entry.memory.object_id);
      const latestHash = latestMemory === undefined ? null : hashMemoryContent(latestMemory.content);

      if (latestMemory === undefined || latestHash !== entry.contentHash) {
        auditEntries.push(`embedding_skipped:stale_content:${entry.memory.object_id}`);
        continue;
      }

      const vector = new Float32Array(embedding);
      try {
        const persisted =
          this.dependencies.memoryEmbeddingRepo.upsertIfContentHashMatchesCurrentMemory === undefined
            ? await this.dependencies.memoryEmbeddingRepo.upsert({
                object_id: latestMemory.object_id,
                workspace_id: latestMemory.workspace_id,
                content_hash: entry.contentHash,
                provider_kind: this.dependencies.provider.providerKind,
                model_id: this.dependencies.provider.modelId,
                schema_version: this.dependencies.provider.schemaVersion,
                dimensions: vector.length,
                embedding: vector,
                created_at: entry.existing?.created_at ?? this.now(),
                updated_at: this.now()
              })
            : await this.dependencies.memoryEmbeddingRepo.upsertIfContentHashMatchesCurrentMemory({
                object_id: latestMemory.object_id,
                workspace_id: latestMemory.workspace_id,
                content_hash: entry.contentHash,
                provider_kind: this.dependencies.provider.providerKind,
                model_id: this.dependencies.provider.modelId,
                schema_version: this.dependencies.provider.schemaVersion,
                dimensions: vector.length,
                embedding: vector,
                created_at: entry.existing?.created_at ?? this.now(),
                updated_at: this.now()
              });

        if (persisted === null) {
          auditEntries.push(`embedding_skipped:stale_content:${entry.memory.object_id}`);
          continue;
        }

        objectsAffected.push(latestMemory.object_id);
        auditEntries.push(`embedding_upserted:${latestMemory.object_id}`);
      } catch (error) {
        const message = toErrorMessage(error);
        auditEntries.push(`embedding_failed:persistence:${latestMemory.object_id}:${message}`);
        this.warn("embedding backfill upsert failed", {
          workspace_id: workspaceId,
          object_id: latestMemory.object_id,
          error: message
        });
        throw new EmbeddingBackfillPartialFailureError({
          workspaceId,
          failedObjectId: latestMemory.object_id,
          message,
          objectsAffected,
          auditEntries,
          cause: error
        });
      }
    }
  }

  private async resolveBatchHqMap(
    batch: readonly EmbeddingBackfillCandidate[]
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const hqProvider = this.dependencies.hqProvider;
    if (hqProvider === undefined) {
      return EMPTY_HQ_MAP;
    }
    return hqProvider.getHqByObjectIds(batch.map((entry) => entry.memory.object_id));
  }

  private async embedBatchWithFallback(
    workspaceId: string,
    batch: readonly EmbeddingBackfillCandidate[],
    auditEntries: string[]
  ): Promise<readonly EmbeddedBackfillCandidate[]> {
    // Resolve HQs once per top-level batch; the split / single-retry paths reuse
    // this map so a provider failure never re-reads HQs.
    const hqByObjectId = await this.resolveBatchHqMap(batch);
    return this.embedBatchWithHqMap(workspaceId, batch, hqByObjectId, auditEntries);
  }

  // off / no HQ provider → texts are raw content (byte-identical to prior path).
  private async embedBatchWithHqMap(
    workspaceId: string,
    batch: readonly EmbeddingBackfillCandidate[],
    hqByObjectId: ReadonlyMap<string, readonly string[]>,
    auditEntries: string[]
  ): Promise<readonly EmbeddedBackfillCandidate[]> {
    const texts = batch.map((entry) =>
      resolveEmbedText(entry.memory, hqByObjectId.get(entry.memory.object_id) ?? EMPTY_HQS)
    );
    try {
      const embeddings = await this.dependencies.provider.embedTexts(texts, {
        timeoutMs: BACKFILL_TIMEOUT_MS
      });

      if (embeddings.length !== batch.length) {
        throw new Error(`Expected ${batch.length} embeddings but received ${embeddings.length}.`);
      }

      return Object.freeze(
        batch.map((entry, index) =>
          Object.freeze({
            entry,
            embedding: embeddings[index]!
          })
        )
      );
    } catch (error) {
      const message = toErrorMessage(error);
      const batchInputChars = texts.reduce((total, text) => total + text.length, 0);

      if (batch.length <= 1) {
        const entry = batch[0];
        if (entry !== undefined) {
          const retryResult = await this.retrySingleItemEmbedding(workspaceId, entry, texts[0]!, message);
          if (retryResult.embedding !== null) {
            return Object.freeze([retryResult.embedding]);
          }
          this.warn("embedding backfill item failed; continuing with remaining batches", {
            workspace_id: workspaceId,
            object_id: entry.memory.object_id,
            input_chars: batchInputChars,
            error: retryResult.errorMessage
          });
          auditEntries.push(
            `embedding_failed:provider:${entry.memory.object_id}:${retryResult.errorMessage}`
          );
        }
        return Object.freeze([]);
      }

      this.warn("embedding backfill batch failed; retrying split batches", {
        workspace_id: workspaceId,
        batch_size: batch.length,
        batch_input_chars: batchInputChars,
        error: message
      });
      const splitIndex = Math.ceil(batch.length / 2);
      const left = await this.embedBatchWithHqMap(workspaceId, batch.slice(0, splitIndex), hqByObjectId, auditEntries);
      const right = await this.embedBatchWithHqMap(workspaceId, batch.slice(splitIndex), hqByObjectId, auditEntries);
      return Object.freeze([...left, ...right]);
    }
  }

  private async retrySingleItemEmbedding(
    workspaceId: string,
    entry: EmbeddingBackfillCandidate,
    entryText: string,
    firstError: string
  ): Promise<
    Readonly<{
      readonly embedding: EmbeddedBackfillCandidate | null;
      readonly errorMessage: string;
    }>
  > {
    let lastError = firstError;
    for (let attempt = 2; attempt <= BACKFILL_ITEM_RETRY_ATTEMPTS; attempt++) {
      this.warn("embedding backfill item failed; retrying item", {
        workspace_id: workspaceId,
        object_id: entry.memory.object_id,
        input_chars: entryText.length,
        attempt,
        max_attempts: BACKFILL_ITEM_RETRY_ATTEMPTS,
        error: lastError
      });
      await sleepBackfillRetry(this.retryDelayMs * (attempt - 1));

      try {
        const embeddings = await this.dependencies.provider.embedTexts([entryText], {
          timeoutMs: BACKFILL_TIMEOUT_MS
        });
        if (embeddings.length !== 1) {
          throw new Error(`Expected 1 embedding but received ${embeddings.length}.`);
        }
        return Object.freeze({
          embedding: Object.freeze({
            entry,
            embedding: embeddings[0]!
          }),
          errorMessage: lastError
        });
      } catch (error) {
        lastError = toErrorMessage(error);
      }
    }

    return Object.freeze({ embedding: null, errorMessage: lastError });
  }
}
