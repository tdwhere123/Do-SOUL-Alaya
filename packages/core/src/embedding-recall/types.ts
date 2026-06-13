import type {
  EventLogEntry,
  HealthJournalRecordPort,
  MemoryEntry
} from "@do-soul/alaya-protocol";

export interface EmbeddingVectorRecord {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding: Float32Array;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EmbeddingProviderPort {
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly isAvailable: boolean;
  embedTexts(
    texts: readonly string[],
    options: {
      readonly timeoutMs: number;
    }
  ): Promise<readonly Float32Array[]>;
}

export interface EmbeddingRecallRepoPort {
  listByObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<EmbeddingVectorRecord>[]>;
  // Optional: full workspace vector scan, used by the embedding-on coarse
  // injection path to find semantically near memories that lexical recall
  // never admitted into the candidate pool. The optional `tierFilter` admits
  // only memories at the requested storage tier (HOT by default in the recall
  // hot path; WARM / COLD stay out of the embedding candidate pool, matching
  // the cascade design). `limit` caps the scan so a workspace with millions
  // of memories does not pay an O(workspace_size) cost per recall.
  listByWorkspace?(
    workspaceId: string,
    options?: EmbeddingWorkspaceScanOptions
  ): Promise<readonly Readonly<EmbeddingVectorRecord>[]>;
}

export interface EmbeddingWorkspaceScanOptions {
  // Optional storage-tier whitelist. When set, callers receive only embeddings
  // whose backing memory_entry sits in one of the listed tiers.
  readonly tierFilter?: readonly ("hot" | "warm" | "cold")[];
  // Hard cap on the number of records returned. Applied after tier filtering.
  readonly limit?: number;
  // invariant: cosine space is valid only within one (provider_kind, model_id);
  // SQL-side restriction prevents the scan cap from being consumed by vectors
  // the JS-side filter would discard.
  readonly providerKind?: string;
  readonly modelId?: string;
}

export interface EmbeddingNeighborHit {
  readonly object_id: string;
  readonly normalized_similarity: number;
}

export interface EmbeddingWorkspaceNeighborResult {
  readonly hits: readonly Readonly<EmbeddingNeighborHit>[];
  // Fresh query-embedding inference calls consumed by this workspace-neighbor
  // scan. A cache hit or unavailable provider contributes 0; a successful
  // fresh provider call contributes 1 even when no neighbor survives filters.
  readonly embedding_inference_calls: number;
  readonly query_embedding_cache_hit: boolean;
}

export interface EmbeddingRecallEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface EmbeddingSimilarityHint {
  readonly object_id: string;
  readonly normalized_similarity: number;
}

export interface EmbeddingRecallSupplementResult {
  readonly supplementaryEntries: readonly Readonly<MemoryEntry>[];
  readonly similarityHintsByObjectId: Readonly<Record<string, Readonly<EmbeddingSimilarityHint>>>;
}

export interface EmbeddingRecallServiceDependencies {
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly provider: EmbeddingProviderPort;
  readonly eventLogRepo: EmbeddingRecallEventLogPort;
  readonly healthJournalRecorder?: HealthJournalRecordPort;
  readonly generateQueryId?: () => string;
  readonly now?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  /**
   * Per-query embedding provider timeout for the recall prefetch / supplement
   * paths. Defaults to
   * packages/core/src/embedding-recall/constants.ts:DEFAULT_QUERY_TIMEOUT_MS.
   * The default of 250 ms was empirically too tight (long-run test 2026-05-08
   * observed 100% of queries finishing as `query_embedding_pending`); 2500 ms
   * gives OpenAI / compatible providers room to land within the recall window
   * while still bounded.
   */
  readonly queryTimeoutMs?: number;
  readonly queryEmbeddingCacheSize?: number;
}

export type PreparedEmbeddingQuerySnapshot =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "ready";
      readonly embedding: Float32Array;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly error_name?: string;
      readonly error_message?: string;
    };

export interface PreparedEmbeddingQueryHandle {
  readonly queryId: string;
  // True when the query embedding was served from the in-memory cache and
  // no provider invocation was issued for this prepared query. False when
  // the provider was called (even if the call later failed or is still
  // pending). Stable across the handle lifetime — set at handle creation
  // and not mutated by subsequent reads. Consumed by RecallService to
  // populate RecallTokenEconomy.embedding_inference_calls.
  readonly cacheHit: boolean;
  getSnapshot(): PreparedEmbeddingQuerySnapshot;
  waitForSnapshot?(timeoutMs: number): Promise<PreparedEmbeddingQuerySnapshot>;
}

export interface PreparedEmbeddingSupplement {
  readonly preparedQuery: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
  readonly degradedReason: string | null;
}

export interface EmbeddingQueryWarmupSummary {
  readonly status: "not_requested" | "ready";
  readonly requested_count: number;
  readonly ready_count: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly missing_count: number;
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly last_error?: string;
}
