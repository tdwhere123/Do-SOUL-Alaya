import { describe, expect, it, vi } from "vitest";
import { EdgeAutoProducerService } from "../../path-graph/edge-auto-producer-service.js";
import type { PathMintOutcome } from "../../path-graph/path-relation-proposal-service.js";
import { createDeps, createMemoryEntry, makePositiveAssociativePath } from "./edge-auto-producer-service-test-fixtures.js";

describe("EdgeAutoProducerService", () => {
// invariant (FIX-3): the per-memory MAX_EDGE_PROPOSALS budget counts only
  // "applied" outcomes. already_present (an equivalent link already exists) and
  // failed (retried later) must NOT consume budget — otherwise already-linked or
  // transiently-failed neighbors starve genuinely-new neighbors past the cap.
  // With 7 eligible neighbors all returning already_present, every neighbor is
  // still attempted because budget never increments.
  it("FIX-3 already_present / failed outcomes do not consume the per-memory proposal budget", async () => {
    const newMemory = createMemoryEntry();
    const neighbors = Array.from({ length: 7 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: "Repository shell commands must use the RTK wrapper for scripts.",
        domain_tags: ["rtk", "workflow"]
      })
    );
    const { deps, pathCandidatePort } = createDeps([newMemory, ...neighbors]);
    // Every candidate reports the link already exists (a no-op mint).
    pathCandidatePort.submitCandidate.mockImplementation(
      async (): Promise<PathMintOutcome> => "already_present"
    );
    const service = new EdgeAutoProducerService({ ...deps });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // All 7 neighbors are attempted: already_present never burns budget, so the
    // MAX_EDGE_PROPOSALS=5 cap is not falsely tripped by no-op outcomes.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(7);
  });

// invariant (FIX-3): the cap still bounds genuinely-applied proposals. With 7
  // eligible neighbors all applying, the loop stops at MAX_EDGE_PROPOSALS=5.
  it("FIX-3 caps genuinely-applied proposals at MAX_EDGE_PROPOSALS", async () => {
    const newMemory = createMemoryEntry();
    const neighbors = Array.from({ length: 7 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `memory-${index}`,
        content: "Repository shell commands must use the RTK wrapper for scripts.",
        domain_tags: ["rtk", "workflow"]
      })
    );
    const { deps, pathCandidatePort } = createDeps([newMemory, ...neighbors]);
    pathCandidatePort.submitCandidate.mockImplementation(
      async (): Promise<PathMintOutcome> => "applied"
    );
    const service = new EdgeAutoProducerService({ ...deps });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(5);
  });

it("B-2 pregate skips the LLM port for structurally eligible but unrelated pairs", async () => {
    // Same workspace + dimension + scope as the new memory so the
    // structural eligibility check passes, but zero shared content
    // tokens and zero shared tags. This is the "obvious non-pair" the
    // LLM cost pregate is designed to drop.
    const newMemory = createMemoryEntry({
      content: "RTK wrapper is required for shell commands in this repository.",
      domain_tags: ["rtk", "workflow"]
    });
    const unrelatedNeighbor = createMemoryEntry({
      object_id: "memory-unrelated",
      content: "Friday afternoon deployment window starts at 1500 UTC.",
      domain_tags: ["release", "operations"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, unrelatedNeighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => ({
        edgeType: "supports" as const,
        confidence: 0.95,
        rationale: "should never be called"
      }))
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // LLM port MUST NOT be consulted for the unrelated neighbor — that is
    // the whole point of the pregate (full bench would otherwise fire
    // NEIGHBOR_SEARCH_LIMIT garden round-trips per new memory).
    expect(llmPort.classifyPair).not.toHaveBeenCalled();
    // The local heuristic also rejects this pair (no strong tag overlap),
    // so no candidate is submitted — the pregate's only job is to skip the
    // LLM, not to short-circuit the heuristic fallback.
    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
  });

it("B-2 pregate routes related pairs to the LLM port as before", async () => {
    // High token-Jaccard pair — pregate passes, LLM verdict propagates.
    const newMemory = createMemoryEntry({
      content: "RTK wrapper is required for shell commands in this repository.",
      domain_tags: ["rtk", "workflow"]
    });
    const relatedNeighbor = createMemoryEntry({
      object_id: "memory-related",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, relatedNeighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => ({
        edgeType: "supports" as const,
        confidence: 0.92,
        rationale: "shared RTK rule"
      }))
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(llmPort.classifyPair).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ relationKind: "supports", recallBiasSign: 1 })
    );
  });

