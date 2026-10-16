import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, sourceSemanticExecution } from "@do-soul/alaya-protocol";
import { createSourceSemanticAccessPolicy } from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
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
      const child = new SourceSemanticReadBudget({ work_units: 1_000, memory_bytes: 1_000 });
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
      const receipt = sourceSemanticAccessReceiptValue("query-conditioned-v1", digest, [], [], false, false, []);
      const pool = { sources: [], descriptors: [], access: { ...receipt, pool_id: digest }, sourcePages: 1, interpretationPages: 1,
        ...(accessHint === undefined ? {} : { accessHint }) };
      actual.retain([]);
      actual.retain(receipt);
      actual.retain(preparationAccessReceiptValue(pool, 0, 0, 0));
      actual.retain(sourceSemanticExecution());
      actual.retain({ ...queryPreparationLease(leaseContext, pool, 0, 0, false), kind: "query" });
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
    expect(observed.access.acquisition.result?.nominations).toHaveLength(16);
    const phases = { preparation: observed.access.preparation, acquisition: observed.access.acquisition };
    const order = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", new SourceSemanticReadBudget(ACCESS_BUDGET));
    const context = { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
      expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: ORIGINAL };
    const attempt = (allowance: { work_units: number; memory_bytes: number }) => {
      const parent = new SourceSemanticReadBudget(allowance), child = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 1000 });
      child.charge(107, 229);
      let error: unknown;
      try { reserveEmptyInterpretationCompletion({ runtime, parent, child, records: observed.sources,
        sourcePages: observed.sourcePages, policy: "query-conditioned-v1", budget: ACCESS_BUDGET,
        orderCost: order.orderCost, leaseContext: context, phases }); }
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
    actual.retain(receipt);
    actual.retain(preparationAccessReceiptValue(observed, 0, 0, 0));
    actual.retain(sourceSemanticExecution(phases.preparation, phases.acquisition));
    actual.retain({ ...queryPreparationLease(context, observed, 0, 0, false), kind: "query" });
    actual.retain({ ...queryPreparationLease(context, observed, 0, 16, false), kind: "page" });
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
    expect(recalled.discovery.access?.pool_id).toBe(prepared.access?.pool_id);
    expect(recalled.total_count).toBe(count);
  });
});
