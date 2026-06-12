import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import { EdgeAutoProducerService } from "@do-soul/alaya-core";

// K4.5 no-network regression (SERVICE-LEVEL): given the DEFAULT-config wiring
// shape `{ edgeClassifyQueue }` only (no synchronous llmPort), B-2 edge
// classification makes NO external/network call. The deterministic heuristic
// produces the edge inline and the LLM-quality verdict is DEFERRED to the
// attached CLI agent via the EDGE_CLASSIFY garden task (a local DB enqueue).
//
// SCOPE: this test hand-builds the EdgeAutoProducerService deps and asserts the
// defer path never fetches. It does NOT exercise the index.ts env+config
// DECISION that chooses this wiring shape under default config — that decision
// is locked separately by the PURE resolveEdgeClassifyWiring regression in
// garden-compute-config-wiring.test.ts (DEFAULT -> host_worker_defer, llm off).
// Together: that test proves the daemon WIRES the defer shape by default; this
// test proves the defer shape makes no network call. A globalThis.fetch spy
// fails this test if any network call is attempted.
// see also: apps/core-daemon/src/runtime/daemon-runtime-support.ts:resolveEdgeClassifyWiring
// see also: apps/core-daemon/src/index.ts:edgeClassifyWiring
// see also: apps/core-daemon/src/ai/edge-auto-producer-llm-adapter.ts:requestVerdictFromGarden
// see also: packages/core/src/path-graph/edge-auto-producer-service.ts:deferEdgeClassify

describe("B-2 edge classification (K4.5 no-network, default config)", () => {
  const originalFetch = globalThis.fetch;
  const originalEdgeLlmEnv = process.env.ALAYA_EDGE_PRODUCER_LLM_ENABLED;
  const originalHostWorkerEnv = process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Default config: neither edge-LLM opt-in flag nor host-worker override set.
    delete process.env.ALAYA_EDGE_PRODUCER_LLM_ENABLED;
    delete process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER;
    // Any fetch during edge classification is a zero-cloud invariant violation.
    fetchSpy = vi.fn(async () => {
      throw new Error("K4.5 violation: edge classification attempted a network call under default config.");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEdgeLlmEnv === undefined) {
      delete process.env.ALAYA_EDGE_PRODUCER_LLM_ENABLED;
    } else {
      process.env.ALAYA_EDGE_PRODUCER_LLM_ENABLED = originalEdgeLlmEnv;
    }
    if (originalHostWorkerEnv === undefined) {
      delete process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER;
    } else {
      process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER = originalHostWorkerEnv;
    }
  });

  it("produces the inline heuristic edge and defers the verdict without any network call", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      created_at: "2026-05-24T10:00:00.000Z",
      updated_at: "2026-05-24T10:00:00.000Z",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });

    const byId = new Map([newMemory, neighbor].map((memory) => [memory.object_id, memory]));
    // "applied" is a valid PathMintOutcome member; typed as the literal so the
    // test does not depend on the unexported PathMintOutcome union.
    const submitCandidate = vi.fn(async (): Promise<"applied"> => "applied");
    // Default-config wiring: host_worker defers, so only the EDGE_CLASSIFY queue
    // is wired — never a synchronous in-process llmPort.
    const enqueueEdgeClassify = vi.fn(async () => {});

    const service = new EdgeAutoProducerService({
      memoryRepo: {
        findById: async (objectId: string) => byId.get(objectId) ?? null,
        searchByKeyword: async () => [{ object_id: "memory-existing", normalized_rank: 0.9 }],
        findByIds: async (objectIds: readonly string[]) =>
          objectIds.flatMap((objectId) => {
            const memory = byId.get(objectId);
            return memory === undefined ? [] : [memory];
          })
      },
      pathCandidatePort: { submitCandidate },
      edgeClassifyQueue: { enqueueEdgeClassify }
    });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // ZERO-CLOUD: no fetch was attempted anywhere on the edge-classify path.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The deterministic heuristic still produced the edge inline.
    expect(submitCandidate).toHaveBeenCalledTimes(1);
    // The LLM-quality verdict was deferred to the host worker via a local DB
    // enqueue (no network), not a synchronous cloud call.
    expect(enqueueEdgeClassify).toHaveBeenCalledTimes(1);
  });
});

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-new",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-24T12:00:00.000Z",
    updated_at: "2026-05-24T12:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.FACT,
    source_kind: "compiler",
    formation_kind: "extracted",
    scope_class: ScopeClass.PROJECT,
    content: "RTK wrapper is required for shell commands in this repository.",
    domain_tags: ["rtk", "workflow"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.6,
    retention_score: 0.6,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.8,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
