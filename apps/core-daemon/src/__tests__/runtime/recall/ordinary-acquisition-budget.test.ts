import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { SourceIndexAcquisition, runConditionalFieldRecallWithReceipt, snapshotIdFromPin } from "@do-soul/alaya-core";
import { fixture, configuration, WORKSPACE, fieldSha256,
  type Fixture } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishIndex, queryInput } from "../../../../../../packages/core/src/__tests__/source-index/source-index-acquisition-fixture.js";
import { createConditionalFieldObserverReaders, nominateNativeSources,
  NATIVE_SOURCE_NOMINATION_ALLOWANCE } from "../../../runtime/recall-read-worker/observer-operations.js";

const opened: Fixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const env of opened.splice(0)) env.database.close(); });

function prepared() {
  const env = fixture(":memory:"); opened.push(env);
  prepareIndexedRecallProjection(env.database);
  const vector = [1, ...Array<number>(63).fill(0)];
  const { config } = publishIndex(env, [
    { id: "lexical", body: "needle a", vectors: [vector] },
    { id: "vector-only", body: "oceanbay".repeat(160), vectors: Array.from({ length: 160 }, () => vector) }
  ], configuration({ dimensions: 64 }));
  const input = queryInput(config);
  if (input.vector.status !== "available") throw new Error("fixed vector required");
  return { env, vector: { ...input.vector, embedding: new Float32Array(vector) } };
}

function recallRequest(env: Fixture, vector: ReturnType<typeof prepared>["vector"]) {
  const readers = createConditionalFieldObserverReaders(env.database, [], vector);
  return { workspace_id: WORKSPACE, query_text: "needle", readers,
    snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)),
    budget: { schema_version: 1 as const, work_units: 10_000, memory_bytes: 1_000_000,
      page_budget: 1, finalization_reserve: 100, min_envelope: 10 },
    interpretation_clock: "2026-09-07T00:00:00.000Z", as_of: "2026-09-07T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
    enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
    protocol_version: 1 as const, supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    supports_source_evidence: true, supports_product_updates: true };
}

