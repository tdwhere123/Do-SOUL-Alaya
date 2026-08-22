import { OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import {
  decodeValidEmbeddingBlob,
  encodeEmbeddingBlob,
  isFiniteNonzeroEmbedding
} from "../../memory/embedding-vector-validity.js";

export interface EvidenceRecallEmbeddingRef {
  readonly ownerObjectId: string;
  readonly documentIdentity: string;
  readonly contentHash: string;
}

export interface EvidenceRecallEmbeddingRecord extends EvidenceRecallEmbeddingRef {
  readonly workspaceId: string;
  readonly documentRole: "evidence_document";
  readonly providerKind: string;
  readonly modelId: string;
  readonly schemaVersion: number;
  readonly dimensions: number;
  readonly embedding: Float32Array;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvidenceRecallEmbeddingSource {
  readonly workspaceId: string;
  readonly ownerObjectId: string;
  readonly documentIdentity: string;
  readonly content: string;
  readonly lifecycleState: string;
  readonly createdBy: string;
  readonly evidenceKind: string;
  readonly evidenceHealthState: string;
  readonly artifactRef: string | null;
  readonly sourceHash: string | null;
}

interface SourceRow {
  readonly workspace_id: string;
  readonly owner_object_id: string;
  readonly document_identity: string;
  readonly content: string;
  readonly lifecycle_state: string;
  readonly created_by: string;
  readonly evidence_kind: string;
  readonly evidence_health_state: string;
  readonly physical_anchor: string | null;
  readonly source_hash: string | null;
}

interface EmbeddingRow {
  readonly workspace_id: string;
  readonly owner_object_id: string;
  readonly document_identity: string;
  readonly content_hash: string;
  readonly document_role: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding_blob: Buffer;
  readonly created_at: string;
  readonly updated_at: string;
}

export class SqliteEvidenceRecallEmbeddingRepo {
  private readonly listOwnerSources;
  private readonly listProjectionSources;
  private readonly findByDocumentsStatement;
  private readonly upsert;

  public constructor(private readonly db: StorageDatabase) {
    this.listOwnerSources = db.connection.prepare(LIST_OWNER_SOURCES_SQL);
    this.listProjectionSources = db.connection.prepare(LIST_PROJECTION_SOURCES_SQL);
    this.findByDocumentsStatement = db.connection.prepare(FIND_BY_DOCUMENTS_SQL);
    this.upsert = db.connection.prepare(UPSERT_SQL);
  }

  public async listSourcesByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<EvidenceRecallEmbeddingSource>[]> {
    try {
      const rows = [
        ...(this.listOwnerSources.all(workspaceId) as SourceRow[]),
        ...(this.listProjectionSources.all(workspaceId) as SourceRow[])
      ];
      return Object.freeze(rows.map(parseSource).sort(compareSources));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list evidence embedding sources for workspace ${workspaceId}.`,
        error
      );
    }
  }

  public async findByDocuments(input: {
    readonly workspaceId: string;
    readonly documents: readonly Readonly<EvidenceRecallEmbeddingRef>[];
    readonly documentRole: "evidence_document";
    readonly providerKind: string;
    readonly modelId: string;
    readonly schemaVersion: number;
  }): Promise<readonly Readonly<EvidenceRecallEmbeddingRecord>[]> {
    if (input.documents.length === 0) return Object.freeze([]);
    try {
      const rows = this.findByDocumentsStatement.all(
        JSON.stringify(input.documents.map((document) => ({
          ownerObjectId: document.ownerObjectId,
          documentIdentity: document.documentIdentity,
          contentHash: document.contentHash
        }))),
        input.workspaceId,
        input.documentRole,
        input.providerKind,
        input.modelId,
        input.schemaVersion
      ) as EmbeddingRow[];
      return Object.freeze(rows.map(parseEmbeddingRow));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load evidence embeddings for workspace ${input.workspaceId}.`,
        error
      );
    }
  }

  public async upsertMany(
    records: readonly Readonly<EvidenceRecallEmbeddingRecord>[]
  ): Promise<void> {
    if (records.length === 0) return;
    const parsed = records.map(parseEmbeddingRecord);
    try {
      this.db.connection.transaction(() => {
        for (const record of parsed) {
          this.upsert.run(...upsertArgs(record));
        }
      })();
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to persist evidence embeddings.", error);
    }
  }
}

function parseSource(row: SourceRow): EvidenceRecallEmbeddingSource {
  return Object.freeze({
    workspaceId: nonEmpty(row.workspace_id, "workspace_id"),
    ownerObjectId: nonEmpty(row.owner_object_id, "owner_object_id"),
    documentIdentity: nonEmpty(row.document_identity, "document_identity"),
    content: nonEmpty(row.content, "content"),
    lifecycleState: nonEmpty(row.lifecycle_state, "lifecycle_state"),
    createdBy: nonEmpty(row.created_by, "created_by"),
    evidenceKind: nonEmpty(row.evidence_kind, "evidence_kind"),
    evidenceHealthState: nonEmpty(row.evidence_health_state, "evidence_health_state"),
    artifactRef: parseArtifactRef(row.physical_anchor),
    sourceHash: nullableNonEmpty(row.source_hash)
  });
}

function parseEmbeddingRecord(
  record: Readonly<EvidenceRecallEmbeddingRecord>
): Readonly<EvidenceRecallEmbeddingRecord> {
  const dimensions = positiveInteger(record.dimensions, "dimensions");
  if (!isFiniteNonzeroEmbedding(record.embedding) || record.embedding.length !== dimensions) {
    throw new StorageError("VALIDATION_FAILED", "evidence embedding vector is invalid.");
  }
  return Object.freeze({
    ...record,
    workspaceId: nonEmpty(record.workspaceId, "workspaceId"),
    ownerObjectId: nonEmpty(record.ownerObjectId, "ownerObjectId"),
    documentIdentity: nonEmpty(record.documentIdentity, "documentIdentity"),
    contentHash: nonEmpty(record.contentHash, "contentHash"),
    providerKind: nonEmpty(record.providerKind, "providerKind"),
    modelId: nonEmpty(record.modelId, "modelId"),
    schemaVersion: positiveInteger(record.schemaVersion, "schemaVersion"),
    dimensions,
    embedding: new Float32Array(record.embedding),
    createdAt: nonEmpty(record.createdAt, "createdAt"),
    updatedAt: nonEmpty(record.updatedAt, "updatedAt")
  });
}

function parseEmbeddingRow(row: EmbeddingRow): EvidenceRecallEmbeddingRecord {
  const dimensions = positiveInteger(row.dimensions, "dimensions");
  const embedding = decodeValidEmbeddingBlob(row.embedding_blob, dimensions);
  if (embedding === null) {
    throw new StorageError("VALIDATION_FAILED", "persisted evidence embedding vector is invalid.");
  }
  return Object.freeze({
    workspaceId: nonEmpty(row.workspace_id, "workspace_id"),
    ownerObjectId: nonEmpty(row.owner_object_id, "owner_object_id"),
    documentIdentity: nonEmpty(row.document_identity, "document_identity"),
    contentHash: nonEmpty(row.content_hash, "content_hash"),
    documentRole: parseDocumentRole(row.document_role),
    providerKind: nonEmpty(row.provider_kind, "provider_kind"),
    modelId: nonEmpty(row.model_id, "model_id"),
    schemaVersion: positiveInteger(row.schema_version, "schema_version"),
    dimensions,
    embedding,
    createdAt: nonEmpty(row.created_at, "created_at"),
    updatedAt: nonEmpty(row.updated_at, "updated_at")
  });
}

function upsertArgs(record: Readonly<EvidenceRecallEmbeddingRecord>) {
  return [
    record.workspaceId,
    record.ownerObjectId,
    record.documentIdentity,
    record.contentHash,
    record.documentRole,
    record.providerKind,
    record.modelId,
    record.schemaVersion,
    record.dimensions,
    encodeEmbeddingBlob(record.embedding),
    record.createdAt,
    record.updatedAt
  ] as const;
}

function parseArtifactRef(physicalAnchor: string | null): string | null {
  if (physicalAnchor === null) return null;
  try {
    const parsed = JSON.parse(physicalAnchor) as { readonly artifact_ref?: unknown };
    return nullableNonEmpty(parsed.artifact_ref);
  } catch {
    return null;
  }
}

function parseDocumentRole(value: string): "evidence_document" {
  if (value !== "evidence_document") {
    throw new StorageError("VALIDATION_FAILED", "document_role is invalid.");
  }
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StorageError("VALIDATION_FAILED", `${field} must be non-empty.`);
  }
  return value;
}

function nullableNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", `${field} must be a positive integer.`);
  }
  return value;
}

function compareSources(
  left: EvidenceRecallEmbeddingSource,
  right: EvidenceRecallEmbeddingSource
): number {
  return left.ownerObjectId.localeCompare(right.ownerObjectId) ||
    left.documentIdentity.localeCompare(right.documentIdentity);
}

const SOURCE_COLUMNS = `
  e.workspace_id,
  e.object_id AS owner_object_id,
  e.lifecycle_state,
  e.created_by,
  e.evidence_kind,
  e.evidence_health_state,
  e.physical_anchor,
  e.source_hash
`;

const LIST_OWNER_SOURCES_SQL = `
  WITH target(workspace_id) AS (VALUES (?))
  SELECT${SOURCE_COLUMNS},
    'owner' AS document_identity,
    COALESCE(e.excerpt, e.gist) AS content
  FROM evidence_capsules e, target t
  WHERE e.workspace_id = t.workspace_id
    AND e.lifecycle_state = 'active'
    AND e.created_by = 'garden_compile'
    AND e.evidence_kind = 'conversation_excerpt'
    AND e.evidence_health_state = 'verified'
  UNION ALL
  SELECT${SOURCE_COLUMNS},
    '${OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY}' AS document_identity,
    e.gist AS content
  FROM evidence_capsules e, target t
  WHERE e.workspace_id = t.workspace_id
    AND e.lifecycle_state = 'active'
    AND e.created_by = 'garden_compile'
    AND e.evidence_kind = 'conversation_excerpt'
    AND e.evidence_health_state = 'verified'
`;

