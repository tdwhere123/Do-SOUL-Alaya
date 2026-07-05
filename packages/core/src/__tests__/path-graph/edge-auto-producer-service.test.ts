import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { EdgeAutoProducerService } from "../../path-graph/producers/edge-auto-producer-service.js";
import type { PathMintOutcome } from "../../path-graph/edge-proposals/path-relation-proposal-service.js";
import { createDeps, createMemoryEntry } from "./edge-auto-producer-service-test-fixtures.js";

describe("EdgeAutoProducerService", () => {
it("B-2 proposes supports for strong same-dimension local neighbors", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      created_at: "2026-05-24T10:00:00.000Z",
      updated_at: "2026-05-24T10:00:00.000Z",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // The producer no longer writes memory_graph_edges; it submits a
    // governed SUPPORTS-profile path candidate (recall_bias +).
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceAnchor: { kind: "object", object_id: "memory-new" },
        targetAnchor: { kind: "object", object_id: "memory-existing" },
        relationKind: "supports",
        governanceClass: "attention_only",
        recallBiasSign: 1,
        initialStrength: 0.5
      })
    );
    const submitArgs = pathCandidatePort.submitCandidate.mock.calls[0]![0];
    expect(submitArgs.why?.some((line) => line.includes("source_signal=signal-1"))).toBe(true);
  });

// invariant: a TRANSIENT "failed" outcome on any
  // candidate must surface as a throw so the bulk-enrich worker keeps the row
  // pending and a later cycle retries. Swallowing it would let the worker
  // markProcessed an owed path away.
  it("throws when a path candidate returns the transient failed outcome", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      created_at: "2026-05-24T10:00:00.000Z",
      updated_at: "2026-05-24T10:00:00.000Z",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "failed");
    const service = new EdgeAutoProducerService(deps);

    await expect(
      service.produceForNewMemory({
        newMemoryId: newMemory.object_id,
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1"
      })
    ).rejects.toMatchObject({ name: "CoreError", code: "OBLIGATION_VIOLATION" });
  });

// invariant: a PERMANENT "rejected" outcome is a
  // decided no (bad anchor) — retrying cannot help — so it must NOT throw. The
  // worker then markProcessed the row instead of looping on a poison pill.
  it("does NOT throw when a path candidate is permanently rejected", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      created_at: "2026-05-24T10:00:00.000Z",
      updated_at: "2026-05-24T10:00:00.000Z",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "rejected");
    const service = new EdgeAutoProducerService(deps);

    await expect(
      service.produceForNewMemory({
        newMemoryId: newMemory.object_id,
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1"
      })
    ).resolves.toBeUndefined();
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
  });

it("B-2 proposes derives_from for deterministic derivation cues", async () => {
    const newMemory = createMemoryEntry({
      formation_kind: "derived",
      content: "Based on the repository RTK workflow, all shell commands should use rtk.",
      domain_tags: ["rtk", "workflow"]
    });
    const neighbor = createMemoryEntry({
      object_id: "memory-source",
      content: "The repository workflow requires rtk for shell commands.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAnchor: { kind: "object", object_id: "memory-new" },
        targetAnchor: { kind: "object", object_id: "memory-source" },
        relationKind: "derives_from",
        recallBiasSign: 1
      })
    );
  });

it("B-3 proposes supersedes for newer replacement memories in the same topic", async () => {
    const newMemory = createMemoryEntry({
      content: "The repo now uses pnpm commands through rtk instead of npm commands.",
      domain_tags: ["package-manager", "workflow"],
      created_at: "2026-05-24T12:00:00.000Z"
    });
    const oldMemory = createMemoryEntry({
      object_id: "memory-old",
      content: "The repo uses npm commands through rtk for package scripts.",
      domain_tags: ["package-manager", "workflow"],
      created_at: "2026-05-23T12:00:00.000Z"
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, oldMemory]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // A local supersedes verdict is a weak claim: it folds into a weak
    // negative path (recall_bias -, attention_only), not a recall_allowed
    // negative edge. The recall_allowed/0.9 band is reserved for
    // SYSTEM-derived negatives from ConflictDetectionService.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAnchor: { kind: "object", object_id: "memory-new" },
        targetAnchor: { kind: "object", object_id: "memory-old" },
        relationKind: "supersedes",
        recallBiasSign: -1,
        governanceClass: "attention_only",
        initialStrength: 0.5
      })
    );
  });