describe("ordinary acquisition allowance and field page accounting", () => {
  it("completes the bounded SQLite scan independently of the field work remainder", () => {
    const { env, vector } = prepared();
    const result = env.database.connection.transaction(() => nominateNativeSources(env.database, {
      workspaceId: WORKSPACE, query: "needle", authorizedScopes: ["project"],
      budget: { work_units: 0, memory_bytes: 1_000_000 }
    }, vector))();
    expect(result.result?.vector).toMatchObject({ completion: "complete", inspected_windows: 161 });
    expect(result.result?.nominations.map(row => row.source.source_id)).toEqual(["lexical", "vector-only"]);
    expect(result.charged_by_caller).toBe(true);
    expect(result.acquisition_resources?.work).toBeGreaterThan(10_000);
    expect(result.retained_bytes).toBeGreaterThan(0);
    expect(result.retained_bytes).toBeLessThan(result.result!.resources.memory_bytes);
  });

  it("does not turn a capped window prefix into a complete scan", () => {
    const { env, vector } = prepared();
    const result = env.database.connection.transaction(() => {
      const input = { ...queryInput(), vector, allowance: { ...NATIVE_SOURCE_NOMINATION_ALLOWANCE, max_vector_windows: 2 } };
      const capacity = env.index.quoteQueryCapacity(WORKSPACE, input.allowance);
      expect(capacity.vector_windows).toBe(2);
      return new SourceIndexAcquisition(env.index, fieldSha256).nominate({ ...input,
        budget: SourceIndexAcquisition.quoteAllowanceBudget(input, capacity) }, () => "admitted");
    })();
    expect(result.vector).toMatchObject({ completion: "partial", inspected_windows: 2, reason: "window_limit" });
    expect(result.completion).toBe("partial");
  });

  it("keeps the explicit library request ledger as its acquisition limit", () => {
    const { env, vector } = prepared();
    const readers = createConditionalFieldObserverReaders(env.database, [], vector, undefined, "request");
    const result = env.database.connection.transaction(() => readers.nominateSources!({
      workspaceId: WORKSPACE, query: "needle", authorizedScopes: ["project"],
      budget: { work_units: 0, memory_bytes: 1_000_000 }
    }))();
    expect(result.charged_by_caller).toBeUndefined();
    expect(result.acquisition_resources).toBeUndefined();
    expect(result.result?.resources.work).toBe(0);
    expect(result.result?.vector.inspected_windows).toBe(0);
    expect(result.result?.nominations).toEqual([]);
  });

  it("delivers on the first default-sized page and records fresh acquisition only once", () => {
    const { env, vector } = prepared();
    const base = recallRequest(env, vector), nominate = vi.fn(base.readers.nominateSources!);
    const request = { ...base, readers: { ...base.readers, nominateSources: nominate } };
    const first = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt(request))();
    expect(first.index.entries).toHaveLength(1);
    expect(first.execution_receipt.actual?.phases.acquire?.budget_work).toBeGreaterThan(10_000);
    expect(first.execution_receipt.actual?.phases.acquire?.native_bytes).toBeGreaterThan(0);
    expect(first.execution_receipt.actual?.retained_bytes_current).toBeGreaterThanOrEqual(nominate.mock.results[0]!.value.retained_bytes);
    expect(first.index.continuation).not.toBeNull();
    const next = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt({ ...request,
      continuation: first.index.continuation! }))();
    expect(nominate).toHaveBeenCalledTimes(1);
    expect(next.execution_receipt.actual?.phases.acquire?.budget_work).toBe(0);
  });

  it("keeps scope rejection and missing generations explicit under the independent allowance", () => {
    const { env, vector } = prepared();
    const input = { workspaceId: WORKSPACE, query: "needle", authorizedScopes: ["global_core"],
      budget: { work_units: 10_000, memory_bytes: 1_000_000 } };
    const denied = env.database.connection.transaction(() => nominateNativeSources(env.database, input, vector))();
    expect(denied.result?.nominations).toEqual([]);
    expect(denied.result?.accounting.scope_denied).toBeGreaterThan(0);
    env.index.unbind(WORKSPACE);
    const unbound = env.database.connection.transaction(() => nominateNativeSources(env.database,
      { ...input, authorizedScopes: ["project"] }, vector))();
    expect(unbound.result?.vector).toMatchObject({ completion: "unavailable", reason: "no_active_generation" });
    expect(unbound.result?.nominations.map(row => row.source.source_id)).toEqual(["lexical"]);
  });

  it("reports acquisition memory refusal without caching absence and permits a larger new request", () => {
    const { env, vector } = prepared(), request = recallRequest(env, vector);
    let failure: unknown;
    try {
      env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt({ ...request,
        budget: { ...request.budget, memory_bytes: 8192 } }))();
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "CONFLICT", details: { outcome: "resource_exhausted", resource: "acquisition_memory",
      required_bytes: expect.any(Number), available_bytes: expect.any(Number),
      execution_receipt: { actual: { phases: { acquire: { budget_work: expect.any(Number) } } } } } });
    expect(JSON.stringify(failure)).not.toMatch(/continuation|delivery_id/u);
    const recovered = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt(request))();
    expect(recovered.index.entries).toHaveLength(1);
  });

  it("does not refill the declared root allowance through a supplemental hint", () => {
    const env = fixture(":memory:"); opened.push(env);
    const { config } = publishIndex(env, Array.from({ length: 20 }, (_, i) => ({
      id: `source-${i}`, body: "needle a", vectors: [[1, 0, 0]]
    })));
    const capture = vi.spyOn(SourceIndexAcquisition.prototype, "nominateWithWitness");
    const result = env.database.connection.transaction(() => nominateNativeSources(env.database, {
      workspaceId: WORKSPACE, query: "needle", hint: "ocean", authorizedScopes: ["project"],
      budget: { work_units: 10_000, memory_bytes: 1_000_000 }
    }, queryInput(config).vector))();
    expect(result.result?.nominations).toHaveLength(16);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(() => env.index.quoteQueryCapacity(WORKSPACE, { ...NATIVE_SOURCE_NOMINATION_ALLOWANCE, max_vector_windows: -1 }))
      .toThrow("invalid source acquisition window allowance");
  });
});
