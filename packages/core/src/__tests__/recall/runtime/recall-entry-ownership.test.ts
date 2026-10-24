import { expect, it, vi } from "vitest";
import { indexEntryCacheKey, sourceIndexEntry, MemoryDimension, SourceSemanticResourceLedger,
  type RecallPolicy, type TaskObjectSurface } from "@do-soul/alaya-protocol";
import { executeRecall, runConditionalFieldRecallWithReceipt, type RecallExecutionParams } from "../../../recall/runtime/recall-service-runner.js";
import { capableRecallConsumerDeclaration } from "../../../recall/runtime/recall-consumer-compatibility.js";
import { captureIndexPreviews } from "../../../recall/runtime/recall-index-commit.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { encodeIndexResults, encodeRecallPageResponse } from "../../../recall/runtime/recall-page-encoding.js";
import type { ObserverReaders } from "../../../recall/conditional-field/observers/observe-ports.js";
import type { RecallServiceActiveConstraintsPort } from "../../../recall/runtime/recall-service-ports.js";
import type { ConditionalFieldRecallRequest } from "../../../recall/runtime/recall-service-runner-types.js";
import { RecallService } from "../../../recall/recall-service.js";
import { captureRecallData, captureRecallRequest, withRecallEnvironment } from "../../../recall/runtime/captured-recall-request.js";
import { fitProjectedRecallPage } from "../../../recall/runtime/recall-page-fit.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import { MEM, NOW, WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { createDependencies, createTaskSurface } from "../recall-service-test-fixtures.js";
import type { StorageDatabase } from "@do-soul/alaya-storage";

const clock = "2026-09-06T12:00:00.000Z";
const budget = { schema_version: 1 as const, work_units: 10000, memory_bytes: 1000000,
  page_budget: 8, finalization_reserve: 100, min_envelope: 10 };
const request: ConditionalFieldRecallRequest = { workspace_id: "workspace", query_text: "needle", budget,
  snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: clock, as_of: clock,
  expires_at: "2099-01-01T00:00:00.000Z", readers: {}, authorized_scopes: null };

it.each(["clock", "snapshot", "governance", "default-snapshot"])("captures Core intent and delivery controls before the %s callback", async phase => {
  const scopes: string[] = [];
  const policy = { coarse_filter: { deterministic_match: { scope_filter: scopes } },
    fine_assessment: { budgets: { max_total_tokens: 10000, max_entries: 8 } } } as unknown as RecallPolicy;
  const params = { workspaceId: "workspace", taskSurface: { display_name: "needle", runtime_id: "capture" } as TaskObjectSurface,
    strategy: "chat" as const, policyOverride: phase === "default-snapshot" ? undefined : policy,
    queryText: "needle", budget: { ...budget },
    defer_delivery: true, activeConstraintsCap: 4, ...capableRecallConsumerDeclaration() };
  const mutate = () => { scopes.push("project"); params.queryText = "changed"; params.budget.page_budget = 0;
    params.defer_delivery = false; params.activeConstraintsCap = 99; };
  const nominate = vi.fn<NonNullable<ObserverReaders["nominateSources"]>>(() => ({ result: null, witness: [] }));
  const result = await executeRecall({ dependencies: { observerReaders: { nominateSources: nominate },
    activeConstraintsPort: { readBounded: async (input: Parameters<NonNullable<RecallServiceActiveConstraintsPort["readBounded"]>>[0]) => {
      if (phase === "governance") mutate();
      expect(input.cap).toBe(4);
      return { constraints: [], paths: [], total_count: 0, completeness: "complete", temporal_uncertain: false,
        work: { native_visits: 0, bytes_read: 0, retained_bytes: 0 }, binding: { workspace_id: input.workspaceId,
          as_of: input.asOf, snapshot_id: input.snapshotId!, authorized_scopes: input.authorizedScopes } };
    } } } as never, now: () => { if (phase === "clock") mutate(); return clock; }, buildDefaultPolicy: () => policy,
    readSnapshot: { beginDeferred: async () => { if (phase === "snapshot" || phase === "default-snapshot") mutate(); }, commit() {}, rollback() {} }
  }, params as RecallExecutionParams);
  expect(result.execution_receipt?.compile_input).toMatchObject({ text: "needle", authorized_scopes: [], budget: { page_budget: 8 } });
  expect(nominate.mock.calls.map(([input]) => input.authorizedScopes)).toEqual([[]]);
  expect(result.acknowledge_delivery).toBeTypeOf("function");
  expect(scopes).toContain("project");
  expect(Object.isFrozen(params)).toBe(false);
  expect(Object.isFrozen(scopes)).toBe(false);
});

