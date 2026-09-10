import {
  memoryRecallTarget,
  type ProjectedCap,
  type RawMeasurement,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../query/compile-query-identity.js";
import {
  collectObserved,
  pageLimit,
  unavailableOrNotApplicable,
  type ObserveConditionalFieldInput,
  type ObserverActionResult
} from "./observe.js";

export const STORED_COSINE_PRODUCER_ID = "stored.cosine.pair.v1";
export const COSINE_DOMAIN_ID = "cosine.unit.v1";
export const COSINE_NORMALIZATION_ID = "l2.dot.v1";

export const INAPPLICABLE_CAP: ProjectedCap = Object.freeze({ status: "inapplicable" });

export type StoredEmbeddingVector = Readonly<{
  readonly object_id: string;
  readonly model_id: string;
  readonly provider_kind: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly content_hash: string;
  readonly embedding: Float32Array;
}>;

export type StoredPairMeasurement = Readonly<{
  readonly object: StoredEmbeddingVector | null;
  readonly query: StoredEmbeddingVector | null;
  readonly objectStatus: "ready" | "missing" | "unavailable";
  readonly queryStatus: "ready" | "missing" | "unavailable";
  readonly rowVisits: number;
  readonly bytesRead: number;
}>;

export type ObservationMeasurement = Readonly<{
  readonly observation_id: string;
  readonly raw: RawMeasurement;
  readonly cap: ProjectedCap;
}>;

export function hasMeasurementProducer(readers: ObserveConditionalFieldInput["readers"]): boolean {
  return readers.embeddingIds !== undefined || readers.measureStoredPair !== undefined;
}

export function queryDigestOf(input: ObserveConditionalFieldInput): string {
  return digestOriginalQuery(input.seed_query ?? input.query.query_id);
}

export function finiteCosine(left: Float32Array, right: Float32Array): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
    dot += leftValue * rightValue;
    leftSq += leftValue * leftValue;
    rightSq += rightValue * rightValue;
  }
  const denom = Math.sqrt(leftSq) * Math.sqrt(rightSq);
  if (!Number.isFinite(denom) || denom === 0) return null;
  const cosine = dot / denom;
  return Number.isFinite(cosine) ? cosine : null;
}

export function rawMeasurementFromPair(
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectId: string;
    readonly queryDigest: string;
    readonly pair: StoredPairMeasurement | undefined;
    readonly sourceRevision?: string;
  }>
): RawMeasurement {
  const pair = input.pair;
  if (pair === undefined) return { status: "unavailable" };
  if (pair.objectStatus === "unavailable") return { status: "unavailable" };
  if (pair.objectStatus === "missing" || pair.object === null) return { status: "missing" };
  if (pair.queryStatus === "unavailable") return { status: "unavailable" };
  if (pair.queryStatus === "missing" || pair.query === null) return { status: "unavailable" };
  if (!compatibleSpaces(pair.object, pair.query)) return { status: "unsupported" };
  const cosine = finiteCosine(pair.query.embedding, pair.object.embedding);
  if (cosine === null) return { status: "unavailable" };
  const memoryRevision = input.sourceRevision;
  if (memoryRevision === undefined || memoryRevision.length === 0) return { status: "unavailable" };
  return {
    status: "measured",
    producer_id: STORED_COSINE_PRODUCER_ID,
    model_id: pair.object.model_id,
    domain: COSINE_DOMAIN_ID,
    normalization: COSINE_NORMALIZATION_ID,
    referent: memoryRecallTarget({
      workspace_id: input.workspaceId,
      object_id: input.objectId,
      source_revision: memoryRevision
    }),
    source_revision: pair.object.content_hash,
    query_digest: input.queryDigest,
    raw: cosine
  };
}

export function observeStoredMeasurement(input: ObserveConditionalFieldInput): ObserverActionResult {
  const embeddingIds = input.readers.embeddingIds;
  if (embeddingIds === undefined) {
    return withMeasurements(unavailableOrNotApplicable(input, "unavailable"), [absentMeasurement(
      `${input.action.region_id}:missing-measurement`,
      "unavailable"
    )]);
  }
  const modelId = input.model_id ?? input.expected_model_id;
  const page = embeddingIds({
    workspaceId: input.workspace_id,
    afterObjectId: input.cursor.committed_through,
    maxRows: enumerationBudget(input),
    ...(modelId === undefined || modelId.length === 0 ? {} : { modelId })
  });
  const domainStatus = page.domainStatus;
  const failClosed = domainStatus === "missing" || domainStatus === "unavailable";
  const ids = failClosed ? [] : idsAffordableForPairs(input, page.objectIds, page.rowVisits);
  const truncated = failClosed ? false : page.truncated || ids.length < page.objectIds.length;
  const collected = collectObserved(input, {
    identities: ids,
    truncated,
    nativeVisits: page.rowVisits,
    bytesRead: page.metadataUtf8Bytes,
    identityKind: "embedding",
    commitThrough: failClosed || ids.length === 0
      ? input.cursor.committed_through
      : ids.at(-1) ?? input.cursor.committed_through
  });
  if (failClosed) {
    return withMeasurements(collected, [absentMeasurement(
      `${input.action.region_id}:missing-measurement`,
      domainStatus
    )]);
  }
  if (collected.page.observations.length === 0) {
    if (truncated || collected.page.outcome.status === "interrupted") return collected;
    return withMeasurements(collected, [absentMeasurement(
      `${input.action.region_id}:missing-measurement`,
      page.objectIds.length === 0 ? "missing" : "unavailable"
    )]);
  }
  return attachPairMeasurements(input, collected);
}

