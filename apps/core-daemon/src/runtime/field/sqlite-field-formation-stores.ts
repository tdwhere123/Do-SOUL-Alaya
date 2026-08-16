import {
  AddressableSourceSpanSchema,
  DerivationJobReceiptSchema,
  FACTOR_INCIDENCE_OPERATOR_ID,
  FactorDescriptorSchema,
  FactorIncidenceSchema,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema,
  type AddressableSourceSpan,
  type DerivationJobReceipt,
  type FactorDescriptor,
  type FactorIncidence,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import type { FieldFormationStores } from "@do-soul/alaya-core";
import type {
  FieldDerivationJobRow,
  FieldFactorDescriptorRow,
  FieldFactorIncidenceRow,
  FieldSourceRecordRow,
  FieldSourceSpanRow,
  StorageDatabase
} from "@do-soul/alaya-storage";
import type { DaemonFieldRepos } from "./field-repos.js";

export function createSqliteFieldFormationStores(input: Readonly<{
  readonly database: StorageDatabase;
  readonly repos: DaemonFieldRepos;
}>): FieldFormationStores {
  const { database, repos } = input;
  return {
    getRecord: (workspaceId, recordId) => {
      const row = repos.records.findById(workspaceId, recordId);
      return row === null ? null : recordFromRow(row);
    },
    putRecord: (record) => recordFromRow(repos.records.insert(recordToRow(record))),
    getSpan: (workspaceId, spanId) => {
      const row = repos.spans.findById(workspaceId, spanId);
      return row === null ? null : spanFromRow(row);
    },
    putSpan: (span) => spanFromRow(repos.spans.insert(spanToRow(span))),
    getDescriptor: (workspaceId, factorId) => {
      const row = repos.factors.findDescriptor(workspaceId, factorId);
      return row === null ? null : factorFromRow(row);
    },
    putDescriptor: (factor) =>
      factorFromRow(repos.factors.insertDescriptor(factorToRow(factor))),
    getIncidence: (workspaceId, incidenceId) => {
      const row = repos.factors.findIncidence(workspaceId, incidenceId);
      return row === null ? null : incidenceFromRow(row);
    },
    putIncidence: (incidence) =>
      incidenceFromRow(repos.factors.insertIncidence(incidenceToRow(incidence))),
    getJob: (workspaceId, jobId) => {
      const row = repos.jobs.findById(workspaceId, jobId);
      return row === null ? null : jobFromRow(row);
    },
    putJob: (job) => jobFromRow(repos.jobs.insert(jobToRow(job))),
    listRecords: (workspaceId) => listMapped(
      database,
      "SELECT * FROM source_records WHERE workspace_id = ?",
      workspaceId,
      recordFromListedRow
    ),
    listSpans: (workspaceId) => listMapped(
      database,
      "SELECT * FROM source_spans WHERE workspace_id = ?",
      workspaceId,
      spanFromListedRow
    ),
    listFactors: (workspaceId) => listMapped(
      database,
      "SELECT * FROM factor_descriptors WHERE workspace_id = ?",
      workspaceId,
      factorFromListedRow
    ),
    listIncidences: (workspaceId) => listMapped(
      database,
      "SELECT * FROM factor_incidences WHERE workspace_id = ?",
      workspaceId,
      incidenceFromListedRow
    )
  };
}

function listMapped<T>(
  database: StorageDatabase,
  sql: string,
  workspaceId: string,
  map: (row: Record<string, unknown>) => T
): readonly T[] {
  const rows = database.connection.prepare(sql).all(workspaceId) as Record<string, unknown>[];
  return Object.freeze(rows.map(map));
}

function receiptFields(identity: string, producer: string, consumer: string) {
  return {
    producer,
    consumer,
    identity,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const
  };
}

function recordToRow(record: SourceRecordIdentity): FieldSourceRecordRow {
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
    source_body: null
  };
}

