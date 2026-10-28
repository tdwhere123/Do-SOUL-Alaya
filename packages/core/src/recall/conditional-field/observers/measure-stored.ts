import {
  ASSOCIATION_DOMAIN_ID,
  StoredCosineAdmissionSchema,
  memoryRecallTarget,
  type ProjectedCap,
  type RawMeasurement,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { digestOriginalQuery } from "../query/compile-query-identity.js";
import {
  collectObserved,
  pageLimit,
  unavailableOrNotApplicable
} from "./observe-collect.js";
import {
  SOURCE_IDENTITY_HYDRATE_RESERVE,
  validateSourceObserverPage,
  type ObserveConditionalFieldInput,
  type ObserverActionResult,
  type SourceObserverRow
} from "./observe-ports.js";
import { buildTypedObservation } from "./observation-admission.js";

export const STORED_COSINE_PRODUCER_ID = "stored.cosine.pair.v1";
export const COSINE_DOMAIN_ID = "cosine.unit.v1";
export const COSINE_NORMALIZATION_ID = "l2.dot.v1";
const STORED_PAIR_SLOT_BYTES = 2 * (16384 * 4 + 2048) + 2304;

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
  readonly resourceLimited?: boolean;
}>;

export type ObservationMeasurement = Readonly<{
  readonly observation_id: string;
  readonly raw: RawMeasurement;
  readonly cap: ProjectedCap;
}>;

export type MeasureStoredPairsInput = Readonly<{
  readonly workspaceId: string;
  readonly objectIds: readonly string[];
  readonly queryDigest: string;
  readonly profile?: ObserveConditionalFieldInput["measurement_profile"];
  readonly byteLimit?: number;
  readonly workLimit?: number;
}>;

export type StoredPairsMeasurement = Readonly<{
  readonly byObjectId: Readonly<Record<string, StoredPairMeasurement>>;
  readonly rowVisits: number;
  readonly bytesRead: number;
  readonly resourceLimited?: boolean;
}>;

type PairReaders = ObserveConditionalFieldInput["readers"] & {
  readonly measureStoredPairs?: (input: MeasureStoredPairsInput) => StoredPairsMeasurement;
};

export function hasMeasurementProducer(readers: ObserveConditionalFieldInput["readers"]): boolean {
  return readers.embeddingIds !== undefined || readers.measureStoredPair !== undefined;
}

