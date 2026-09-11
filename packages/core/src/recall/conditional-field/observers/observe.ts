import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  type CoverageRegion,
  type CoverageRegionKind,
  type ObserverAction,
  type ObserverCursor,
  type ObserverPage,
  type ObserverStatus,
  type QueryInterpretation,
  type RelationValidity,
  type SnapshotReadLease,
  type SourceEvidenceRootKind,
  type StagedWarningArray,
  type StoredCosineObligation,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  advanceObserverCursor,
  mapNativeReaderPage
} from "../reference/accepting-projection.js";
import {
  buildTypedObservation,
  relationRowEligible,
  sourceRowEligible
} from "./observation-admission.js";
import { hydrateUtf8Chunk } from "../../../memory/evidence-create/source-utf8-hydrate.js";
import { observeSourceAwareSeed } from "./source-root-observe.js";
import {
  observeStoredMeasurement,
  type ObservationMeasurement,
  type StoredPairMeasurement
} from "./measure-stored.js";

export type {
  ObservationMeasurement,
  StoredEmbeddingVector,
  StoredPairMeasurement
} from "./measure-stored.js";
export { hasMeasurementProducer, queryDigestOf } from "./measure-stored.js";

export type LexicalObserverPage = Readonly<{
  readonly ids: readonly string[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
}>;

export type SourceObserverRow = Readonly<{
  readonly object_id: string;
  readonly sourceRevision: string;
  readonly predicates?: Readonly<Record<string, boolean>>;
  readonly observed_at?: string;
  readonly content?: string;
  readonly lifecycle_state?: string;
  readonly retention_state?: string | null;
  readonly scope_class?: string;
  readonly evidence_refs?: readonly string[];
  readonly staged_warnings?: StagedWarningArray;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
  readonly dimension?: string;
  readonly domain_tags?: readonly string[];
  readonly created_at?: string;
  readonly last_used_at?: string | null;
}>;

export type SourceObserverPage = Readonly<{
  readonly row: SourceObserverRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type SourceRootObserverRow = Readonly<{
  readonly kind: SourceEvidenceRootKind;
  readonly workspace_id: string;
  readonly root_id: string;
  readonly revision: string;
  readonly digest: string;
  readonly evidence_object_id: string | null;
  readonly evidence_verified?: boolean;
  readonly event_time?: string | null;
  readonly role?: string;
  readonly content?: string;
  readonly content_complete?: boolean;
  readonly content_start?: number;
  readonly content_end?: number;
  readonly retained_extent?: "body" | "excerpt" | "gist";
  readonly literal_verdicts?: Readonly<Record<string, "true" | "false" | "unresolved">>;
  readonly original_complete?: boolean;
  readonly scope_class?: string;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
  readonly body_erased?: boolean;
}>;

export type SourceRootObserverPage = Readonly<{
  readonly rows: readonly SourceRootObserverRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly metadataBytes?: number;
  readonly nativeWork?: number;
  readonly resourceLimited?: boolean;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
  readonly unavailable?: boolean;
}>;

export type SourceRootHydrateObserverPage = Readonly<{
  readonly row: SourceRootObserverRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly metadataBytes?: number;
  readonly nativeWork?: number;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type RelationObserverRow = Readonly<{
  readonly assertionId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly resultObjectId: string;
  readonly predicate: string;
  readonly validity?: RelationValidity;
  readonly evidenceRefs?: readonly string[];
  readonly evidenceReceipts?: readonly Readonly<{ evidenceId: string; eventId: string; eventType: string; occurredAt: string }>[];
  readonly sourceObservations?: readonly Readonly<{ source_id: string; source_sha256: string }>[];
  readonly source_revision?: string;
  readonly resolutionKind?: string | null;
  readonly resolvedAt?: string | null;
  readonly source_event_id?: string;
  readonly occurred_at?: string;
}>;

export type RelationObserverPage = Readonly<{
  readonly unavailable?: boolean;
  readonly observations: readonly RelationObserverRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
}>;

export type EmbeddingObserverPage = Readonly<{
  readonly objectIds: readonly string[];
  readonly rowVisits: number;
  readonly metadataUtf8Bytes: number;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
  readonly domainStatus?: "missing" | "unavailable";
}>;

export type ObserverReaders = Readonly<{
  readonly sourceRootMetadataByteLimit?: number;
  readonly sourceRootChunkByteLimit?: number;
  readonly permittedTimelessPolicyIds?: () => readonly string[];
  readonly lexical?: (input: Readonly<{
    readonly workspaceId: string;
    readonly query: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterObjectId: string | null;
  }>) => LexicalObserverPage;
  readonly source?: (input: Readonly<{
    readonly workspaceId: string;
    readonly objectId: string;
    readonly byteLimit?: number;
  }>) => SourceObserverPage;
  readonly sourceRoots?: (input: Readonly<{
    readonly workspaceId: string;
    readonly query?: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly workLimit?: number;
    readonly afterCursor: string | null;
    readonly byteLimit?: number;
    readonly nativeByteLimit?: number;
  }>) => SourceRootObserverPage;
  readonly sourceRoot?: (input: Readonly<{
    readonly workspaceId: string;
    readonly rootKind: SourceEvidenceRootKind;
    readonly rootId: string;
    readonly revision?: string;
    readonly digest?: string;
    readonly evidenceObjectId?: string | null;
    readonly byteLimit?: number;
    readonly nativeByteLimit?: number;
    readonly offset?: number;
  }>) => SourceRootHydrateObserverPage;
  readonly relation?: (input: Readonly<{
    readonly workspaceId: string;
    readonly subject: string | null;
    readonly predicate: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterAssertionId: string | null;
    readonly asOf?: string;
  }>) => RelationObserverPage;
  readonly relationKinds?: (input: Readonly<{
    readonly workspaceId: string;
    readonly subject: string | null;
    readonly limit?: number;
  }>) => readonly string[];
  readonly snapshotPin?: (workspaceId: string) => Readonly<{
    readonly source_revision: string;
    readonly applied_at?: string;
  }>;
  readonly embeddingIds?: (input: Readonly<{
    readonly workspaceId: string;
    readonly afterObjectId: string | null;
    readonly maxRows: number;
    readonly byteLimit?: number;
    readonly modelId?: string;
    readonly profile?: StoredCosineObligation;
  }>) => EmbeddingObserverPage;
  readonly measureStoredPair?: (input: Readonly<{
    readonly workspaceId: string;
    readonly objectId: string;
    readonly queryDigest: string;
    readonly profile?: StoredCosineObligation;
    readonly byteLimit?: number;
    readonly workLimit?: number;
  }>) => StoredPairMeasurement;
}>;

export type ObserverWorkReceipt = Readonly<{
  readonly work_units: number;
  readonly residual_work_units: number;
  readonly native_visits: number;
  readonly bytes_read: number;
}>;

export type ObserveConditionalFieldInput = Readonly<{
  readonly measurement_profile?: StoredCosineObligation;
  readonly lease: SnapshotReadLease;
  readonly action: ObserverAction;
  readonly cursor: ObserverCursor;
  readonly query: QueryInterpretation;
  readonly workspace_id: string;
  readonly readers: ObserverReaders;
  readonly seed_query?: string;
  readonly relation_subject?: string | null;
  readonly relation_kind?: string;
  readonly authorized_scopes?: readonly string[] | null;
  readonly permitted_timeless_policy_ids?: readonly string[];
  readonly anchor_object_ids?: readonly string[];
  readonly object_observed_at?: Readonly<Record<string, string>>;
  readonly page_limit?: number;
  readonly as_of?: string;
  readonly model_id?: string;
  readonly measurement_id?: string;
  readonly expected_model_id?: string;
  readonly expected_source_revision?: string;
  readonly source_byte_limit?: number;
}>;

export const DEFAULT_SOURCE_BYTE_LIMIT = 65_536;
/** Spare work `collectObserved` needs after native visits before hydrating one identity. */
export const SOURCE_IDENTITY_HYDRATE_RESERVE = 3;

export type ObserverActionResult = Readonly<{
  readonly page: ObserverPage;
  readonly work: ObserverWorkReceipt;
  readonly measurements?: readonly ObservationMeasurement[];
  readonly source_roots?: readonly SourceRootObserverRow[];
}>;

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;

export function toSourceObserverRow(row: Readonly<{
  readonly object_id: string;
  readonly sourceRevision: string;
  readonly event_time_start?: string | null;
  readonly observed_at?: string;
  readonly content?: string;
  readonly lifecycle_state?: string;
  readonly retention_state?: string | null;
  readonly scope_class?: string;
  readonly evidence_refs?: readonly string[];
  readonly staged_warnings?: StagedWarningArray;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
  readonly dimension?: string;
  readonly domain_tags?: readonly string[];
  readonly created_at?: string;
  readonly last_used_at?: string | null;
}>): SourceObserverRow {
  return {
    object_id: row.object_id,
    sourceRevision: row.sourceRevision,
    observed_at: row.observed_at ?? row.event_time_start ?? undefined,
    ...(row.content === undefined ? {} : { content: row.content }),
    ...(row.lifecycle_state === undefined ? {} : { lifecycle_state: row.lifecycle_state }),
    ...(row.retention_state === undefined ? {} : { retention_state: row.retention_state }),
    ...(row.scope_class === undefined ? {} : { scope_class: row.scope_class }),
    ...(row.evidence_refs === undefined ? {} : { evidence_refs: row.evidence_refs }),
    ...(row.staged_warnings === undefined ? {} : { staged_warnings: row.staged_warnings }),
    ...(row.valid_from === undefined ? {} : { valid_from: row.valid_from }),
    ...(row.valid_to === undefined ? {} : { valid_to: row.valid_to }),
    ...(row.dimension === undefined ? {} : { dimension: row.dimension }),
    ...(row.domain_tags === undefined ? {} : { domain_tags: row.domain_tags }),
    ...(row.created_at === undefined ? {} : { created_at: row.created_at }),
    ...(row.last_used_at === undefined ? {} : { last_used_at: row.last_used_at })
  };
}

export function applyUtf8HydrateToSourceRootPage(
  page: SourceRootHydrateObserverPage,
  offset: number,
  byteLimit: number
): SourceRootHydrateObserverPage {
  if (page.row === null || page.unavailable || page.row.content === undefined) return page;
  const chunk = hydrateUtf8Chunk(page.row.content, { offset, byteLimit });
  if (chunk.status === "unavailable") {
    return { row: null, rowsRead: page.rowsRead, bytesRead: page.bytesRead, unavailable: true };
  }
  return {
    row: {
      ...page.row,
      content: chunk.text,
      content_complete: chunk.complete
    },
    rowsRead: page.rowsRead,
    bytesRead: Buffer.byteLength(chunk.text, "utf8"),
    unavailable: false,
    ...(chunk.complete ? {} : { resourceLimited: true })
  };
}

export function toSourceRootObserverRow(row: SourceRootObserverRow): SourceRootObserverRow {
  return { ...row };
}

export function startObserverCursor(input: Readonly<{
  readonly cursor_id: string;
  readonly snapshot_id: string;
  readonly query_id: string;
  readonly region_id: string;
}>): ObserverCursor {
  return {
    schema_version: SCHEMA,
    cursor_id: input.cursor_id,
    snapshot_id: input.snapshot_id,
    query_id: input.query_id,
    region_id: input.region_id,
    position: null,
    committed_through: null
  };
}

export function observeConditionalField(input: ObserveConditionalFieldInput): ObserverActionResult {
  const pinWork = input.readers.snapshotPin === undefined ? 0 : SNAPSHOT_PIN_NATIVE_WORK;
  if (input.action.work_limit < pinWork) return interruptedAction(input);
  const bounded = { ...input, action: { ...input.action, work_limit: input.action.work_limit - pinWork } };
  const invalid = invalidSnapshotPage(bounded);
  const result = invalid ?? (bounded.action.work_limit === 0 ? interruptedAction(bounded) : observeAction(bounded));
  return { ...result, work: { ...result.work,
    work_units: result.work.work_units + pinWork,
    native_visits: result.work.native_visits + pinWork
  } };
}

function interruptedAction(input: ObserveConditionalFieldInput): ObserverActionResult {
  return finish({ input, cursor: input.cursor, observations: [], ids: [], truncated: true,
    readerAvailable: true, status: "interrupted", work: workReceipt(0, 0, 0, true) });
}

function observeAction(input: ObserveConditionalFieldInput): ObserverActionResult {
  switch (input.action.action) {
    case "seed":
      return observeSeed(input);
    case "adjacency":
    case "relation":
      return observeRelation(input);
    case "measurement":
      return observeStoredMeasurement(input);
  }
}

function invalidSnapshotPage(input: ObserveConditionalFieldInput): ObserverActionResult | null {
  const { lease, cursor, query, action } = input;
  const pin = input.readers.snapshotPin?.(input.workspace_id);
  const pinChanged = input.expected_source_revision !== undefined
    && pin !== undefined
    && pin.source_revision !== input.expected_source_revision;
  const modelChanged = input.model_id !== undefined
    && input.expected_model_id !== undefined
    && input.model_id !== input.expected_model_id;
  if (lease.status !== "active"
    || lease.snapshot_id !== cursor.snapshot_id
    || lease.query_id !== cursor.query_id
    || query.snapshot_id !== lease.snapshot_id
    || query.query_id !== lease.query_id
    || cursor.region_id !== action.region_id
    || pinChanged
    || modelChanged) {
    return finish({
      input,
      cursor,
      observations: [],
      ids: [],
      truncated: false,
      readerAvailable: true,
      status: "invalidated",
      work: emptyWork(0)
    });
  }
  return null;
}

function observeSeed(input: ObserveConditionalFieldInput): ObserverActionResult {
  const view = input.query.view.result_kind_view ?? "mixed";
  if (view !== "memory_only" && input.readers.sourceRoots !== undefined) {
    return observeSourceAwareSeed(input, view !== "source_only");
  }
  if (view === "source_only") {
    return unavailableOrNotApplicable(input, "unavailable");
  }
  return observeLexicalSeed(input);
}

function observeLexicalSeed(input: ObserveConditionalFieldInput): ObserverActionResult {
  const queryText = input.seed_query;
  const lexical = input.readers.lexical;
  if (queryText === undefined || lexical === undefined) {
    return unavailableOrNotApplicable(input, lexical === undefined ? "unavailable" : "not_applicable");
  }
  const page = lexical({
    workspaceId: input.workspace_id,
    query: queryText,
    limit: pageLimit(input),
    nativeLimit: input.action.work_limit,
    afterObjectId: input.cursor.committed_through
  });
  return collectObserved(input, {
    identities: page.ids,
    truncated: page.truncated,
    nativeVisits: page.nativeVisits,
    bytesRead: page.bytesRead,
    identityKind: "object",
    commitThrough: page.committedThrough ?? page.ids.at(-1) ?? input.cursor.committed_through
  });
}

function observeRelation(input: ObserveConditionalFieldInput): ObserverActionResult {
  const predicate = input.relation_kind;
  const relation = input.readers.relation;
  if (predicate === undefined || relation === undefined) {
    return unavailableOrNotApplicable(input, relation === undefined ? "unavailable" : "not_applicable");
  }
  if (input.action.action === "adjacency" && input.relation_subject === undefined) {
    return unavailableOrNotApplicable(input, "not_applicable");
  }
  const page = relation({
    workspaceId: input.workspace_id,
    subject: input.relation_subject ?? null,
    predicate,
    limit: pageLimit(input),
    nativeLimit: input.action.work_limit,
    afterAssertionId: input.cursor.committed_through,
    asOf: input.as_of ?? input.query.interpretation_clock
  });
  if (page.unavailable === true) {
    const result = unavailableOrNotApplicable(input, "unavailable");
    return { ...result, work: { work_units: page.nativeVisits, residual_work_units: 0,
      native_visits: page.nativeVisits, bytes_read: page.bytesRead } };
  }
  const rows = page.observations.filter((row) => relationRowEligible(input, row));
  return collectObserved(input, {
    identities: rows.map((row) => row.assertionId),
    truncated: page.truncated,
    nativeVisits: page.nativeVisits,
    bytesRead: page.bytesRead,
    identityKind: "assertion",
    rows,
    commitThrough: page.committedThrough ?? input.cursor.committed_through
  });
}

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

function emptyWork(nativeVisits: number): ObserverWorkReceipt {
  return workReceipt(nativeVisits, nativeVisits, 0, false);
}

export function pageLimit(input: ObserveConditionalFieldInput): number {
  return Math.min(input.page_limit ?? input.action.work_limit, input.action.work_limit);
}
