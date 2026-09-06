import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  isRelationValidityActiveAt,
  type CoverageRegion,
  type CoverageRegionKind,
  type Guard,
  type ObserverAction,
  type ObserverCursor,
  type ObserverPage,
  type ObserverStatus,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity,
  type SnapshotReadLease,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  advanceObserverCursor,
  mapNativeReaderPage
} from "../reference/accepting-projection.js";

export type LexicalObserverPage = Readonly<{
  readonly ids: readonly string[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
}>;

export type SourceObserverRow = Readonly<{
  readonly object_id: string;
  readonly sourceRevision: string;
  readonly observed_at?: string;
  readonly content?: string;
  readonly lifecycle_state?: string;
  readonly retention_state?: string | null;
  readonly scope_class?: string;
  readonly evidence_refs?: readonly string[];
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
}>;

export type SourceObserverPage = Readonly<{
  readonly row: SourceObserverRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly unavailable: boolean;
}>;

export type RelationObserverRow = Readonly<{
  readonly assertionId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly resultObjectId: string;
  readonly predicate: string;
  readonly validity?: RelationValidity;
  readonly evidenceRefs?: readonly string[];
  readonly resolutionKind?: string | null;
  readonly resolvedAt?: string | null;
}>;

export type RelationObserverPage = Readonly<{
  readonly observations: readonly RelationObserverRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
}>;

export type EmbeddingObserverPage = Readonly<{
  readonly objectIds: readonly string[];
  readonly rowVisits: number;
  readonly metadataUtf8Bytes: number;
  readonly truncated: boolean;
}>;

export type ObserverReaders = Readonly<{
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
  }>) => SourceObserverPage;
  readonly relation?: (input: Readonly<{
    readonly workspaceId: string;
    readonly subject: string | null;
    readonly predicate: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterAssertionId: string | null;
  }>) => RelationObserverPage;
  readonly relationKinds?: (input: Readonly<{
    readonly workspaceId: string;
    readonly subject: string | null;
  }>) => readonly string[];
  readonly snapshotPin?: (workspaceId: string) => Readonly<{
    readonly source_revision: string;
    readonly applied_at?: string;
  }>;
  readonly embeddingIds?: (input: Readonly<{
    readonly workspaceId: string;
    readonly afterObjectId: string | null;
    readonly maxRows: number;
  }>) => EmbeddingObserverPage;
}>;

export type ObserverWorkReceipt = Readonly<{
  readonly work_units: number;
  readonly residual_work_units: number;
  readonly native_visits: number;
  readonly bytes_read: number;
}>;

export type ObserveConditionalFieldInput = Readonly<{
  readonly lease: SnapshotReadLease;
  readonly action: ObserverAction;
  readonly cursor: ObserverCursor;
  readonly query: QueryInterpretation;
  readonly workspace_id: string;
  readonly readers: ObserverReaders;
  readonly seed_query?: string;
  readonly relation_subject?: string | null;
  readonly relation_kind?: string;
  readonly authorized_scopes?: readonly string[];
  readonly anchor_object_ids?: readonly string[];
  readonly object_observed_at?: Readonly<Record<string, string>>;
  readonly page_limit?: number;
  readonly as_of?: string;
}>;

export type ObserverActionResult = Readonly<{
  readonly page: ObserverPage;
  readonly work: ObserverWorkReceipt;
}>;

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;

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
  const invalid = invalidSnapshotPage(input);
  if (invalid !== null) return invalid;
  switch (input.action.action) {
    case "seed":
      return observeSeed(input);
    case "adjacency":
    case "relation":
      return observeRelation(input);
    case "measurement":
      return observeMeasurement(input);
  }
}

function invalidSnapshotPage(input: ObserveConditionalFieldInput): ObserverActionResult | null {
  const { lease, cursor, query, action } = input;
  if (lease.status !== "active"
    || lease.snapshot_id !== cursor.snapshot_id
    || lease.query_id !== cursor.query_id
    || query.snapshot_id !== lease.snapshot_id
    || query.query_id !== lease.query_id
    || cursor.region_id !== action.region_id) {
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
    identityKind: "object"
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
    afterAssertionId: input.cursor.committed_through
  });
  const rows = page.observations.filter((row) => relationRowEligible(input, row));
  return collectObserved(input, {
    identities: rows.map((row) => row.assertionId),
    truncated: page.truncated,
    nativeVisits: page.nativeVisits,
    bytesRead: page.bytesRead,
    identityKind: "assertion",
    rows
  });
}

