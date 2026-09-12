import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CoverageRegion,
  type CoverageRegionKind,
  type ObserverAction,
  type ObserverCursor,
  type ObserverStatus,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  advanceObserverCursor,
  mapNativeReaderPage
} from "../reference/accepting-projection.js";
import {
  buildTypedObservation,
  sourceRowEligible
} from "./observation-admission.js";
import {
  DEFAULT_SOURCE_BYTE_LIMIT,
  SOURCE_IDENTITY_HYDRATE_RESERVE,
  type ObserveConditionalFieldInput,
  type ObserverActionResult,
  type ObserverReaders,
  type ObserverWorkReceipt,
  type RelationObserverRow,
  type SourceObserverPage
} from "./observe-ports.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;

export function collectObserved(
  input: ObserveConditionalFieldInput,
  native: Readonly<{
    readonly identities: readonly string[];
    readonly truncated: boolean;
    readonly nativeVisits: number;
    readonly bytesRead: number;
    readonly identityKind: "object" | "assertion" | "embedding";
    readonly rows?: readonly RelationObserverRow[];
    readonly commitThrough?: string | null;
  }>
): ObserverActionResult {
  const observations: TypedObservation[] = [];
  let cursor = input.cursor;
  let workUnits = native.nativeVisits;
  let bytes = native.bytesRead;
  let hydrationUnavailable = false;
  let resourceLimited = false;
  let processed = 0;
  for (const [index, identity] of native.identities.entries()) {
    if (native.identityKind !== "embedding" && input.readers.source !== undefined
      && input.action.work_limit - workUnits < SOURCE_IDENTITY_HYDRATE_RESERVE) {
      hydrationUnavailable = true;
      resourceLimited = true;
      break;
    }
    const prepared = prepareObservation(input, native, identity, index);
    workUnits += prepared.extraWork;
    bytes += prepared.extraBytes;
    if (prepared.unavailable === true) {
      hydrationUnavailable = true;
      resourceLimited = prepared.resourceLimited === true;
      break;
    }
    if (prepared.observation !== null) observations.push(prepared.observation);
    processed += 1;
  }
  if (hydrationUnavailable) {
    if (processed > 0) {
      cursor = advanceObserverCursor(cursor, native.identities[processed - 1]!);
    }
  } else if (native.commitThrough !== undefined && native.commitThrough !== null) {
    cursor = {
      ...cursor,
      position: native.commitThrough,
      committed_through: native.commitThrough
    };
  } else if (processed > 0) {
    cursor = advanceObserverCursor(cursor, native.identities[processed - 1]!);
  }
  return finish({
    input,
    cursor,
    observations,
    ids: native.identities,
    truncated: native.truncated,
    readerAvailable: true,
    ...(hydrationUnavailable ? { status: resourceLimited ? "interrupted" as const : "unavailable" as const } : {}),
    work: workReceipt(
      workUnits,
      workUnits,
      bytes,
      native.truncated || hydrationUnavailable
    )
  });
}

function prepareObservation(
  input: ObserveConditionalFieldInput,
  native: Readonly<{
    readonly identityKind: "object" | "assertion" | "embedding";
    readonly rows?: readonly RelationObserverRow[];
  }>,
  identity: string,
  index: number
): Readonly<{
  readonly observation: TypedObservation | null;
  readonly extraWork: number;
  readonly extraBytes: number;
  readonly unavailable?: boolean;
  readonly resourceLimited?: boolean;
}> {
  if (native.identityKind === "assertion") {
    const row = native.rows?.[index];
    if (row === undefined) return { observation: null, extraWork: 0, extraBytes: 0 };
    const source = input.readers.source;
    if (source === undefined) {
      return {
        observation: buildTypedObservation(input, {
          objectId: row.targetObjectId,
          sourceRevision: row.assertionId,
          observationKey: identity,
          relation: row,
          identityKind: "assertion"
        }),
        extraWork: 0,
        extraBytes: 0
      };
    }
    const page = readSource(input, source, row.targetObjectId);
    if (page.unavailable) {
      return {
        observation: null,
        extraWork: Math.max(1, page.rowsRead),
        extraBytes: page.bytesRead,
        unavailable: true,
        resourceLimited: page.resourceLimited
      };
    }
    if (page.row === null) {
      return {
        observation: null,
        extraWork: Math.max(1, page.rowsRead),
        extraBytes: page.bytesRead
      };
    }
    return {
      observation: buildTypedObservation(input, {
        objectId: row.targetObjectId,
        sourceRevision: page.row.sourceRevision,
        observationKey: identity,
        observedAt: page.row.observed_at,
        sourceRow: page.row,
        relation: row,
        identityKind: "assertion"
      }),
      extraWork: Math.max(1, page.rowsRead),
      extraBytes: page.bytesRead
    };
  }
  if (native.identityKind === "embedding") {
    return {
      observation: buildTypedObservation(input, {
        objectId: identity,
        sourceRevision: identity,
        observationKey: identity,
        identityKind: "embedding"
      }),
      extraWork: 0,
      extraBytes: 0
    };
  }
  return hydrateSeedObservation(input, identity);
}

