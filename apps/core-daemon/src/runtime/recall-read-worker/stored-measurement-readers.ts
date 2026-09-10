import type { ObserverReaders, StoredEmbeddingVector } from "@do-soul/alaya-core";
import { readBoundedEmbeddingIds, readBoundedEmbeddings, readUniqueEmbeddingProfile, type StorageDatabase } from "@do-soul/alaya-storage";
import type { StoredCosineObligation } from "@do-soul/alaya-protocol";

export function storedMeasurementReaders(database: StorageDatabase): Pick<ObserverReaders, "embeddingIds" | "measureStoredPair"> {
  return {
    embeddingIds: (input) => {
      const lookupBytes = input.profile === undefined ? 2048 : 0;
      const maxRows = Math.min(512, Math.max(0, input.maxRows), Math.max(0, Math.floor(((input.byteLimit ?? 133120) - lookupBytes) / 256)));
      if (maxRows === 0) return { objectIds: [], rowVisits: 0, metadataUtf8Bytes: 0, truncated: true,
        committedThrough: input.afterObjectId };
      const lookup = input.profile === undefined ? readUniqueEmbeddingProfile(database, input.workspaceId, input.modelId)
        : { status: "unique" as const, rowVisits: 0, metadataUtf8Bytes: 0, profile: { providerKind: input.profile.provider_kind,
          modelId: input.profile.model_id, schemaVersion: input.profile.schema_version } };
      if (lookup.status !== "unique") return { objectIds: [], rowVisits: lookup.rowVisits, metadataUtf8Bytes: lookup.metadataUtf8Bytes,
        truncated: false, committedThrough: input.afterObjectId, domainStatus: lookup.status };
      const page = readBoundedEmbeddingIds(database, input.workspaceId, { ...lookup.profile, maxRows,
        maxMetadataUtf8Bytes: 256 }, input.afterObjectId);
      return { ...page, rowVisits: lookup.rowVisits + page.rowVisits, metadataUtf8Bytes: lookup.metadataUtf8Bytes + page.metadataUtf8Bytes };
    },
    measureStoredPair: (input) => {
      let profile: Pick<StoredCosineObligation, "provider_kind" | "model_id" | "schema_version" | "dimensions"> | undefined = input.profile;
      const absent = { object: null, query: null, objectStatus: "unavailable" as const, queryStatus: "unavailable" as const,
        rowVisits: 0, bytesRead: 0 };
      let metadataBytes = 0;
      let metadataWork = 0;
      if (profile === undefined) {
        if ((input.byteLimit ?? 65536) < 2048 || (input.workLimit ?? 16388) < 1) return { ...absent, resourceLimited: true };
        const metadata = database.connection.prepare(`SELECT
          CASE WHEN octet_length(provider_kind) + octet_length(model_id) <= 2048 THEN provider_kind ELSE NULL END AS provider_kind,
          CASE WHEN octet_length(provider_kind) + octet_length(model_id) <= 2048 THEN model_id ELSE NULL END AS model_id,
          schema_version, dimensions FROM memory_embeddings WHERE workspace_id = ? AND object_id = ? LIMIT 1`)
          .get(input.workspaceId, input.objectId) as { provider_kind: string | null; model_id: string | null; schema_version: number; dimensions: number } | undefined;
        if (metadata === undefined) return { ...absent, objectStatus: "missing", rowVisits: 1 };
        if (metadata.provider_kind === null || metadata.model_id === null || !Number.isSafeInteger(metadata.dimensions)
          || metadata.dimensions < 1 || metadata.dimensions > 16384) return { ...absent, rowVisits: 1 };
        metadataBytes = Buffer.byteLength(metadata.provider_kind, "utf8") + Buffer.byteLength(metadata.model_id, "utf8");
        metadataWork = 1;
        profile = { ...metadata, provider_kind: metadata.provider_kind, model_id: metadata.model_id };
      }
      const reservedBytes = 2 * (profile.dimensions * 4 + 2048) + 256;
      if (reservedBytes + metadataBytes > (input.byteLimit ?? 65536) || profile.dimensions + metadataWork + 3 > (input.workLimit ?? 16388)) {
        return { ...absent, resourceLimited: true, rowVisits: metadataWork, bytesRead: metadataBytes };
      }
      const options = { providerKind: profile.provider_kind, modelId: profile.model_id, schemaVersion: profile.schema_version,
        expectedDimensions: profile.dimensions, maxVectorBytes: profile.dimensions * 4, maxMetadataUtf8Bytes: 2048,
        maxRows: 1, maxObjectIds: 1 };
      const objectRead = readBoundedEmbeddings(database, input.workspaceId, [input.objectId], options);
      const object = objectRead.records[0];
      const objectBytes = metadataBytes + objectRead.vectorBytes + objectRead.metadataUtf8Bytes;
      if (object === undefined) return { ...absent, objectStatus: objectRead.filteredRows > 0 ? "unavailable" : "missing",
        rowVisits: metadataWork + 1, bytesRead: objectBytes };
      const queryId = database.connection.prepare(`SELECT CASE WHEN octet_length(object_id) <= 256 THEN object_id ELSE NULL END AS object_id
        FROM memory_embeddings WHERE workspace_id = ? AND content_hash = ? AND provider_kind = ? AND model_id = ?
          AND schema_version = ? AND dimensions = ? AND vector_valid = 1 ORDER BY object_id LIMIT 1`).get(input.workspaceId,
        input.queryDigest, profile.provider_kind, profile.model_id, profile.schema_version, profile.dimensions) as { object_id: string | null } | undefined;
      if (queryId?.object_id == null) return { ...absent, object: vector(object), objectStatus: "ready", queryStatus: "missing",
        rowVisits: metadataWork + 2, bytesRead: objectBytes };
      const queryRead = readBoundedEmbeddings(database, input.workspaceId, [queryId.object_id], options);
      const query = queryRead.records[0];
      return { object: vector(object), query: query === undefined ? null : vector(query), objectStatus: "ready",
        queryStatus: query === undefined ? "unavailable" : "ready", rowVisits: metadataWork + 3,
        bytesRead: objectBytes + Buffer.byteLength(queryId.object_id, "utf8") + queryRead.vectorBytes + queryRead.metadataUtf8Bytes };
    }
  };
}

function vector(record: { object_id: string; provider_kind: string; model_id: string; schema_version: number;
  dimensions: number; content_hash: string; embedding: Float32Array }): StoredEmbeddingVector {
  return { object_id: record.object_id, provider_kind: record.provider_kind, model_id: record.model_id,
    schema_version: record.schema_version, dimensions: record.dimensions, content_hash: record.content_hash, embedding: record.embedding };
}
