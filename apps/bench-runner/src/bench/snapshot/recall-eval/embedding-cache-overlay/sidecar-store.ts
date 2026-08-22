import BetterSqlite3 from "better-sqlite3";
import {
  EmbeddingBackfillHandler,
  EvidenceDocumentEmbeddingBackfillHandler,
  type EmbeddingBackfillRepoPort,
  type EmbeddingProviderPort,
  type EvidenceDocumentEmbeddingRecord,
  type EvidenceDocumentEmbeddingRepoPort
} from "@do-soul/alaya-core";
import {
  SqliteEvidenceRecallEmbeddingRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { EmbeddingCacheOverlaySourceBinding } from "./contract.js";
import { createOverlaySchema } from "./overlay-schema.js";

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export async function populateOverlayFromSnapshot(input: {
  readonly snapshot: StorageDatabase;
  readonly overlayPath: string;
  readonly provider: EmbeddingProviderPort;
  readonly source: EmbeddingCacheOverlaySourceBinding;
  readonly now?: () => string;
}): Promise<{ readonly memory: number; readonly evidence: number }> {
  const overlay = new BetterSqlite3(input.overlayPath);
  try {
    createOverlaySchema(overlay);
    const memoryStore = new OverlayMemoryStore(overlay);
    const evidenceStore = new OverlayEvidenceStore(overlay);
    const memoryHandler = new EmbeddingBackfillHandler({
      memoryRepo: new SqliteMemoryEntryRepo(input.snapshot),
      memoryEmbeddingRepo: memoryStore,
      provider: input.provider,
      expectedDimensions: () => input.source.vector_space.dimensions,
      ...(input.now === undefined ? {} : { now: input.now })
    });
    const evidenceHandler = new EvidenceDocumentEmbeddingBackfillHandler({
      evidenceDocumentEmbeddingRepo: composeEvidenceRepo(
        new SqliteEvidenceRecallEmbeddingRepo(input.snapshot),
        evidenceStore
      ),
      provider: input.provider,
      ...(input.now === undefined ? {} : { now: input.now })
    });
    for (const workspaceId of listWorkspaceIds(input.snapshot)) {
      await memoryHandler.handle({ workspace_id: workspaceId });
      await evidenceHandler.handle({ workspace_id: workspaceId });
    }
    overlay.exec("VACUUM");
    return countOverlayRows(overlay);
  } finally {
    overlay.close();
  }
}

function composeEvidenceRepo(
  snapshot: SqliteEvidenceRecallEmbeddingRepo,
  overlay: OverlayEvidenceStore
): EvidenceDocumentEmbeddingRepoPort {
  return {
    listSourcesByWorkspace: (workspaceId) => snapshot.listSourcesByWorkspace(workspaceId),
    findByDocuments: (query) => overlay.findByDocuments(query),
    upsertMany: (records) => overlay.upsertMany(records)
  };
}

function listWorkspaceIds(snapshot: StorageDatabase): readonly string[] {
  return Object.freeze(
    snapshot.connection.prepare(`
      SELECT workspace_id FROM memory_entries
      UNION
      SELECT workspace_id FROM evidence_capsules
      ORDER BY 1
    `).pluck().all() as string[]
  );
}

function countOverlayRows(
  overlay: SqliteDatabase
): { readonly memory: number; readonly evidence: number } {
  const count = (table: string): number =>
    overlay.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  return Object.freeze({
    memory: count("memory_embeddings"),
    evidence: count("evidence_recall_embeddings")
  });
}

class OverlayMemoryStore implements EmbeddingBackfillRepoPort {
  private readonly findMetadata;
  private readonly insert;

  public constructor(database: SqliteDatabase) {
    this.findMetadata = database.prepare(`
      SELECT object_id, workspace_id, content_hash, provider_kind, model_id,
             schema_version, dimensions, vector_valid, created_at, updated_at
      FROM memory_embeddings WHERE object_id IN (SELECT value FROM json_each(?))
    `);
    this.insert = database.prepare(`
      INSERT INTO memory_embeddings (
        object_id, workspace_id, content_hash, provider_kind, model_id,
        schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        content_hash = excluded.content_hash,
        provider_kind = excluded.provider_kind,
        model_id = excluded.model_id,
        schema_version = excluded.schema_version,
        dimensions = excluded.dimensions,
        embedding_blob = excluded.embedding_blob,
        vector_valid = 1,
        updated_at = excluded.updated_at
    `);
  }

  public async findMetadataByObjectIds(objectIds: readonly string[]) {
    if (objectIds.length === 0) return Object.freeze([]);
    const rows = this.findMetadata.all(JSON.stringify(objectIds)) as ReadonlyArray<{
      readonly object_id: string;
      readonly workspace_id: string;
      readonly content_hash: string;
      readonly provider_kind: string;
      readonly model_id: string;
      readonly schema_version: number;
      readonly dimensions: number;
      readonly vector_valid: number;
      readonly created_at: string;
      readonly updated_at: string;
    }>;
    return Object.freeze(rows.map((row) => Object.freeze({
      object_id: row.object_id,
      workspace_id: row.workspace_id,
      content_hash: row.content_hash,
      provider_kind: row.provider_kind,
      model_id: row.model_id,
      schema_version: row.schema_version,
      dimensions: row.dimensions,
      vector_valid: row.vector_valid === 1,
      created_at: row.created_at,
      updated_at: row.updated_at
    })));
  }

  public async upsert(record: Parameters<EmbeddingBackfillRepoPort["upsert"]>[0]) {
    this.insert.run(
      record.object_id, record.workspace_id, record.content_hash,
      record.provider_kind, record.model_id, record.schema_version,
      record.dimensions, encodeVector(record.embedding),
      record.created_at, record.updated_at
    );
    return record;
  }
}

class OverlayEvidenceStore {
  private readonly find;
  private readonly insert;

  public constructor(database: SqliteDatabase) {
    this.find = database.prepare(`
      WITH requested AS (
        SELECT json_extract(value, '$.ownerObjectId') AS owner_object_id,
               json_extract(value, '$.documentIdentity') AS document_identity,
               json_extract(value, '$.contentHash') AS content_hash
        FROM json_each(?)
      )
      SELECT e.* FROM evidence_recall_embeddings e
      INNER JOIN requested r
        ON r.owner_object_id = e.owner_object_id
       AND r.document_identity = e.document_identity
       AND r.content_hash = e.content_hash
      WHERE e.workspace_id = ? AND e.document_role = ?
        AND e.provider_kind = ? AND e.model_id = ? AND e.schema_version = ?
        AND e.vector_valid = 1
    `);
    this.insert = database.prepare(`
      INSERT INTO evidence_recall_embeddings (
        workspace_id, owner_object_id, document_identity, content_hash,
        document_role, provider_kind, model_id, schema_version, dimensions,
        embedding_blob, vector_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (workspace_id, owner_object_id, document_identity, document_role)
      DO UPDATE SET
        content_hash = excluded.content_hash,
        provider_kind = excluded.provider_kind,
        model_id = excluded.model_id,
        schema_version = excluded.schema_version,
        dimensions = excluded.dimensions,
        embedding_blob = excluded.embedding_blob,
        vector_valid = 1,
        updated_at = excluded.updated_at
    `);
  }

  public async findByDocuments(
    input: Parameters<EvidenceDocumentEmbeddingRepoPort["findByDocuments"]>[0]
  ): Promise<readonly Readonly<EvidenceDocumentEmbeddingRecord>[]> {
    if (input.documents.length === 0) return Object.freeze([]);
    const rows = this.find.all(
      JSON.stringify(input.documents),
      input.workspaceId, input.documentRole,
      input.providerKind, input.modelId, input.schemaVersion
    ) as ReadonlyArray<EvidenceOverlayRow>;
    return Object.freeze(rows.map(parseEvidenceRow));
  }

  public async upsertMany(
    records: readonly Readonly<EvidenceDocumentEmbeddingRecord>[]
  ): Promise<void> {
    for (const record of records) {
      this.insert.run(
        record.workspaceId, record.ownerObjectId, record.documentIdentity,
        record.contentHash, record.documentRole, record.providerKind,
        record.modelId, record.schemaVersion, record.dimensions,
        encodeVector(record.embedding), record.createdAt, record.updatedAt
      );
    }
  }
}

interface EvidenceOverlayRow {
  readonly workspace_id: string;
  readonly owner_object_id: string;
  readonly document_identity: string;
  readonly content_hash: string;
  readonly document_role: "evidence_document";
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding_blob: Buffer;
  readonly created_at: string;
  readonly updated_at: string;
}

function parseEvidenceRow(row: EvidenceOverlayRow): Readonly<EvidenceDocumentEmbeddingRecord> {
  return Object.freeze({
    workspaceId: row.workspace_id,
    ownerObjectId: row.owner_object_id,
    documentIdentity: row.document_identity,
    contentHash: row.content_hash,
    documentRole: row.document_role,
    providerKind: row.provider_kind,
    modelId: row.model_id,
    schemaVersion: row.schema_version,
    dimensions: row.dimensions,
    embedding: decodeVector(row.embedding_blob, row.dimensions),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function encodeVector(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => bytes.writeFloatLE(
    value, index * Float32Array.BYTES_PER_ELEMENT
  ));
  return bytes;
}

function decodeVector(blob: Buffer, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = blob.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  return vector;
}
