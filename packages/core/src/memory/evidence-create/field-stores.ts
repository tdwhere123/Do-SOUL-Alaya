import type {
  AddressableSourceSpan,
  DerivationJobReceipt,
  FactorDescriptor,
  FactorIncidence,
  SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

export interface FieldFormationStores {
  getRecord(workspaceId: string, recordId: string): SourceRecordIdentity | null;
  putRecord(record: SourceRecordIdentity): SourceRecordIdentity;
  getSpan(workspaceId: string, spanId: string): AddressableSourceSpan | null;
  putSpan(span: AddressableSourceSpan): AddressableSourceSpan;
  getDescriptor(workspaceId: string, factorId: string): FactorDescriptor | null;
  putDescriptor(factor: FactorDescriptor): FactorDescriptor;
  getIncidence(workspaceId: string, incidenceId: string): FactorIncidence | null;
  putIncidence(incidence: FactorIncidence): FactorIncidence;
  getJob(workspaceId: string, jobId: string): DerivationJobReceipt | null;
  putJob(job: DerivationJobReceipt): DerivationJobReceipt;
  listRecords(workspaceId: string): readonly SourceRecordIdentity[];
  listSpans(workspaceId: string): readonly AddressableSourceSpan[];
  listFactors(workspaceId: string): readonly FactorDescriptor[];
  listIncidences(workspaceId: string): readonly FactorIncidence[];
}

export function createInMemoryFieldStores(): FieldFormationStores {
  return bindFieldStores({
    records: new Map<string, SourceRecordIdentity>(),
    spans: new Map<string, AddressableSourceSpan>(),
    factors: new Map<string, FactorDescriptor>(),
    incidences: new Map<string, FactorIncidence>(),
    jobs: new Map<string, DerivationJobReceipt>()
  });
}

function bindFieldStores(maps: Readonly<{
  readonly records: Map<string, SourceRecordIdentity>;
  readonly spans: Map<string, AddressableSourceSpan>;
  readonly factors: Map<string, FactorDescriptor>;
  readonly incidences: Map<string, FactorIncidence>;
  readonly jobs: Map<string, DerivationJobReceipt>;
}>): FieldFormationStores {
  return {
    getRecord: (workspaceId, recordId) => maps.records.get(key(workspaceId, recordId)) ?? null,
    putRecord: (record) => putSame(
      maps.records,
      key(record.workspace_id, record.identity),
      record,
      sameRecord,
      "source record"
    ),
    getSpan: (workspaceId, spanId) => maps.spans.get(key(workspaceId, spanId)) ?? null,
    putSpan: (span) => putSame(
      maps.spans,
      key(span.workspace_id, span.identity),
      span,
      sameSpan,
      "source span"
    ),
    ...bindFactorStores(maps),
    listRecords: (workspaceId) => listFor(maps.records, workspaceId),
    listSpans: (workspaceId) => listFor(maps.spans, workspaceId),
    listFactors: (workspaceId) => listFor(maps.factors, workspaceId),
    listIncidences: (workspaceId) => listFor(maps.incidences, workspaceId)
  };
}

function bindFactorStores(maps: Readonly<{
  readonly factors: Map<string, FactorDescriptor>;
  readonly incidences: Map<string, FactorIncidence>;
  readonly jobs: Map<string, DerivationJobReceipt>;
}>): Pick<
  FieldFormationStores,
  "getDescriptor" | "putDescriptor" | "getIncidence" | "putIncidence" | "getJob" | "putJob"
> {
  return {
    getDescriptor: (workspaceId, factorId) =>
      maps.factors.get(key(workspaceId, factorId)) ?? null,
    putDescriptor: (factor) => putSame(
      maps.factors,
      key(factor.workspace_id, factor.identity),
      factor,
      sameFactor,
      "factor"
    ),
    getIncidence: (workspaceId, incidenceId) =>
      maps.incidences.get(key(workspaceId, incidenceId)) ?? null,
    putIncidence: (incidence) => putSame(
      maps.incidences,
      key(incidence.workspace_id, incidence.identity),
      incidence,
      sameIncidence,
      "incidence"
    ),
    getJob: (workspaceId, jobId) => maps.jobs.get(key(workspaceId, jobId)) ?? null,
    putJob: (job) => putSame(
      maps.jobs,
      key(job.workspace_id, job.identity),
      job,
      sameJob,
      "derivation job"
    )
  };
}

function key(workspaceId: string, identity: string): string {
  return `${workspaceId}\u0000${identity}`;
}

function putSame<T>(
  store: Map<string, T>,
  storeKey: string,
  incoming: T,
  same: (existing: T, incoming: T) => boolean,
  label: string
): T {
  const existing = store.get(storeKey);
  if (existing === undefined) {
    store.set(storeKey, incoming);
    return incoming;
  }
  if (!same(existing, incoming)) {
    throw new CoreError("CONFLICT", `${label} identity replay mismatch`);
  }
  return existing;
}

function listFor<T extends { readonly workspace_id: string }>(
  store: Map<string, T>,
  workspaceId: string
): readonly T[] {
  return [...store.values()].filter((row) => row.workspace_id === workspaceId);
}

function sameRecord(existing: SourceRecordIdentity, incoming: SourceRecordIdentity): boolean {
  return existing.source_id === incoming.source_id &&
    existing.source_version === incoming.source_version &&
    existing.content_digest === incoming.content_digest &&
    existing.operator_id === incoming.operator_id &&
    existing.event_time === incoming.event_time &&
    existing.valid_from === incoming.valid_from &&
    existing.valid_to === incoming.valid_to;
}

function sameSpan(existing: AddressableSourceSpan, incoming: AddressableSourceSpan): boolean {
  return existing.record_id === incoming.record_id &&
    existing.start_offset === incoming.start_offset &&
    existing.end_offset === incoming.end_offset &&
    existing.purpose === incoming.purpose &&
    existing.producer_version === incoming.producer_version;
}

function sameFactor(existing: FactorDescriptor, incoming: FactorDescriptor): boolean {
  return existing.family === incoming.family &&
    existing.operator_id === incoming.operator_id &&
    (existing.canonical_payload === incoming.canonical_payload ||
      existing.canonical_payload === null);
}

function sameIncidence(existing: FactorIncidence, incoming: FactorIncidence): boolean {
  return existing.span_id === incoming.span_id &&
    existing.factor_id === incoming.factor_id &&
    existing.scope === incoming.scope &&
    existing.operator_id === incoming.operator_id;
}

function sameJob(existing: DerivationJobReceipt, incoming: DerivationJobReceipt): boolean {
  return existing.purpose === incoming.purpose &&
    existing.operator_id === incoming.operator_id &&
    [...existing.input_evidence_ids].sort().join("\u0000") ===
      [...incoming.input_evidence_ids].sort().join("\u0000");
}
