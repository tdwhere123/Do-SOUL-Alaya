import { afterEach, describe, expect, it } from "vitest";
import {
  type AddressableSourceSpan,
  type FactorDescriptor,
  type FactorIncidence,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import {
  SqliteFieldEraseBarrierRepo,
  SqliteFieldFactorRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo,
  type FieldFactorDescriptorRow,
  type FieldFactorIncidenceRow,
  type FieldSourceRecordRow,
  type FieldSourceSpanRow,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { emitDeterministicIncidences } from "../../memory/evidence-create/factor-emit.js";
import { persistDescriptors, persistIncidences, createFactorIncidencePort } from
  "../../memory/evidence-create/factor-incidence.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import { createSourceAdmissionPort } from "../../memory/evidence-create/source-admission.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import {
  CLOCK,
  openFieldDatabase
} from "../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";

const BODY = "atlas";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("shared factor source erase", () => {
  it("keeps independent support, continues formation, and refuses last-source resurrection", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const repos = {
      records: new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
      spans: new SqliteFieldSourceSpanRepo(database, fieldContractSha256),
      factors: new SqliteFieldFactorRepo(database, fieldContractSha256),
      erase: new SqliteFieldEraseBarrierRepo(database, fieldContractSha256)
    };
    const first = formSource("src-1", "00000000-0000-4000-8000-000000000001");
    const second = formSource("src-2", "00000000-0000-4000-8000-000000000002");
    persistFormedSource(database, repos, first);
    persistFormedSource(database, repos, second);
    const shared = sharedContentFactors(first.emitted.factors, second.emitted.factors);
    expect(shared.length).toBeGreaterThan(0);
    const sharedId = shared[0]!.identity;
    const firstIncidence = first.emitted.incidences.find((row) => row.factor_id === sharedId)!;
    const secondIncidence = second.emitted.incidences.find((row) => row.factor_id === sharedId)!;

    expect(repos.erase.apply(sourceBarrier("barrier-first", first.record.identity)))
      .toMatchObject({ subject_id: first.record.identity });
    expect(repos.erase.apply(sourceBarrier("barrier-first", first.record.identity)))
      .toMatchObject({ subject_id: first.record.identity });
    expect(repos.factors.findIncidence("workspace-1", firstIncidence.identity)).toBeNull();
    expect(repos.factors.findIncidence("workspace-1", secondIncidence.identity)).toEqual(
      incidenceRow(secondIncidence)
    );
    expect(repos.factors.findDescriptor("workspace-1", sharedId)?.canonical_payload)
      .toBe(shared[0]!.canonical_payload);

    persistFormedSource(database, repos, second);
    expect(repos.factors.findDescriptor("workspace-1", sharedId)?.canonical_payload)
      .toBe(shared[0]!.canonical_payload);
    expect(repos.factors.insertIncidence(incidenceRow(secondIncidence))).toEqual(
      incidenceRow(secondIncidence)
    );

    expect(repos.erase.apply(sourceBarrier("barrier-second", second.record.identity)))
      .toMatchObject({ subject_id: second.record.identity });
    expect(repos.erase.apply(sourceBarrier("barrier-second", second.record.identity)))
      .toMatchObject({ subject_id: second.record.identity });
    expect(repos.factors.findDescriptor("workspace-1", sharedId)?.canonical_payload).toBeNull();
    expect(() => repos.factors.insertDescriptor(factorRow(shared[0]!)))
      .toThrow(/collision|erased/u);
    expect(() => repos.factors.insertIncidence(incidenceRow(secondIncidence)))
      .toThrow(/erased|check failed/u);
  });

  it("terminates a single-source shared token and refuses replay", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const repos = {
      records: new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
      spans: new SqliteFieldSourceSpanRepo(database, fieldContractSha256),
      factors: new SqliteFieldFactorRepo(database, fieldContractSha256),
      erase: new SqliteFieldEraseBarrierRepo(database, fieldContractSha256)
    };
    const only = formSource("src-1", "00000000-0000-4000-8000-000000000001");
    persistFormedSource(database, repos, only);
    const token = only.emitted.factors.find((factor) =>
      factor.family === "f0" && factor.canonical_payload === BODY
    );
    expect(token).toBeDefined();
    repos.erase.apply(sourceBarrier("barrier-only", only.record.identity));
    expect(repos.factors.findDescriptor("workspace-1", token!.identity)?.canonical_payload).toBeNull();
    expect(() => repos.factors.insertDescriptor(factorRow(token!))).toThrow(/collision|erased/u);
  });
});

