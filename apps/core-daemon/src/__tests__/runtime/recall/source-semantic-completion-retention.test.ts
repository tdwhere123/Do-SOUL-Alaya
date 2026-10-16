import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { SourceSemanticResourceExhausted, sourceSemanticExecution } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import { bindAccessPoolIdentity } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { sourceSemanticAccessReceiptValue, preparationAccessReceiptValue } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { queryPreparationLease, issueSemanticLeaseGroup, readSemanticLease } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { withIndexedSources, WS, CLOCK, ORIGINAL, SCOPES, QUERY_BUDGET } from "./source-semantic-index-acquisition.test-support.js";

type Completion = Parameters<SourceSemanticUnionCompletion["emptyCompletion"]>[0];
function finish(input: Completion, actual: SourceSemanticReadBudget, issuedId?: string) {
  const rows = input.records.map(record => ({ source_id: record.source_id, record_id: record.identity,
    read_bytes: 123456, body_bytes: 123456, complete: true,
    signal: { source_text_score: 0.5, interpretation_reading_score: 0 } }));
  const order = input.orderCost(rows.length); actual.charge(order.work_units, order.memory_bytes);
  actual.retain([]);
  const receipt = sourceSemanticAccessReceiptValue(actual, input.policy, `sha256:${"a".repeat(64)}`, rows, [], false, false, [],
    input.sourcePreviewExtents, { ...input.phases!, observation: [123456, 123456, 123456] });
  actual.retain(receipt, "access receipt identity", "borrow");
  const access = bindAccessPoolIdentity(input.runtime, WS, ["project"], receipt, actual);
  const pool = { sources: input.records, descriptors: [], access, sourcePages: input.sourcePages,
    interpretationPages: 1, ...(input.accessHint === undefined ? {} : { accessHint: input.accessHint }) };
  actual.retain(preparationAccessReceiptValue(pool, 0, 0, 0), "access trace delivery", "borrow");
  sourceSemanticExecution(input.phases!.preparation, input.phases!.acquisition, actual);
  return issueSemanticLeaseGroup(input.runtime, [{ issuedId,
    lease: { ...queryPreparationLease(input.leaseContext, pool, 0, rows.length, false), kind: "query" } }], actual);
}

it.each(Array.from({ length: 15 }, (_, index) => index + 2))(
  "keeps actual identity, receipt, trace, execution and lease completion outside observation for %i raw sources", async count => {
    await withIndexedSources(Array.from({ length: count }, (_, index) => ({ id: `raw-${index}`,
      text: "Orchid irrigation channel notes. ".repeat(3), vector: [1, 0, 0] })), async fixture => {
      const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "x".repeat(1024),
        signal: new AbortController().signal, remainingMs: () => 60_000 });
      const empty = SourceSemanticUnionCompletion.prototype.emptyCompletion;
      let checked = 0, censusReadCount = 0;
      const reads = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
      vi.spyOn(SourceSemanticUnionCompletion.prototype, "emptyCompletion").mockImplementation(function (this: SourceSemanticUnionCompletion, input) {
        const outstanding = input.parent.outstandingAllowance();
        const held = { work_units: outstanding.work_units - input.parent.spentWork,
          memory_bytes: outstanding.memory_bytes - input.parent.spentBytes };
        const ceiling = input.child.remaining();
        empty.call(this, input);
        censusReadCount = reads.mock.calls.length;
        expect(input.child.work).toBeLessThanOrEqual(ceiling.work_units);
        expect(input.child.bytes).toBeLessThanOrEqual(ceiling.memory_bytes);
        const gap = { work_units: input.parent.work - input.child.spentWork - input.child.work,
          memory_bytes: input.parent.bytes - input.child.spentBytes - input.child.bytes };
        expect(gap.work_units).toBeGreaterThanOrEqual(held.work_units);
        expect(gap.memory_bytes).toBeGreaterThanOrEqual(held.memory_bytes);
        // Model observation consuming its entire lawful remainder. Completion has only
        // this parent-minus-child gap, not a fresh request allowance.
        const actual = new SourceSemanticReadBudget(gap);
        finish(input, actual);
        expect(gap.work_units).toBeGreaterThanOrEqual(actual.spentWork);
        expect(gap.memory_bytes).toBeGreaterThanOrEqual(actual.spentBytes);
        checked++;
      });
      const result = runSourceSemanticWorker({ database: fixture.database } as RecallReadWorkerRuntime, {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared,
        request: { kind: "prepare_query", original_query: ORIGINAL, access_hint: "x".repeat(1024), budget: QUERY_BUDGET } });
      expect(checked).toBe(1);
      if (result.kind !== "prepare_query") throw new Error("query preparation expected");
      expect(result.query_handle).toBeDefined();
      expect(result.access?.source_candidates).toHaveLength(count);
      expect(result.access?.source_candidates.every(row => row.complete)).toBe(true);
      const afterCensus = reads.mock.calls.slice(censusReadCount).filter(call => call[2] > 1);
      expect(new Set(afterCensus.map(call => call[1])).size).toBe(count - 1);
    });
  });