function attachPairMeasurements(
  input: ObserveConditionalFieldInput,
  collected: ObserverActionResult
): ObserverActionResult {
  const digest = queryDigestOf(input);
  const measure = input.readers.measureStoredPair;
  const measurements: ObservationMeasurement[] = [];
  let extraWork = 0;
  let extraBytes = 0;
  const observations: TypedObservation[] = [];
  const reserves = measurementWorkReserves(input);
  for (const observation of collected.page.observations) {
    if (collected.work.native_visits + extraWork + reserves.pair + reserves.source > input.action.work_limit) {
      break;
    }
    const pair = measure?.({
      workspaceId: input.workspace_id,
      objectId: observation.object_id,
      queryDigest: digest
    });
    extraWork += pair?.rowVisits ?? 0;
    extraBytes += pair?.bytesRead ?? 0;
    const memory = pairNeedsMemoryRevision(pair)
      ? memoryProductRevision(input, observation.object_id)
      : { rowVisits: 0, bytesRead: 0 };
    extraWork += memory.rowVisits;
    extraBytes += memory.bytesRead;
    const raw = rawMeasurementFromPair({
      workspaceId: input.workspace_id,
      objectId: observation.object_id,
      queryDigest: digest,
      pair,
      sourceRevision: memory.revision
    });
    measurements.push({ observation_id: observation.observation_id, raw, cap: INAPPLICABLE_CAP });
    observations.push(stampMeasuredObservation(observation, raw, pair, memory.revision));
  }
  const nativeVisits = collected.work.native_visits + extraWork;
  const truncated = observations.length < collected.page.observations.length;
  return withMeasurements({
    page: {
      ...collected.page,
      observations,
      ...(truncated ? { outcome: { ...collected.page.outcome, status: "interrupted" as const } } : {})
    },
    work: {
      work_units: nativeVisits,
      residual_work_units: truncated ? Math.max(1, nativeVisits) : collected.work.residual_work_units,
      native_visits: nativeVisits,
      bytes_read: collected.work.bytes_read + extraBytes
    }
  }, measurements);
}

function measurementWorkReserves(input: ObserveConditionalFieldInput): Readonly<{
  readonly lookup: number;
  readonly pair: number;
  readonly source: number;
}> {
  const pair = input.readers.measureStoredPair === undefined ? 0 : 2;
  return {
    lookup: 1,
    pair,
    // Production source pays length, row, and revision; reserving 1 overshoots native visits.
    source: pair === 0 || input.readers.source === undefined ? 0 : 3
  };
}

function enumerationBudget(input: ObserveConditionalFieldInput): number {
  const reserves = measurementWorkReserves(input);
  const perIdentity = 1 + reserves.pair + reserves.source;
  return Math.min(
    pageLimit(input),
    Math.max(0, Math.floor((input.action.work_limit - reserves.lookup) / perIdentity))
  );
}

function idsAffordableForPairs(
  input: ObserveConditionalFieldInput,
  objectIds: readonly string[],
  spent: number
): readonly string[] {
  const reserves = measurementWorkReserves(input);
  const perId = reserves.pair + reserves.source;
  if (perId === 0) return objectIds;
  return objectIds.slice(0, Math.max(0, Math.floor((input.action.work_limit - spent) / perId)));
}

function stampMeasuredObservation(
  observation: TypedObservation,
  raw: RawMeasurement,
  pair: StoredPairMeasurement | undefined,
  memoryRevision: string | undefined
): TypedObservation {
  if (raw.status !== "measured" || pair?.object == null || memoryRevision === undefined) {
    return observation;
  }
  return {
    ...observation,
    source_revision: memoryRevision,
    measurement_id: STORED_COSINE_PRODUCER_ID,
    model_id: pair.object.model_id
  };
}

function pairNeedsMemoryRevision(pair: StoredPairMeasurement | undefined): boolean {
  return pair !== undefined
    && pair.objectStatus === "ready"
    && pair.object !== null
    && pair.queryStatus === "ready"
    && pair.query !== null;
}

function memoryProductRevision(
  input: ObserveConditionalFieldInput,
  objectId: string
): Readonly<{
  readonly revision?: string;
  readonly rowVisits: number;
  readonly bytesRead: number;
}> {
  const source = input.readers.source;
  if (source === undefined) return { rowVisits: 0, bytesRead: 0 };
  const page = source({ workspaceId: input.workspace_id, objectId });
  const revision = page.unavailable ? undefined : page.row?.sourceRevision;
  return {
    ...(revision === undefined || revision.length === 0 ? {} : { revision }),
    rowVisits: Math.max(1, page.rowsRead),
    bytesRead: page.bytesRead
  };
}

function absentMeasurement(observationId: string, status: "missing" | "unavailable"): ObservationMeasurement {
  return {
    observation_id: observationId,
    raw: { status },
    cap: INAPPLICABLE_CAP
  };
}

function withMeasurements(
  result: ObserverActionResult,
  measurements: readonly ObservationMeasurement[]
): ObserverActionResult {
  return { ...result, measurements };
}

function compatibleSpaces(object: StoredEmbeddingVector, query: StoredEmbeddingVector): boolean {
  return object.provider_kind === query.provider_kind
    && object.model_id === query.model_id
    && object.schema_version === query.schema_version
    && object.dimensions === query.dimensions
    && object.embedding.length === query.embedding.length
    && query.embedding.length === query.dimensions;
}
