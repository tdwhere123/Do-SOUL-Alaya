import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { ORDINARY_NATIVE_FIELD_RESULT_VERSION, SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION,
  sourceSemanticExecutionPhases, sourceSemanticAccessPhases } from "@do-soul/alaya-protocol";
import { readSemanticLease } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { withIndexedSources, workerCall, WS, CLOCK, ORIGINAL, RAW, SCOPES, QUERY_BUDGET }
  from "./source-semantic-index-acquisition.test-support.js";

it.each([1, 17])("retains one paid immutable population shared by query and preparation-page leases for %i sources", async count => {
  await withIndexedSources(Array.from({ length: count }, (_, index) => ({ id: `raw-${index}`, text: RAW, vector: [1, 0, 0] })), async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "x".repeat(1024),
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const budget = count === 1 ? { ...QUERY_BUDGET, memory_bytes: 300_000 } : QUERY_BUDGET;
    const result = runSourceSemanticWorker(runtime, { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      prepared_query: prepared, request: { kind: "prepare_query", original_query: ORIGINAL, access_hint: "x".repeat(1024), budget } });
    if (result.kind !== "prepare_query" || result.query_handle === undefined) throw new Error("query handle expected");
    expect(result.outcome).toEqual({ status: "preparation_required", missing: "query_semantics" });
    const lease = readSemanticLease(runtime, { workspace_id: WS, as_of: CLOCK }, result.query_handle, ["project"], "query");
    const pool = lease.access_pool;
    if (pool === undefined) throw new Error("retained access pool expected");
    expect(pool.sources).toHaveLength(count);
    expect(pool.catalogPositions).toHaveLength(count);
    expect(pool.retainedWitness?.length).toBeGreaterThan(0);
    expect(Object.isFrozen(pool.retainedWitness)).toBe(true);
    expect(pool.sources.every(Object.isFrozen)).toBe(true);
    expect(pool).not.toHaveProperty("nativeCaptures");
    expect(result.access?.source_candidates.every(row => row.complete)).toBe(true);
    expect(result.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
    if (count === 17) {
      expect(result.continuation_handle).toBeDefined();
      const page = readSemanticLease(runtime, { workspace_id: WS, as_of: CLOCK }, result.continuation_handle!, ["project"], "page");
      expect(page.access_pool).toBe(pool);
      expect(page.access_source_offset).toBe(16);
    } else expect(result.continuation_handle).toBeUndefined();
  });
});

it("reuses both captured native routes through the built worker without another query preparation or acquisition", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient(), budget = { ...QUERY_BUDGET, memory_bytes: 300_000 };
    const prepared = await workerCall(client, { kind: "prepare_query", original_query: ORIGINAL,
      access_hint: "x".repeat(1024), budget });
    expect(prepared.query_handle).toBeDefined();
    const acquisition = sourceSemanticAccessPhases(prepared.access!).acquisition;
    expect(acquisition.result?.nominations).toHaveLength(1);
    expect(acquisition.supplemental?.[0]?.result?.nominations).toHaveLength(1);
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(2);
    const calls = fixture.prepareQuery.mock.calls.length;
    const recalled = await workerCall(client, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle!, semantic_correspondences: [], budget, output_byte_limit: 1_000_000 });
    expect(fixture.prepareQuery.mock.calls).toHaveLength(calls);
    expect(recalled.protocol_version).toBe(SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION);
    if (recalled.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) throw new Error("field library delivery expected");
    expect(recalled.index.result_version).toBe(ORDINARY_NATIVE_FIELD_RESULT_VERSION);
    expect(recalled.index.entries.map(row => row.target.kind === "source_evidence" ? row.target.root_id : null))
      .toEqual(prepared.access!.source_candidates.map(row => row.record_id));
    expect(sourceSemanticExecutionPhases(recalled.execution!).acquisition.status).toBe("not_run");
    expect(recalled.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
  });
});
