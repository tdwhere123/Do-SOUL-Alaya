import { PublishedSourceInterpretationPacketSchema, sourceReferencePreparationCost, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { CoreError, authorizedScopesFromAdmission, fieldContractSha256, packetEvidenceId,
  reasonSourceInterpretation, verifyPublishedSourceInterpretation, type FieldFormationStores } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, SqliteSourceHintReader, sourceRecordFromRow,
  RETAINED_SOURCE_READ_RESERVATION, type StorageDatabase } from "@do-soul/alaya-storage";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";

type Payload = WorkerOperationPayload<"conditionalField.interpretation">;

/** Packet and source reads share the worker snapshot and the request's finite budget. */
export function runSourceInterpretationReasoning(runtime: RecallReadWorkerRuntime, payload: Payload) {
  const run = () => reasonWithinSnapshot(runtime.database, payload);
  return runtime.database.connection.inTransaction ? run() : runtime.database.connection.transaction(run)();
}

function reasonWithinSnapshot(database: StorageDatabase, payload: Payload) {
  const meter = new SourceReadBudget(payload.request.budget);
  meter.reserve(1, 16);
  const capsule = new SqliteSourceHintReader(database.connection).readBoundInterpretation(payload.workspace_id,
    packetEvidenceId(payload.request.packet_id, fieldContractSha256), meter.bytes);
  meter.charge(capsule.nativeVisits, capsule.bytesRead);
  if (capsule.status !== "complete" || capsule.gist === null) {
    throw new CoreError("CONFLICT", `interpretation packet read is ${capsule.status}`);
  }
  const bound = PublishedSourceInterpretationPacketSchema.parse(JSON.parse(capsule.gist));
  const scopeAdmission = authorizedScopesFromAdmission(payload.authorized_scopes);
  const authorized = scopeAdmission.authorized_scopes;
  if (authorized === undefined) throw new CoreError("VALIDATION", "interpretation requires explicit scope admission");
  const stores = boundedSourceStores(database, payload.workspace_id, bound.artifact_key, meter, authorized);
  // Source-reference reconstruction examines every selected source code unit, not just emitted mentions.
  const verificationWork = bound.assertions.reduce((sum, row) => sum + row.text.length + 1, 0) + bound.packet.mentions.length + 1;
  meter.reserve(verificationWork, 0);
  meter.charge(verificationWork, 0);
  const referencePreparation = sourceReferencePreparationCost(bound.assertions);
  meter.reserve(referencePreparation.work_units, referencePreparation.memory_bytes, "source reference preparation");
  meter.charge(referencePreparation.work_units, 0);
  // The source reader must preserve this workspace until Core finishes catalog reconstruction.
  meter.bytes -= referencePreparation.memory_bytes;
  const checked = verifyPublishedSourceInterpretation({ stores, sha256: fieldContractSha256 }, bound, payload.workspace_id);
  meter.bytes += referencePreparation.memory_bytes;
  const scope = checked.stored.record.scope_class;
  if (scope == null) throw new CoreError("VALIDATION", "interpretation source has no governed scope");
  return reasonSourceInterpretation({ bound: checked.bound, workspaceId: payload.workspace_id,
    scope, authorizedScopes: authorized, asOf: payload.as_of, sourceValidity: checked.stored.record,
    request: { ...payload.request, budget: { ...payload.request.budget, work_units: meter.work,
      memory_bytes: meter.bytes } }, native: { work: meter.spentWork, bytes: meter.spentBytes } });
}

function boundedSourceStores(database: StorageDatabase, workspace: string, artifact: string,
  meter: SourceReadBudget, authorized: readonly string[] | null): Pick<FieldFormationStores, "listRecords" | "getStoredRecord"> {
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  let records: SourceRecordIdentity[] | undefined;
  const stored = new Map<string, NonNullable<ReturnType<FieldFormationStores["getStoredRecord"]>>>();
  return {
    listRecords: (workspaceId) => {
      if (workspaceId !== workspace) throw new CoreError("VALIDATION", "source workspace mismatch");
      if (records !== undefined) return records;
      records = [];
      let afterRecordedAt = "";
      let afterRecordId = "";
      while (true) {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.listPageBounded(workspace, { limit: 1, afterRecordedAt, afterRecordId }, 1);
        meter.charge(5, page.rows.reduce((sum, row) => sum + row.nativeBytes + row.metadataBytes, 0));
        if (page.unavailable) throw new CoreError("CONFLICT", "source catalog is unavailable");
        const row = page.rows[0]?.record;
        if (row == null) {
          if (page.rows.length !== 0) throw new CoreError("CONFLICT", "source metadata is unavailable");
          break;
        }
        if (row.source_id === artifact) records.push(sourceRecordFromRow(row));
        afterRecordedAt = row.recorded_at; afterRecordId = row.record_id;
        if (!page.truncated) break;
      }
      return records;
    },
    getStoredRecord: (workspaceId, id) => {
      if (workspaceId !== workspace) throw new CoreError("VALIDATION", "source workspace mismatch");
      const cached = stored.get(id);
      if (cached !== undefined) return cached;
      let offset = 0;
      const chunks: string[] = [];
      let record: SourceRecordIdentity | undefined;
      while (true) {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.findByIdBounded(workspace, id, 4096, offset);
        meter.charge(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
        if (page?.record == null || page.record.source_body === null || page.invalidOffset) return null;
        record = sourceRecordFromRow(page.record);
        if (record.scope_class == null || (authorized !== null && !authorized.includes(record.scope_class))) {
          throw new CoreError("VALIDATION", "interpretation source is outside authorized scopes");
        }
        const content = page.record.source_body;
        const bytes = Buffer.byteLength(content);
        chunks.push(content); offset += bytes;
        if (offset >= page.bodyBytes) break;
        if (bytes === 0) throw new CoreError("CONFLICT", "source chunk did not advance");
      }
      const result = { record, content_bytes: chunks.join("") };
      stored.set(id, result);
      return result;
    }
  };
}

class SourceReadBudget {
  public work: number;
  public bytes: number;
  public spentWork = 0;
  public spentBytes = 0;
  public constructor(budget: Readonly<{ work_units: number; memory_bytes: number }>) {
    this.work = budget.work_units; this.bytes = budget.memory_bytes;
  }
  public reserve(work: number, bytes: number, operation = "source read"): void {
    if (work > this.work || bytes > this.bytes) throw new CoreError("CONFLICT", `interpretation ${operation} budget exhausted`,
      { subCode: "RETRYABLE_BACKPRESSURE" });
  }
  public charge(work: number, bytes: number): void {
    this.reserve(work, bytes);
    this.work -= work; this.bytes -= bytes; this.spentWork += work; this.spentBytes += bytes;
  }
}
