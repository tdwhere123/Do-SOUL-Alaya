import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { SourceSemanticResourceExhausted, sourceSemanticExecution, sourceSemanticAccessPhases,
  type PreparedSourceSemanticCanonicalSubtrees } from "@do-soul/alaya-protocol";
import { captureSourcePhaseFixture } from "../../../../../../packages/protocol/src/__tests__/garden/source-semantic-canonical.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import { bindAccessPoolIdentity, quoteAccessPoolIdentity, sourceSemanticObservationAccounting,
  sourceSemanticAccessReceiptValue, preparationAccessReceiptValue } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { queryPreparationLease, issueSemanticLeaseGroup, readSemanticLease } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { withIndexedSources, WS, CLOCK, ORIGINAL, SCOPES, QUERY_BUDGET } from "./source-semantic-index-acquisition.test-support.js";

type Completion = Parameters<SourceSemanticUnionCompletion["emptyCompletion"]>[0];
function capturedCompletion(input: Completion): Completion {
  const phases = sourceSemanticAccessPhases({ phases: [2, input.phases!.preparation, input.phases!.acquisition, null] });
  const pair = captureSourcePhaseFixture(new SourceSemanticReadBudget(QUERY_BUDGET), phases);
  return { ...input, phases: { preparation: pair.phases[1], acquisition: pair.phases[2] },
    borrowPreparation: pair.borrowPreparation, acquisitionCapture: pair.acquisition };
}

function finish(input: Completion, actual: SourceSemanticReadBudget, issuedId?: string,
  identityPreparation?: PreparedSourceSemanticCanonicalSubtrees, prepareIdentity = false) {
  const rows = input.records.map(record => ({ source_id: record.source_id, record_id: record.identity,
    read_bytes: 123456, body_bytes: 123456, complete: true,
    signal: { source_text_score: 0.5, interpretation_reading_score: 0 } }));
  const order = input.orderCost(rows.length); actual.charge(order.work_units, order.memory_bytes);
  actual.retain([]);
  const observation = sourceSemanticObservationAccounting(input.phases!.acquisition, { spentWork: Number.MAX_SAFE_INTEGER,
    spentBytes: Number.MAX_SAFE_INTEGER, nativeBytes: Number.MAX_SAFE_INTEGER }, actual);
  const receipt = sourceSemanticAccessReceiptValue(actual, input.policy, `sha256:${"a".repeat(64)}`, rows, [], false, false, [],
    input.sourcePreviewExtents, { ...input.phases!, observation });
  actual.retain(receipt, "access receipt identity", "borrow");
  const beforeIdentity = { work_units: actual.spentWork, memory_bytes: actual.spentBytes };
  // Prepare an independent, canonically equal copy outside the actual completion
  // ledger. The worker's original sealed plan must remain unconsumed for its bind.
  const prepared = identityPreparation ?? (prepareIdentity ? quoteAccessPoolIdentity(input.runtime, WS, ["project"], receipt,
    new SourceSemanticReadBudget(QUERY_BUDGET), input).prepared : undefined);
  const access = bindAccessPoolIdentity(input.runtime, WS, ["project"], receipt, actual, prepared);
  const identity = { work_units: actual.spentWork - beforeIdentity.work_units,
    memory_bytes: actual.spentBytes - beforeIdentity.memory_bytes };
  const pool = { sources: input.records, descriptors: [], access, sourcePages: input.sourcePages,
    interpretationPages: 1, ...(input.accessHint === undefined ? {} : { accessHint: input.accessHint }) };
  actual.retain(preparationAccessReceiptValue(pool, 0, 0, 0), "access trace delivery", "borrow");
  sourceSemanticExecution(input.phases!.preparation, input.phases!.acquisition, actual);
  issueSemanticLeaseGroup(input.runtime, [{ issuedId,
    lease: { ...queryPreparationLease(input.leaseContext, pool, 0, rows.length, false), kind: "query" } }], actual);
  return identity;
}