const LIST_PROJECTION_SOURCES_SQL = `
  SELECT${SOURCE_COLUMNS},
    p.projection_kind || ':' || p.projection_id AS document_identity,
    p.content AS content
  FROM evidence_search_projections p
  INNER JOIN evidence_capsules e
    ON e.object_id = p.evidence_object_id
   AND e.workspace_id = p.workspace_id
   AND e.source_hash = p.source_hash
  WHERE p.workspace_id = ?
    AND p.projection_kind IN ('assistant_observation', 'fact_key')
    AND e.lifecycle_state = 'active'
    AND e.created_by = 'garden_compile'
    AND e.evidence_kind = 'conversation_excerpt'
    AND e.evidence_health_state = 'verified'
`;

const FIND_BY_DOCUMENTS_SQL = `
  WITH requested AS (
    SELECT
      json_extract(value, '$.ownerObjectId') AS owner_object_id,
      json_extract(value, '$.documentIdentity') AS document_identity,
      json_extract(value, '$.contentHash') AS content_hash
    FROM json_each(?)
  )
  SELECT e.*
  FROM evidence_recall_embeddings e
  INNER JOIN requested r
    ON r.owner_object_id = e.owner_object_id
   AND r.document_identity = e.document_identity
   AND r.content_hash = e.content_hash
  WHERE e.workspace_id = ?
    AND e.document_role = ?
    AND e.provider_kind = ?
    AND e.model_id = ?
    AND e.schema_version = ?
    AND e.vector_valid = 1
  ORDER BY e.owner_object_id, e.document_identity, e.content_hash
`;

const UPSERT_SQL = `
  INSERT INTO main.evidence_recall_embeddings (
    workspace_id,
    owner_object_id,
    document_identity,
    content_hash,
    document_role,
    provider_kind,
    model_id,
    schema_version,
    dimensions,
    embedding_blob,
    vector_valid,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT (
    workspace_id,
    owner_object_id,
    document_identity,
    document_role
  ) DO UPDATE SET
    content_hash = excluded.content_hash,
    provider_kind = excluded.provider_kind,
    model_id = excluded.model_id,
    schema_version = excluded.schema_version,
    dimensions = excluded.dimensions,
    embedding_blob = excluded.embedding_blob,
    vector_valid = 1,
    updated_at = excluded.updated_at
`;
