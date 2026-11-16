const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../../scripts/test-support/provider-free/provider-free-boundary.js"
  );
  return installProviderFreeBoundary();
});
const stubs = vi.hoisted(() => ({
  encode: vi.fn(),
  build: vi.fn(),
  emit: vi.fn(async () => undefined)
}));
vi.mock("../../../harness/daemon/handle/bench-recall-response.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../harness/daemon/handle/bench-recall-response.js")>();
  return {
    ...actual,
    encodeBenchRecallResults: (...args: unknown[]) => stubs.encode(...args),
    buildBenchRecallResponse: (...args: unknown[]) => stubs.build(...args)
  };
});
vi.mock("../../../harness/daemon/daemon-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../harness/daemon/daemon-support.js")>();
  return { ...actual, emitBenchContextLensAssembledEvent: stubs.emit };
});
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SoulMemorySearchResponseSchema, type Continuation } from "@do-soul/alaya-protocol";
import {
  createBenchRecallOperation,
  type BenchRecallOperationInput
} from "../../../harness/daemon/handle/daemon-handle-ops.js";
import { prepareBenchRecallRequest } from "../../../harness/daemon/handle/bench-recall-request.js";
import type { BenchRecallOptions } from "../../../harness/daemon/daemon-types.js";

afterAll(() => {
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});
afterEach(() => {
  vi.clearAllMocks();
  stubs.emit.mockResolvedValue(undefined);
});

const CLOCK = "2026-10-01T00:00:00.000Z";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const identity = {
  query_id: "query", snapshot_id: SNAPSHOT, interpretation_id: "interpretation", as_of: CLOCK
};

function token(cursor = "next"): Continuation {
  return {
    schema_version: 1, continuation_id: cursor, query_id: identity.query_id, snapshot_id: identity.snapshot_id,
    result_version: "v1", cursor, expires_at: "2099-01-01T00:00:00.000Z",
    interpretation_id: identity.interpretation_id, interpretation_clock: CLOCK
  };
}

function encodedResults() {
  return [{
    object_id: "memory", object_kind: "memory_entry", budget_state: { token_estimate: 4 }
  }];
}

function searchResponse(deliveryId: string, continuation: Continuation | null = token()) {
  return SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId, protocol_version: 1, results: [{
      object_id: "memory", object_kind: "memory_entry",
      target: { kind: "memory_entry", workspace_id: "workspace-1", object_id: "memory", source_revision: "rev" },
      relevance_score: 0.5, content_preview: "preview", evidence_pointers: [], selection_reason: "fixture",
      hypothesis_id: "hypothesis", output_binding: "binding", program_state: "accepting", time_state: "as_of",
      source_channels: [], score_factors: { activation: 0, relevance: 0 },
      budget_state: {
        token_estimate: 4, max_entries: 5, max_total_tokens: 100,
        remaining_entries: 4, remaining_tokens: 96, within_budget: true
      }
    }],
    total_count: 1,
    index: {
      schema_version: 1, ...identity, result_version: "v1",
      entries: [{
        schema_version: 1, object_id: "memory", hypothesis_id: "hypothesis", output_binding: "binding",
        target: { kind: "memory_entry", workspace_id: "workspace-1", object_id: "memory", source_revision: "rev" },
        program_state: "accepting", time_state: "as_of", role: "requested",
        association_milligrades: 850, claim: "unknown", explanation_ids: []
      }],
      continuation,
      completeness: {
        schema_version: 1, logical_index: "partial", observed_coverage: "partial",
        transport: "complete", payload: "complete", representation: "complete"
      },
      representation: {
        schema_version: 1, policy: "construct_index_then_page_then_payload",
        page_budget: 5, identity_tie_break: "serialization"
      },
      page_purpose: "membership"
    }
  });
}