it("executes actual completion at exact and adjacent exhaustion with a full retained lease group", async () => {
  await withIndexedSources([{ id: "raw", text: "Orchid irrigation.", vector: [1, 0, 0] }], async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const empty = SourceSemanticUnionCompletion.prototype.emptyCompletion;
    let completion: Completion | undefined;
    vi.spyOn(SourceSemanticUnionCompletion.prototype, "emptyCompletion").mockImplementation(function (this: SourceSemanticUnionCompletion, input) {
      completion = input; empty.call(this, input);
    });
    runSourceSemanticWorker(runtime, { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET } });
    if (completion === undefined) throw new Error("empty completion expected");
    const input = completion;
    issueSemanticLeaseGroup(runtime, Array.from({ length: 32 }, (_, index) => ({ issuedId: `retained-${index}`,
      lease: { ...input.leaseContext, kind: "query" as const } })), new SourceSemanticReadBudget(QUERY_BUDGET));
    const ample = new SourceSemanticReadBudget(QUERY_BUDGET);
    finish(input, ample, "ample");
    const exactBudget = { work_units: ample.spentWork, memory_bytes: ample.spentBytes };
    const exact = new SourceSemanticReadBudget(exactBudget);
    finish(input, exact, "exact");
    expect(exact.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    expect(readSemanticLease(runtime, input.leaseContext, "exact", ["project"], "query").access_pool?.sources).toHaveLength(1);
    for (const [index, budget] of [{ ...exactBudget, work_units: exactBudget.work_units - 1 },
      { ...exactBudget, memory_bytes: exactBudget.memory_bytes - 1 }].entries()) {
      const short = new SourceSemanticReadBudget(budget), id = `unpublished-${index}`;
      expect(() => finish(input, short, id)).toThrow(SourceSemanticResourceExhausted);
      expect(short.spentWork).toBeLessThanOrEqual(budget.work_units);
      expect(short.spentBytes).toBeLessThanOrEqual(budget.memory_bytes);
      expect(() => readSemanticLease(runtime, input.leaseContext, id, ["project"], "query")).toThrow(/expired/u);
      expect(readSemanticLease(runtime, input.leaseContext, "exact", ["project"], "query").access_pool?.sources).toHaveLength(1);
    }
  });
});

it("rechecks actual lease byte capacity at the raw census before any later source body read", async () => {
  await withIndexedSources([{ id: "a", text: "Orchid irrigation.", vector: [1, 0, 0] },
    { id: "b", text: "Water channel.", vector: [1, 0, 0] }], async fixture => {
    const empty = SourceSemanticUnionCompletion.prototype.emptyCompletion;
    const reads = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    let atCensus = -1;
    vi.spyOn(SourceSemanticUnionCompletion.prototype, "emptyCompletion").mockImplementation(function (this: SourceSemanticUnionCompletion, input) {
      atCensus = reads.mock.calls.length;
      // Exercise the real capacity owner, not a mocked rejection or quote-call count.
      empty.call(this, { ...input, leaseContext: { ...input.leaseContext, original_query: "x".repeat(2_100_000) } });
    });
    expect(() => runSourceSemanticWorker({ database: fixture.database } as RecallReadWorkerRuntime, {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }
    })).toThrow(/exceeds lease capacity/u);
    expect(atCensus).toBeGreaterThan(0);
    expect(reads.mock.calls.slice(atCensus)).toEqual([]);
  });
});
