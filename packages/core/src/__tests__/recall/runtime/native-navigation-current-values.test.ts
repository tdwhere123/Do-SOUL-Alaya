import { expect, it } from "vitest";
import { MemoryDimension, QueryViewSchema, SourceSemanticResourceLedger, sourceGoldRootIdentity, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import type { FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { projectFromField } from "../../../recall/runtime/recall-field-projection.js";
import { nativeNavigationProjection } from "../../../recall/runtime/native-navigation-projection.js";
import { sourceFactKey } from "../../../recall/conditional-field/engine/binding-environment.js";
import { StatementKeyRetention } from "../../../source-index/statement-association.js";
import { startRequestCost } from "../../../recall/runtime/request-cost-ledger.js";
import type { ConditionalFieldRecallRequest } from "../../../recall/runtime/recall-service-runner-types.js";
import { defaultBudget, FAR_FUTURE_EXPIRY } from "../conditional-field/reference/deployment.fixture.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import { MEM, NOW, WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

it("uses current unreachable values after a same-cardinality navigation projection", async () => {
  let database: StorageDatabase | undefined;
  const slice = await openSourceSlice(db => { database = db; });
  try {
    await slice.writeMemory(MEM.r, "needle cache value", MemoryDimension.FACT);
    const source = hashedRecord(WS, "authored source", "catalog-source");
    new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert(source);
    const target = sourceRecallTarget({ workspace_id: WS, root_kind: "source_record", root_id: source.record_id,
      source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: source.evidence_object_id });
    const budget = defaultBudget({ work_units: 10_000, memory_bytes: 1_000_000, page_budget: 1, finalization_reserve: 100 });
    const request: ConditionalFieldRecallRequest = { workspace_id: WS, query_text: "needle", budget,
      snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: NOW, as_of: NOW, lifetime_now: NOW,
      expires_at: FAR_FUTURE_EXPIRY, authorized_scopes: null, readers: readersFor(slice),
      protocol_version: 1, supports_source_evidence: true, supported_result_kinds: ["memory_entry", "source_evidence"] };
    const interpretation = compileConditionalFieldQuery({ source: "ordinary", text: request.query_text,
      budget, snapshot_id: request.snapshot_id, interpretation_clock: NOW, authorized_scopes: null,
      view: QueryViewSchema.parse({ schema_version: 1, requested_roles: ["requested", "associated"], enumeration_policy: "native_query",
        result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"] }) });
    const initial = observeField(interpretation, { workspace_id: WS, query_text: "needle", budget,
      as_of: NOW, readers: request.readers, authorized_scopes: null });
    let retained: FieldEngineState | undefined;
    const captured = { ...initial, native_sources: { result: null, witness: [], admitted_roots: [target],
      catalog_positions: { [sourceGoldRootIdentity(target)]: 0 } } };
    const refusalObservations: unknown[] = [];
    const workRefused = nativeNavigationProjection(captured, [],
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 100_000 }), capture => refusalObservations.push(capture()));
    expect(refusalObservations).toEqual([expect.objectContaining({ status: "resource_refused", entries: [],
      navigation_refusal: { phase: expect.any(String), constraints: { work: { required: 1, available: 0 } } } })]);
    expect(workRefused).toMatchObject({ status: "resource_refused", constraints: { work: { required: 2, available: 1 } } });
    const memoryRefused = nativeNavigationProjection(captured, [],
      new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 0 }));
    expect(memoryRefused).toMatchObject({ status: "resource_refused", constraints: { memory: { available: 0 } } });
    if (memoryRefused.status !== "resource_refused") throw new Error("Expected bounded navigation refusal");
    expect(memoryRefused.constraints?.work).toBeUndefined();
    const first = projectFromField(captured, request, interpretation,
    state => { retained = state; }, startRequestCost());
    expect(first.entries.map(entry => entry.object_id)).toContain(MEM.r);
    let fitObserved = false;
    const isolated = projectFromField(captured, { ...request, observe_page_attempt: read => {
      const attempt = read();
      expect(attempt.index.entries.length).toBeGreaterThan(0);
      expect(Reflect.set(attempt.index.entries[0]!.target, "workspace_id", "tampered")).toBe(true);
      fitObserved = true;
      throw new Error("attempt observer failure");
    } }, interpretation, undefined, startRequestCost());
    expect(fitObserved).toBe(true);
    expect(isolated.entries).toEqual(first.entries);
    if (retained?.binding.kind !== "bound") throw new Error("bound fixture expected");
    const values = retained.binding.snapshot.values;
    const ordinary = nativeNavigationProjection(captured, values,
      new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 }));
    let observed = false;
    const diagnostic = nativeNavigationProjection(captured, values,
      new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 }), read => {
        const frame = read();
        expect(frame.total).toBe(values.length);
        expect(frame.entries.length).toBeGreaterThan(0);
        expect(Reflect.set(frame.entries[0]!.target, "workspace_id", "tampered")).toBe(true);
        observed = true;
        throw new Error("observer failure");
      });
    expect(observed).toBe(true);
    expect(diagnostic.status).toBe(ordinary.status);
    expect(Array.from({ length: diagnostic.values.size }, (_, index) => diagnostic.values.at(index)))
      .toEqual(Array.from({ length: ordinary.values.size }, (_, index) => ordinary.values.at(index)));
    // Optional evidence coverage must not consume the later mandatory coordinate/sort allowance.
    // This is the full projection entry, not only the source-slot helper's fallback.
    const targets = Array.from({ length: 6 }, (_, i) => ({ ...target, root_id: `catalog-${i}` }));
    const baseState = { ...captured, native_sources: { result: null, witness: [], admitted_roots: targets,
      catalog_positions: Object.fromEntries(targets.map((entry, i) => [sourceGoldRootIdentity(entry), i])) } };
    const generous = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 1_000_000 });
    const base = nativeNavigationProjection(baseState, values, generous);
    expect(base.status).toBe("ordered");
    const covered = (top: number) => {
      const retention = new StatementKeyRetention(new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 1_000_000 }),
        () => { throw new Error("unexpected retention refusal"); }, { status: "ready", vectors: [Float32Array.of(0, 1)] });
      targets.forEach((entry, i) => retention.consider(sourceFactKey(entry), 1, i === top ? Float32Array.of(0.6, 0.8) : Float32Array.of(1, 0)));
      return retention.associate(targets.map(sourceFactKey))!;
    };
    const tight = new SourceSemanticResourceLedger({ work_units: generous.spentWork + 20,
      memory_bytes: generous.spentBytes + 1024 });
    let optionalStatus: string | undefined;
    const preserved = nativeNavigationProjection({ ...baseState, native_sources: { ...baseState.native_sources, association: covered(5) } },
      values, tight, capture => { optionalStatus = capture().evidence_coverage?.status; });
    expect(preserved.status).toBe("ordered");
    expect(optionalStatus).toBe("resource_refused");
    expect(tight.spentWork).toBeGreaterThan(generous.spentWork);
    expect(Array.from({ length: preserved.values.size }, (_, i) => preserved.values.at(i)))
      .toEqual(Array.from({ length: base.values.size }, (_, i) => base.values.at(i)));
    const selectedState = { ...baseState, native_sources: { ...baseState.native_sources, association: covered(5) } };
    const funded = () => new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 1_000_000 });
    expect(nativeNavigationProjection(selectedState, values, funded()).status).toBe("ordered");
    expect(selectedState.native_sources.association.decision).toEqual({ refused: null, applied: true });
    const laterRefusal = nativeNavigationProjection(selectedState, values, new SourceSemanticResourceLedger({
      work_units: generous.spentWork, memory_bytes: 1_000_000 }));
    expect(laterRefusal.status).toBe("resource_refused");
    if (laterRefusal.status !== "resource_refused") throw new Error("expected later navigation refusal");
    expect(laterRefusal.constraints!.work!.required).toBeGreaterThan(laterRefusal.constraints!.work!.available);
    const laterMemoryRefusal = nativeNavigationProjection(selectedState, values, new SourceSemanticResourceLedger({
      work_units: 1_000_000, memory_bytes: generous.spentBytes }));
    expect(laterMemoryRefusal.status).toBe("resource_refused");
    if (laterMemoryRefusal.status !== "resource_refused") throw new Error("expected later navigation memory refusal");
    expect(laterMemoryRefusal.constraints!.memory!.required).toBeGreaterThan(laterMemoryRefusal.constraints!.memory!.available);
    expect(selectedState.native_sources.association.decision.refused).toBeNull();
    expect(nativeNavigationProjection(selectedState, values, funded()).status).toBe("ordered");
    const changed: FieldEngineState = { ...retained, projection_progress: undefined, binding: { ...retained.binding,
      snapshot: { ...retained.binding.snapshot, values: retained.binding.snapshot.values.map(value => ({ ...value,
        activation: { kind: "unreachable" as const }, milligrades: undefined, low_milligrades: undefined, high_milligrades: undefined })) } } };
    const page = projectFromField(changed, request, interpretation, undefined, startRequestCost());
    expect(page.entries).toEqual([]);
  } finally { database?.close(); }
});
