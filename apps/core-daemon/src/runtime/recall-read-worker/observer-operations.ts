import {
  InformationIndexSchema,
  sourceRecallTarget
} from "@do-soul/alaya-protocol";
import {
  assertRecallConsumerCompatibility,
  captureIndexPreviews,
  captureIndexSourceMetadata,
  commitIssuedDelivery,
  fieldContractSha256,
  issuedDeliveryIdOf,
  pendingIssuedDeliveryOf,
  runConditionalFieldRecallWithReceipt,
  reserveSnapshotPinWork,
  snapshotIdFromPin,
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
import { withWorkerActualCost } from "../recall/worker-actual-cost.js";
import { storedMeasurementReaders } from "./stored-measurement-readers.js";
import type { ConditionalFieldRecallWorkerPayload } from "./protocol.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

const readersByRuntime = new WeakMap<RecallReadWorkerRuntime, ObserverReaders>();

export function runConditionalFieldWorkerRecall(
  runtime: RecallReadWorkerRuntime,
  payload: ConditionalFieldRecallWorkerPayload
): ConditionalFieldRecallPortResult {
  assertRecallConsumerCompatibility(payload);
  const workspaceId = payload.workspace_id;
  const reserved = reserveSnapshotPinWork(payload.budget);
  const readers: ObserverReaders = reserved.permitted && payload.cancelled !== true ? readersFor(runtime) : {};
  let governance = payload.governance;
  const snapshotId = "snapshotPin" in readers && readers.snapshotPin !== undefined
    ? snapshotIdFromPin(workspaceId, readers.snapshotPin(workspaceId))
    : payload.snapshot_id;
  if (governance?.completeness === "incomplete" && governance.work.native_visits === 0
    && governance.paths.length === 0 && governance.constraints.length === 0) {
    governance = { ...governance, binding: { ...governance.binding, snapshot_id: snapshotId } };
  }
  if (reserved.permitted && governance !== undefined && (governance.binding.workspace_id !== workspaceId
    || governance.binding.snapshot_id !== snapshotId || governance.binding.as_of !== payload.as_of)) {
    throw new Error("conditional field governance snapshot mismatch");
  }
  const executed = withWorkerActualCost(readers, (instrumented) => runConditionalFieldRecallWithReceipt({
    workspace_id: workspaceId,
    query_text: payload.query_text,
    budget: reserved.budget,
    ...(payload.requested_budget === undefined ? {} : {
      requested_budget: payload.requested_budget
    }),
    snapshot_id: snapshotId,
    ...(governance === undefined ? {} : { governance }),
    interpretation_clock: payload.interpretation_clock,
    as_of: payload.as_of,
    expires_at: payload.expires_at,
    ...(payload.lifetime_now === undefined ? {} : { lifetime_now: payload.lifetime_now }),
    readers: instrumented,
    ...(payload.since === undefined ? {} : { since: payload.since }),
    ...(payload.until === undefined ? {} : { until: payload.until }),
    ...(payload.time_field === undefined ? {} : { time_field: payload.time_field }),
    ...(payload.dimension_filter === undefined ? {} : { dimension_filter: payload.dimension_filter }),
    ...(payload.domain_tag_filter === undefined ? {} : { domain_tag_filter: payload.domain_tag_filter }),
    continuation: payload.continuation ?? null,
    cancelled: payload.cancelled === true,
    ...(payload.authorized_scopes === undefined
      ? {}
      : { authorized_scopes: payload.authorized_scopes }), // null stays present; omitted stays omitted.
    ...(payload.enumeration_policy === undefined
      ? {}
      : { enumeration_policy: payload.enumeration_policy }),
    ...(payload.result_kind_view === undefined
      ? {}
      : { result_kind_view: payload.result_kind_view }),
    ...(payload.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: payload.interpretation_proposal }),
    ...(payload.payload_continuation === undefined
      ? {}
      : { payload_continuation: payload.payload_continuation }),
    ...(payload.cap_contracts === undefined ? {} : { cap_contracts: payload.cap_contracts }),
    ...(payload.claim_demands === undefined ? {} : { claim_demands: payload.claim_demands }),
    ...(payload.protocol_version === undefined ? {} : { protocol_version: payload.protocol_version }),
    ...(payload.supported_result_kinds === undefined
      ? {}
      : { supported_result_kinds: payload.supported_result_kinds }),
    ...(payload.supports_source_evidence === undefined
      ? {}
      : { supports_source_evidence: payload.supports_source_evidence }),
    ...(payload.supports_product_updates === undefined
      ? {}
      : { supports_product_updates: payload.supports_product_updates })
  }));
  const index = InformationIndexSchema.parse(executed.index);
  const previews = captureIndexPreviews(executed.index, readers, workspaceId);
  const source_metadata = captureIndexSourceMetadata(executed.index);
  const pending = pendingIssuedDeliveryOf(executed.index);
  // Retry RPC lands in this worker heap, so the issued ledger stays here — not
  // the parent. Payload is already finalized in projectAcceptingIndex; preview
  // capture is this process's encode boundary. Parent encodeRecallResult /
  // encodeIndexResults only wrap tokens and keep every index.entries identity.
  const issuedDeliveryId = pending === undefined
    ? issuedDeliveryIdOf(executed.index)
    : commitIssuedDelivery({
      ...pending,
      index,
      previews,
      metadata: source_metadata
    });
  return {
    execution_receipt: executed.execution_receipt,
    index,
    previews: Object.fromEntries(previews),
    source_metadata,
    ...(issuedDeliveryId === undefined ? {} : { issued_delivery_id: issuedDeliveryId })
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
    sourceRootMetadataByteLimit: 8192,
    sourceRootChunkByteLimit: 4096,
    sourceRoots: (input) => {
      const page = sourceRoots.page({
        workspaceId: input.workspaceId,
        query: input.query,
        limit: input.limit,
        nativeLimit: input.nativeLimit,
        workLimit: input.workLimit,
        afterCursor: input.afterCursor,
        byteLimit: input.byteLimit,
        nativeByteLimit: input.nativeByteLimit
      });
      return {
        rows: page.rows.map(toSourceRootObserverRow),
        nativeVisits: page.nativeVisits,
        nativeBytes: page.nativeBytes,
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
        truncated: page.truncated,
        committedThrough: page.committedThrough,
        unavailable: page.unavailable
      };
    },
    sourceRoot: (input) => {
      if (input.revision === undefined || input.digest === undefined) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const page = sourceRoots.hydrate(
        input.workspaceId,
        sourceRecallTarget({
          workspace_id: input.workspaceId,
          root_kind: input.rootKind,
          root_id: input.rootId,
          source_version: input.revision,
          content_digest: input.digest,
          evidence_object_id: input.evidenceObjectId ?? (input.rootKind === "evidence_capsule" ? input.rootId : null)
        }),
        input.byteLimit ?? 65536,
        input.offset ?? 0,
        // 12288 is the retained chunk+metadata reservation; logical clip is separate.
        input.nativeByteLimit ?? Math.max(input.byteLimit ?? 65536, 12_288)
      );
      return {
        row: page.row === null ? null : toSourceRootObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
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
    snapshotPin: (workspaceId) => projection.observablePin(workspaceId),
    ...storedMeasurementReaders(database)
  };
}

function readersFor(runtime: RecallReadWorkerRuntime): ObserverReaders {
  const existing = readersByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const created = createConditionalFieldObserverReaders(runtime.database);
  readersByRuntime.set(runtime, created);
  return created;
}
