import {
  sameFactorDescriptorFields,
  type AddressableSourceSpan,
  type DerivationJobReceipt,
  type FactorDescriptor,
  type FactorIncidence,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

export interface FieldFormationStores {
  runAtomic<T>(work: () => T): T;
  getRecord(workspaceId: string, recordId: string): SourceRecordIdentity | null;
  getStoredRecord(workspaceId: string, recordId: string): StoredSourceRecord | null;
  putRecord(record: SourceRecordIdentity, contentBytes: string): SourceRecordIdentity;
  getSpan(workspaceId: string, spanId: string): AddressableSourceSpan | null;
  putSpan(span: AddressableSourceSpan): AddressableSourceSpan;
  getDescriptor(workspaceId: string, factorId: string): FactorDescriptor | null;
  putDescriptor(factor: FactorDescriptor): FactorDescriptor;
  getIncidence(workspaceId: string, incidenceId: string): FactorIncidence | null;
  putIncidence(incidence: FactorIncidence): FactorIncidence;
  getJob(workspaceId: string, jobId: string): DerivationJobReceipt | null;
  putJob(job: DerivationJobReceipt): DerivationJobReceipt;
  listRecords(workspaceId: string): readonly SourceRecordIdentity[];
  listStoredRecords(workspaceId: string): readonly StoredSourceRecord[];
  listSpans(workspaceId: string): readonly AddressableSourceSpan[];
  listFactors(workspaceId: string): readonly FactorDescriptor[];
  listIncidences(workspaceId: string): readonly FactorIncidence[];
  listRecordEvidenceBindings(workspaceId: string): readonly SourceRecordEvidenceBinding[];
}

export type StoredSourceRecord = Readonly<{
  readonly record: SourceRecordIdentity;
  readonly content_bytes: string;
}>;

export type SourceRecordEvidenceBinding = Readonly<{
  readonly workspace_id: string;
  readonly record_id: string;
  readonly evidence_object_id: string;
}>;

export function createInMemoryFieldStores(): FieldFormationStores {
  return bindFieldStores({
    records: new Map<string, SourceRecordIdentity>(),
    recordBodies: new Map<string, string>(),
    spans: new Map<string, AddressableSourceSpan>(),
    factors: new Map<string, FactorDescriptor>(),
    incidences: new Map<string, FactorIncidence>(),
    jobs: new Map<string, DerivationJobReceipt>(),
    evidenceBindings: new Map<string, SourceRecordEvidenceBinding>()
  });
}

function bindFieldStores(maps: Readonly<{
  readonly records: Map<string, SourceRecordIdentity>;
  readonly recordBodies: Map<string, string>;
  readonly spans: Map<string, AddressableSourceSpan>;
  readonly factors: Map<string, FactorDescriptor>;
  readonly incidences: Map<string, FactorIncidence>;
  readonly jobs: Map<string, DerivationJobReceipt>;
  readonly evidenceBindings: Map<string, SourceRecordEvidenceBinding>;
}>): FieldFormationStores {
  return {
    runAtomic: (work) => runInMemoryAtomic(maps, work),
    getRecord: (workspaceId, recordId) => maps.records.get(key(workspaceId, recordId)) ?? null,
    getStoredRecord: (workspaceId, recordId) => storedRecord(maps, workspaceId, recordId),
    putRecord: (record, contentBytes) => putRecordWithBinding(maps, record, contentBytes),
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
    listStoredRecords: (workspaceId) => listFor(maps.records, workspaceId).map((record) => {
      const stored = storedRecord(maps, workspaceId, record.identity);
      if (stored === null) {
        throw new CoreError("OBLIGATION_VIOLATION", "source body is unavailable");
      }
      return stored;
    }),
    listSpans: (workspaceId) => listFor(maps.spans, workspaceId),
    listFactors: (workspaceId) => listFor(maps.factors, workspaceId),
    listIncidences: (workspaceId) => listFor(maps.incidences, workspaceId),
    listRecordEvidenceBindings: (workspaceId) =>
      listFor(maps.evidenceBindings, workspaceId)
  };
}

function putRecordWithBinding(
  maps: Readonly<{
    readonly records: Map<string, SourceRecordIdentity>;
    readonly recordBodies: Map<string, string>;
    readonly evidenceBindings: Map<string, SourceRecordEvidenceBinding>;
  }>,
  record: SourceRecordIdentity,
  contentBytes: string
): SourceRecordIdentity {
  const persisted = putSame(
    maps.records,
    key(record.workspace_id, record.identity),
    record,
    sameRecord,
    "source record"
  );
  putSame(
    maps.recordBodies,
    key(record.workspace_id, record.identity),
    contentBytes,
    (existing, incoming) => existing === incoming,
    "source body"
  );
  if (record.evidence_object_id !== null) {
    const binding = Object.freeze({
      workspace_id: record.workspace_id,
      record_id: record.identity,
      evidence_object_id: record.evidence_object_id
    });
    maps.evidenceBindings.set(
      key(record.workspace_id, `${record.identity}\u0000${record.evidence_object_id}`),
      binding
    );
  }
  return persisted;
}

function storedRecord(
  maps: Readonly<{
    readonly records: Map<string, SourceRecordIdentity>;
    readonly recordBodies: Map<string, string>;
  }>,
  workspaceId: string,
  recordId: string
): StoredSourceRecord | null {
  const record = maps.records.get(key(workspaceId, recordId));
  const content = maps.recordBodies.get(key(workspaceId, recordId));
  return record === undefined || content === undefined
    ? null
    : Object.freeze({ record, content_bytes: content });
}

function runInMemoryAtomic<T>(
  maps: Readonly<{
    readonly records: Map<string, SourceRecordIdentity>;
    readonly recordBodies: Map<string, string>;
    readonly spans: Map<string, AddressableSourceSpan>;
    readonly factors: Map<string, FactorDescriptor>;
    readonly incidences: Map<string, FactorIncidence>;
    readonly jobs: Map<string, DerivationJobReceipt>;
    readonly evidenceBindings: Map<string, SourceRecordEvidenceBinding>;
  }>,
  work: () => T
): T {
  const stores = Object.values(maps) as Map<string, unknown>[];
  const snapshots = stores.map((store) => new Map(store));
  try {
    return work();
  } catch (error) {
    stores.forEach((store, index) => {
      store.clear();
      for (const [key, value] of snapshots[index] ?? []) store.set(key, value);
    });
    throw error;
  }
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
  return existing.identity === incoming.identity &&
    sameFactorDescriptorFields(existing, incoming);
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
