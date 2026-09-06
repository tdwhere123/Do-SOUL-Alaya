import type { RelationValidity } from "@do-soul/alaya-protocol";
import type { EmbeddingVectorRecord } from "../../embedding-recall/types.js";

export interface ReadyArtifactReader {
  searchReadyObserved(workspaceId: string, query: string, limit: number): {
    readonly rows: readonly { objectId: string; sourceRevision: string; projectionText: string }[];
    readonly rowsRead: number;
    readonly bytesRead: number;
    readonly nativeVisits: number;
    readonly nativeBytes: number;
    readonly truncated: boolean;
  };
}

export interface RetrievalCounters {
  row_visits: number;
  raw_bytes: number;
  source_reads: number;
  source_revision_rows: number;
  assertion_rows: number;
  query_embed_count: number;
  native_lexical_visits: number;
  native_lexical_bytes: number;
  native_assertion_visits: number;
  native_assertion_bytes: number;
  native_artifact_visits: number;
  native_artifact_bytes: number;
  artifact_validation_utf8_bytes: number;
  embedding_id_json_bytes: number;
  embedding_id_metadata_utf8_bytes: number;
  embedding_vector_payload_bytes: number;
}

export interface IndexedSourceRow {
  readonly workspace_id: string;
  readonly lifecycle_state: string;
  readonly retention_state: string | null;
  readonly evidence_refs: readonly string[];
  readonly content: string;
  readonly dimension: string;
  readonly sourceRevision: string;
}

export interface IndexedMemoryReadPort {
  source(workspaceId: string, objectId: string, byteLimit?: number): {
    readonly row: IndexedSourceRow | null;
    readonly rowsRead: number;
    readonly sourceRowsRead: number;
    readonly revisionRowsRead: number;
    readonly bytesRead: number;
    readonly unavailable: boolean;
  };
  lexical(workspaceId: string, query: string, limit: number, nativeLimit?: number): {
    readonly ids: readonly string[];
    readonly rowsRead: number;
    readonly bytesRead: number;
    readonly nativeVisits: number;
    readonly nativeBytes: number;
    readonly truncated: boolean;
  };
}

export interface RecallAssertionObservation {
  readonly assertionId: string;
  readonly workspaceId: string;
  readonly predicate: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly resultObjectId: string;
  readonly validity: RelationValidity;
  readonly evidenceRefs: readonly string[];
  readonly resolvedAt: string | null;
  readonly resolutionKind: string | null;
}

export interface IndexedRelationReadPort {
  read(workspaceId: string, subject: string | null, predicate: string, limit: number, nativeLimit?: number): {
    readonly nativeVisits: number;
    readonly nativeBytes: number;
    readonly observations: readonly RecallAssertionObservation[];
    readonly rowsRead: number;
    readonly bytesRead: number;
    readonly truncated: boolean;
  };
}

export interface IndexedEmbeddingReadPort {
  listBoundedIdsByWorkspace(workspaceId: string, profile: {
    readonly maxRows: number;
    readonly maxMetadataUtf8Bytes: number;
    readonly providerKind: string;
    readonly modelId: string;
    readonly schemaVersion: number;
  }): Promise<{
    readonly objectIds: readonly string[];
    readonly rowVisits: number;
    readonly metadataUtf8Bytes: number;
    readonly truncated: boolean;
  }>;
  listBoundedByObjectIds(workspaceId: string, objectIds: readonly string[], options: {
    readonly maxRows: number;
    readonly maxMetadataUtf8Bytes: number;
    readonly providerKind: string;
    readonly modelId: string;
    readonly schemaVersion: number;
    readonly maxObjectIds: number;
    readonly expectedDimensions: number;
    readonly maxVectorBytes: number;
  }): Promise<{
    readonly records: readonly EmbeddingVectorRecord[];
    readonly rowVisits: number;
    readonly vectorBytes: number;
    readonly metadataUtf8Bytes: number;
    readonly truncated: boolean;
  }>;
}
