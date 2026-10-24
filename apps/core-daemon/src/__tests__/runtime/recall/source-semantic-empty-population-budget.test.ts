import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, sourceSemanticAccessPhases, sourceSemanticExecution,
  SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, ORDINARY_NATIVE_FIELD_RESULT_VERSION } from "@do-soul/alaya-protocol";
import { createSourceSemanticAccessPolicy, sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticObserver, readSourceSemanticObservation } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { reserveEmptyInterpretationCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import { queryPreparationLease, semanticLeaseGroupAccountingCost } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { preparationAccessReceiptValue, sourceSemanticAccessReceiptValue } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { ORIGINAL, QUERY_BUDGET, SCOPES, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

it.each([{ name: "omitted", accessHint: undefined }, { name: "maximum-length", accessHint: "x".repeat(1024) }])(
  "reserves $name hint retention and prior work at the exact completion boundary", async ({ accessHint }) => {
  await withAccessLibrary([], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const runtime = { database } as RecallReadWorkerRuntime;
    const policy = createSourceSemanticAccessPolicy("orchid irrigation", undefined, "query-conditioned-v1",
      new SourceSemanticReadBudget(ACCESS_BUDGET));
    const leaseContext = { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
      expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: "orchid irrigation" };
    const attempt = (allowance: { work_units: number; memory_bytes: number }) => {
      const parent = new SourceSemanticReadBudget(allowance);
      // Isolate the explicit quote boundary; parent-only borrowing and complete
      // finalization are checked through the observation owner in retention tests.
      const child = new SourceSemanticReadBudget(allowance);
      child.charge(107, 229, "already observed header");
      let error: unknown;
      try {
        reserveEmptyInterpretationCompletion({ runtime, parent, child, records: [], sourcePages: 1,
          policy: "query-conditioned-v1", budget: ACCESS_BUDGET,
          orderCost: policy.orderCost, accessHint, leaseContext });
      } catch (caught) { error = caught; }
      finally { parent.absorb(child); }
      return { parent, child, error };
    };
    try {
      const ampleBudget = { work_units: 1_000_000, memory_bytes: 1_000_000 };
      const ample = attempt(ampleBudget);
      expect(ample.error).toBeUndefined();
      const workReserve = ample.parent.work - ample.child.work;
      const byteReserve = ample.parent.bytes - ample.child.bytes;
      const actual = new SourceSemanticReadBudget(ampleBudget);
      const digest = `sha256:${"a".repeat(64)}`;
      const receipt = sourceSemanticAccessReceiptValue(new SourceSemanticReadBudget(ampleBudget),
        "query-conditioned-v1", digest, [], [], false, false, []);
      const pool = { sources: [], descriptors: [], access: { ...receipt, pool_id: digest }, sourcePages: 1, interpretationPages: 1,
        ...(accessHint === undefined ? {} : { accessHint }) };
      actual.retain([]);
      actual.retain(receipt, "access receipt identity", "borrow");
      actual.retain(preparationAccessReceiptValue(pool, 0, 0, 0), "access trace delivery", "borrow");
      actual.retain(sourceSemanticExecution());
      actual.retain({ ...queryPreparationLease(leaseContext, pool, 0, 0, false), kind: "query" }, "preparation lease", "borrow");
      actual.charge(semanticLeaseGroupAccountingCost(1), 0);
      expect(workReserve).toBeGreaterThanOrEqual(actual.spentWork);
      expect(byteReserve).toBeGreaterThanOrEqual(actual.spentBytes);
      const exactBudget = { work_units: ample.parent.spentWork + workReserve,
        memory_bytes: ample.parent.spentBytes + byteReserve };
      const exact = attempt(exactBudget);
      expect(exact.error).toBeUndefined();
      expect(exact.child.work).toBe(0);
      expect(exact.child.bytes).toBe(0);
      expect(exact.parent.spentWork).toBeLessThanOrEqual(exactBudget.work_units);
      expect(exact.parent.spentBytes).toBeLessThanOrEqual(exactBudget.memory_bytes);
      for (const short of [{ ...exactBudget, work_units: exactBudget.work_units - 1 },
        { ...exactBudget, memory_bytes: exactBudget.memory_bytes - 1 }]) {
        const rejected = attempt(short);
        expect(rejected.error).toBeInstanceOf(SourceSemanticResourceExhausted);
        expect(rejected.parent.spentWork).toBeLessThanOrEqual(short.work_units);
        expect(rejected.parent.spentBytes).toBeLessThanOrEqual(short.memory_bytes);
        expect(rejected.parent.spentWork).toBeGreaterThan(107);
      }
    } finally { database.close(); closeCachedDatabase(filename); }
  });
});

it("reserves real v2 nomination metadata, execution evidence and both frozen leases at exact and adjacent completion boundaries", async () => {
  await withIndexedSources(Array.from({ length: 17 }, (_, index) => ({ id: `raw-${index}`,
    text: `Granite wall ${index}.`, vector: [0, 1, 0] })), async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL,
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const observed = fixture.database.connection.transaction(() => observeSourceSemanticAccess(runtime, {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared,
      request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }
    }, ["project"], new SourceSemanticReadBudget(QUERY_BUDGET), ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET))();
    expect(observed.sources).toHaveLength(17);
    expect(sourceSemanticAccessPhases(observed.access).acquisition.result?.nominations).toHaveLength(16);
    const phases = { preparation: observed.access.phases[1], acquisition: observed.access.phases[2] };
    const order = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", new SourceSemanticReadBudget(ACCESS_BUDGET));
    const context = { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
      expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: ORIGINAL };
    const attempt = (allowance: { work_units: number; memory_bytes: number }) => {
      const parent = new SourceSemanticReadBudget(allowance), child = new SourceSemanticReadBudget(allowance);
      child.charge(107, 229);
      let error: unknown;
      try { reserveEmptyInterpretationCompletion({ runtime, parent, child, records: observed.sources,
        sourcePages: observed.sourcePages, policy: "query-conditioned-v1", budget: ACCESS_BUDGET,
        orderCost: order.orderCost, leaseContext: context, phases,
        retainedWitness: observed.retainedWitness, catalogPositions: observed.catalogPositions }); }
      catch (caught) { error = caught; }
      finally { parent.absorb(child); }
      return { parent, child, error };
    };
    const allowance = { work_units: 1_000_000, memory_bytes: 4_000_000 }, ample = attempt(allowance);
    expect(ample.error).toBeUndefined();
    const reservedWork = ample.parent.work - ample.child.work, reservedBytes = ample.parent.bytes - ample.child.bytes;
    const actual = new SourceSemanticReadBudget(allowance);
    const orderCost = order.orderCost(observed.sources.length);
    actual.charge(orderCost.work_units, orderCost.memory_bytes);
    actual.retain([]);
    const { pool_id: _poolId, ...receipt } = observed.access;
    actual.retain(receipt, "access receipt identity", "borrow");
    actual.retain(preparationAccessReceiptValue(observed, 0, 0, 0), "access trace delivery", "borrow");
    sourceSemanticExecution(phases.preparation, phases.acquisition, actual);
    actual.retain({ ...queryPreparationLease(context, observed, 0, 0, false), kind: "query" }, "preparation lease", "borrow");
    actual.retain({ ...queryPreparationLease(context, observed, 0, 16, false), kind: "page" }, "preparation lease", "borrow");
    actual.charge(semanticLeaseGroupAccountingCost(2), 0);
    expect(reservedWork).toBeGreaterThanOrEqual(actual.spentWork);
    expect(reservedBytes).toBeGreaterThanOrEqual(actual.spentBytes);
    const exact = { work_units: ample.parent.spentWork + reservedWork, memory_bytes: ample.parent.spentBytes + reservedBytes };
    const accepted = attempt(exact);
    expect(accepted.error).toBeUndefined();
    expect(accepted.child.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    for (const short of [{ ...exact, work_units: exact.work_units - 1 }, { ...exact, memory_bytes: exact.memory_bytes - 1 }]) {
      const rejected = attempt(short);
      expect(rejected.error).toBeInstanceOf(SourceSemanticResourceExhausted);
      expect(rejected.parent.spentWork).toBeLessThanOrEqual(short.work_units);
      expect(rejected.parent.spentBytes).toBeLessThanOrEqual(short.memory_bytes);
    }
  });
});

