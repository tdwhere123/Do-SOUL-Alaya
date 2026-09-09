import {
  EnumerationPolicySchema,
  InformationIndexSchema,
  PayloadContinuationRequestSchema,
  QueryInterpretationProposalSchema,
  ResultKindViewSchema,
  sourceRecallTarget
} from "@do-soul/alaya-protocol";
import {
  captureIndexPreviews,
  captureIndexSourceMetadata,
  fieldContractSha256,
  runConditionalFieldRecall,
  runConditionalFieldRecallWithReceipt,
  reserveSnapshotPinWork,
  snapshotIdFromPin,
  applyUtf8HydrateToSourceRootPage,
  toSourceObserverRow,
  toSourceRootObserverRow,
  type ConditionalFieldRecallPortResult,
  type ObserverReaders
} from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteIndexedRecallProjection,
  SqliteMemoryRecallReader,
  SqliteRelationRecallReader,
  SqliteSourceRootRecallReader,
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
  const reserved = reserveSnapshotPinWork(body.budget as Parameters<typeof runConditionalFieldRecall>[0]["budget"]);
  const readers: ObserverReaders = reserved.permitted && body.cancelled !== true ? readersFor(runtime) : {};
  let governance = body.governance as Parameters<typeof runConditionalFieldRecall>[0]["governance"];
  const snapshotId = "snapshotPin" in readers && readers.snapshotPin !== undefined
    ? snapshotIdFromPin(workspaceId, readers.snapshotPin(workspaceId))
    : readString(body.snapshot_id, "snapshot_id");
  if (governance?.completeness === "incomplete" && governance.work.native_visits === 0
    && governance.paths.length === 0 && governance.constraints.length === 0) {
    governance = { ...governance, binding: { ...governance.binding, snapshot_id: snapshotId } };
  }
  if (reserved.permitted && governance !== undefined && (governance.binding.workspace_id !== workspaceId
    || governance.binding.snapshot_id !== snapshotId || governance.binding.as_of !== body.as_of)) {
    throw new Error("conditional field governance snapshot mismatch");
  }
  const executed = runConditionalFieldRecallWithReceipt({
    workspace_id: workspaceId,
    query_text: readString(body.query_text, "query_text"),
    budget: reserved.budget,
    ...(body.requested_budget === undefined ? {} : {
      requested_budget: body.requested_budget as Parameters<typeof runConditionalFieldRecall>[0]["budget"]
    }),
    snapshot_id: snapshotId,
    ...(governance === undefined ? {} : { governance }),
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
      : { authorized_scopes: body.authorized_scopes as readonly string[] }),
    ...(body.enumeration_policy === undefined
      ? {}
      : { enumeration_policy: EnumerationPolicySchema.parse(body.enumeration_policy) }),
    ...(body.result_kind_view === undefined
      ? {}
      : { result_kind_view: ResultKindViewSchema.parse(body.result_kind_view) }),
    ...(body.interpretation_proposal === undefined
      ? {}
      : {
        interpretation_proposal: QueryInterpretationProposalSchema.parse(body.interpretation_proposal)
      }),
    ...(body.payload_continuation === undefined
      ? {}
      : {
        payload_continuation: PayloadContinuationRequestSchema.parse(body.payload_continuation)
      })
  });
  const index = executed.index;
  return {
    execution_receipt: executed.execution_receipt,
    index: InformationIndexSchema.parse(index),
    previews: Object.fromEntries(captureIndexPreviews(index, readers, workspaceId)),
    source_metadata: captureIndexSourceMetadata(index)
  };
}

export function createConditionalFieldObserverReaders(database: StorageDatabase, permittedTimelessPolicyIds: readonly string[] = []): ObserverReaders {
  const memory = new SqliteMemoryRecallReader(database);
  const relation = new SqliteRelationRecallReader(database);
  const projection = new SqliteIndexedRecallProjection(database.connection);
  const sourceRoots = new SqliteSourceRootRecallReader(
    new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
    new SqliteEvidenceCapsuleRepo(database)
  );
  const kindsSql = database.connection.prepare(
    `SELECT relation_kind AS kind FROM relation_assertions
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
    sourceRoots: (input) => {
      const page = sourceRoots.page({
        workspaceId: input.workspaceId,
        limit: input.limit,
        nativeLimit: input.nativeLimit,
        afterCursor: input.afterCursor,
        byteLimit: input.byteLimit
      });
      return {
        rows: page.rows.map(toSourceRootObserverRow),
        nativeVisits: page.nativeVisits,
        nativeBytes: page.nativeBytes,
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        truncated: page.truncated,
        committedThrough: page.committedThrough,
        unavailable: page.unavailable
      };
    },
    sourceRoot: (input) => {
      if (input.revision === undefined || input.digest === undefined) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const loaded = sourceRoots.load(
        input.workspaceId,
        sourceRecallTarget({
          workspace_id: input.workspaceId,
          root_kind: input.rootKind,
          root_id: input.rootId,
          source_version: input.revision,
          content_digest: input.digest,
          evidence_object_id: input.evidenceObjectId ?? (input.rootKind === "evidence_capsule" ? input.rootId : null)
        })
      );
      return applyUtf8HydrateToSourceRootPage({
        row: loaded.row === null ? null : toSourceRootObserverRow(loaded.row),
        rowsRead: loaded.rowsRead,
        bytesRead: loaded.bytesRead,
        unavailable: loaded.unavailable,
        resourceLimited: loaded.resourceLimited
      }, input.offset ?? 0, input.byteLimit ?? 65536);
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