it.each(Array.from({ length: 16 }, (_, index) => index + 1))(
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
        const prepared = empty.call(this, input);
        censusReadCount = reads.mock.calls.length;
        // The old half-budget clamp fails here even when the parent has lawful surplus.
        expect(input.child.work).toBeGreaterThan(ceiling.work_units);
        expect(input.child.bytes).toBeGreaterThan(ceiling.memory_bytes);
        const gap = { work_units: input.parent.work - input.child.spentWork - input.child.work,
          memory_bytes: input.parent.bytes - input.child.spentBytes - input.child.bytes };
        expect(gap.work_units).toBeGreaterThanOrEqual(held.work_units);
        expect(gap.memory_bytes).toBeGreaterThanOrEqual(held.memory_bytes);
        // Model observation consuming its entire lawful remainder. Completion has only
        // this parent-minus-child gap, not a fresh request allowance.
        const actual = new SourceSemanticReadBudget(gap);
        const identity = finish(capturedCompletion(input), actual, undefined, undefined, true);
        expect(gap.work_units).toBeGreaterThanOrEqual(actual.spentWork);
        expect(gap.memory_bytes).toBeGreaterThanOrEqual(actual.spentBytes);
        // Padding in the earlier retention quote cannot substitute for the missing
        // identity hold. A promotion that merely removes the clamp fails this bound.
        expect(gap.work_units - held.work_units).toBeGreaterThanOrEqual(identity.work_units);
        expect(gap.memory_bytes - held.memory_bytes).toBeGreaterThanOrEqual(identity.memory_bytes);
        checked++;
        return prepared;
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

it("borrows only the parent's surplus outside spent effects, unrelated holds and deferred child effects", async () => {
  await withIndexedSources([{ id: "raw", text: "Orchid irrigation.", vector: [1, 0, 0] }], async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const empty = SourceSemanticUnionCompletion.prototype.emptyCompletion;
    let captured: Completion | undefined;
    const census = vi.spyOn(SourceSemanticUnionCompletion.prototype, "emptyCompletion")
      .mockImplementation(function (this: SourceSemanticUnionCompletion, input) { captured = input; return empty.call(this, input); });
    runSourceSemanticWorker(runtime, { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET } });
    census.mockRestore();
    if (captured === undefined) throw new Error("empty completion expected");
    const budget = { work_units: 180_000, memory_bytes: 4_000_000 };
    const parent = new SourceSemanticReadBudget(budget);
    const child = new SourceSemanticReadBudget({ work_units: 50_000, memory_bytes: 200_000 });
    const input = { ...capturedCompletion(captured), parent, child };
    parent.charge(1003, 2009, "prior parent effects");
    child.charge(2011, 3011, "prior child effects");
    const unrelated = { work_units: 7001, memory_bytes: 11003 };
    const deferred = { work_units: 4001, memory_bytes: 5003 };
    const releaseUnrelated = parent.hold(unrelated), releaseDeferred = child.hold(deferred);
    const owner = new SourceSemanticUnionCompletion(parent, child, input.orderCost);
    let identityPreparation: PreparedSourceSemanticCanonicalSubtrees | undefined;
    try {
      owner.preparationBase({ ...input, records: [], sourcePages: 0 });
      owner.metadata(input.phases!.acquisition);
      for (const record of input.records) owner.source(record);
      identityPreparation = owner.emptyCompletion(input);
      expect(child.work).toBeGreaterThan(90_000);
      // Spend every granted unit; a fresh allowance must not hide an underquoted completion.
      child.charge(child.work, child.bytes, "remaining raw observation");
      releaseDeferred(); child.charge(deferred.work_units, deferred.memory_bytes, "deferred native effect");
      parent.absorb(child);
      releaseUnrelated(); parent.charge(unrelated.work_units, unrelated.memory_bytes, "unrelated future effect");
      finish(input, parent, "borrowed-parent-surplus", identityPreparation);
      expect(parent.spentWork + parent.work).toBe(budget.work_units);
      expect(parent.spentBytes + parent.bytes).toBe(budget.memory_bytes);
      expect(parent.work).toBeGreaterThanOrEqual(0);
      expect(parent.bytes).toBeGreaterThanOrEqual(0);
      expect(readSemanticLease(runtime, input.leaseContext, "borrowed-parent-surplus", ["project"], "query")
        .access_pool?.sources).toHaveLength(1);
    } finally { identityPreparation?.close(); owner.release(); releaseDeferred(); releaseUnrelated(); }
  });
});

it("executes actual completion at exact and adjacent exhaustion with a full retained lease group", async () => {
  await withIndexedSources([{ id: "raw", text: "Orchid irrigation.", vector: [1, 0, 0] }], async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const empty = SourceSemanticUnionCompletion.prototype.emptyCompletion;
    let completion: Completion | undefined;
    vi.spyOn(SourceSemanticUnionCompletion.prototype, "emptyCompletion").mockImplementation(function (this: SourceSemanticUnionCompletion, input) {
      completion = input; return empty.call(this, input);
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
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const prior = runSourceSemanticWorker(runtime, { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET } });
    if (prior.kind !== "prepare_query" || prior.query_handle === undefined) throw new Error("prior query handle expected");
    const empty = SourceSemanticUnionCompletion.prototype.emptyCompletion;
    const reads = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    let atCensus = -1;
    vi.spyOn(SourceSemanticUnionCompletion.prototype, "emptyCompletion").mockImplementation(function (this: SourceSemanticUnionCompletion, input) {
      atCensus = reads.mock.calls.length;
      // Exercise the real capacity owner, not a mocked rejection or quote-call count.
      const before = input.child.remaining();
      try { return empty.call(this, { ...input, leaseContext: { ...input.leaseContext, original_query: "x".repeat(2_100_000) } }); }
      finally {
        expect(input.child.work).toBeLessThanOrEqual(before.work_units);
        expect(input.child.bytes).toBeLessThanOrEqual(before.memory_bytes);
      }
    });
    expect(() => runSourceSemanticWorker(runtime, {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET }
    })).toThrow(/exceeds lease capacity/u);
    expect(atCensus).toBeGreaterThan(0);
    expect(reads.mock.calls.slice(atCensus)).toEqual([]);
    expect(readSemanticLease(runtime, { workspace_id: WS, as_of: CLOCK }, prior.query_handle, ["project"], "query")
      .access_pool?.sources).toHaveLength(2);
  });
});