it.each([6, 40])("observes real census promotion and planning constraints for %i SQLite sources without changing native spend", async count => {
  await withIndexedSources(Array.from({ length: count }, (_, index) => ({ id: `raw-${index}`, text: "Granite wall." })), async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const run = (observer?: SourceSemanticObserver) => {
      const meter = new SourceSemanticReadBudget(QUERY_BUDGET, observer);
      const pool = fixture.database.connection.transaction(() => observeSourceSemanticAccess(runtime, {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
        request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }
      }, ["project"], meter, ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET, undefined, {
        leaseContext: { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
          expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: ORIGINAL }
      }))();
      return { meter, pool };
    };
    const ordinary = run(), observer = new SourceSemanticObserver(7, { max_events: 512, max_bytes: 262144 });
    const observed = run(observer), row = observer.finish("success");
    expect(observed.pool.sources.map(source => source.identity)).toEqual(ordinary.pool.sources.map(source => source.identity));
    expect(observed.pool.sources).toHaveLength(count);
    expect([observed.meter.spentWork, observed.meter.spentBytes, observed.meter.nativeBytes, observed.meter.remaining()])
      .toEqual([ordinary.meter.spentWork, ordinary.meter.spentBytes, ordinary.meter.nativeBytes, ordinary.meter.remaining()]);
    expect(row.costs.some(cost => cost.reason === "parent constraint" && cost.operation === "capacity_decrease")).toBe(true);
    expect(row.costs.some(cost => cost.reason === "empty census promotion" && cost.operation === "capacity_increase" && cost.work > 0)).toBe(true);
    const observation = row.meters.find(meter => meter.phase === "observation")!;
    expect(observation.capacity!.changes).toBeGreaterThan(1);
    expect(observation.capacity!.current.work_units).toBe(observation.initial.work_units + observation.capacity!.adjustment.work_units);
    expect(observation.capacity!.current.memory_bytes).toBe(observation.initial.memory_bytes + observation.capacity!.adjustment.memory_bytes);
    expect(observation.capacity!.current).toEqual({ work_units: observation.remaining.work_units + observation.spent.work_units + observation.held.work_units,
      memory_bytes: observation.remaining.memory_bytes + observation.spent.memory_bytes + observation.held.memory_bytes });
    expect(row.meter_totals!.root_spent).toEqual({ work_units: observed.meter.spentWork, memory_bytes: observed.meter.spentBytes });
    expect(row.meter_totals!.child_spent).toEqual({ work_units: row.totals!.absorb_work, memory_bytes: row.totals!.absorb_bytes });
    expect(readSourceSemanticObservation(row, 7)).toEqual(row);
    if (count === 40) { expect(row.meters).toHaveLength(32); expect(row.issues).toContain("meter_detail_limit"); }
  });
});

