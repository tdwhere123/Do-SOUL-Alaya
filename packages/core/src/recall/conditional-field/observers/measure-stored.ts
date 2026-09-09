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
  return {
    status: "measured",
    producer_id: STORED_COSINE_PRODUCER_ID,
    model_id: pair.object.model_id,
    domain: COSINE_DOMAIN_ID,
    normalization: COSINE_NORMALIZATION_ID,
    referent: memoryRecallTarget({
      workspace_id: input.workspaceId,
      object_id: input.objectId,
      source_revision: pair.object.content_hash
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
  const page = embeddingIds({
    workspaceId: input.workspace_id,
    afterObjectId: input.cursor.committed_through,
    maxRows: pageLimit(input)
  });
  const collected = collectObserved(input, {
    identities: page.objectIds,
    truncated: page.truncated,
    nativeVisits: page.rowVisits,
    bytesRead: page.metadataUtf8Bytes,
    identityKind: "embedding",
    commitThrough: page.committedThrough ?? page.objectIds.at(-1) ?? input.cursor.committed_through
  });
  return attachPairMeasurements(input, collected, page.objectIds);
}

function attachPairMeasurements(
  input: ObserveConditionalFieldInput,
  collected: ObserverActionResult,
  enumeratedIds: readonly string[]
): ObserverActionResult {
  const digest = queryDigestOf(input);
  const measure = input.readers.measureStoredPair;
  if (collected.page.observations.length === 0) {
    const status = enumeratedIds.length === 0 ? "missing" : "unavailable";
    return withMeasurements(collected, [absentMeasurement(
      `${input.action.region_id}:missing-measurement`,
      status
    )]);
  }
  const measurements: ObservationMeasurement[] = [];
  let extraWork = 0;
  let extraBytes = 0;
  const observations: TypedObservation[] = [];
  for (const observation of collected.page.observations) {
    const pair = measure?.({
      workspaceId: input.workspace_id,
      objectId: observation.object_id,
      queryDigest: digest
    });
    extraWork += pair?.rowVisits ?? 0;
    extraBytes += pair?.bytesRead ?? 0;
    const raw = rawMeasurementFromPair({
      workspaceId: input.workspace_id,
      objectId: observation.object_id,
      queryDigest: digest,
      pair
    });
    measurements.push({ observation_id: observation.observation_id, raw, cap: INAPPLICABLE_CAP });
    observations.push(stampMeasuredObservation(observation, raw, pair));
  }
  return withMeasurements({
    page: { ...collected.page, observations },
    work: {
      work_units: collected.work.work_units + extraWork,
      residual_work_units: collected.work.residual_work_units,
      native_visits: collected.work.native_visits + extraWork,
      bytes_read: collected.work.bytes_read + extraBytes
    }
  }, measurements);
}

function stampMeasuredObservation(
  observation: TypedObservation,
  raw: RawMeasurement,
  pair: StoredPairMeasurement | undefined
): TypedObservation {
  if (raw.status !== "measured" || pair?.object === undefined) return observation;
  return {
    ...observation,
    source_revision: pair.object.content_hash,
    measurement_id: STORED_COSINE_PRODUCER_ID,
    model_id: pair.object.model_id
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
