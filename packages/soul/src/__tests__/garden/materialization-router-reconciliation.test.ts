import { describe, expect, it, vi } from "vitest";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  type EnqueueFn,
  type MockPathRelationProposalFn,
  createDeps,
  createPathRelationProposalPort,
  createSignal} from "./materialization-router-fixture.js";

describe("MaterializationRouter ingest reconciliation", () => {
  function factSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
    return createSignal({
      object_kind: "fact",
      signal_kind: "potential_claim",
      confidence: 0.8,
      raw_payload: {
        excerpt: "The user lives in Berlin.",
        distilled_fact: "The user lives in Berlin."
      },
      ...overrides
    });
  }
  it("appends every fact when no reconciliationPort is wired (unchanged default)", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(result.created_objects).toContainEqual({
      object_kind: "memory_entry",
      object_id: "memory-1"
    });
  });


  it("memory_entry_only append branch enqueues enrichment after creating a memory", async () => {
    const deps = createDeps();
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    await router.materializeSignal(factSignal());

    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledWith({
      memoryId: "memory-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });
  });


  it("memory_entry_only append branch honors first-class source_memory_refs", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter({
      ...deps,
      pathRelationProposalPort: createPathRelationProposalPort()
    });

    await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-1", "mem-prior-2"],
        raw_payload: {
          excerpt: "Derived fact for D-1 attribution.",
          distilled_fact: "Derived fact for D-1 attribution."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const derivesFrom = calls.filter((candidate) => candidate.relationKind === "derives_from");
    expect(derivesFrom).toHaveLength(2);
    expect(derivesFrom.map((candidate) => candidate.targetAnchor.object_id).sort()).toEqual([
      "mem-prior-1",
      "mem-prior-2"
    ]);
    expect(
      derivesFrom.every((candidate) => candidate.sourceAnchor.object_id === "memory-1")
    ).toBe(true);
  });


  it("defers every first-class memory ref to the gating sink, which refuses refs that fail existence/ownership", async () => {
    const deps = createDeps();
    const validRefs = new Set(["mem-prior-1"]);
    deps.pathCandidateSinkPort.submitCandidate.mockImplementation(async (input) =>
      validRefs.has(input.targetAnchor.object_id) ? "applied" : "rejected"
    );
    const router = new MaterializationRouter({
      ...deps,
      pathRelationProposalPort: createPathRelationProposalPort()
    });

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-1"],
        supersedes_refs: ["mem-old-1"],
        exception_to_refs: ["mem-rule-2"],
        contradicts_refs: ["mem-conflict-3"],
        incompatible_with_refs: ["mem-incompat-4"],
        raw_payload: {
          excerpt: "Fact with stray claim-bearing refs.",
          distilled_fact: "Fact with stray claim-bearing refs."
        }
      })
    );

    expect(result.success).toBe(true);

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const results = deps.pathCandidateSinkPort.submitCandidate.mock.results.map(
      (entry) => entry.value
    );
    const accepted = await Promise.all(results);
    const decisions = calls.map((candidate, idx) => [
      candidate.targetAnchor.object_id,
      accepted[idx]
    ]);
    expect(decisions).toEqual([
      ["mem-prior-1", "applied"],
      ["mem-old-1", "rejected"],
      ["mem-rule-2", "rejected"],
      ["mem-conflict-3", "rejected"],
      ["mem-incompat-4", "rejected"]
    ]);
  });


  it("creates a durable path_relation proposal when a signal-ref path candidate returns failed", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockImplementation(async (input) =>
      input.targetAnchor.object_id === "mem-transient" ? "failed" : "applied"
    );
    const pathRelationProposalPort = createPathRelationProposalPort();
    const router = new MaterializationRouter({ ...deps, pathRelationProposalPort });

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-transient"],
        raw_payload: {
          excerpt: "Fact whose derives_from edge mint fails transiently.",
          distilled_fact: "Fact whose derives_from edge mint fails transiently."
        }
      })
    );

    expect(result.success).toBe(true);
    expect(result.created_objects).toContainEqual({
      object_kind: "proposal",
      object_id: "proposal-1"
    });
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledTimes(1);
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      targetObjectId: "memory-1",
      reason: expect.stringContaining("source_memory_refs path_relation candidate derives_from"),
      proposedPathRelation: {
        target_anchor: { kind: "object", object_id: "mem-transient" },
        constitution: {
          relation_kind: "derives_from",
          why_this_relation_exists: [
            "source_memory_refs on candidate signal signal-1",
            "run=run-1",
            "path candidate mint failed for target_anchor=mem-transient"
          ]
        },
        effect_vector: {
          salience: 0.5,
          recall_bias: 0.5,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "lens_entry"
        },
        plasticity_state: {
          strength: 0.5,
          direction_bias: "source_to_target",
          stability_class: "volatile",
          support_events_count: 1,
          contradiction_events_count: 0
        },
        lifecycle: {
          status: "active",
          retirement_rule: "governance_reject_or_low_strength"
        },
        legitimacy: {
          evidence_basis: ["llm_derives_inference"],
          governance_class: "attention_only"
        }
      }
    });
  });


  it("creates exactly one durable path_relation proposal when the signal-ref sink throws", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockImplementation(async (input) => {
      if (input.targetAnchor.object_id === "mem-thrower") {
        throw new Error("port wiring fault");
      }
      return "applied";
    });
    const pathRelationProposalPort = createPathRelationProposalPort();
    const router = new MaterializationRouter({ ...deps, pathRelationProposalPort });

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-thrower"],
        raw_payload: {
          excerpt: "Fact whose derives_from edge mint throws.",
          distilled_fact: "Fact whose derives_from edge mint throws."
        }
      })
    );

    expect(result.success).toBe(true);
    expect(result.created_objects).toContainEqual({
      object_kind: "proposal",
      object_id: "proposal-1"
    });
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledTimes(1);
    expect(pathRelationProposalPort.createPathRelationProposal.mock.calls[0]![0]).toMatchObject({
      targetObjectId: "memory-1",
      reason: expect.stringContaining("submitCandidate error: port wiring fault"),
      proposedPathRelation: {
        target_anchor: { kind: "object", object_id: "mem-thrower" },
        constitution: {
          relation_kind: "derives_from",
          why_this_relation_exists: [
            "source_memory_refs on candidate signal signal-1",
            "run=run-1",
            "path candidate mint failed for target_anchor=mem-thrower",
            "submitCandidate threw: port wiring fault"
          ]
        }
      }
    });
  });


  it("keeps a permanently-rejected signal-ref a clean drop without a fallback proposal", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockResolvedValue("rejected");
    const pathRelationProposalPort = createPathRelationProposalPort();
    const router = new MaterializationRouter({ ...deps, pathRelationProposalPort });

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-foreign"],
        raw_payload: {
          excerpt: "Fact referencing a foreign/missing memory.",
          distilled_fact: "Fact referencing a foreign/missing memory."
        }
      })
    );

    expect(result.success).toBe(true);
    expect(deps.pathCandidateSinkPort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathRelationProposalPort.createPathRelationProposal).not.toHaveBeenCalled();
  });


  it("defers post-create signal-ref transient failures to enrich_pending instead of duplicating proposal handoffs", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockResolvedValue("failed");
    const pathRelationProposalPort = {
      assertPathRelationProposalAvailable: vi.fn(async () => undefined),
      createPathRelationProposal: vi.fn<MockPathRelationProposalFn>(async () => {
        throw new Error("should not create inline proposal when enrich_pending can retry");
      })
    };
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = new MaterializationRouter({
      ...deps,
      pathRelationProposalPort,
      enrichPendingPort
    });

    try {
      const result = await router.materializeSignal(
        factSignal({
          source_memory_refs: ["mem-transient"],
          raw_payload: {
            excerpt: "Fact whose fallback proposal write fails after memory create.",
            distilled_fact: "Fact whose fallback proposal write fails after memory create."
          }
        })
      );

      expect(result.success).toBe(true);
      expect(result.created_objects).toContainEqual({
        object_kind: "memory_entry",
        object_id: "memory-1"
      });
      expect(enrichPendingPort.enqueue).toHaveBeenCalledWith({
        memoryId: "memory-1",
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1"
      });
      expect(pathRelationProposalPort.createPathRelationProposal).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "materialization-router: signal-ref path candidate deferred to enrich_pending retry",
        expect.objectContaining({
          sourceMemoryId: "memory-1",
          targetMemoryIds: ["mem-transient"],
          signalId: "signal-1",
          error: expect.stringContaining("source_memory_refs path_relation candidate derives_from")
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });


  it("replaySignalRefs throws transient failures for claim retry without creating fallback proposals", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockResolvedValue("failed");
    const pathRelationProposalPort = createPathRelationProposalPort();
    const router = new MaterializationRouter({ ...deps, pathRelationProposalPort });

    await expect(
      router.replaySignalRefs({
        newObjectId: "memory-1",
        signal: factSignal({ source_memory_refs: ["mem-transient"] })
      })
    ).rejects.toThrow("source_memory_refs path_relation candidate derives_from");
    expect(pathRelationProposalPort.createPathRelationProposal).not.toHaveBeenCalled();
  });


  it("returns unsuccessful before memory creation when refs need a fallback but no durable proposal port exists", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockResolvedValue("failed");
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-transient"],
        raw_payload: {
          excerpt: "Fact whose fallback proposal port is absent.",
          distilled_fact: "Fact whose fallback proposal port is absent."
        }
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("PathRelationProposalPort unavailable before materializing");
    expect(result.created_objects).toEqual([]);
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.pathCandidateSinkPort.submitCandidate).not.toHaveBeenCalled();
  });

});