function observeMeasurement(input: ObserveConditionalFieldInput): ObserverActionResult {
  const embeddingIds = input.readers.embeddingIds;
  if (embeddingIds === undefined) {
    return unavailableOrNotApplicable(input, "unavailable");
  }
  const page = embeddingIds({
    workspaceId: input.workspace_id,
    afterObjectId: input.cursor.committed_through,
    maxRows: pageLimit(input)
  });
  return collectObserved(input, {
    identities: page.objectIds,
    truncated: page.truncated,
    nativeVisits: page.rowVisits,
    bytesRead: page.metadataUtf8Bytes,
    identityKind: "embedding"
  });
}

function collectObserved(
  input: ObserveConditionalFieldInput,
  native: Readonly<{
    readonly identities: readonly string[];
    readonly truncated: boolean;
    readonly nativeVisits: number;
    readonly bytesRead: number;
    readonly identityKind: "object" | "assertion" | "embedding";
    readonly rows?: readonly RelationObserverRow[];
  }>
): ObserverActionResult {
  const observations: TypedObservation[] = [];
  let cursor = input.cursor;
  let workUnits = native.nativeVisits;
  let bytes = native.bytesRead;
  for (const [index, identity] of native.identities.entries()) {
    const prepared = prepareObservation(input, native, identity, index);
    workUnits += prepared.extraWork;
    bytes += prepared.extraBytes;
    if (prepared.observation !== null) observations.push(prepared.observation);
    cursor = advanceObserverCursor(cursor, identity);
  }
  return finish({
    input,
    cursor,
    observations,
    ids: native.identities,
    truncated: native.truncated,
    readerAvailable: true,
    work: workReceipt(workUnits, native.nativeVisits, bytes, native.truncated)
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
}> {
  if (native.identityKind === "assertion") {
    const row = native.rows?.[index];
    if (row === undefined) return { observation: null, extraWork: 0, extraBytes: 0 };
    const source = input.readers.source;
    if (source === undefined) {
      return {
        observation: maybeObservation(input, row.targetObjectId, row.assertionId, identity),
        extraWork: 0,
        extraBytes: 0
      };
    }
    const page = source({ workspaceId: input.workspace_id, objectId: row.targetObjectId });
    return {
      observation: maybeObservation(
        input,
        row.targetObjectId,
        row.assertionId,
        identity,
        page.row?.observed_at,
        page.row ?? undefined
      ),
      extraWork: Math.max(1, page.rowsRead),
      extraBytes: page.bytesRead
    };
  }
  if (native.identityKind === "embedding") {
    return {
      observation: maybeObservation(input, identity, identity, identity),
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
}> {
  const source = input.readers.source;
  if (source === undefined) {
    return {
      observation: maybeObservation(input, objectId, objectId, objectId),
      extraWork: 0,
      extraBytes: 0
    };
  }
  const page = source({ workspaceId: input.workspace_id, objectId });
  if (page.row !== null && !sourceRowEligible(input, page.row)) {
    return { observation: null, extraWork: Math.max(1, page.rowsRead), extraBytes: page.bytesRead };
  }
  if (page.row === null && (input.authorized_scopes ?? []).length > 0) {
    return { observation: null, extraWork: Math.max(1, page.rowsRead), extraBytes: page.bytesRead };
  }
  return {
    observation: maybeObservation(
      input,
      objectId,
      page.row?.sourceRevision ?? objectId,
      objectId,
      page.row?.observed_at,
      page.row ?? undefined
    ),
    extraWork: Math.max(1, page.rowsRead),
    extraBytes: page.bytesRead
  };
}

function maybeObservation(
  input: ObserveConditionalFieldInput,
  objectId: string,
  sourceRevision: string,
  observationKey: string,
  observedAt?: string,
  sourceRow?: SourceObserverRow
): TypedObservation | null {
  if (!sourceRowEligible(input, sourceRow)) return null;
  const applicability = applicabilityFor(input, objectId, observedAt, sourceRow);
  if (applicability.verdict === "false") return null;
  return {
    schema_version: SCHEMA,
    observation_id: `${input.action.region_id}:${observationKey}`,
    object_id: objectId,
    source_revision: sourceRevision,
    applicability
  };
}

function applicabilityFor(
  input: ObserveConditionalFieldInput,
  objectId: string,
  observedAt?: string,
  sourceRow?: SourceObserverRow
): Guard {
  const guards = collectGuards(input.query.program);
  const authorization = guards.find((guard) => guard.kind === "authorization");
  const scopes = input.authorized_scopes ?? [];
  if (authorization !== undefined) {
    const scope = authorization.authorization_scope;
    const allowed = scope === undefined || scopes.includes(scope);
    if (!allowed) return { ...authorization, verdict: "false" };
  } else if (scopes.length > 0) {
    const scopeClass = sourceRow?.scope_class;
    if (scopeClass === undefined || !scopes.includes(scopeClass)) {
      return { schema_version: SCHEMA, kind: "authorization", verdict: "false" };
    }
  }
  const timed = guards.find((guard) => guard.kind === "interval_relation");
  if (timed === undefined || !appliesTimeGuard(input, timed, objectId)) {
    return authorization === undefined
      ? { schema_version: SCHEMA, kind: "query_predicate", verdict: "true" }
      : { ...authorization, verdict: "true" };
  }
  return evaluateInterval(timed, input.object_observed_at?.[objectId] ?? observedAt);
}

function appliesTimeGuard(
  input: ObserveConditionalFieldInput,
  guard: Guard,
  objectId: string
): boolean {
  // Anchor-only intervals stay on seed identities; adjacency must not inherit them.
  if (input.action.action !== "seed") return false;
  if (guard.time_scope === "none") return false;
  if (guard.time_scope === "anchor") {
    const anchors = input.anchor_object_ids;
    if (anchors === undefined || anchors.length === 0) return true;
    return anchors.includes(objectId);
  }
  return true;
}

function evaluateInterval(guard: Guard, observedAt: string | undefined): Guard {
  const interval = guard.interval;
  if (observedAt === undefined || interval === undefined) {
    return { ...guard, verdict: "unresolved" };
  }
  const inside = observedAt >= interval.start && observedAt < interval.end;
  return { ...guard, verdict: inside ? "true" : "false" };
}

function collectGuards(program: QueryProgram): readonly Guard[] {
  switch (program.kind) {
    case "relation":
      return [program.guard];
    case "sequence":
      return program.steps.flatMap(collectGuards);
    case "alternative":
      return program.options.flatMap(collectGuards);
    case "repeat":
    case "closure":
      return collectGuards(program.body);
    case "hyperedge":
      return program.premises.flatMap(collectGuards);
    default:
      return [];
  }
}

function unavailableOrNotApplicable(
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

function finish(args: Readonly<{
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
  if (action === "adjacency" || action === "relation") return "adjacency";
  return "seed";
}

function workReceipt(
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

function pageLimit(input: ObserveConditionalFieldInput): number {
  return Math.min(input.page_limit ?? input.action.work_limit, input.action.work_limit);
}

function sourceRowEligible(
  input: ObserveConditionalFieldInput,
  row: SourceObserverRow | undefined
): boolean {
  if (row === undefined) {
    return (input.authorized_scopes ?? []).length === 0;
  }
  if (row.lifecycle_state !== undefined && row.lifecycle_state !== "active") return false;
  if (row.retention_state === "tombstoned") return false;
  const scopes = input.authorized_scopes ?? [];
  if (scopes.length > 0 && (row.scope_class === undefined || !scopes.includes(row.scope_class))) {
    return false;
  }
  return true;
}

function relationRowEligible(
  input: ObserveConditionalFieldInput,
  row: RelationObserverRow
): boolean {
  if (row.resolutionKind === "retracted" || row.resolutionKind === "expired" || row.resolutionKind === "contradicted") {
    return false;
  }
  if (row.validity === undefined) return false;
  const asOf = input.as_of ?? input.query.interpretation_clock;
  if (asOf === undefined) return true;
  return isRelationValidityActiveAt(row.validity, asOf, new Set());
}