function recordFromRow(row: FieldSourceRecordRow): SourceRecordIdentity {
  return SourceRecordIdentitySchema.parse({
    ...receiptFields(row.record_id, SOURCE_SPAN_IDENTITY_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: row.workspace_id,
    source_id: row.source_id,
    source_version: row.source_version,
    content_digest: row.content_digest,
    evidence_object_id: row.evidence_object_id,
    recorded_at: row.recorded_at,
    event_time: row.event_time,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    operator_id: row.operator_id
  });
}

function recordFromListedRow(row: Record<string, unknown>): SourceRecordIdentity {
  return recordFromRow({
    record_id: String(row.record_id),
    workspace_id: String(row.workspace_id),
    source_id: String(row.source_id),
    source_version: String(row.source_version),
    content_digest: String(row.content_digest),
    evidence_object_id: row.evidence_object_id === null ? null : String(row.evidence_object_id),
    recorded_at: String(row.recorded_at),
    event_time: row.event_time === null ? null : String(row.event_time),
    valid_from: row.valid_from === null ? null : String(row.valid_from),
    valid_to: row.valid_to === null ? null : String(row.valid_to),
    operator_id: String(row.operator_id),
    source_body: row.source_body === null || row.source_body === undefined
      ? null
      : String(row.source_body)
  });
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

function spanFromRow(row: FieldSourceSpanRow): AddressableSourceSpan {
  return AddressableSourceSpanSchema.parse({
    ...receiptFields(row.span_id, SOURCE_SPAN_IDENTITY_OPERATOR_ID, "factor_incidence"),
    schema_version: 1,
    workspace_id: row.workspace_id,
    record_id: row.record_id,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    purpose: row.purpose,
    producer_version: row.producer_version,
    recorded_at: row.recorded_at
  });
}

function spanFromListedRow(row: Record<string, unknown>): AddressableSourceSpan {
  return spanFromRow({
    span_id: String(row.span_id),
    record_id: String(row.record_id),
    start_offset: Number(row.start_offset),
    end_offset: Number(row.end_offset),
    purpose: String(row.purpose),
    producer_version: String(row.producer_version),
    workspace_id: String(row.workspace_id),
    recorded_at: String(row.recorded_at)
  });
}

function factorToRow(factor: FactorDescriptor): FieldFactorDescriptorRow {
  return {
    factor_id: factor.identity,
    workspace_id: factor.workspace_id,
    family: factor.family,
    canonical_payload: factor.canonical_payload,
    operator_id: factor.operator_id,
    recorded_at: factor.recorded_at
  };
}

function factorFromRow(row: FieldFactorDescriptorRow): FactorDescriptor {
  return FactorDescriptorSchema.parse({
    ...receiptFields(row.factor_id, FACTOR_INCIDENCE_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: row.workspace_id,
    family: row.family,
    canonical_payload: row.canonical_payload,
    operator_id: row.operator_id,
    recorded_at: row.recorded_at
  });
}

function factorFromListedRow(row: Record<string, unknown>): FactorDescriptor {
  return factorFromRow({
    factor_id: String(row.factor_id),
    workspace_id: String(row.workspace_id),
    family: row.family as FieldFactorDescriptorRow["family"],
    canonical_payload: row.canonical_payload === null ? null : String(row.canonical_payload),
    operator_id: String(row.operator_id),
    recorded_at: String(row.recorded_at)
  });
}

function incidenceToRow(incidence: FactorIncidence): FieldFactorIncidenceRow {
  return {
    incidence_id: incidence.identity,
    span_id: incidence.span_id,
    factor_id: incidence.factor_id,
    scope: incidence.scope,
    operator_id: incidence.operator_id,
    workspace_id: incidence.workspace_id,
    recorded_at: incidence.recorded_at
  };
}

function incidenceFromRow(row: FieldFactorIncidenceRow): FactorIncidence {
  return FactorIncidenceSchema.parse({
    ...receiptFields(row.incidence_id, FACTOR_INCIDENCE_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: row.workspace_id,
    span_id: row.span_id,
    factor_id: row.factor_id,
    scope: row.scope,
    operator_id: row.operator_id,
    recorded_at: row.recorded_at
  });
}

function incidenceFromListedRow(row: Record<string, unknown>): FactorIncidence {
  return incidenceFromRow({
    incidence_id: String(row.incidence_id),
    span_id: String(row.span_id),
    factor_id: String(row.factor_id),
    scope: String(row.scope),
    operator_id: String(row.operator_id),
    workspace_id: String(row.workspace_id),
    recorded_at: String(row.recorded_at)
  });
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

function jobFromRow(row: FieldDerivationJobRow): DerivationJobReceipt {
  return DerivationJobReceiptSchema.parse({
    ...receiptFields(row.job_id, FACTOR_INCIDENCE_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: row.workspace_id,
    purpose: row.purpose,
    operator_id: row.operator_id,
    input_evidence_ids: JSON.parse(row.input_evidence_ids_json) as string[],
    status: row.status,
    disposition: row.disposition,
    recorded_at: row.recorded_at
  });
}
