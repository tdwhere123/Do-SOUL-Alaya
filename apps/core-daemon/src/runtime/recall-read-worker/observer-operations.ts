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
  const index = runConditionalFieldRecall({
    workspace_id: workspaceId,
    query_text: readString(body.query_text, "query_text"),
    budget: body.budget as Parameters<typeof runConditionalFieldRecall>[0]["budget"],
    snapshot_id: snapshotIdFromPin(workspaceId, readers.snapshotPin?.(workspaceId)),
    interpretation_clock: readString(body.interpretation_clock, "interpretation_clock"),
    as_of: readString(body.as_of, "as_of"),
    expires_at: readString(body.expires_at, "expires_at"),
    ...(body.lifetime_now === undefined ? {} : { lifetime_now: readString(body.lifetime_now, "lifetime_now") }),
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
  });
  return {
    index: InformationIndexSchema.parse(index),
    previews: Object.fromEntries(captureIndexPreviews(index, readers, workspaceId))
  };
}

export function createConditionalFieldObserverReaders(database: StorageDatabase, permittedTimelessPolicyIds: readonly string[] = []): ObserverReaders {
  const memory = new SqliteMemoryRecallReader(database);
  const relation = new SqliteRelationRecallReader(database);
  const projection = new SqliteIndexedRecallProjection(database.connection);
  memory.prepareIndex();
  relation.prepareIndex();
  const kindsSql = database.connection.prepare(
    `SELECT relation_kind AS kind FROM relation_assertions INDEXED BY idx_relation_recall_predicate
     WHERE workspace_id = ? AND relation_kind > ? ORDER BY relation_kind LIMIT 1`
  );
  return {
    permittedTimelessPolicyIds: () => permittedTimelessPolicyIds,
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
        unavailable: page.unavailable,
        resourceLimited: page.resourceLimited
      };
    },
    relation: (input) => relation.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId,
      input.asOf
    ),
    relationKinds: (input) => {
      const kinds: string[] = [];
      for (let i = 0; i < Math.min(512, input.limit ?? 32); i += 1) {
        const row = kindsSql.get(input.workspaceId, kinds.at(-1) ?? "") as { readonly kind: string } | undefined;
        if (row === undefined) break;
        kinds.push(row.kind);
      }
      return kinds;
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