// B7: the local contradicts heuristic — a high-overlap neighbor with an
  // explicit contradiction cue folds into a weak negative `contradicts` path
  // (attention_only, recall_bias -0.4), the sibling of the supersedes lane.
  it("B7 proposes contradicts for a high-overlap neighbor carrying a contradiction cue", async () => {
    const newMemory = createMemoryEntry({
      content:
        "The claim that the repo uses npm commands through rtk for package scripts is not true.",
      domain_tags: ["package-manager", "workflow"],
      created_at: "2026-05-24T12:00:00.000Z"
    });
    const neighbor = createMemoryEntry({
      object_id: "memory-claim",
      content: "The repo uses npm commands through rtk for package scripts.",
      domain_tags: ["package-manager", "workflow"],
      created_at: "2026-05-23T12:00:00.000Z"
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAnchor: { kind: "object", object_id: "memory-new" },
        targetAnchor: { kind: "object", object_id: "memory-claim" },
        relationKind: "contradicts",
        recallBiasSign: -1,
        governanceClass: "attention_only",
        initialStrength: 0.5
      })
    );
  });

it("does not propose contradicts when the high-overlap neighbor carries no contradiction cue", async () => {
    const newMemory = createMemoryEntry({
      content: "The repo uses npm commands through rtk for package scripts in detail.",
      domain_tags: ["package-manager", "workflow"],
      created_at: "2026-05-24T12:00:00.000Z"
    });
    const neighbor = createMemoryEntry({
      object_id: "memory-claim",
      content: "The repo uses npm commands through rtk for package scripts.",
      domain_tags: ["package-manager", "workflow"],
      created_at: "2026-05-23T12:00:00.000Z"
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // No contradiction cue -> not a contradicts edge (it may fold into a
    // positive supports/derives_from path instead, but never contradicts).
    for (const call of pathCandidatePort.submitCandidate.mock.calls) {
      expect(call[0].relationKind).not.toBe("contradicts");
    }
  });

it("does not propose edges for weak, cross-scope, or cross-dimension neighbors", async () => {
    const newMemory = createMemoryEntry();
    const weak = createMemoryEntry({
      object_id: "memory-weak",
      content: "The deployment window is on Friday.",
      domain_tags: ["release"],
      dimension: MemoryDimension.FACT
    });
    const crossDimension = createMemoryEntry({
      object_id: "memory-dimension",
      dimension: MemoryDimension.PREFERENCE,
      content: newMemory.content,
      domain_tags: newMemory.domain_tags
    });
    const crossScope = createMemoryEntry({
      object_id: "memory-scope",
      scope_class: ScopeClass.GLOBAL_CORE,
      content: newMemory.content,
      domain_tags: newMemory.domain_tags
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, weak, crossDimension, crossScope]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
  });

it("B-2 LLM supports verdict above floor folds into the SUPPORTS path profile", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => ({
        edgeType: "supports" as const,
        confidence: 0.92,
        rationale: "both rows assert the same RTK rule"
      }))
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(llmPort.classifyPair).toHaveBeenCalledWith({ newMemory, neighbor });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAnchor: { kind: "object", object_id: "memory-new" },
        targetAnchor: { kind: "object", object_id: "memory-existing" },
        relationKind: "supports",
        recallBiasSign: 1
      })
    );
    // The LLM trigger + rationale provenance survives in why_this_relation_exists.
    const submitArgs = pathCandidatePort.submitCandidate.mock.calls[0]![0];
    expect(submitArgs.why?.some((line) => line.includes("llm pair classifier"))).toBe(true);
  });

it("B-2 LLM derives_from verdict folds into the DERIVES_FROM path profile", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-source",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => ({
        edgeType: "derives_from" as const,
        confidence: 0.88,
        rationale: ""
      }))
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        relationKind: "derives_from",
        recallBiasSign: 1
      })
    );
  });

