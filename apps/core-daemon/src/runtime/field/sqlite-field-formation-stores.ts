import type {
  AddressableSourceSpan,
  DerivationJobReceipt,
  FactorDescriptor,
  FactorIncidence,
  SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import type { FieldFormationStores } from "@do-soul/alaya-core";
import {
  factorFromRow,
  incidenceFromRow,
  jobFromRow,
  sourceRecordFromRow,
  sourceSpanFromRow,
  type FieldDerivationJobRow,
  type FieldFactorDescriptorRow,
  type FieldFactorIncidenceRow,
  type FieldSourceRecordRow,
  type FieldSourceSpanRow
} from "@do-soul/alaya-storage";
import type { DaemonFieldRepos } from "./field-repos.js";

export function createSqliteFieldFormationStores(input: Readonly<{
  readonly repos: DaemonFieldRepos;
}>): FieldFormationStores {
  const { repos } = input;
  return {
    getRecord: (workspaceId, recordId) => {
      const row = repos.records.findById(workspaceId, recordId);
      return row === null ? null : sourceRecordFromRow(row);
    },
    putRecord: (record) => sourceRecordFromRow(repos.records.insert(recordToRow(record))),
    getSpan: (workspaceId, spanId) => {
      const row = repos.spans.findById(workspaceId, spanId);
      return row === null ? null : sourceSpanFromRow(row);
    },
    putSpan: (span) => sourceSpanFromRow(repos.spans.insert(spanToRow(span))),
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
    listRecords: (workspaceId) =>
      Object.freeze(repos.records.listByWorkspace(workspaceId).map(sourceRecordFromRow)),
    listSpans: (workspaceId) =>
      Object.freeze(repos.spans.listByWorkspace(workspaceId).map(sourceSpanFromRow)),
    listFactors: (workspaceId) =>
      Object.freeze(repos.factors.listDescriptors(workspaceId).map(factorFromRow)),
    listIncidences: (workspaceId) =>
      Object.freeze(repos.factors.listIncidences(workspaceId).map(incidenceFromRow))
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
