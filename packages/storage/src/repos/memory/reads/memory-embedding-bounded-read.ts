import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { parseRows } from "../../shared/parse-row.js";
import { MemoryEmbeddingRowParser } from "../../shared/sqlite-row-schemas.js";
import { parseMemoryEmbeddingRow, parseModelId, parseObjectId, parseProviderKind, parseWorkspaceId } from "../mappers/memory-embedding-mappers.js";
import type { MemoryEmbeddingRecord } from "../memory-embedding-repo.js";

export interface BoundedEmbeddingProfile {
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly maxRows: number;
  readonly maxMetadataUtf8Bytes: number;
}

export interface BoundedEmbeddingReadOptions extends BoundedEmbeddingProfile {
  readonly expectedDimensions: number;
  readonly maxVectorBytes: number;
  readonly maxObjectIds: number;
}

export interface BoundedEmbeddingReadReceipt {
  readonly rowVisits: number;
  readonly metadataUtf8Bytes: number;
  readonly filteredRows: number;
  readonly truncated: boolean;
}

export const BOUNDED_EMBEDDING_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_recall_profile_identity
  ON memory_embeddings(workspace_id, provider_kind, model_id, schema_version, vector_valid, object_id)`;

function validateProfile(workspaceId: string, profile: BoundedEmbeddingProfile): void {
  parseWorkspaceId(workspaceId); parseProviderKind(profile.providerKind); parseModelId(profile.modelId);
  for (const value of [profile.maxRows, profile.schemaVersion, profile.maxMetadataUtf8Bytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("VALIDATION_FAILED", "Invalid bounded embedding profile");
  }
  if (profile.maxRows > 512 || profile.maxMetadataUtf8Bytes < 1 ||
    [workspaceId, profile.providerKind, profile.modelId].some((value) => Buffer.byteLength(value, "utf8") > profile.maxMetadataUtf8Bytes)) {
    throw new StorageError("VALIDATION_FAILED", "Bounded embedding profile exceeds input capacity");
  }
}

export function readBoundedEmbeddingIds(
  db: StorageDatabase,
  workspaceId: string,
  profile: BoundedEmbeddingProfile,
  afterObjectId: string | null = null
):
  BoundedEmbeddingReadReceipt & { readonly objectIds: readonly string[] } {
  validateProfile(workspaceId, profile);
  if (profile.maxRows === 0) return Object.freeze({ objectIds: Object.freeze([]), rowVisits: 0, metadataUtf8Bytes: 0, filteredRows: 0, truncated: true });
  // The indexed canonical prefix owns the native visit cap; downstream source admission owns lifecycle and tier.
  const rows = db.connection.prepare(`WITH candidates AS MATERIALIZED (
    SELECT e.object_id AS object_id FROM memory_embeddings e INDEXED BY idx_memory_embeddings_recall_profile_identity
    WHERE e.workspace_id = ? AND e.provider_kind = ? AND e.model_id = ? AND e.schema_version = ? AND e.vector_valid = 1
      AND e.object_id > ?
    ORDER BY e.object_id ASC LIMIT ?
  ) SELECT CASE WHEN octet_length(object_id) <= ? THEN object_id ELSE NULL END AS object_id,
    CASE WHEN octet_length(object_id) <= ? THEN octet_length(object_id) ELSE 0 END AS metadata_bytes
    FROM candidates ORDER BY object_id`).all(workspaceId, profile.providerKind, profile.modelId,
    profile.schemaVersion, afterObjectId ?? "", profile.maxRows, profile.maxMetadataUtf8Bytes, profile.maxMetadataUtf8Bytes) as
    { object_id: string | null; metadata_bytes: number }[];
  const objectIds = rows.flatMap((row) => row.object_id === null ? [] : [row.object_id]);
  const filteredRows = rows.length - objectIds.length;
  return Object.freeze({ objectIds: Object.freeze(objectIds), rowVisits: rows.length,
    metadataUtf8Bytes: rows.reduce((sum, row) => sum + row.metadata_bytes, 0), filteredRows,
    truncated: filteredRows > 0 || rows.length === profile.maxRows });
}

const METADATA_COLUMNS = ["object_id", "workspace_id", "content_hash", "provider_kind", "model_id", "created_at", "updated_at"] as const;
const META_BYTES = METADATA_COLUMNS.map((column) => `octet_length(e.${column})`).join(" + ");
const PAYLOAD_COLUMNS = [...METADATA_COLUMNS, "schema_version", "dimensions", "embedding_blob"] as const;

export function readBoundedEmbeddings(db: StorageDatabase, workspaceId: string, objectIds: readonly string[], options: BoundedEmbeddingReadOptions):
  BoundedEmbeddingReadReceipt & { readonly records: readonly Readonly<MemoryEmbeddingRecord>[]; readonly vectorBytes: number } {
  validateProfile(workspaceId, options);
  if (!Number.isSafeInteger(options.maxObjectIds) || options.maxObjectIds < 0 || options.maxObjectIds > 512 ||
    !Number.isSafeInteger(options.expectedDimensions) || options.expectedDimensions < 1 ||
    !Number.isSafeInteger(options.maxVectorBytes) || options.maxVectorBytes !== options.expectedDimensions * 4) {
    throw new StorageError("VALIDATION_FAILED", "Invalid bounded embedding vector capacity");
  }
  if (objectIds.length > 512) throw new StorageError("VALIDATION_FAILED", "Bounded embedding identity input exceeds capacity");
  const unique = [...new Set(objectIds.map(parseObjectId))].sort();
  if (unique.some((id) => Buffer.byteLength(id, "utf8") > options.maxMetadataUtf8Bytes)) {
    throw new StorageError("VALIDATION_FAILED", "Bounded embedding identity exceeds byte capacity");
  }
  const selected = unique.slice(0, Math.min(options.maxRows, options.maxObjectIds));
  if (!selected.length) return Object.freeze({ records: Object.freeze([]), rowVisits: 0, metadataUtf8Bytes: 0,
    vectorBytes: 0, filteredRows: 0, truncated: unique.length > 0 });
  const eligibleSql = `e.vector_valid = 1 AND e.provider_kind = $provider AND e.model_id = $model AND e.schema_version = $schema
    AND e.dimensions = $dimensions AND typeof(e.embedding_blob) = 'blob' AND length(e.embedding_blob) = $vectorBytes
    AND (${META_BYTES}) <= $metadataBytes`;
  const projected = PAYLOAD_COLUMNS.map((column) => `CASE WHEN ${eligibleSql} THEN e.${column} ELSE NULL END AS ${column}`).join(", ");
  // Lazy CASE masks payload at the single indexed owner read, without a second table hydration.
  const rows = db.connection.prepare(`SELECT CASE WHEN ${eligibleSql} THEN 1 ELSE 0 END AS eligible, ${projected},
    CASE WHEN ${eligibleSql} THEN (${META_BYTES}) ELSE 0 END AS metadata_bytes,
    CASE WHEN ${eligibleSql} THEN length(e.embedding_blob) ELSE 0 END AS vector_bytes
    FROM json_each($ids) ids CROSS JOIN memory_embeddings e ON e.object_id = ids.value
    WHERE e.workspace_id = $workspace ORDER BY e.object_id`).all({ provider: options.providerKind, model: options.modelId,
    schema: options.schemaVersion, dimensions: options.expectedDimensions, vectorBytes: options.maxVectorBytes,
    metadataBytes: options.maxMetadataUtf8Bytes, ids: JSON.stringify(selected), workspace: workspaceId }) as
    { eligible: number; metadata_bytes: number; vector_bytes: number }[];
  const eligible = rows.filter((row) => row.eligible === 1);
  const records = parseRows(eligible, MemoryEmbeddingRowParser, "bounded memory embedding row").map(parseMemoryEmbeddingRow);
  const filteredRows = rows.length - records.length;
  return Object.freeze({ records: Object.freeze(records), rowVisits: rows.length, filteredRows,
    vectorBytes: rows.reduce((sum, row) => sum + row.vector_bytes, 0),
    metadataUtf8Bytes: rows.reduce((sum, row) => sum + row.metadata_bytes, 0),
    truncated: filteredRows > 0 || unique.length > selected.length });
}