it("B-2 LLM below 0.85 floor falls back to the local supports profile", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const llmPort = {
      classifyPair: vi.fn(async () => ({
        edgeType: "supports" as const,
        confidence: 0.7, // below floor
        rationale: "uncertain"
      }))
    };
    const service = new EdgeAutoProducerService({ ...deps, llmPort });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // Falls back to the local supports heuristic — same supports profile,
    // but the why provenance names the local rule bucket.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ relationKind: "supports", recallBiasSign: 1 })
    );
    const submitArgs = pathCandidatePort.submitCandidate.mock.calls[0]![0];
    expect(submitArgs.why?.some((line) => line.includes("local_supports"))).toBe(true);
  });

it("B-2 LLM null verdict falls back to the local supports profile", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
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

    expect(llmPort.classifyPair).toHaveBeenCalled();
    const submitArgs = pathCandidatePort.submitCandidate.mock.calls[0]![0];
    expect(submitArgs.relationKind).toBe("supports");
    expect(submitArgs.why?.some((line) => line.includes("local_supports"))).toBe(true);
  });

// invariant: the LLM port can return `null` either because the model
  // explicitly judged "no relationship" OR because the adapter failed and
  // degraded to null. Both paths fall through to the local heuristic and
  // a local-heuristic proposal may still be emitted (with trigger_source
  // = local_*). This is the intended design: the LLM is advisory, never
  // a veto. Adapter failures additionally emit a single warn event;
  // verdict-null does not (an explicit model "no" is not an error).
  it("LLM-rejected verdict (null) still allows a local-heuristic proposal to be emitted with no warn", async () => {
    const newMemory = createMemoryEntry();
    const neighbor = createMemoryEntry({
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighbor]);
    const llmPort = {
      // Simulates the model explicitly judging "no relationship" — the
      // adapter parsed a well-formed verdict whose edge_type was "none",
      // and createEdgeAutoProducerLlmPort.classifyPair returned null
      // (see apps/core-daemon/src/edge-auto-producer-llm-adapter.ts
      // materializeDecision). This is NOT an adapter failure.
      classifyPair: vi.fn(async () => null)
    };
    const warn = vi.fn();
    const service = new EdgeAutoProducerService({ ...deps, llmPort, warn });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // The local heuristic still gets to fire on the same neighbor and
    // submits a local supports-profile candidate. The LLM rejection is
    // silent: it is not an adapter error, so no warn fires.
    expect(llmPort.classifyPair).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ relationKind: "supports", recallBiasSign: 1 })
    );
    // Verdict-null must NOT emit a warn — only adapter exceptions do.
    // see also: B-2 LLM throwing port test above (warns + falls back).
    const adapterWarnCalls = warn.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes("edge auto producer llm port classify failed")
    );
    expect(adapterWarnCalls).toEqual([]);
  });

it("B-2 LLM throwing port is non-fatal: falls back, warns, never aborts other neighbors", async () => {
    const newMemory = createMemoryEntry();
    const neighborA = createMemoryEntry({
      object_id: "memory-A",
      content: "Repository shell commands must use the RTK wrapper.",
      domain_tags: ["rtk", "workflow"]
    });
    const neighborB = createMemoryEntry({
      object_id: "memory-B",
      content: "RTK is required for shell commands in repository scripts.",
      domain_tags: ["rtk", "workflow"]
    });
    const { deps, pathCandidatePort } = createDeps([newMemory, neighborA, neighborB]);
    const llmPort = {
      classifyPair: vi.fn(async () => {
        throw new Error("garden timed out");
      })
    };
    const warn = vi.fn();
    const service = new EdgeAutoProducerService({ ...deps, llmPort, warn });

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    // Both neighbors still submit local supports-profile candidates.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(2);
    for (const call of pathCandidatePort.submitCandidate.mock.calls) {
      expect(call[0].relationKind).toBe("supports");
    }
    expect(warn).toHaveBeenCalled();
    const warnArgs = warn.mock.calls[0]!;
    expect(warnArgs[0]).toContain("edge auto producer llm port classify failed");
    expect(warnArgs[1]).toMatchObject({
      new_memory_id: "memory-new",
      error: "garden timed out"
    });
  });
});
