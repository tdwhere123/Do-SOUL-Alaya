import { createHash } from "node:crypto";
import { StorageTier, type MemoryEntry } from "@do-soul/alaya-protocol";
import type { EmbeddingProviderPort, EmbeddingVectorRecord } from "./embedding-recall-service.js";

export interface EmbeddingBackfillMemoryRepoPort {
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier,
    page?: {
      readonly limit: number;
      readonly offset: number;
    }
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceIdAll?(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

export type EmbeddingBackfillMetadata = Omit<EmbeddingVectorRecord, "embedding">;

export interface EmbeddingBackfillRepoPort {
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
  readonly batchConcurrency?: number | string;
}

export const BACKFILL_TIMEOUT_MS = 10_000;
export const BACKFILL_BATCH_SIZE = 16;
export const BACKFILL_BATCH_MAX_INPUT_CHARS = 32_000;
export const BACKFILL_ITEM_RETRY_ATTEMPTS = 3;
export const BACKFILL_ITEM_RETRY_DELAY_MS = 1_000;
const BACKFILL_MEMORY_SCAN_PAGE_LIMIT = 500;
export const BACKFILL_BATCH_CONCURRENCY_DEFAULT = 6;
export const BACKFILL_BATCH_CONCURRENCY_MAX = 32;
export const BACKFILL_BATCH_CONCURRENCY_ENV = "ALAYA_EMBEDDING_BACKFILL_CONCURRENCY";

export type EmbeddingBackfillCandidate = Readonly<{
  readonly memory: Readonly<MemoryEntry>;
  readonly contentHash: string;
  readonly existing: Readonly<EmbeddingBackfillMetadata> | null;
}>;

export type EmbeddedBackfillCandidate = Readonly<{
  readonly entry: EmbeddingBackfillCandidate;
  readonly embedding: Float32Array;
}>;

export type ConcurrentBatchResult = Readonly<{
  readonly embedded: readonly EmbeddedBackfillCandidate[];
  readonly auditFragments: readonly string[];
}>;

export async function collectBackfillMemories(
  memoryRepo: EmbeddingBackfillMemoryRepoPort,
  workspaceId: string,
  tier: StorageTier
): Promise<readonly Readonly<MemoryEntry>[]> {
  if (memoryRepo.findByWorkspaceIdAll !== undefined) {
    return await memoryRepo.findByWorkspaceIdAll(workspaceId, tier);
  }

  const rows: Readonly<MemoryEntry>[] = [];
  for (let offset = 0; ; offset += BACKFILL_MEMORY_SCAN_PAGE_LIMIT) {
    const page = await memoryRepo.findByWorkspaceId(workspaceId, tier, {
      limit: BACKFILL_MEMORY_SCAN_PAGE_LIMIT,
      offset
    });
    rows.push(...page);
    if (page.length < BACKFILL_MEMORY_SCAN_PAGE_LIMIT) {
      break;
    }
  }
  return Object.freeze(rows);
}

export function resolveBackfillBatchConcurrency(
  raw: number | string | undefined
): number {
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

export function buildEmbeddingBackfillBatches(
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

export function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function sleepBackfillRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
  });
}