it.each([0, 1])("finishes maximum-length hinted preparation for %i raw sources within a small native budget", async (count) => {
  await withAccessLibrary(Array.from({ length: count }, (_, index) => ({ id: `raw-${index}`, text: "Orchid irrigation." })),
  async ({ execute }) => {
    const budget = { ...ACCESS_BUDGET, work_units: 200_000, memory_bytes: 300_000 };
    const prepared = await accessCall(execute, { kind: "prepare_query", original_query: "orchid",
      access_hint: "x".repeat(1024), budget });
    expect(prepared.outcome).toEqual({ status: "preparation_required", missing: "query_semantics" });
    expect(prepared.query_handle).toBeDefined();
    expect(prepared.access).toMatchObject({ observed_source_count: count, observed_interpretation_count: 0,
      unvisited_sources: false, unvisited_interpretations: false });
    expect(prepared.access?.source_candidates.every(row => row.complete)).toBe(true);
    expect(prepared.work.native_work).toBeGreaterThan(0);
    expect(prepared.work.logical_work).toBeLessThanOrEqual(budget.work_units);
    expect(prepared.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
    const recalled = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle!, semantic_correspondences: [], budget, output_byte_limit: 1_000_000 });
    expect(recalled.protocol_version).toBe(SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION);
    if (recalled.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) throw new Error("field library delivery expected");
    expect(recalled.index.result_version).toBe(ORDINARY_NATIVE_FIELD_RESULT_VERSION);
    // Live field delivery does not manufacture the archived discovery.access receipt.
    // Its request identity retains the frozen hint, and the lease still enforces
    // the exact preparation budget even though that receipt is not public output.
    expect(recalled.request_identity).toBe(sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
      authorized_scopes: ["project"], original_query: "orchid", query_semantics_status: prepared.query_semantics_status,
      access_hint: "x".repeat(1024), semantic_correspondences: [], budget,
      output_byte_limit: 1_000_000, access_policy: "query-conditioned-v1" }));
    expect(recalled.index.entries.map(row => row.target.kind === "source_evidence" ? row.target.root_id : null))
      .toEqual(prepared.access!.source_candidates.map(row => row.record_id));
    expect(recalled.total_count).toBe(count);
    await expect(accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle!, semantic_correspondences: [],
      budget: { ...budget, memory_bytes: budget.memory_bytes - 1 }, output_byte_limit: 1_000_000 }))
      .rejects.toThrow(/access policy or budget changed/u);
  });
});
