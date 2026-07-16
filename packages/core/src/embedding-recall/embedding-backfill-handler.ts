import { type GardenTaskDescriptor, type MemoryEntry } from "@do-soul/alaya-protocol";
import { getCoreConfig } from "../config/install-core-config.js";
import { toErrorMessage } from "../recall/runtime/recall-service-helpers.js";
import { persistEmbeddedBackfillBatch } from "./backfill/persist-embedded-batch.js";
import { resolveEmbedText } from "./embed-text-resolver.js";
import { assertValidEmbeddingBatch } from "./helpers.js";
import { resolveEmbeddingRecallTiers } from "./tier-config.js";
import {
  BACKFILL_ITEM_RETRY_ATTEMPTS,
  BACKFILL_ITEM_RETRY_DELAY_MS,
  BACKFILL_TIMEOUT_MS,
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
      dependencies.batchConcurrency ??
        (getCoreConfig().embedding.backfillConcurrency === undefined
          ? undefined
          : String(getCoreConfig().embedding.backfillConcurrency))
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
    const expectedDimensions = this.dependencies.expectedDimensions?.();
    const mixedDimensions = this.hasMixedCurrentIdentityDimensions(existingById);
    const auditEntries: string[] = [];
    const memoriesToEmbed = initialMemories.flatMap((memory) =>
      this.selectMemoryForEmbedding(
        memory,
        existingById,
        expectedDimensions,
        mixedDimensions,
        auditEntries
      )
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
    expectedDimensions: number | null | undefined,
    mixedDimensions: boolean,
    auditEntries: string[]
  ): readonly EmbeddingBackfillCandidate[] {
    const contentHash = hashMemoryContent(memory.content);
    const existing = existingById.get(memory.object_id) ?? null;

    if (this.isEmbeddingMetadataFresh(existing, contentHash, expectedDimensions, mixedDimensions)) {
      auditEntries.push(`embedding_skipped:unchanged:${memory.object_id}`);
      return Object.freeze([]);
    }

    return Object.freeze([Object.freeze({ memory, contentHash, existing })]);
  }

  private isEmbeddingMetadataFresh(
    existing: Readonly<EmbeddingBackfillMetadata> | null,
    contentHash: string,
    expectedDimensions: number | null | undefined,
    mixedDimensions: boolean
  ): boolean {
    return (
      existing !== null &&
      !mixedDimensions &&
      existing.vector_valid &&
      existing.content_hash === contentHash &&
      existing.provider_kind === this.dependencies.provider.providerKind &&
      existing.model_id === this.dependencies.provider.modelId &&
      existing.schema_version === this.dependencies.provider.schemaVersion &&
      (expectedDimensions === undefined ||
        (expectedDimensions !== null && existing.dimensions === expectedDimensions))
    );
  }

  private hasMixedCurrentIdentityDimensions(
    existingById: ReadonlyMap<string, Readonly<EmbeddingBackfillMetadata>>
  ): boolean {
    const dimensions = new Set<number>();
    for (const existing of existingById.values()) {
      if (!existing.vector_valid ||
          existing.provider_kind !== this.dependencies.provider.providerKind ||
          existing.model_id !== this.dependencies.provider.modelId ||
          existing.schema_version !== this.dependencies.provider.schemaVersion) {
        continue;
      }
      dimensions.add(existing.dimensions);
      if (dimensions.size > 1) return true;
    }
    return false;
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
    await persistEmbeddedBackfillBatch({
      workspaceId,
      result,
      snapshotMemories,
      objectsAffected,
      auditEntries,
      dependencies: this.dependencies,
      now: this.now,
      warn: this.warn
    });
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
      return await this.embedBackfillBatch(batch, texts);
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

  private async embedBackfillBatch(
    batch: readonly EmbeddingBackfillCandidate[],
    texts: readonly string[]
  ): Promise<readonly EmbeddedBackfillCandidate[]> {
    const embeddings = await this.dependencies.provider.embedTexts(texts, {
      timeoutMs: BACKFILL_TIMEOUT_MS
    });
    assertValidEmbeddingBatch(embeddings, batch.length);
    return Object.freeze(batch.map((entry, index) => Object.freeze({
      entry,
      embedding: embeddings[index]!
    })));
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
        assertValidEmbeddingBatch(embeddings, 1);
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
