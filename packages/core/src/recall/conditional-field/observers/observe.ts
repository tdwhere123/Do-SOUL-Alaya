import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  SNAPSHOT_PIN_NATIVE_WORK,
  type ObserverCursor,
  type StagedWarningArray
} from "@do-soul/alaya-protocol";
import {
  relationRowEligible
} from "./observation-admission.js";
import { hydrateUtf8Chunk } from "../../../memory/evidence-create/source-utf8-hydrate.js";
import { observeSourceAwareSeed } from "./source-root-observe.js";
import { observeStoredMeasurement } from "./measure-stored.js";
import {
  type ObserveConditionalFieldInput,
  type ObserverActionResult,
  type SourceObserverRow,
  type SourceRootHydrateObserverPage,
  type SourceRootObserverRow
} from "./observe-ports.js";
import {
  collectObserved,
  emptyWork,
  finish,
  pageLimit,
  unavailableOrNotApplicable,
  workReceipt
} from "./observe-collect.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;

export type {
  ObservationMeasurement,
  StoredEmbeddingVector,
  StoredPairMeasurement
} from "./measure-stored.js";
export { hasMeasurementProducer, queryDigestOf } from "./measure-stored.js";
export type {
  EmbeddingObserverPage,
  LexicalObserverPage,
  ObserveConditionalFieldInput,
  ObserverActionResult,
  ObserverReaders,
  ObserverWorkReceipt,
  RelationObserverPage,
  RelationObserverRow,
  SourceObserverPage,
  SourceObserverRow,
  SourceRootHydrateObserverPage,
  SourceRootObserverPage,
  SourceRootObserverRow
} from "./observe-ports.js";
export {
  DEFAULT_SOURCE_BYTE_LIMIT,
  SOURCE_IDENTITY_HYDRATE_RESERVE
} from "./observe-ports.js";
export {
  collectObserved,
  finish,
  pageLimit,
  unavailableOrNotApplicable,
  workReceipt
} from "./observe-collect.js";


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

