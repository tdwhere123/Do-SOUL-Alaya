import type { ObserverReaders, StoredEmbeddingVector, StoredPairMeasurement } from "@do-soul/alaya-core";
import { readBoundedEmbeddingIds, readBoundedEmbeddings, readUniqueEmbeddingProfile, type StorageDatabase } from "@do-soul/alaya-storage";
import type { StoredCosineObligation } from "@do-soul/alaya-protocol";

type PairProfile = Pick<StoredCosineObligation, "provider_kind" | "model_id" | "schema_version" | "dimensions">;

type MeasureStoredPairsInput = Readonly<{
  readonly workspaceId: string;
  readonly objectIds: readonly string[];
  readonly queryDigest: string;
  readonly profile?: StoredCosineObligation;
  readonly byteLimit?: number;
  readonly workLimit?: number;
}>;

type StoredPairsMeasurement = Readonly<{
  readonly byObjectId: Readonly<Record<string, StoredPairMeasurement>>;
  readonly rowVisits: number;
  readonly bytesRead: number;
  readonly resourceLimited?: boolean;
}>;

interface CachedStatement {
  get(...params: unknown[]): unknown;
}

interface CachedMeasurementStatements {
  readonly connectionVersion: number;
  readonly metadata: CachedStatement;
  readonly queryId: CachedStatement;
}

const statementsByDatabase = new WeakMap<StorageDatabase, CachedMeasurementStatements>();

const absentPair = Object.freeze({
  object: null,
  query: null,
  objectStatus: "unavailable" as const,
  queryStatus: "unavailable" as const,
  rowVisits: 0,
  bytesRead: 0
});

export function storedMeasurementReaders(database: StorageDatabase): Pick<ObserverReaders, "embeddingIds" | "measureStoredPair"> & {
  readonly measureStoredPairs: (input: MeasureStoredPairsInput) => StoredPairsMeasurement;
} {
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
      const batch = measureStoredPairs(database, {
        workspaceId: input.workspaceId,
        objectIds: [input.objectId],
        queryDigest: input.queryDigest,
        profile: input.profile,
        byteLimit: input.byteLimit,
        workLimit: input.workLimit
      });
      const pair = batch.byObjectId[input.objectId];
      if (pair !== undefined) return pair;
      if (batch.resourceLimited === true) {
        return { ...absentPair, resourceLimited: true, rowVisits: batch.rowVisits, bytesRead: batch.bytesRead };
      }
      return { ...absentPair, rowVisits: batch.rowVisits, bytesRead: batch.bytesRead };
    },
    measureStoredPairs: (input) => measureStoredPairs(database, input)
  };
}

function measureStoredPairs(database: StorageDatabase, input: MeasureStoredPairsInput): StoredPairsMeasurement {
  const uniqueIds = [...new Set(input.objectIds)].slice(0, 512);
  if (uniqueIds.length === 0) {
    return { byObjectId: {}, rowVisits: 0, bytesRead: 0 };
  }
  const resolved = resolvePairProfile(database, input, uniqueIds[0]!);
  if (resolved.kind === "absent") return resolved.measurement;
  const profile = resolved.profile;
  const reservedBytes = uniqueIds.length * (profile.dimensions * 4 + 2048) + (profile.dimensions * 4 + 2048) + 256;
  if (reservedBytes + resolved.metadataBytes > (input.byteLimit ?? 65536)
    || profile.dimensions * Math.min(2, uniqueIds.length) + resolved.metadataWork + 3 > (input.workLimit ?? 16388)) {
    return { byObjectId: {}, resourceLimited: true, rowVisits: resolved.metadataWork, bytesRead: resolved.metadataBytes };
  }
  const options = {
    providerKind: profile.provider_kind,
    modelId: profile.model_id,
    schemaVersion: profile.schema_version,
    expectedDimensions: profile.dimensions,
    maxVectorBytes: profile.dimensions * 4,
    maxMetadataUtf8Bytes: 2048,
    maxRows: uniqueIds.length,
    maxObjectIds: uniqueIds.length
  };
  const objectRead = readBoundedEmbeddings(database, input.workspaceId, uniqueIds, options);
  const objects = new Map(objectRead.records.map((record) => [record.object_id, record] as const));
  const query = loadQueryVector(database, input, profile);
  const objectBytes = resolved.metadataBytes + objectRead.vectorBytes + objectRead.metadataUtf8Bytes;
  const byObjectId: Record<string, StoredPairMeasurement> = {};
  for (const objectId of uniqueIds) {
    const object = objects.get(objectId);
    if (object === undefined) {
      byObjectId[objectId] = {
        ...absentPair,
        objectStatus: objectRead.filteredRows > 0 ? "unavailable" : "missing",
        queryStatus: query.vector === null ? query.status : "ready",
        rowVisits: 0,
        bytesRead: 0
      };
      continue;
    }
    byObjectId[objectId] = {
      object: vector(object),
      query: query.vector,
      objectStatus: "ready",
      queryStatus: query.status === "ready" && query.vector !== null ? "ready" : query.status,
      rowVisits: 0,
      bytesRead: 0
    };
  }
  return {
    byObjectId,
    rowVisits: resolved.metadataWork + objectRead.records.length + (query.rowVisits > 0 ? query.rowVisits : 1),
    bytesRead: objectBytes + query.bytesRead,
    ...(query.resourceLimited === true ? { resourceLimited: true } : {})
  };
}

