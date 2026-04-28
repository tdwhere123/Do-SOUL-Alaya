import { createHash } from "node:crypto";
import { StorageTier, type GardenTaskDescriptor, type MemoryEntry } from "@do-what/protocol";
import type { EmbeddingProviderPort, EmbeddingVectorRecord } from "./embedding-recall-service.js";

export interface EmbeddingBackfillMemoryRepoPort {
  findByWorkspaceId(
    workspaceId: string,
    tier?: StorageTier
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface EmbeddingBackfillRepoPort {
  findByObjectId(objectId: string): Promise<Readonly<EmbeddingVectorRecord> | null>;
  upsert(record: EmbeddingVectorRecord): Promise<Readonly<EmbeddingVectorRecord>>;
  upsertIfContentHashMatchesCurrentMemory?(
    record: EmbeddingVectorRecord
  ): Promise<Readonly<EmbeddingVectorRecord> | null>;
}

export interface EmbeddingBackfillHandleResult {
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
}

export interface EmbeddingBackfillHandlerDependencies {
  readonly memoryRepo: EmbeddingBackfillMemoryRepoPort;
  readonly memoryEmbeddingRepo: EmbeddingBackfillRepoPort;
  readonly provider: EmbeddingProviderPort;
  readonly now?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

const BACKFILL_TIMEOUT_MS = 10_000;
const BACKFILL_BATCH_SIZE = 16;

export class EmbeddingBackfillHandler {
  private readonly now: () => string;
  private readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public constructor(private readonly dependencies: EmbeddingBackfillHandlerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
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

    const existingById = new Map(
      await Promise.all(
        initialHotMemories.map(async (memory) => [
          memory.object_id,
          await this.dependencies.memoryEmbeddingRepo.findByObjectId(memory.object_id)
        ] as const)
      )
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

    for (let index = 0; index < memoriesToEmbed.length; index += BACKFILL_BATCH_SIZE) {
      const batch = memoriesToEmbed.slice(index, index + BACKFILL_BATCH_SIZE);
      const embeddings = await this.dependencies.provider.embedTexts(
        batch.map((entry) => entry.memory.content),
        {
          timeoutMs: BACKFILL_TIMEOUT_MS
        }
      );

      if (embeddings.length !== batch.length) {
        throw new Error(`Expected ${batch.length} embeddings but received ${embeddings.length}.`);
      }

      const latestHotMemories = new Map(
        (
          await this.dependencies.memoryRepo.findByWorkspaceId(task.workspace_id, StorageTier.HOT)
        ).map((memory) => [memory.object_id, memory] as const)
      );

      for (const [batchIndex, entry] of batch.entries()) {
        const latestMemory = latestHotMemories.get(entry.memory.object_id);
        const latestHash = latestMemory === undefined ? null : hashMemoryContent(latestMemory.content);

        if (latestMemory === undefined || latestHash !== entry.contentHash) {
          auditEntries.push(`embedding_skipped:stale_content:${entry.memory.object_id}`);
          continue;
        }

        const vector = new Float32Array(embeddings[batchIndex]!);
        try {
          const persisted =
            this.dependencies.memoryEmbeddingRepo.upsertIfContentHashMatchesCurrentMemory ===
            undefined
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
          this.warn("embedding backfill upsert failed", {
            workspace_id: task.workspace_id,
            object_id: latestMemory.object_id,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    }

    return Object.freeze({
      objectsAffected: Object.freeze(objectsAffected),
      auditEntries: Object.freeze(auditEntries)
    });
  }
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