function operationInput() {
  const order: string[] = [];
  const recall = vi.fn(async (_params?: unknown) => {
    order.push("recall");
    return { active_constraints: [] as { readonly object_id: string; readonly object_kind: string }[] };
  });
  const recordDelivery = vi.fn(async (row: { readonly delivery_id: string }) => {
    order.push("delivery");
    return row;
  });
  return {
    dataDir: "/tmp/bench-recall-adapter-unused",
    activeContext: { workspaceId: "workspace-1", runId: "run-1" },
    activeRuntime: {
      services: {
        recallService: { recall },
        trustStateRecorder: { recordDelivery }
      }
    },
    embeddingMode: "disabled" as const,
    effectiveEnv: {},
    order,
    recall,
    recordDelivery
  } as unknown as BenchRecallOperationInput & {
    readonly order: string[];
    readonly recall: typeof recall;
    readonly recordDelivery: typeof recordDelivery;
  };
}

function stubEffects(continuation: Continuation | null = token()) {
  stubs.encode.mockReturnValue(encodedResults());
  stubs.build.mockImplementation((deliveryId: string) => searchResponse(deliveryId, continuation));
}

describe("bench recall delivery effects", () => {
  it("forwards the prepared request through invokeBoundRecall without defer_delivery", async () => {
    const input = operationInput();
    stubEffects();
    stubs.encode.mockImplementation(() => {
      input.order.push("encode");
      return encodedResults();
    });
    stubs.build.mockImplementation((deliveryId: string) => {
      input.order.push("response");
      return searchResponse(deliveryId);
    });
    stubs.emit.mockImplementation(async () => {
      input.order.push("event");
    });
    const opts: BenchRecallOptions = {
      interpretationClock: CLOCK, snapshotDigest: SNAPSHOT, cancelled: true
    };
    const prepared = prepareBenchRecallRequest(input, "needle", opts);
    const result = await createBenchRecallOperation(input)("needle", opts);
    const forwarded = input.recall.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (forwarded === undefined) throw new Error("expected invokeBoundRecall to forward a recall request");
    expect(Object.hasOwn(forwarded, "sideEffectMode")).toBe(false);
    expect(Object.hasOwn(forwarded, "defer_delivery")).toBe(false);
    expect(Object.hasOwn(forwarded, "recallService")).toBe(false);
    expect(forwarded.queryText).toBe(prepared.invoke.queryText);
    expect(forwarded.workspaceId).toBe(prepared.invoke.workspaceId);
    expect(forwarded.runId).toBe(prepared.invoke.runId);
    expect(forwarded.strategy).toBe("chat");
    expect(forwarded.snapshotDigest).toBe(SNAPSHOT);
    expect(forwarded.cancelled).toBe(true);
    expect(forwarded.interpretationClock).toBe(CLOCK);
    expect(forwarded.protocol_version).toBe(1);
    expect(forwarded.supports_source_evidence).toBe(true);
    expect(forwarded.supported_result_kinds).toEqual(["memory_entry", "source_evidence"]);
    expect(forwarded.activeConstraintsCap).toBeNull();
    expect(Object.hasOwn(forwarded, "referenceTime")).toBe(false);
    expect(input.order).toEqual(["recall", "encode", "delivery", "event", "response"]);
    expect(result.delivery_id).toBe(input.recordDelivery.mock.calls[0]?.[0].delivery_id);
    expect(result.delivery_id).toMatch(/^delivery_[0-9a-f-]{36}$/iu);
    expect(result.first_exposure_page?.delivery_id).toBe(result.delivery_id);
    const taskSurface = forwarded.taskSurface as { readonly runtime_id: string };
    expect(stubs.emit).toHaveBeenCalledWith("/tmp/bench-recall-adapter-unused", {
      taskSurfaceRef: taskSurface.runtime_id,
      lensEntryCount: 1,
      totalTokenEstimate: 4,
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    const recorded = input.recordDelivery.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({
      agent_target: "bench-runner",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory"],
      delivered_objects: [{ object_id: "memory", object_kind: "memory_entry" }]
    });
  });

  it("stops before delivery and the lens event when encoding fails", async () => {
    const input = operationInput();
    stubs.encode.mockImplementation(() => {
      input.order.push("encode");
      throw new Error("page budget differs");
    });
    await expect(createBenchRecallOperation(input)("needle")).rejects.toThrow(/page budget differs/);
    expect(input.order).toEqual(["recall", "encode"]);
    expect(input.recordDelivery).not.toHaveBeenCalled();
    expect(stubs.emit).not.toHaveBeenCalled();
    expect(stubs.build).not.toHaveBeenCalled();
  });

  it("stops before the lens event when delivery persistence fails", async () => {
    const input = operationInput();
    stubEffects();
    input.recordDelivery.mockImplementation(async () => {
      input.order.push("delivery");
      throw new Error("delivery failed");
    });
    await expect(createBenchRecallOperation(input)("needle")).rejects.toThrow(/delivery failed/);
    expect(input.order).toEqual(["recall", "delivery"]);
    expect(stubs.emit).not.toHaveBeenCalled();
    expect(stubs.build).not.toHaveBeenCalled();
  });

  it("does not return a first-exposure page when the lens event fails after delivery", async () => {
    const input = operationInput();
    stubEffects();
    stubs.emit.mockRejectedValue(new Error("event failed"));
    await expect(createBenchRecallOperation(input)("needle")).rejects.toThrow(/event failed/);
    expect(input.recordDelivery).toHaveBeenCalledTimes(1);
    expect(stubs.build).not.toHaveBeenCalled();
  });

  it("does not record delivery when recall itself fails", async () => {
    const input = operationInput();
    stubEffects();
    input.recall.mockRejectedValue(new Error("recall failed"));
    await expect(createBenchRecallOperation(input)("needle")).rejects.toThrow(/recall failed/);
    expect(stubs.encode).not.toHaveBeenCalled();
    expect(input.recordDelivery).not.toHaveBeenCalled();
    expect(stubs.emit).not.toHaveBeenCalled();
  });

  it("omits encoded rows without object_id and dedupes constraints onto delivery persistence", async () => {
    const input = operationInput();
    stubEffects();
    input.recall.mockResolvedValue({
      active_constraints: [
        { object_id: "memory", object_kind: "memory_entry" },
        { object_id: "constraint", object_kind: "constraint" }
      ]
    });
    stubs.encode.mockReturnValue([
      { object_id: "memory", object_kind: "memory_entry", budget_state: { token_estimate: 1 } },
      { object_kind: "source_evidence", budget_state: { token_estimate: 2 } },
      { object_id: "memory", object_kind: "memory_entry", budget_state: { token_estimate: 1 } }
    ]);
    await createBenchRecallOperation(input)("needle");
    expect(input.recordDelivery.mock.calls[0]?.[0]).toMatchObject({
      delivered_object_ids: ["memory", "constraint"],
      delivered_objects: [
        { object_id: "memory", object_kind: "memory_entry" },
        { object_id: "constraint", object_kind: "constraint" }
      ]
    });
  });

  it("keeps first-exposure session ownership across a continuation page", async () => {
    const input = operationInput();
    const issued = token();
    stubs.encode.mockReturnValue(encodedResults());
    stubs.build.mockImplementation((deliveryId: string) => searchResponse(deliveryId, issued));
    const recall = createBenchRecallOperation(input);
    const first = await recall("needle", { interpretationClock: CLOCK });
    stubs.build.mockImplementation((deliveryId: string) => searchResponse(deliveryId, null));
    const later = await recall("needle", { interpretationClock: CLOCK, continuation: issued });
    expect(later.first_exposure_page?.initial).toEqual(first.first_exposure_page?.initial);
    expect(later.first_exposure_page?.request_continuation).toEqual(issued);
    expect(later.delivery_id).not.toBe(first.delivery_id);
  });
});