function resolvePairProfile(
  database: StorageDatabase,
  input: MeasureStoredPairsInput,
  firstObjectId: string
): Readonly<{
  readonly kind: "ready";
  readonly profile: PairProfile;
  readonly metadataBytes: number;
  readonly metadataWork: number;
} | {
  readonly kind: "absent";
  readonly measurement: StoredPairsMeasurement;
}> {
  if (input.profile !== undefined) {
    return { kind: "ready", profile: input.profile, metadataBytes: 0, metadataWork: 0 };
  }
  if ((input.byteLimit ?? 65536) < 2048 || (input.workLimit ?? 16388) < 1) {
    return { kind: "absent", measurement: { byObjectId: {}, resourceLimited: true, rowVisits: 0, bytesRead: 0 } };
  }
  const metadata = statementsFor(database).metadata.get(input.workspaceId, firstObjectId) as {
    provider_kind: string | null;
    model_id: string | null;
    schema_version: number;
    dimensions: number;
  } | undefined;
  if (metadata === undefined) {
    return {
      kind: "absent",
      measurement: {
        byObjectId: Object.fromEntries(input.objectIds.map((objectId) => [objectId, {
          ...absentPair,
          objectStatus: "missing" as const,
          rowVisits: 0,
          bytesRead: 0
        }])),
        rowVisits: 1,
        bytesRead: 0
      }
    };
  }
  if (metadata.provider_kind === null || metadata.model_id === null || !Number.isSafeInteger(metadata.dimensions)
    || metadata.dimensions < 1 || metadata.dimensions > 16384) {
    return { kind: "absent", measurement: { byObjectId: {}, rowVisits: 1, bytesRead: 0 } };
  }
  return {
    kind: "ready",
    profile: { ...metadata, provider_kind: metadata.provider_kind, model_id: metadata.model_id },
    metadataBytes: Buffer.byteLength(metadata.provider_kind, "utf8") + Buffer.byteLength(metadata.model_id, "utf8"),
    metadataWork: 1
  };
}

function loadQueryVector(
  database: StorageDatabase,
  input: MeasureStoredPairsInput,
  profile: PairProfile
): Readonly<{
  readonly vector: StoredEmbeddingVector | null;
  readonly status: StoredPairMeasurement["queryStatus"];
  readonly rowVisits: number;
  readonly bytesRead: number;
  readonly resourceLimited?: boolean;
}> {
  const queryId = statementsFor(database).queryId.get(
    input.workspaceId,
    input.queryDigest,
    profile.provider_kind,
    profile.model_id,
    profile.schema_version,
    profile.dimensions
  ) as { object_id: string | null } | undefined;
  if (queryId?.object_id == null) {
    return { vector: null, status: "missing", rowVisits: 1, bytesRead: 0 };
  }
  const queryRead = readBoundedEmbeddings(database, input.workspaceId, [queryId.object_id], {
    providerKind: profile.provider_kind,
    modelId: profile.model_id,
    schemaVersion: profile.schema_version,
    expectedDimensions: profile.dimensions,
    maxVectorBytes: profile.dimensions * 4,
    maxMetadataUtf8Bytes: 2048,
    maxRows: 1,
    maxObjectIds: 1
  });
  const query = queryRead.records[0];
  return {
    vector: query === undefined ? null : vector(query),
    status: query === undefined ? "unavailable" : "ready",
    rowVisits: 2,
    bytesRead: Buffer.byteLength(queryId.object_id, "utf8") + queryRead.vectorBytes + queryRead.metadataUtf8Bytes
  };
}

function statementsFor(database: StorageDatabase): CachedMeasurementStatements {
  const existing = statementsByDatabase.get(database);
  if (existing !== undefined && existing.connectionVersion === database.getConnectionVersion()) {
    return existing;
  }
  const created: CachedMeasurementStatements = {
    connectionVersion: database.getConnectionVersion(),
    metadata: database.connection.prepare(`SELECT
      CASE WHEN octet_length(provider_kind) + octet_length(model_id) <= 2048 THEN provider_kind ELSE NULL END AS provider_kind,
      CASE WHEN octet_length(provider_kind) + octet_length(model_id) <= 2048 THEN model_id ELSE NULL END AS model_id,
      schema_version, dimensions FROM memory_embeddings WHERE workspace_id = ? AND object_id = ? LIMIT 1`),
    queryId: database.connection.prepare(`SELECT CASE WHEN octet_length(object_id) <= 256 THEN object_id ELSE NULL END AS object_id
      FROM memory_embeddings WHERE workspace_id = ? AND content_hash = ? AND provider_kind = ? AND model_id = ?
        AND schema_version = ? AND dimensions = ? AND vector_valid = 1 ORDER BY object_id LIMIT 1`)
  };
  statementsByDatabase.set(database, created);
  return created;
}

function vector(record: { object_id: string; provider_kind: string; model_id: string; schema_version: number;
  dimensions: number; content_hash: string; embedding: Float32Array }): StoredEmbeddingVector {
  return { object_id: record.object_id, provider_kind: record.provider_kind, model_id: record.model_id,
    schema_version: record.schema_version, dimensions: record.dimensions, content_hash: record.content_hash, embedding: record.embedding };
}
