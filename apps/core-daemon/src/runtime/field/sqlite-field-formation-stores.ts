import type {
  AddressableSourceSpan,
  DerivationJobReceipt,
  SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { CoreError, type FieldAtomicOutcome, type FieldFormationStores } from "@do-soul/alaya-core";
import {
  putSourceStatementArtifact, putSourceStatementMemoryBinding,
  jobFromRow,
  sourceRecordFromRow,
  sourceSpanFromRow,
  type FieldDerivationJobRow,
  type FieldSourceRecordRow,
  type FieldSourceSpanRow,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { DaemonFieldRepos } from "./field-repos.js";

export function createSqliteFieldFormationStores(input: Readonly<{
  readonly repos: DaemonFieldRepos;
  readonly database: StorageDatabase;
}>): FieldFormationStores {
  const { repos } = input;
  return {
    runAtomic: (work) => input.database.connection.transaction(work)(),
    runAtomicWithOutcome: (work) => runSqliteAtomicWithOutcome(input.database, work),
    getRecord: (workspaceId, recordId) => {
      const row = repos.records.findById(workspaceId, recordId);
      return row === null ? null : sourceRecordFromRow(row);
    },
    getCurrentRecord: (workspaceId, sourceId) => {
      const row = repos.records.findCurrent(workspaceId, sourceId);
      return row === null ? null : sourceRecordFromRow(row);
    },
    getStoredRecord: (workspaceId, recordId) => storedRecordFromRow(repos.records.findById(workspaceId, recordId)),
    putSourceStatementArtifact: artifact => putSourceStatementArtifact(input.database, artifact),
    putSourceStatementMemoryBinding: (workspaceId, memoryId, evidenceId) =>
      putSourceStatementMemoryBinding(input.database, workspaceId, memoryId, evidenceId),
    putRecord: (record, contentBytes) =>
      sourceRecordFromRow(repos.records.insert(recordToRow(record, contentBytes))),
    getHostInventory: (workspaceId, recordId) => repos.records.getHostInventory(workspaceId, recordId),
    putHostInventory: (workspaceId, recordId, inventory) => repos.records.putHostInventory(workspaceId, recordId, inventory),
    hasHostCaptureResourceLimit: (workspaceId, recordId) => repos.records.hasHostCaptureResourceLimit(workspaceId, recordId),
    putHostCaptureResourceLimit: (workspaceId, recordId) => repos.records.putHostCaptureResourceLimit(workspaceId, recordId),
    getSpan: (workspaceId, spanId) => {
      const row = repos.spans.findById(workspaceId, spanId);
      return row === null ? null : sourceSpanFromRow(row);
    },
    putSpan: (span) => sourceSpanFromRow(repos.spans.insert(spanToRow(span))),
    getJob: (workspaceId, jobId) => {
      const row = repos.jobs.findById(workspaceId, jobId);
      return row === null ? null : jobFromRow(row);
    },
    putJob: (job) => jobFromRow(repos.jobs.insert(jobToRow(job))),
    listRecords: (workspaceId) =>
      Object.freeze(repos.records.listByWorkspace(workspaceId).map(sourceRecordFromRow)),
    listStoredRecords: (workspaceId) => listStoredSources(repos.records.listByWorkspace(workspaceId)),
    listSpans: (workspaceId) =>
      Object.freeze(repos.spans.listByWorkspace(workspaceId).map(sourceSpanFromRow)),
    listRecordEvidenceBindings: (workspaceId) =>
      Object.freeze(repos.records.listEvidenceBindings(workspaceId))
  };
}

function storedRecordFromRow(row: FieldSourceRecordRow | null) {
  return row?.source_body == null ? null : Object.freeze({
    record: sourceRecordFromRow(row),
    content_bytes: row.source_body
  });
}

function listStoredSources(rows: readonly FieldSourceRecordRow[]) {
  return Object.freeze(rows.flatMap(row => {
    const stored = storedRecordFromRow(row);
    return stored === null ? [] : [stored];
  }));
}

function runSqliteAtomicWithOutcome<T>(database: StorageDatabase, work: () => T): FieldAtomicOutcome<T> {
  const connection = database.connection;
  if (connection.inTransaction) {
    return { status: "not_committed", cause: new CoreError("CONFLICT", "source replacement requires a top-level transaction") };
  }
  let entered = false;
  let callbackFailed = false;
  let callbackFailure: unknown;
  try {
    const result = connection.transaction(() => {
      entered = true;
      try { return work(); }
      catch (cause) { callbackFailed = true; callbackFailure = cause; throw cause; }
    }).immediate();
    return { status: "committed", result, projection: "ready" };
  } catch (cause) {
    // better-sqlite3 rethrows the callback error only after rollback (or SQLite
    // auto-rollback). A rollback error replaces it. A COMMIT error is unknown:
    // do not infer this invocation's result from the source subsequently read.
    if (!connection.inTransaction && (!entered || (callbackFailed && cause === callbackFailure))) {
      return { status: "not_committed", cause };
    }
    return { status: "unknown", cause };
  }
}

function recordToRow(
  record: SourceRecordIdentity,
  contentBytes: string
): FieldSourceRecordRow {
  return {
    record_id: record.identity,
    workspace_id: record.workspace_id,
    source_id: record.source_id,
    source_version: record.source_version,
    content_digest: record.content_digest,
    evidence_object_id: record.evidence_object_id,
    recorded_at: record.recorded_at,
    event_time: record.event_time,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
    operator_id: record.operator_id,
    speaker: record.speaker ?? null,
    scope_class: record.scope_class ?? null,
    attribution_context: record.attribution_context ?? null,
    ...(record.source_representation === undefined ? {} : { source_representation: record.source_representation }),
    ...(record.host_structure === undefined ? {} : { host_structure: record.host_structure }),
    source_body: contentBytes
  };
}

function spanToRow(span: AddressableSourceSpan): FieldSourceSpanRow {
  return {
    span_id: span.identity,
    record_id: span.record_id,
    start_offset: span.start_offset,
    end_offset: span.end_offset,
    purpose: span.purpose,
    producer_version: span.producer_version,
    workspace_id: span.workspace_id,
    recorded_at: span.recorded_at
  };
}

function jobToRow(job: DerivationJobReceipt): FieldDerivationJobRow {
  return {
    job_id: job.identity,
    workspace_id: job.workspace_id,
    purpose: job.purpose,
    operator_id: job.operator_id,
    input_evidence_ids_json: JSON.stringify(job.input_evidence_ids),
    status: job.status,
    disposition: job.disposition,
    recorded_at: job.recorded_at
  };
}
