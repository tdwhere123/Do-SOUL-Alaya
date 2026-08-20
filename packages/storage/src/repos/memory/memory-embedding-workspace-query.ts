import { StorageError } from "../../shared/errors.js";
import {
  parseModelId,
  parseProviderKind
} from "./memory-embedding-mappers.js";
import type { MemoryEmbeddingListByWorkspaceOptions } from "./memory-embedding-repo.js";

export interface MemoryEmbeddingWorkspaceQuery {
  readonly sql: string;
  readonly args: readonly (string | number)[];
}

// invariant: unfiltered listByWorkspace without a positive limit must not hydrate all blobs.
export function usesDefaultWorkspaceEmbeddingQuery(
  options: MemoryEmbeddingListByWorkspaceOptions | undefined
): boolean {
  return (
    options?.tierFilter === undefined &&
    (options?.limit === undefined || options.limit <= 0) &&
    options?.providerKind === undefined &&
    options?.modelId === undefined &&
    options?.schemaVersion === undefined
  );
}

export function buildWorkspaceEmbeddingQuery(
  workspaceId: string,
  options: MemoryEmbeddingListByWorkspaceOptions | undefined,
  columns: "blob" | "ids"
): MemoryEmbeddingWorkspaceQuery {
  const clauses = [
    "e.workspace_id = ?",
    "e.vector_valid = 1",
    "m.lifecycle_state = 'active'",
    "COALESCE(m.retention_state, '') != 'tombstoned'"
  ];
  const args: (string | number)[] = [workspaceId];
  appendWorkspaceEmbeddingFilters(clauses, args, options);
  const selectSql = columns === "ids"
    ? WORKSPACE_EMBEDDING_ID_SELECT_SQL
    : WORKSPACE_EMBEDDING_SELECT_SQL;
  let sql = `${selectSql}
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.object_id ASC`;
  if (options?.limit !== undefined && options.limit > 0) {
    sql += " LIMIT ?";
    args.push(Math.floor(options.limit));
  }
  return { sql, args };
}

function appendWorkspaceEmbeddingFilters(
  clauses: string[],
  args: (string | number)[],
  options: MemoryEmbeddingListByWorkspaceOptions | undefined
): void {
  appendTierFilter(clauses, args, options?.tierFilter);
  if (options?.providerKind !== undefined) {
    clauses.push("e.provider_kind = ?");
    args.push(parseProviderKind(options.providerKind));
  }
  if (options?.modelId !== undefined) {
    clauses.push("e.model_id = ?");
    args.push(parseModelId(options.modelId));
  }
  if (options?.schemaVersion !== undefined) {
    clauses.push("e.schema_version = ?");
    args.push(Math.floor(options.schemaVersion));
  }
}

function appendTierFilter(
  clauses: string[],
  args: (string | number)[],
  tierFilter: readonly ("hot" | "warm" | "cold")[] | undefined
): void {
  if (tierFilter === undefined || tierFilter.length === 0) {
    return;
  }
  clauses.push(`m.storage_tier IN (${tierFilter.map(() => "?").join(", ")})`);
  args.push(...tierFilter);
}

const WORKSPACE_EMBEDDING_SELECT_SQL = `
        SELECT
          e.object_id,
          e.workspace_id,
          e.content_hash,
          e.provider_kind,
          e.model_id,
          e.schema_version,
          e.dimensions,
          e.embedding_blob,
          e.created_at,
          e.updated_at
        FROM memory_embeddings e
        INNER JOIN memory_entries m ON m.object_id = e.object_id`;

const WORKSPACE_EMBEDDING_ID_SELECT_SQL = `
        SELECT e.object_id AS object_id
        FROM memory_embeddings e
        INNER JOIN memory_entries m ON m.object_id = e.object_id`;

export function rejectUnboundedWorkspaceEmbeddingQuery(
  options: MemoryEmbeddingListByWorkspaceOptions | undefined
): void {
  if (!usesDefaultWorkspaceEmbeddingQuery(options)) return;
  throw new StorageError(
    "VALIDATION_FAILED",
    "listByWorkspace requires a positive limit (or tier/provider/model/schema filters) to avoid unbounded embedding blob hydration."
  );
}
