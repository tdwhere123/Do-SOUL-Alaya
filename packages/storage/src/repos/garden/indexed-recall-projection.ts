import type {
  IndexedRecallCursor,
  IndexedRecallFreshness
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import type { SqliteConnection } from "../../sqlite/db.js";
import { BOUNDED_EMBEDDING_INDEX_SQL } from "../memory/reads/memory-embedding-bounded-read.js";
import { RELATION_RECALL_INDEX_SQL } from "../path/reads/relation-assertion/bounded-reader.js";
import { initializeSemanticArtifactCandidateSchema } from "./semantic-artifact-schema.js";

interface IndexRevisionRow {
  readonly object_id: string;
  readonly source_event_revision: number;
  readonly semantic_publication_key: string | null;
  readonly embedding_content_hash: string | null;
  readonly tombstoned: number;
}

export class SqliteIndexedRecallProjection {
  public constructor(private readonly db: SqliteConnection) {}

  public cursor(workspaceId: string): IndexedRecallCursor | null {
    const row = this.db.prepare(`SELECT workspace_id AS workspaceId, applied_event_revision AS appliedEventRevision,
      applied_at AS appliedAt FROM garden_projection_cursor WHERE workspace_id=?`)
      .get(workspaceId) as IndexedRecallCursor | undefined;
    return row ?? null;
  }

  public observablePin(workspaceId: string): Readonly<{
    readonly source_revision: string;
    readonly applied_at?: string;
  }> {
    const row = this.db.prepare(`SELECT observable_epoch, CAST(observable_generation AS TEXT) AS generation,
      applied_at FROM garden_projection_cursor WHERE workspace_id = ?`).get(workspaceId) as
      { readonly observable_epoch: string; readonly generation: string; readonly applied_at: string } | undefined;
    return {
      source_revision: row === undefined ? "uninitialized" : `${row.observable_epoch}:${row.generation}`,
      ...(row === undefined ? {} : { applied_at: row.applied_at })
    };
  }

  public freshness(workspaceId: string, objectId: string): IndexedRecallFreshness {
    const row = this.db.prepare(`SELECT object_id, source_event_revision, semantic_publication_key,
      embedding_content_hash, tombstoned FROM garden_index_revisions
      WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId) as IndexRevisionRow | undefined;
    if (row === undefined) {
      return Object.freeze({
        objectId, sourceEventRevision: null,
        lexical: "missing", semantic: "unavailable", embedding: "unavailable"
      });
    }
    if (row.tombstoned === 1) {
      return Object.freeze({
        objectId, sourceEventRevision: row.source_event_revision,
        lexical: "tombstoned", semantic: "tombstoned", embedding: "tombstoned"
      });
    }
    return Object.freeze({
      objectId,
      sourceEventRevision: row.source_event_revision,
      lexical: "ready",
      semantic: row.semantic_publication_key === null ? "pending" : "ready",
      embedding: row.embedding_content_hash === null ? "pending" : "ready"
    });
  }

  public revision(workspaceId: string, objectId: string): IndexRevisionRow | null {
    const row = this.db.prepare(`SELECT object_id, source_event_revision, semantic_publication_key,
      embedding_content_hash, tombstoned FROM garden_index_revisions
      WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId) as IndexRevisionRow | undefined;
    return row ?? null;
  }
}

export function prepareIndexedRecallProjection(database: StorageDatabase): void {
  initializeSemanticArtifactCandidateSchema(database.connection);
  database.connection.exec(RELATION_RECALL_INDEX_SQL);
  database.connection.exec(BOUNDED_EMBEDDING_INDEX_SQL);
}
