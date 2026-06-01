import { createHash } from "node:crypto";
import { StorageTier, type GardenTaskDescriptor, type MemoryEntry } from "@do-soul/alaya-protocol";
import type { EmbeddingProviderPort, EmbeddingVectorRecord } from "./embedding-recall-service.js";
import { toErrorMessage } from "./recall-service-helpers.js";

export interface EmbeddingBackfillMemoryRepoPort {
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

// Metadata-only view of an embedding row: every field the backfill cache-hit /
// stale decision needs, but NOT the embedding vector. Derived from
// EmbeddingVectorRecord so the field set never drifts; matches the storage
// port's MemoryEmbeddingMetadata shape structurally.
// see also: packages/storage/src/repos/memory-embedding-repo.ts MemoryEmbeddingMetadata
export type EmbeddingBackfillMetadata = Omit<EmbeddingVectorRecord, "embedding">;

export interface EmbeddingBackfillRepoPort {
  // Batch metadata-only lookup (no vector hydration). The handler's cache-hit /
  // stale decision reads only these fields, so this replaces n per-id
  // findByObjectId calls and avoids deserializing the full embedding blob.
  findMetadataByObjectIds(
    objectIds: readonly string[]
  ): Promise<readonly Readonly<EmbeddingBackfillMetadata>[]>;
  upsert(record: EmbeddingVectorRecord): Promise<Readonly<EmbeddingVectorRecord>>;
  upsertIfContentHashMatchesCurrentMemory?(
    record: EmbeddingVectorRecord
  ): Promise<Readonly<EmbeddingVectorRecord> | null>;
}

export interface EmbeddingBackfillHandleResult {
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
}

export interface EmbeddingBackfillPartialFailureInput {
  readonly workspaceId: string;
  readonly failedObjectId: string;
  readonly message: string;
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
  readonly cause: unknown;
}

export class EmbeddingBackfillPartialFailureError extends Error {
  public override readonly name = "EmbeddingBackfillPartialFailureError";
  public override readonly cause: unknown;
  public readonly workspaceId: string;
  public readonly failedObjectId: string;
  public readonly objectsAffected: readonly string[];
  public readonly auditEntries: readonly string[];