it("B-2 pregate still allows tag-overlap-only pairs through to the LLM", async () => {
    // Zero content token overlap (different topics in text) but a shared
    // domain tag — the LLM should still get a chance to judge, because
    // tag overlap is an independent relatedness signal.
    const newMemory = createMemoryEntry({
      content: "Database connection pool is sized at thirty-two slots.",
      domain_tags: ["rtk", "platform"]
    });
    const tagOverlapNeighbor = createMemoryEntry({
      object_id: "memory-tag-overlap",
      content: "Shell logging follows a structured json line format.",
      domain_tags: ["rtk", "platform"]
    });
    const { deps } = createDeps([newMemory, tagOverlapNeighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => null)
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // LLM gets the call (tag overlap is a real relatedness signal); a
    // null verdict then falls back to the local heuristic which (lacking
    // strong tag overlap and token Jaccard) rejects the pair.
    expect(llmPort.classifyPair).toHaveBeenCalledTimes(1);
  });

// R0-B host-worker defer: when the edgeClassifyQueue is wired, the
  // LLM-quality verdict is ENQUEUED (not called synchronously) and the
  // deterministic heuristic still produces the edge inline.
  it("host-worker defer: enqueues EDGE_CLASSIFY AND still submits the inline heuristic edge", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const edgeClassifyQueue = {
      enqueueEdgeClassify: vi.fn(async () => undefined)
    };
    const service = new EdgeAutoProducerService({ ...deps, edgeClassifyQueue });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // The LLM-quality verdict was DEFERRED to the host worker.
    expect(edgeClassifyQueue.enqueueEdgeClassify).toHaveBeenCalledTimes(1);
    expect(edgeClassifyQueue.enqueueEdgeClassify).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        source: expect.objectContaining({ object_id: "memory-new" }),
        neighbor: expect.objectContaining({ object_id: "memory-existing" })
      })
    );
    // The inline heuristic edge still landed (eventual consistency: the edge
    // exists now; the LLM verdict refines it later).
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ relationKind: "supports", recallBiasSign: 1 })
    );
    const submitArgs = pathCandidatePort.submitCandidate.mock.calls[0]![0];
    expect(submitArgs.why?.some((line) => line.includes("local_supports"))).toBe(true);
  });

it("host-worker defer: a queue enqueue failure is non-fatal — the heuristic edge still stands", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const edgeClassifyQueue = {
      enqueueEdgeClassify: vi.fn(async () => {
        throw new Error("queue is down");
      })
    };
    const warn = vi.fn();
    const service = new EdgeAutoProducerService({ ...deps, edgeClassifyQueue, warn });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // Enqueue threw, but the inline heuristic edge still landed and the call
    // did not abort. A single observable warn fires for the operator.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toContain("edge-classify enqueue failed");
  });

it("host-worker defer: bypasses the synchronous llmPort entirely", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps } = createDeps([newMemory, neighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => ({
        edgeType: "supports" as const,
        confidence: 0.95,
        rationale: "should never be consulted when the queue is wired"
      }))
    };
    const edgeClassifyQueue = {
      enqueueEdgeClassify: vi.fn(async () => undefined)
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort, edgeClassifyQueue });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // The in-process llmPort is NOT consulted: the verdict is deferred.
    expect(llmPort.classifyPair).not.toHaveBeenCalled();
    expect(edgeClassifyQueue.enqueueEdgeClassify).toHaveBeenCalledTimes(1);
  });