function hydrateSeedObservation(
  input: ObserveConditionalFieldInput,
  objectId: string
): Readonly<{
  readonly observation: TypedObservation | null;
  readonly extraWork: number;
  readonly extraBytes: number;
  readonly unavailable?: boolean;
  readonly resourceLimited?: boolean;
}> {
  const source = input.readers.source;
  if (source === undefined) {
    return {
      observation: buildTypedObservation(input, {
        objectId,
        sourceRevision: objectId,
        observationKey: objectId,
        identityKind: "object"
      }),
      extraWork: 0,
      extraBytes: 0
    };
  }
  const page = readSource(input, source, objectId);
  const extraWork = Math.max(1, page.rowsRead);
  const extraBytes = page.bytesRead;
  if (page.unavailable) {
    return { observation: null, extraWork, extraBytes, unavailable: true, resourceLimited: page.resourceLimited };
  }
  if (page.row === null) {
    return { observation: null, extraWork, extraBytes };
  }
  if (!sourceRowEligible(input, page.row)) {
    return { observation: null, extraWork, extraBytes };
  }
  return {
    observation: buildTypedObservation(input, {
      objectId,
      sourceRevision: page.row.sourceRevision,
      observationKey: objectId,
      observedAt: page.row.observed_at,
      sourceRow: page.row,
      identityKind: "object"
    }),
    extraWork,
    extraBytes
  };
}

function readSource(
  input: ObserveConditionalFieldInput,
  source: NonNullable<ObserverReaders["source"]>,
  objectId: string
): SourceObserverPage {
  const byteLimit = input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT;
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
    return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
  }
  return source({
    workspaceId: input.workspace_id,
    objectId,
    byteLimit
  });
}

export function unavailableOrNotApplicable(
  input: ObserveConditionalFieldInput,
  status: "unavailable" | "not_applicable"
): ObserverActionResult {
  return finish({
    input,
    cursor: input.cursor,
    observations: [],
    ids: [],
    truncated: false,
    readerAvailable: status !== "unavailable",
    status,
    work: emptyWork(0)
  });
}

export function finish(args: Readonly<{
  readonly input: ObserveConditionalFieldInput;
  readonly cursor: ObserverCursor;
  readonly observations: readonly TypedObservation[];
  readonly ids: readonly string[];
  readonly truncated: boolean;
  readonly readerAvailable: boolean;
  readonly status?: ObserverStatus;
  readonly work: ObserverWorkReceipt;
}>): ObserverActionResult {
  const mapped = mapNativeReaderPage({
    ids: args.ids,
    truncated: args.truncated,
    readerAvailable: args.readerAvailable
  });
  const status = args.status ?? mapped.outcome.status;
  return {
    page: {
      schema_version: SCHEMA,
      query_id: args.input.query.query_id,
      snapshot_id: args.input.lease.snapshot_id,
      cursor: args.cursor,
      observations: args.observations,
      outcome: { schema_version: SCHEMA, status },
      open_regions: coverageRegions(args.input.action, status)
    },
    work: args.work
  };
}

function coverageRegions(action: ObserverAction, status: ObserverStatus): readonly CoverageRegion[] {
  const currentKind = regionKind(action.action);
  const currentStatus: ObserverStatus = status === "exhausted" ? "exhausted" : openOrStatus(status);
  return (["seed", "adjacency", "guard", "binding"] as const).map((kind) => ({
    schema_version: SCHEMA,
    region_id: kind === currentKind ? action.region_id : kind,
    kind,
    status: status === "invalidated" ? "invalidated" : (kind === currentKind ? currentStatus : "open")
  }));
}

function openOrStatus(status: ObserverStatus): ObserverStatus {
  if (status === "interrupted" || status === "open") return "open";
  return status;
}

function regionKind(action: ObserverAction["action"]): CoverageRegionKind {
  if (action === "measurement") return "binding";
  if (action === "adjacency" || action === "relation") return "adjacency";
  return "seed";
}

export function workReceipt(
  workUnits: number,
  nativeVisits: number,
  bytesRead: number,
  truncated: boolean
): ObserverWorkReceipt {
  return {
    work_units: workUnits,
    residual_work_units: truncated ? Math.max(1, workUnits) : 0,
    native_visits: nativeVisits,
    bytes_read: bytesRead
  };
}

export function emptyWork(nativeVisits: number): ObserverWorkReceipt {
  return workReceipt(nativeVisits, nativeVisits, 0, false);
}

export function pageLimit(input: ObserveConditionalFieldInput): number {
  return Math.min(input.page_limit ?? input.action.work_limit, input.action.work_limit);
}