it.each([false, true])("keeps the executed query identity stable across JSON when an optional context is explicit=%s", explicit => {
  const result = runConditionalFieldRecallWithReceipt({ ...request,
    ...(explicit ? { delivery_context: undefined } : {}) });
  const receipt = result.execution_receipt;
  expect(receipt.compile_input.view).not.toHaveProperty("delivery_context");
  const transported = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  expect(compileConditionalFieldQuery(transported.compile_input).query_id).toBe(receipt.query_id);
  expect(transported.query_id).toBe(result.index.query_id);
});

it.each([false, true])("captures accounting callback before nomination with issuance mutation %s", mutateMode => {
  const original = vi.fn(), replacement = vi.fn();
  const options: { issue: "defer" | "now"; capture_budget_work: (value: number | undefined) => void } = {
    issue: "defer", capture_budget_work: original };
  const result = runConditionalFieldRecallWithReceipt({ ...request, readers: { nominateSources: () => {
    if (mutateMode) options.issue = "now";
    options.capture_budget_work = replacement; return { result: null, witness: [] };
  } } }, options);
  expect(result.issue).toBeTypeOf("function");
  expect(original).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

it("isolates post-measurement diagnostics from membership, previews and issuance", () => {
  const extra = sourceIndexEntry({ workspace_id: "workspace", root_kind: "source_record", root_id: "diagnostic-only",
    source_version: "1", content_digest: `sha256:${"c".repeat(64)}`, evidence_object_id: null,
    association_milligrades: 500, hypothesis_id: "source", output_binding: "source", program_state: "matched", time_state: "current" });
  let measured = 0;
  const result = runConditionalFieldRecallWithReceipt({ ...request,
    delivery_budget: { max_total_tokens: 100000, max_encoded_bytes: 10000 }, observe_page_fit: fit => {
      if (!fit.fits) return;
      measured = fit.bytes;
      (fit.index as unknown as { entries: typeof extra[] }).entries = [extra];
      (fit.previews as Map<string, string>).set(indexEntryCacheKey(extra), "x".repeat(20000));
      throw new Error("diagnostics must not affect the result");
    } }, { issue: "defer" });
  const previews = captureIndexPreviews(result.index, {}, "workspace");
  const envelope = encodeRecallPageResponse({ delivery_id: `delivery_${result.delivery_id}`, index: result.index,
    results: encodeIndexResults(result.index, previews, 100000), active_constraints: [], active_constraints_count: null,
    active_constraints_completeness: "incomplete", degradation_reason: null });
  expect(result.index.entries).toEqual([]);
  expect(previews.size).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBe(measured);
  expect(measured).toBeLessThanOrEqual(10000);
  expect(result.issue?.({ index: result.index, previews, metadata: {} })).toBeTypeOf("string");
});

it("keeps codec-owned references from mutating the page after measurement", () => {
  let codecIndex: unknown;
  const result = runConditionalFieldRecallWithReceipt({ ...request, encode_page: index => {
    codecIndex = index; return { index };
  }, observe_page_fit: () => {
    (codecIndex as { entries: unknown[] }).entries = [{ unexpected: true }];
  } }, { issue: "defer" });
  expect(result.index.entries).toEqual([]);
});

it("holds empty delivery retention while a codec spends every available byte", () => {
  const baseline = runConditionalFieldRecallWithReceipt({ ...request, encode_page: () => ({ ok: true }) }, { issue: "defer" });
  let offered = 0;
  const result = runConditionalFieldRecallWithReceipt({ ...request, encode_page: (_index, _previews, _metadata, owner) => {
    offered += owner.bytes; owner.charge(1, owner.bytes, "metadata consumes available memory"); return { ok: true };
  } }, { issue: "defer" });
  expect(offered).toBeLessThan(budget.memory_bytes);
  expect(offered + baseline.execution_receipt.actual!.retained_bytes_current).toBe(budget.memory_bytes);
  expect(result.execution_receipt.actual?.retained_bytes_current).toBe(budget.memory_bytes);
  // Control admission precedes observation: a codec consuming that allowance
  // prevents field allocation rather than inheriting baseline preparation costs.
  expect(result.execution_receipt.actual!.phases.observe.charged_retained_bytes).toBe(0);
  expect(result.execution_receipt.actual!.charged_retained_bytes)
    .toBe(offered + baseline.execution_receipt.actual!.retained_bytes_current);
  expect(result.issue?.({ index: result.index, previews: new Map(), metadata: {} })).toBeTypeOf("string");
});

class DomainRecord {}
function classRecord<T extends object>(data: T): T {
  return Object.assign(new DomainRecord(), data);
}

const representations = ["plain", "class-policy", "class-params", "nested-classes"] as const;
type Representation = typeof representations[number];
type CallbackPhase = "clock" | "default-policy" | "snapshot" | "governance";

function publicRecallFixture(representation: Representation, phase?: CallbackPhase, scope: "empty" | "null" | "unbound" = "empty") {
  let mutate = () => {};
  const invoke = (current: CallbackPhase) => { if (phase === current) mutate(); };
  const nominate = vi.fn<NonNullable<ObserverReaders["nominateSources"]>>(() => ({ result: null, witness: [] }));
  const service = new RecallService({ now: () => { invoke("clock"); return clock; },
    generateRuntimeId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    defaultPolicyDecorator: (policy: RecallPolicy) => { invoke("default-policy"); return policy; },
    observerReaders: { nominateSources: nominate },
    readSnapshot: { beginDeferred: () => invoke("snapshot"), commit() {}, rollback() {} },
    activeConstraintsPort: { readBounded: async (input: Parameters<NonNullable<RecallServiceActiveConstraintsPort["readBounded"]>>[0]) => {
      invoke("governance");
      expect(input.cap).toBe(4);
      return { constraints: [], paths: [], total_count: 0, completeness: "complete", temporal_uncertain: false,
        work: { native_visits: 0, bytes_read: 0, retained_bytes: 0 }, binding: { workspace_id: input.workspaceId,
          as_of: input.asOf, snapshot_id: input.snapshotId!, authorized_scopes: input.authorizedScopes } };
    } }
  } as never);
  const nested = <T extends object>(data: T): T => representation === "nested-classes" ? classRecord(data) : data;
  const scopes: "project"[] = [];
  const defaultPolicy = service.buildDefaultPolicy("chat", "capture", clock);
  const match = nested({ ...defaultPolicy.coarse_filter.deterministic_match,
    scope_filter: scope === "empty" ? scopes : null });
  if (scope === "unbound") Reflect.deleteProperty(match, "scope_filter");
  const policyData = { ...defaultPolicy, coarse_filter: nested({ ...defaultPolicy.coarse_filter, deterministic_match: match }),
    fine_assessment: nested({ ...defaultPolicy.fine_assessment, budgets: nested({ ...defaultPolicy.fine_assessment.budgets }) }) };
  const policy = representation === "class-policy" ? classRecord(policyData) : policyData;
  const data = { workspaceId: "workspace", taskSurface: nested({ display_name: "needle", runtime_id: "capture" } as TaskObjectSurface),
    strategy: "chat" as const, policyOverride: phase === "default-policy" ? undefined : policy,
    queryText: "needle", pageBudget: 8, budget: nested({ ...budget }), timeFilter: nested({ since: clock }),
    defer_delivery: true, activeConstraintsCap: 4, ...capableRecallConsumerDeclaration() };
  const params = representation === "class-params" ? classRecord(data) : data;
  mutate = () => {
    scopes.push("project"); match.scope_filter = ["project"];
    params.queryText = "retargeted"; params.pageBudget = 0; params.budget.page_budget = 0;
    params.timeFilter.since = "2026-09-07T12:00:00.000Z";
    policy.fine_assessment.budgets.max_total_tokens = 1;
    params.defer_delivery = false; params.activeConstraintsCap = 99;
  };
  return { service, params, scopes, nominate, mutate, policy };
}

it.each(representations)("captures public %s domain data before clock, snapshot and governance callbacks", async representation => {
  const baseline = publicRecallFixture("plain");
  const expected = await baseline.service.recall(baseline.params);
  for (const phase of ["clock", "snapshot", "governance"] as const) {
    const fixture = publicRecallFixture(representation, phase);
    const result = await fixture.service.recall(fixture.params);
    expect(result.execution_receipt?.compile_input).toMatchObject({ text: "needle", since: clock,
      authorized_scopes: [], budget: { page_budget: 8 }, view: { delivery_budget: { max_total_tokens: 3000 } } });
    expect(result.index.query_id).toBe(expected.index.query_id);
    expect(fixture.nominate.mock.calls.map(([input]) => input.authorizedScopes)).toEqual([[]]);
    expect(result.acknowledge_delivery).toBeTypeOf("function");
    expect(fixture.params.queryText).toBe("retargeted");
    expect(fixture.scopes).toEqual(["project"]);
    expect(Object.isFrozen(fixture.params)).toBe(false);
    expect(Object.isFrozen(fixture.params.budget)).toBe(false);
    expect(Object.isFrozen(fixture.policy)).toBe(false);
    fixture.mutate();
    expect(result.execution_receipt?.compile_input.authorized_scopes).toEqual([]);
  }
});

it.each(representations)("captures public %s params before default-policy resolution without changing defaults", async representation => {
  const fixture = publicRecallFixture(representation, "default-policy");
  const result = await fixture.service.recall(fixture.params);
  expect(result.execution_receipt?.compile_input).toMatchObject({ text: "needle", authorized_scopes: null,
    since: clock, budget: { page_budget: 8 } });
  expect(result.acknowledge_delivery).toBeTypeOf("function");
  expect(fixture.params.queryText).toBe("retargeted");
});

it.each(representations)("preserves empty, unrestricted and unbound scope states for public %s policy", async representation => {
  for (const scope of ["empty", "null", "unbound"] as const) {
    const fixture = publicRecallFixture(representation, "clock", scope);
    const result = await fixture.service.recall(fixture.params);
    const input = result.execution_receipt!.compile_input;
    expect(input.authorized_scopes).toEqual(scope === "empty" ? [] : scope === "null" ? null : undefined);
    expect(Object.hasOwn(input, "authorized_scopes")).toBe(scope !== "unbound");
    expect(fixture.nominate.mock.calls.map(([nomination]) => nomination.authorizedScopes))
      .toEqual(scope === "unbound" ? [] : [scope === "empty" ? [] : null]);
    expect(result.index.entries).toEqual([]);
    if (scope === "unbound") expect(result.index.completeness.logical_index).toBe("invalidated");
  }
});

it.each([false, true])("captures the public query and page-budget shorthand without an explicit budget for class params %s", async useClass => {
  const data = { workspaceId: "workspace", taskSurface: { display_name: "needle", runtime_id: "capture" } as TaskObjectSurface,
    strategy: "chat" as const, queryText: "needle", pageBudget: 8, ...capableRecallConsumerDeclaration() };
  const params = useClass ? classRecord(data) : data;
  const service = new RecallService({ now: () => { params.queryText = "changed"; params.pageBudget = 0; return clock; },
    generateRuntimeId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never);
  const result = await service.recall(params);
  expect(result.execution_receipt?.compile_input.text).toBe("needle");
  expect(result.execution_receipt?.requested_budget.page_budget).toBe(8);
  expect(params.queryText).toBe("changed"); expect(params.pageBudget).toBe(0);
  expect(Object.isFrozen(params)).toBe(false);
});

it("owns class-backed continuation and nested selections rather than retaining domain instances", () => {
  const scopes: string[] = [];
  const continuation = classRecord({ query_id: "original", authorized_scopes: scopes,
    view: classRecord({ requested_roles: ["requested"] }) });
  const original = classRecord({ continuation, budget: classRecord({ ...budget }) });
  const captured = captureRecallData(original);
  continuation.query_id = "retargeted"; scopes.push("project"); continuation.view.requested_roles.push("associated");
  original.budget.page_budget = 0;
  expect(captured).toEqual({ continuation: { query_id: "original", authorized_scopes: [],
    view: { requested_roles: ["requested"] } }, budget });
  expect(Object.isFrozen(captured.continuation.view.requested_roles)).toBe(true);
  expect(Object.isFrozen(continuation)).toBe(false);
});

it("keeps explicit reader capabilities, cancellation signals and codecs live while capturing class data", () => {
  const controller = new AbortController();
  class Readers {
    signal = controller.signal;
    calls = 0;
    nominateSources: NonNullable<ObserverReaders["nominateSources"]> = () => {
      expect(this.signal).toBe(controller.signal);
      this.calls++; return { result: null, witness: [] };
    };
  }
  const readers = new Readers(), encode = vi.fn(() => ({ ok: true })), observe = vi.fn();
  const captured = captureRecallRequest(classRecord({ ...request, readers, budget: classRecord({ ...budget }) }));
  const composed = withRecallEnvironment(captured, { encode_page: encode, observe_page_fit: observe });
  expect(composed.readers).toBe(readers);
  expect(composed.encode_page).toBe(encode);
  expect(composed.observe_page_fit).toBe(observe);
  runConditionalFieldRecallWithReceipt(composed, { issue: "defer" });
  expect(readers.calls).toBe(1);
  expect(encode).toHaveBeenCalled(); expect(observe).toHaveBeenCalled();
  controller.abort();
  expect(composed.readers).toHaveProperty("signal.aborted", true);
  expect(Object.isFrozen(readers)).toBe(false);
  expect(Object.isFrozen(controller.signal)).toBe(false);
});

it("captures a valid class-backed continuation before the public clock can retarget its query", async () => {
  const databases: StorageDatabase[] = [];
  const slice = await openSourceSlice(database => databases.push(database));
  try {
    for (const [index, id] of [MEM.r, MEM.c, MEM.h].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    let mutate = () => {};
    const service = new RecallService({ ...createDependencies().dependencies,
      now: () => { mutate(); return NOW; }, observerReaders: readersFor(slice) });
    const params = { taskSurface: { ...createTaskSurface(), display_name: "needle" },
      workspaceId: WS, strategy: "chat" as const, queryText: "needle", pageBudget: 1,
      budget: { ...budget, work_units: 2000, page_budget: 1, finalization_reserve: 20, min_envelope: 1 },
      ...capableRecallConsumerDeclaration() };
    const first = await service.recall(params);
    expect(first.index.continuation).not.toBeNull();
    const continuation = classRecord(structuredClone(first.index.continuation!));
    mutate = () => { expect(Reflect.set(continuation, "query_id", "retargeted")).toBe(true); };
    const second = await service.recall({ ...params, continuation });
    expect(continuation.query_id).toBe("retargeted");
    expect(second.index.query_id).toBe(first.index.query_id);
    expect(second.index.completeness.logical_index).not.toBe("invalidated");
    expect(second.issued_delivery_id).toBeDefined();
  } finally {
    for (const database of databases) database.close();
  }
});

it("isolates class-backed metadata retained by a page codec from later caller mutation", () => {
  const metadata = { source: classRecord({ evidence_refs: ["safe"] }) };
  let retained = metadata;
  const fitted = fitProjectedRecallPage({ index: runConditionalFieldRecallWithReceipt(request).index,
    previews: new Map(), metadata, request_digest: "owned-metadata",
    meter: new SourceSemanticResourceLedger({ work_units: 10000, memory_bytes: 1000000 }),
    request: { ...request, encode_page: (_index, _previews, captured) => {
      retained = captured as typeof metadata;
      expect(Object.isFrozen(retained.source)).toBe(true);
      return { captured };
    }, observe_page_fit: () => { metadata.source.evidence_refs[0] = "retargeted"; } } });
  expect(fitted.fits).toBe(true);
  expect(retained.source.evidence_refs).toEqual(["safe"]);
  expect(metadata.source.evidence_refs).toEqual(["retargeted"]);
  expect(Object.isFrozen(metadata.source)).toBe(false);
});

it.each([new Map(), new Date(clock), () => undefined])("rejects non-record domain representations before calling the public clock: %s", unsupported => {
  const fixture = publicRecallFixture("plain");
  const now = vi.fn(() => clock);
  const service = new RecallService({ now } as never);
  const invalidBudget = Object.assign(unsupported, { ...budget });
  return expect(service.recall({ ...fixture.params, budget: invalidBudget })).rejects.toThrow(TypeError)
    .then(() => expect(now).not.toHaveBeenCalled());
});