describe("applyVerdict (host-worker verdict upgrade)", () => {
    it("applies a supports verdict above floor through the path candidate sink", async () => {
      const { deps, pathCandidatePort } = createDeps([]);
      const service = new EdgeAutoProducerService(deps);

      const outcome = await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-existing",
          edge_type: "supports",
          confidence: 0.93,
          rationale: "both rows assert the same rule"
        }
      });

      expect(outcome).toBe("applied");
      expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAnchor: { kind: "object", object_id: "memory-new" },
          targetAnchor: { kind: "object", object_id: "memory-existing" },
          relationKind: "supports",
          recallBiasSign: 1
        })
      );
      const submitArgs = pathCandidatePort.submitCandidate.mock.calls[0]![0];
      expect(submitArgs.why?.some((line) => line.includes("host-worker pair classifier"))).toBe(true);
      expect(submitArgs.why?.some((line) => line.includes("llm_supports"))).toBe(true);
    });

    it("applies a derives_from verdict into the DERIVES_FROM profile", async () => {
      const { deps, pathCandidatePort } = createDeps([]);
      const service = new EdgeAutoProducerService(deps);

      await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: null,
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-source",
          edge_type: "derives_from",
          confidence: 0.9,
          rationale: ""
        }
      });

      expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ relationKind: "derives_from", recallBiasSign: 1 })
      );
    });

    it("a none verdict is a no-op — the heuristic edge is never touched", async () => {
      const { deps, pathCandidatePort } = createDeps([]);
      const service = new EdgeAutoProducerService(deps);

      const outcome = await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-existing",
          edge_type: "none",
          confidence: 0.99,
          rationale: "no relationship"
        }
      });

      expect(outcome).toBeNull();
      expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
    });

    it("a below-floor verdict is a no-op (heuristic edge stands)", async () => {
      const { deps, pathCandidatePort } = createDeps([]);
      const service = new EdgeAutoProducerService(deps);

      const outcome = await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-existing",
          edge_type: "supports",
          confidence: 0.5,
          rationale: "uncertain"
        }
      });

      expect(outcome).toBeNull();
      expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
    });

    it("directional-dedup: a family-swap verdict does NOT mint a second positive path", async () => {
      // The inline heuristic already minted a positive associative `supports`
      // path for the exact ordered pair. A host verdict of a DIFFERENT positive
      // family (derives_from) on the SAME ordered pair must NOT mint a parallel
      // positive path (that would double the pair's recall-bias from untrusted
      // worker input); it is a no-op refinement instead.
      const { deps, pathCandidatePort } = createDeps([]);
      const existingPathReader = {
        findByBackingObjectId: vi.fn(async (_workspaceId: string, objectId: string) => {
          if (objectId !== "memory-new") {
            return [];
          }
          return [
            makePositiveAssociativePath("supports", "memory-new", "memory-existing")
          ];
        })
      };
      const service = new EdgeAutoProducerService({ ...deps, existingPathReader });

      const outcome = await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-existing",
          edge_type: "derives_from",
          confidence: 0.95,
          rationale: "host worker says derives_from"
        }
      });

      // Exactly ONE positive path on the pair: the verdict refined nothing, so
      // submitCandidate was never invoked a second time.
      expect(outcome).toBe("already_present");
      expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
      expect(existingPathReader.findByBackingObjectId).toHaveBeenCalledWith(
        "workspace-1",
        "memory-new"
      );
    });

    it("directional-dedup: a verdict for a pair with NO existing positive path still mints", async () => {
      // The legitimate weak-overlap / first-edge case: no inline heuristic edge
      // exists for the pair, so the host verdict is the first (and only) edge.
      const { deps, pathCandidatePort } = createDeps([]);
      const existingPathReader = {
        findByBackingObjectId: vi.fn(async () => [])
      };
      const service = new EdgeAutoProducerService({ ...deps, existingPathReader });

      const outcome = await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-existing",
          edge_type: "derives_from",
          confidence: 0.95,
          rationale: "host worker says derives_from"
        }
      });

      expect(outcome).toBe("applied");
      expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
      expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ relationKind: "derives_from", recallBiasSign: 1 })
      );
    });

    it("directional-dedup: an existing path on a DIFFERENT pair does not block the mint", async () => {
      // A positive path exists from memory-new to memory-other; the verdict pair
      // is memory-new -> memory-existing. Different ordered pair, so the verdict
      // still mints its own first edge.
      const { deps, pathCandidatePort } = createDeps([]);
      const existingPathReader = {
        findByBackingObjectId: vi.fn(async () => [
          makePositiveAssociativePath("supports", "memory-new", "memory-other")
        ])
      };
      const service = new EdgeAutoProducerService({ ...deps, existingPathReader });

      const outcome = await service.applyVerdict({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        verdict: {
          source_object_id: "memory-new",
          neighbor_object_id: "memory-existing",
          edge_type: "supports",
          confidence: 0.95,
          rationale: "host worker says supports"
        }
      });

      expect(outcome).toBe("applied");
      expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    });
  });
});