  public constructor(input: EmbeddingBackfillPartialFailureInput) {
    super(`embedding_backfill_failed:persistence:${input.failedObjectId}:${input.message}`);
    this.workspaceId = input.workspaceId;
    this.failedObjectId = input.failedObjectId;
    this.objectsAffected = Object.freeze([...input.objectsAffected]);
    this.auditEntries = Object.freeze([...input.auditEntries]);
    this.cause = input.cause;
    Object.setPrototypeOf(this, EmbeddingBackfillPartialFailureError.prototype);
  }
}

export function isEmbeddingBackfillPartialFailureError(
  error: unknown
): error is EmbeddingBackfillPartialFailureError {
  return error instanceof EmbeddingBackfillPartialFailureError;
}

export interface EmbeddingBackfillHandlerDependencies {
  readonly memoryRepo: EmbeddingBackfillMemoryRepoPort;
  readonly memoryEmbeddingRepo: EmbeddingBackfillRepoPort;
  readonly provider: EmbeddingProviderPort;
  readonly now?: () => string;
  readonly retryDelayMs?: number;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  // Bounded concurrency for in-flight batch embedding calls. Accepts a number
  // or a raw string (env-style); falsy/garbage falls back to the default.
  // Overrides ALAYA_EMBEDDING_BACKFILL_CONCURRENCY when set.
  readonly batchConcurrency?: number | string;
}

const BACKFILL_TIMEOUT_MS = 10_000;
const BACKFILL_BATCH_SIZE = 16;
const BACKFILL_BATCH_MAX_INPUT_CHARS = 32_000;
const BACKFILL_ITEM_RETRY_ATTEMPTS = 3;
const BACKFILL_ITEM_RETRY_DELAY_MS = 1_000;
// invariant: how many batch embedding calls may be in flight to the provider
// at once. The per-question backfill issues ~47 batches; sequential await made
// each question network-bound (~5.7 min, CPU idle at 20%). The concurrency is
// on the NETWORK embedding calls only. Network calls may OVERLAP batch-ordered
// persistence — the drain in handle() starts the next batch's embedding call
// before persisting the ready head — but the DB upserts themselves are
// batch-ordered and sequential (better-sqlite3 transactions are synchronous, so
// no two upserts interleave mid-transaction). 6 balances throughput against the
// provider's per-minute rate limit (429); higher risks throttling, lower leaves
// the network idle. Override via ALAYA_EMBEDDING_BACKFILL_CONCURRENCY.
const BACKFILL_BATCH_CONCURRENCY_DEFAULT = 6;
const BACKFILL_BATCH_CONCURRENCY_MAX = 32;
const BACKFILL_BATCH_CONCURRENCY_ENV = "ALAYA_EMBEDDING_BACKFILL_CONCURRENCY";

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
      return Object.freeze({
        objectsAffected: Object.freeze([]),
        auditEntries: Object.freeze(["embedding_backfill_skipped:provider_unavailable"])
      });
    }

    const initialHotMemories = await this.dependencies.memoryRepo.findByWorkspaceId(
      task.workspace_id,
      StorageTier.HOT
    );
    if (initialHotMemories.length === 0) {
      return Object.freeze({
        objectsAffected: Object.freeze([]),
        auditEntries: Object.freeze(["embedding_backfill_skipped:no_hot_memories"])
      });
    }

    // One batched metadata read for the whole hot corpus (no per-memory round
    // trip, no vector hydration). The cache-hit / stale decision and created_at
    // preservation below use only these metadata fields.
    const existingMetadata = await this.dependencies.memoryEmbeddingRepo.findMetadataByObjectIds(
      initialHotMemories.map((memory) => memory.object_id)
    );
    const existingById = new Map<string, Readonly<EmbeddingBackfillMetadata>>(
      existingMetadata.map((record) => [record.object_id, record] as const)
    );

    const unchangedAuditEntries: string[] = [];
    const memoriesToEmbed = initialHotMemories.flatMap((memory) => {
      const contentHash = hashMemoryContent(memory.content);
      const existing = existingById.get(memory.object_id) ?? null;

      if (
        existing !== null &&
        existing.content_hash === contentHash &&
        existing.provider_kind === this.dependencies.provider.providerKind &&
        existing.model_id === this.dependencies.provider.modelId &&
        existing.schema_version === this.dependencies.provider.schemaVersion
      ) {
        unchangedAuditEntries.push(`embedding_skipped:unchanged:${memory.object_id}`);
        return [];
      }

      return [
        Object.freeze({
          memory,
          contentHash,
          existing
        })
      ];
    });

    if (memoriesToEmbed.length === 0) {
      return Object.freeze({
        objectsAffected: Object.freeze([]),
        auditEntries: Object.freeze(unchangedAuditEntries)
      });
    }

    const objectsAffected: string[] = [];
    const auditEntries = [...unchangedAuditEntries];

    // invariant: the single hot-corpus snapshot taken above is the embed input
    // and the only in-handler stale reference. The atomic write-time guard
    // (upsertIfContentHashMatchesCurrentMemory) re-reads live memory content
    // inside the upsert transaction and refuses a vector whose content_hash no
    // longer matches, so a per-batch re-fetch here would only duplicate that
    // guard at O(n) hydration per batch (O(n^2) over the corpus).
    // see also: packages/storage/src/repos/memory-embedding-repo.ts guardedUpsertTransaction
    const snapshotMemories = new Map(
      initialHotMemories.map((memory) => [memory.object_id, memory] as const)
    );

    const batches = buildEmbeddingBackfillBatches(memoriesToEmbed);

    // Pipelined bounded-concurrency drain: keep up to `batchConcurrency` batch
    // embedding calls in flight (the network-bound cost), but persist each
    // batch IN ORDER as soon as it is ready. This bounds peak in-flight vector
    // memory to ~`batchConcurrency` batches (a completed batch is consumed and
    // released before the window slides forward) rather than buffering the
    // whole corpus, and it keeps the all-ready postcondition: every batch is
    // embedded and attempted exactly once.
    //
    // Each in-flight task owns a private auditFragments array so the recursive
    // split/retry fallback never races the shared auditEntries; the fragments
    // and embeddings are replayed deterministically in batch order during
    // persistence. better-sqlite3 is synchronous, so each guardedUpsert
    // transaction runs to completion on the event loop before the next begins —
    // no two upserts interleave mid-transaction even though their embeddings
    // were fetched concurrently — so aggregate counts and audit ordering stay
    // deterministic.
    // see also: packages/storage/src/repos/memory-embedding-repo.ts guardedUpsertTransaction
    const concurrencyWindow = Math.max(1, Math.min(this.batchConcurrency, batches.length));
    const inFlight: (Promise<ConcurrentBatchResult> | null)[] = [];
    const startBatch = (batch: readonly EmbeddingBackfillCandidate[]): Promise<ConcurrentBatchResult> => {
      const auditFragments: string[] = [];
      return this.embedBatchWithFallback(task.workspace_id, batch, auditFragments).then((embedded) => ({
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
        await this.persistEmbeddedBatch(task.workspace_id, ready, snapshotMemories, objectsAffected, auditEntries);
      } catch (error) {
        // invariant: a persistence failure aborts the drain, but the K-1 batch
        // promises already in flight to the provider must not outlive the task
        // lifecycle — otherwise a fast retry starts another K calls and the
        // effective provider concurrency exceeds the cap across failure+retry.
        // Settle (never reject) every started promise before re-throwing the
        // ORIGINAL persistence error so the cap guarantee describes task
        // lifecycle behavior. embedBatchWithFallback already catches provider
        // errors, so allSettled here is bounded (<=K) and cannot itself throw.
        await Promise.allSettled(inFlight.filter((entry) => entry !== null));
        throw error;
      }
    }

    return Object.freeze({
      objectsAffected: Object.freeze(objectsAffected),
      auditEntries: Object.freeze(auditEntries)
    });
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

  private async embedBatchWithFallback(
    workspaceId: string,
    batch: readonly EmbeddingBackfillCandidate[],
    auditEntries: string[]
  ): Promise<readonly EmbeddedBackfillCandidate[]> {
    try {
      const embeddings = await this.dependencies.provider.embedTexts(
        batch.map((entry) => entry.memory.content),
        {
          timeoutMs: BACKFILL_TIMEOUT_MS
        }
      );

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
      const batchInputChars = batch.reduce((total, entry) => total + entry.memory.content.length, 0);

      if (batch.length <= 1) {
        const entry = batch[0];
        if (entry !== undefined) {
          const retried = await this.retrySingleItemEmbedding(workspaceId, entry, message);
          if (retried !== null) {
            return Object.freeze([retried]);
          }
          this.warn("embedding backfill item failed; continuing with remaining batches", {
            workspace_id: workspaceId,
            object_id: entry.memory.object_id,
            input_chars: batchInputChars,
            error: message
          });
          auditEntries.push(`embedding_failed:provider:${entry.memory.object_id}`);
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
      const left = await this.embedBatchWithFallback(workspaceId, batch.slice(0, splitIndex), auditEntries);
      const right = await this.embedBatchWithFallback(workspaceId, batch.slice(splitIndex), auditEntries);
      return Object.freeze([...left, ...right]);
    }
  }

  private async retrySingleItemEmbedding(
    workspaceId: string,
    entry: EmbeddingBackfillCandidate,
    firstError: string
  ): Promise<EmbeddedBackfillCandidate | null> {
    let lastError = firstError;
    for (let attempt = 2; attempt <= BACKFILL_ITEM_RETRY_ATTEMPTS; attempt++) {
      this.warn("embedding backfill item failed; retrying item", {
        workspace_id: workspaceId,
        object_id: entry.memory.object_id,
        input_chars: entry.memory.content.length,
        attempt,
        max_attempts: BACKFILL_ITEM_RETRY_ATTEMPTS,
        error: lastError
      });
      await sleepBackfillRetry(this.retryDelayMs * (attempt - 1));

      try {
        const embeddings = await this.dependencies.provider.embedTexts([entry.memory.content], {
          timeoutMs: BACKFILL_TIMEOUT_MS
        });
        if (embeddings.length !== 1) {
          throw new Error(`Expected 1 embedding but received ${embeddings.length}.`);
        }
        return Object.freeze({
          entry,
          embedding: embeddings[0]!
        });
      } catch (error) {
        lastError = toErrorMessage(error);
      }
    }

    return null;
  }
}

type EmbeddingBackfillCandidate = Readonly<{
  readonly memory: Readonly<MemoryEntry>;
  readonly contentHash: string;
  readonly existing: Readonly<EmbeddingBackfillMetadata> | null;
}>;

type EmbeddedBackfillCandidate = Readonly<{
  readonly entry: EmbeddingBackfillCandidate;
  readonly embedding: Float32Array;
}>;

type ConcurrentBatchResult = Readonly<{
  readonly embedded: readonly EmbeddedBackfillCandidate[];
  readonly auditFragments: readonly string[];
}>;

// Resolve the in-flight batch concurrency from an explicit number, an env-style
// string, or undefined. Garbage (non-integer, <1, NaN) falls back to the
// default; values above the ceiling clamp to the max so a misconfigured env
// cannot flood the provider with rate-limited (429) calls. The string path
// accepts ONLY a full positive-integer string after trimming — integer-prefix
// garbage like "6abc", "6.7", or "1e3" falls back to the default rather than
// silently resolving to a partial parse.
export function resolveBackfillBatchConcurrency(raw: number | string | undefined): number {
  if (raw === undefined) {
    return BACKFILL_BATCH_CONCURRENCY_DEFAULT;
  }
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      return BACKFILL_BATCH_CONCURRENCY_DEFAULT;
    }
    parsed = Number(trimmed);
  }
  if (!Number.isInteger(parsed) || parsed < 1) {
    return BACKFILL_BATCH_CONCURRENCY_DEFAULT;
  }
  return Math.min(parsed, BACKFILL_BATCH_CONCURRENCY_MAX);
}

function buildEmbeddingBackfillBatches(
  entries: readonly EmbeddingBackfillCandidate[]
): readonly (readonly EmbeddingBackfillCandidate[])[] {
  const batches: EmbeddingBackfillCandidate[][] = [];
  let currentBatch: EmbeddingBackfillCandidate[] = [];
  let currentChars = 0;

  for (const entry of entries) {
    const entryChars = entry.memory.content.length;
    const wouldExceedCount = currentBatch.length >= BACKFILL_BATCH_SIZE;
    const wouldExceedChars =
      currentBatch.length > 0 &&
      currentChars + entryChars > BACKFILL_BATCH_MAX_INPUT_CHARS;
    if (wouldExceedCount || wouldExceedChars) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(entry);
    currentChars += entryChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return Object.freeze(batches.map((batch) => Object.freeze([...batch])));
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function sleepBackfillRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
  });
}