export function requiresStoredMeasurement(query: ObserveConditionalFieldInput["query"]): boolean {
  // A reader capability does not add a semantic premise to an ordinary query.
  // Only the admitted declaration makes this stored-measurement domain required.
  return query.interpretation_proposal?.stored_cosine_admission !== undefined;
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
  const memoryRevision = input.sourceRevision;
  if (memoryRevision === undefined || memoryRevision.length === 0) return { status: "unavailable" };
  const cosine = finiteCosine(pair.query.embedding, pair.object.embedding);
  if (cosine === null) return { status: "unavailable" };
  return {
    status: "measured",
    producer_id: STORED_COSINE_PRODUCER_ID,
    model_id: pair.object.model_id,
    provider_kind: pair.object.provider_kind,
    schema_version: pair.object.schema_version,
    dimensions: pair.object.dimensions,
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
  const declaration = input.query.interpretation_proposal?.stored_cosine_admission;
  if (declaration === undefined) return observeMeasurementProfile(input);
  if (!StoredCosineAdmissionSchema.safeParse(declaration).success) return unavailableOrNotApplicable(input, "unavailable");
  const continuation = parseMeasurementCursor(input.cursor.committed_through);
  const profile = declaration.obligations[continuation.index];
  if (profile === undefined) return unavailableOrNotApplicable(input, "unavailable");
  const result = observeMeasurementProfile({ ...input, measurement_profile: profile,
    cursor: { ...input.cursor, committed_through: continuation.after, position: continuation.after ?? "" } });
  const finished = result.page.outcome.status === "exhausted";
  const nextIndex = finished && continuation.index + 1 < declaration.obligations.length ? continuation.index + 1 : continuation.index;
  const cursor = `s:${JSON.stringify([nextIndex, nextIndex === continuation.index ? result.page.cursor.committed_through : null])}`;
  return { ...result, page: { ...result.page, cursor: { ...result.page.cursor, position: cursor, committed_through: cursor },
    open_regions: result.page.open_regions.map((region) => region.region_id === input.action.region_id && nextIndex !== continuation.index
      ? { ...region, status: "open" } : region),
    outcome: { ...result.page.outcome, status: nextIndex !== continuation.index ? "open" : result.page.outcome.status } } };
}

function parseMeasurementCursor(value: string | null): { index: number; after: string | null } {
  if (!value?.startsWith("s:")) return { index: 0, after: value };
  try { const [index, after] = JSON.parse(value.slice(2)) as [number, string | null];
    if (Number.isSafeInteger(index) && index >= 0 && index < 16 && (after === null || typeof after === "string")) return { index, after };
  } catch { /* Invalid continuations cannot acquire a different measurement profile. */ }
  return { index: 16, after: null };
}

export function measurementCursorAdvanced(before: string | null, after: string | null): boolean {
  const prior = parseMeasurementCursor(before), next = parseMeasurementCursor(after);
  return prior.index !== next.index || prior.after !== next.after;
}

export function measurementWorkRequirement(query: ObserveConditionalFieldInput["query"],
  readers: ObserveConditionalFieldInput["readers"], cursor: string | null): number {
  if (readers.embeddingIds === undefined) return 1;
  const declaration = query.interpretation_proposal?.stored_cosine_admission;
  if (declaration === undefined) return measurementMinimumWork({ readers });
  if (!StoredCosineAdmissionSchema.safeParse(declaration).success) return 1;
  const profile = declaration.obligations[parseMeasurementCursor(cursor).index];
  return profile === undefined ? 1 : measurementMinimumWork({ readers, measurement_profile: profile });
}

function observeMeasurementProfile(input: ObserveConditionalFieldInput): ObserverActionResult {
  const embeddingIds = input.readers.embeddingIds;
  if (embeddingIds === undefined) {
    return withMeasurements(unavailableOrNotApplicable(input, "unavailable"), [absentMeasurement(
      `${input.action.region_id}:missing-measurement`,
      "unavailable"
    )]);
  }
  const minimum = measurementMinimumWork(input);
  if (input.action.work_limit < minimum) {
    input.on_atomic_work_block?.(minimum);
    return collectObserved(input, { identities: [], truncated: true, nativeVisits: 0,
      bytesRead: 0, identityKind: "embedding" });
  }
  const modelId = input.model_id ?? input.expected_model_id;
  const page = embeddingIds({
    workspaceId: input.workspace_id,
    afterObjectId: input.cursor.committed_through,
    maxRows: enumerationBudget(input),
    ...(input.measurement_profile === undefined ? {} : { profile: input.measurement_profile }),
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
  const measureMany = (input.readers as PairReaders).measureStoredPairs;
  const reserves = measurementWorkReserves(input);
  const affordable: TypedObservation[] = [];
  for (const observation of collected.page.observations) {
    if (collected.work.native_visits + affordable.length * (reserves.pair + reserves.source) + reserves.pair + reserves.source
      > input.action.work_limit) {
      break;
    }
    affordable.push(observation);
  }
  let batch = measureMany === undefined || affordable.length === 0
    ? undefined
    : measureMany({
      workspaceId: input.workspace_id,
      objectIds: affordable.map((observation) => observation.object_id),
      queryDigest: digest,
      profile: input.measurement_profile,
      byteLimit: STORED_PAIR_SLOT_BYTES * affordable.length,
      workLimit: input.action.work_limit - collected.work.native_visits - reserves.source
    });
  if (batch?.resourceLimited === true && Object.keys(batch.byObjectId).length === 0) {
    batch = undefined;
  }
  const measurements: ObservationMeasurement[] = [];
  let extraWork = batch?.rowVisits ?? 0;
  let extraBytes = batch?.bytesRead ?? 0;
  let computeWork = 0;
  const observations: TypedObservation[] = [];
  const serial = batch === undefined ? collected.page.observations : affordable;
  for (const observation of serial) {
    if (batch === undefined
      && collected.work.native_visits + extraWork + computeWork + reserves.pair + reserves.source > input.action.work_limit) {
      break;
    }
    const pair = batch === undefined
      ? measure?.({
        workspaceId: input.workspace_id,
        objectId: observation.object_id,
        queryDigest: digest,
        profile: input.measurement_profile,
        byteLimit: STORED_PAIR_SLOT_BYTES,
        workLimit: input.action.work_limit - collected.work.native_visits - extraWork - computeWork - reserves.source
      })
      : batch.byObjectId[observation.object_id];
    if (batch === undefined) {
      extraWork += pair?.rowVisits ?? 0;
      extraBytes += pair?.bytesRead ?? 0;
    }
    if (pair?.resourceLimited === true || (batch?.resourceLimited === true && pair === undefined)) break;
    let memory: ReturnType<typeof memoryProductRevision>;
    try { memory = pairNeedsMemoryRevision(pair)
      ? memoryProductRevision(input, observation.object_id) : { rowVisits: 0, bytesRead: 0 }; }
    catch (error) {
      input.on_failure_work?.({ native_visits: collected.work.native_visits + extraWork,
        native_bytes: collected.work.bytes_read + extraBytes });
      throw error;
    }
    extraWork += memory.rowVisits;
    extraBytes += memory.bytesRead;
    if (memory.resourceLimited === true) break;
    if (collected.work.native_visits + extraWork + computeWork + (pair?.object?.dimensions ?? 0) > input.action.work_limit) break;
    const attached = attachOnePair(input, observation, digest, pair, memory);
    computeWork += attached.computeWork;
    measurements.push(attached.measurement);
    observations.push(attached.observation);
  }
  const nativeVisits = collected.work.native_visits + extraWork;
  const truncated = observations.length < collected.page.observations.length;
  const committed = observations.at(-1)?.object_id ?? input.cursor.committed_through;
  return withMeasurements({
    page: {
      ...collected.page,
      observations,
      cursor: { ...collected.page.cursor, position: committed, committed_through: committed },
      ...(truncated ? { outcome: { ...collected.page.outcome, status: "interrupted" as const } } : {})
    },
    work: {
      work_units: nativeVisits + computeWork,
      residual_work_units: truncated ? Math.max(1, nativeVisits) : collected.work.residual_work_units,
      native_visits: nativeVisits,
      bytes_read: collected.work.bytes_read + extraBytes
    }
  }, measurements);
}

function attachOnePair(
  input: ObserveConditionalFieldInput,
  observation: TypedObservation,
  digest: string,
  pair: StoredPairMeasurement | undefined,
  memory: ReturnType<typeof memoryProductRevision>
): Readonly<{
  readonly measurement: ObservationMeasurement;
  readonly observation: TypedObservation;
  readonly computeWork: number;
}> {
  const fresh = pair?.object == null || memory.contentHash === pair.object.content_hash;
  const computeWork = fresh && memory.revision !== undefined && pairNeedsMemoryRevision(pair)
    && compatibleSpaces(pair!.object!, pair!.query!)
    ? pair!.object!.dimensions
    : 0;
  let raw: RawMeasurement = fresh ? rawMeasurementFromPair({
    workspaceId: input.workspace_id,
    objectId: observation.object_id,
    queryDigest: digest,
    pair,
    sourceRevision: memory.revision
  }) : { status: "unavailable" };
  const profile = input.measurement_profile;
  if (raw.status === "measured" && profile !== undefined) raw = { ...raw, obligation_id: profile.obligation_id };
  const cap: ProjectedCap = raw.status === "measured" && typeof raw.raw === "number" && profile !== undefined
    && raw.producer_id === profile.producer_id && raw.provider_kind === profile.provider_kind && raw.model_id === profile.model_id
    && raw.schema_version === profile.schema_version && raw.dimensions === profile.dimensions
    && raw.domain === profile.domain && raw.normalization === profile.normalization && raw.raw >= profile.raw_threshold
    ? { status: "projected", domain_id: ASSOCIATION_DOMAIN_ID, transfer_id: profile.transfer_id,
      transfer_version: profile.transfer_version, milligrades: Math.floor(500 * (Math.max(-1, Math.min(1, raw.raw)) + 1)) }
    : INAPPLICABLE_CAP;
  const observationId = profile === undefined ? observation.observation_id : `${observation.observation_id}:${profile.obligation_id}`;
  const admitted = raw.status !== "measured" ? null : buildTypedObservation(input, {
    objectId: observation.object_id,
    sourceRevision: raw.referent.kind === "memory_entry" ? raw.referent.source_revision : observation.source_revision,
    sourceRow: memory.row, target: raw.referent, observationKey: observationId, identityKind: "object"
  });
  return {
    measurement: { observation_id: observationId, raw, cap },
    observation: {
      ...stampMeasuredObservation(observation, raw, pair, memory.revision),
      observation_id: observationId,
      applicability: admitted?.applicability ?? { ...observation.applicability, verdict: "false" }
    },
    computeWork
  };
}

function measurementWorkReserves(input: Pick<ObserveConditionalFieldInput, "readers" | "measurement_profile">): Readonly<{
  readonly lookup: number;
  readonly pair: number;
  readonly source: number;
}> {
  const pair = input.readers.measureStoredPair === undefined && input.readers.measureStoredPairs === undefined ? 0
    : input.measurement_profile === undefined ? 6 : 5 + input.measurement_profile.dimensions;
  return {
    lookup: input.measurement_profile === undefined ? 2 : 0,
    pair,
    source: pair === 0 || input.readers.source === undefined ? 0 : SOURCE_IDENTITY_HYDRATE_RESERVE
  };
}

function measurementMinimumWork(input: Pick<ObserveConditionalFieldInput, "readers" | "measurement_profile">): number {
  const reserves = measurementWorkReserves(input);
  return reserves.lookup + 1 + reserves.pair + reserves.source;
}

function enumerationBudget(input: ObserveConditionalFieldInput): number {
  const reserves = measurementWorkReserves(input);
  const perIdentity = 1 + reserves.pair + reserves.source;
  return Math.min(
    512,
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
  readonly contentHash?: string;
  readonly row?: SourceObserverRow;
  readonly rowVisits: number;
  readonly bytesRead: number;
  readonly resourceLimited?: boolean;
}> {
  const source = input.readers.source;
  if (source === undefined) return { rowVisits: 0, bytesRead: 0 };
  const page = validateSourceObserverPage(source({ workspaceId: input.workspace_id, objectId }));
  const revision = page.unavailable ? undefined : page.row?.sourceRevision;
  return {
    ...(page.resourceLimited === true ? { resourceLimited: true } : {}),
    ...(revision === undefined || revision.length === 0 ? {} : { revision }),
    ...(page.row == null ? {} : { row: page.row }),
    ...(page.row?.content === undefined || page.unavailable || page.resourceLimited ? {} : {
      contentHash: `sha256:${createHash("sha256").update(page.row.content, "utf8").digest("hex")}` }),
    rowVisits: page.rowsRead,
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
