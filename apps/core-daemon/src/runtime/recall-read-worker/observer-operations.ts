import {
  InformationIndexSchema,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import {
  runConditionalFieldRecall,
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
): InformationIndex {
  const body = asPayload(payload);
  return InformationIndexSchema.parse(runConditionalFieldRecall({
    workspace_id: readString(body.workspace_id, "workspace_id"),
    query_text: readString(body.query_text, "query_text"),
    budget: body.budget as Parameters<typeof runConditionalFieldRecall>[0]["budget"],
    snapshot_id: readString(body.snapshot_id, "snapshot_id"),
    interpretation_clock: readString(body.interpretation_clock, "interpretation_clock"),
    as_of: readString(body.as_of, "as_of"),
    expires_at: readString(body.expires_at, "expires_at"),
    readers: readersFor(runtime),
    ...(body.since === undefined ? {} : { since: readString(body.since, "since") }),
    ...(body.until === undefined ? {} : { until: readString(body.until, "until") }),
    continuation: (body.continuation ?? null) as Parameters<typeof runConditionalFieldRecall>[0]["continuation"],
    cancelled: body.cancelled === true,
    ...(body.authorized_scopes === undefined
      ? {}
      : { authorized_scopes: body.authorized_scopes as readonly string[] })
  }));
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
  const maxRevisionSql = database.connection.prepare(
    `SELECT COALESCE(MAX(revision), 0) AS revision FROM event_log WHERE workspace_id = ?`
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
      const page = memory.source(input.workspaceId, input.objectId);
      return {
        row: page.row === null
          ? null
          : {
            object_id: page.row.object_id,
            sourceRevision: page.row.sourceRevision,
            observed_at: page.row.created_at
          },
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
    snapshotPin: (workspaceId) => {
      const cursor = projection.cursor(workspaceId);
      if (cursor !== null) {
        return {
          source_revision: String(cursor.appliedEventRevision),
          applied_at: cursor.appliedAt
        };
      }
      const row = maxRevisionSql.get(workspaceId) as { readonly revision: number };
      return { source_revision: String(row.revision) };
    }
  };
}

function readersFor(runtime: RecallReadWorkerRuntime): ObserverReaders {
  const existing = readersByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const created = createConditionalFieldObserverReaders(runtime.database);
  readersByRuntime.set(runtime, created);
  return created;
}