function formSource(sourceId: string, evidenceObjectId: string) {
  const stores = createInMemoryFieldStores();
  const admitted = createSourceAdmissionPort({ sha256: fieldContractSha256, stores }).admit({
    workspace_id: "workspace-1",
    source_id: sourceId,
    source_version: "v1",
    content_bytes: BODY,
    evidence_object_id: evidenceObjectId,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    spans: [{ start_offset: 0, end_offset: BODY.length, purpose: "native_structure" }]
  });
  const emitted = emitDeterministicIncidences({
    sha256: fieldContractSha256,
    recorded_at: CLOCK,
    workspace_id: "workspace-1",
    scope: "workspace-1",
    source_id: sourceId,
    source_version: "v1",
    content_bytes: BODY,
    actor: "user_action",
    event_time: null,
    valid_from: null,
    valid_to: null,
    spans: admitted.spans,
    factFrameSlots: [],
    semanticSurfaces: []
  });
  persistDescriptors(stores, emitted.factors);
  persistIncidences(createFactorIncidencePort({ sha256: fieldContractSha256, stores }), emitted.incidences);
  return { record: admitted.record, spans: admitted.spans, emitted, body: BODY };
}

function persistFormedSource(
  database: StorageDatabase,
  repos: {
    records: SqliteFieldSourceRecordRepo;
    spans: SqliteFieldSourceSpanRepo;
    factors: SqliteFieldFactorRepo;
  },
  formed: {
    record: SourceRecordIdentity;
    spans: readonly AddressableSourceSpan[];
    emitted: { factors: readonly FactorDescriptor[]; incidences: readonly FactorIncidence[] };
    body: string;
  }
): void {
  seedEvidenceCapsule(database, formed.record.evidence_object_id);
  repos.records.insert(recordRow(formed.record, formed.body));
  for (const span of formed.spans) repos.spans.insert(spanRow(span));
  for (const factor of formed.emitted.factors) repos.factors.insertDescriptor(factorRow(factor));
  for (const incidence of formed.emitted.incidences) repos.factors.insertIncidence(incidenceRow(incidence));
}

function sharedContentFactors(
  left: readonly FactorDescriptor[],
  right: readonly FactorDescriptor[]
): readonly FactorDescriptor[] {
  const rightIds = new Set(right.map((factor) => factor.identity));
  return left.filter((factor) =>
    rightIds.has(factor.identity) &&
    factor.canonical_payload !== null &&
    !factor.canonical_payload.startsWith("source_id:") &&
    !factor.canonical_payload.startsWith("source:") &&
    !factor.canonical_payload.startsWith("source_version:")
  );
}

function seedEvidenceCapsule(database: StorageDatabase, evidenceId: string | null): void {
  if (evidenceId === null) return;
  database.connection.prepare(`
    INSERT OR IGNORE INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'test', 'file_content',
      '{"topic":"atlas","keywords":["atlas"],"summary":"atlas"}',
      '{"event_type":"test","event_id":null,"occurred_at":"2026-08-16T00:00:00.000Z"}',
      '{"file_path":"atlas.txt","line_range":null,"symbol_name":null,"artifact_ref":null}', 'verified',
      'atlas', 'atlas', 'atlas-hash', 'run-atlas', 'workspace-1', NULL)
  `).run(evidenceId, CLOCK, CLOCK);
}

function sourceBarrier(barrierId: string, subjectId: string) {
  return {
    barrier_id: barrierId,
    workspace_id: "workspace-1",
    generation_id: null,
    subject_kind: "source_record" as const,
    subject_id: subjectId,
    erased_at: CLOCK
  };
}

function recordRow(record: SourceRecordIdentity, body: string): FieldSourceRecordRow {
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
    source_body: body
  };
}

function spanRow(span: AddressableSourceSpan): FieldSourceSpanRow {
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

function factorRow(factor: FactorDescriptor): FieldFactorDescriptorRow {
  return {
    factor_id: factor.identity,
    workspace_id: factor.workspace_id,
    family: factor.family,
    canonical_payload: factor.canonical_payload,
    operator_id: factor.operator_id,
    recorded_at: factor.recorded_at
  };
}

function incidenceRow(incidence: FactorIncidence): FieldFactorIncidenceRow {
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
