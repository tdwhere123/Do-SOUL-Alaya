import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { toErrorMessage } from "../../recall/runtime/recall-service-helpers.js";
import {
  EmbeddingBackfillPartialFailureError,
  hashMemoryContent,
  type ConcurrentBatchResult,
  type EmbeddedBackfillCandidate,
  type EmbeddingBackfillHandlerDependencies
} from "../embedding-backfill-handler-shared.js";
import { assertValidEmbeddingBatch } from "../helpers.js";
import type { EmbeddingVectorRecord } from "../types.js";

interface PersistEmbeddedBatchParams {
  readonly workspaceId: string;
  readonly result: ConcurrentBatchResult;
  readonly snapshotMemories: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly objectsAffected: string[];
  readonly auditEntries: string[];
  readonly dependencies: Pick<
    EmbeddingBackfillHandlerDependencies,
    "memoryEmbeddingRepo" | "provider"
  >;
  readonly now: () => string;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export async function persistEmbeddedBackfillBatch(
  params: PersistEmbeddedBatchParams
): Promise<void> {
  assertValidEmbeddingBatch(
    params.result.embedded.map(({ embedding }) => embedding),
    params.result.embedded.length
  );
  params.auditEntries.push(...params.result.auditFragments);
  for (const candidate of params.result.embedded) {
    await persistEmbeddedCandidate(params, candidate);
  }
}

async function persistEmbeddedCandidate(
  params: PersistEmbeddedBatchParams,
  candidate: EmbeddedBackfillCandidate
): Promise<void> {
  const { entry } = candidate;
  const latestMemory = params.snapshotMemories.get(entry.memory.object_id);
  if (latestMemory === undefined || hashMemoryContent(latestMemory.content) !== entry.contentHash) {
    params.auditEntries.push(`embedding_skipped:stale_content:${entry.memory.object_id}`);
    return;
  }
  try {
    const persisted = await upsertEmbeddingRecord(params, buildEmbeddingRecord(params, candidate, latestMemory));
    if (persisted === null) {
      params.auditEntries.push(`embedding_skipped:stale_content:${entry.memory.object_id}`);
      return;
    }
    params.objectsAffected.push(latestMemory.object_id);
    params.auditEntries.push(`embedding_upserted:${latestMemory.object_id}`);
  } catch (error) {
    throwPersistenceFailure(params, latestMemory.object_id, error);
  }
}

function buildEmbeddingRecord(
  params: PersistEmbeddedBatchParams,
  candidate: EmbeddedBackfillCandidate,
  memory: Readonly<MemoryEntry>
): EmbeddingVectorRecord {
  const vector = new Float32Array(candidate.embedding);
  return {
    object_id: memory.object_id,
    workspace_id: memory.workspace_id,
    content_hash: candidate.entry.contentHash,
    provider_kind: params.dependencies.provider.providerKind,
    model_id: params.dependencies.provider.modelId,
    schema_version: params.dependencies.provider.schemaVersion,
    dimensions: vector.length,
    embedding: vector,
    created_at: candidate.entry.existing?.created_at ?? params.now(),
    updated_at: params.now()
  };
}

async function upsertEmbeddingRecord(
  params: PersistEmbeddedBatchParams,
  record: EmbeddingVectorRecord
): Promise<Readonly<EmbeddingVectorRecord> | null> {
  const guardedUpsert = params.dependencies.memoryEmbeddingRepo.upsertIfContentHashMatchesCurrentMemory;
  return guardedUpsert === undefined
    ? await params.dependencies.memoryEmbeddingRepo.upsert(record)
    : await guardedUpsert.call(params.dependencies.memoryEmbeddingRepo, record);
}

function throwPersistenceFailure(
  params: PersistEmbeddedBatchParams,
  objectId: string,
  error: unknown
): never {
  const message = toErrorMessage(error);
  params.auditEntries.push(`embedding_failed:persistence:${objectId}:${message}`);
  params.warn("embedding backfill upsert failed", {
    workspace_id: params.workspaceId,
    object_id: objectId,
    error: message
  });
  throw new EmbeddingBackfillPartialFailureError({
    workspaceId: params.workspaceId,
    failedObjectId: objectId,
    message,
    objectsAffected: params.objectsAffected,
    auditEntries: params.auditEntries,
    cause: error
  });
}
