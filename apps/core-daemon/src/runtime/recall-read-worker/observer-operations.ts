import {
  InformationIndexSchema
} from "@do-soul/alaya-protocol";
import {
  captureIndexPreviews,
  runConditionalFieldRecall,
  snapshotIdFromPin,
  toSourceObserverRow,
  type ConditionalFieldRecallPortResult,
  type ObserverReaders
} from "@do-soul/alaya-core";
import {
  SqliteIndexedRecallProjection,
  SqliteMemoryRecallReader,
  SqliteRelationRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { asPayload, readString } from "./payload-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

const readersByRuntime = new WeakMap<RecallReadWorkerRuntime, ObserverReaders>();

export function runConditionalFieldWorkerRecall(
  runtime: RecallReadWorkerRuntime,
  payload: unknown
): ConditionalFieldRecallPortResult {
  const body = asPayload(payload);
  const workspaceId = readString(body.workspace_id, "workspace_id");
  const readers = readersFor(runtime);
  const index = InformationIndexSchema.parse(runConditionalFieldRecall({
    workspace_id: workspaceId,
    query_text: readString(body.query_text, "query_text"),
    budget: body.budget as Parameters<typeof runConditionalFieldRecall>[0]["budget"],
    snapshot_id: snapshotIdFromPin(workspaceId, readers.snapshotPin?.(workspaceId)),
    interpretation_clock: readString(body.interpretation_clock, "interpretation_clock"),
    as_of: readString(body.as_of, "as_of"),
    expires_at: readString(body.expires_at, "expires_at"),
    readers,
    ...(body.since === undefined ? {} : { since: readString(body.since, "since") }),
    ...(body.until === undefined ? {} : { until: readString(body.until, "until") }),
    ...(body.time_field === undefined ? {} : { time_field: readString(body.time_field, "time_field") as "created_at" | "last_used_at" }),
    ...(body.dimension_filter === undefined ? {} : { dimension_filter: body.dimension_filter as readonly string[] }),
    ...(body.domain_tag_filter === undefined ? {} : { domain_tag_filter: body.domain_tag_filter as readonly string[] }),
    continuation: (body.continuation ?? null) as Parameters<typeof runConditionalFieldRecall>[0]["continuation"],
    cancelled: body.cancelled === true,
    ...(body.authorized_scopes === undefined
      ? {}
      : { authorized_scopes: body.authorized_scopes as readonly string[] })
  }));
  return {
    index,
    previews: Object.fromEntries(captureIndexPreviews(index, readers, workspaceId))
  };
}

export function createConditionalFieldObserverReaders(database: StorageDatabase): ObserverReaders {
  const memory = new SqliteMemoryRecallReader(database);
  const relation = new SqliteRelationRecallReader(database);
  const projection = new SqliteIndexedRecallProjection(database.connection);
  memory.prepareIndex();
  relation.prepareIndex();
  const kindsSql = database.connection.prepare(
    `SELECT DISTINCT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ?
       AND (? IS NULL OR lower(json_extract(anchors_json, '$.source_anchor.object_id')) = ?)`
  );
  return {
    lexical: (input) => memory.lexical(
      input.workspaceId,
      input.query,
      input.limit,
      input.nativeLimit,
      input.afterObjectId
    ),
    source: (input) => {
      const page = memory.source(
        input.workspaceId,
        input.objectId,
        input.byteLimit ?? 65536
      );
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => relation.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId
    ),
    relationKinds: (input) => {
      const subject = input.subject === null ? null : input.subject.toLowerCase();
      const rows = kindsSql.all(input.workspaceId, subject, subject) as { readonly kind: string }[];
      return rows.map((row) => row.kind);
    },
    snapshotPin: (workspaceId) => projection.observablePin(workspaceId)
  };
}

function readersFor(runtime: RecallReadWorkerRuntime): ObserverReaders {
  const existing = readersByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const created = createConditionalFieldObserverReaders(runtime.database);
  readersByRuntime.set(runtime, created);
  return created;
}
