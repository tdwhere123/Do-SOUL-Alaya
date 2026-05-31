import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { EdgeAutoProducerService } from "../edge-auto-producer-service.js";
import type { PathMintOutcome } from "../path-relation-proposal-service.js";

// Structural shape the assertions read off the submitCandidate fake; the
// full SubmitCandidateInput is wider but these are the fields under test.
interface SubmittedCandidate {
  readonly relationKind: string;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly governanceClass?: string;
  readonly initialStrength?: number;
  readonly why?: readonly string[];
}

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

function createDeps(memories: readonly MemoryEntry[]) {
  const byId = new Map(memories.map((memory) => [memory.object_id, memory]));
  const searchByKeyword = vi.fn(async (_workspaceId: string, _queryText: string, _limit: number) =>
    memories
      .filter((memory) => memory.object_id !== "memory-new")
      .map((memory, index) => ({
        object_id: memory.object_id,
        normalized_rank: 1 - index * 0.1
      }))
  );
  const findByIds = vi.fn(async (objectIds: readonly string[]) =>
    objectIds.flatMap((objectId) => {
      const memory = byId.get(objectId);
      return memory === undefined ? [] : [memory];
    })
  );
  const findById = vi.fn(async (objectId: string) => byId.get(objectId) ?? null);
  const pathCandidatePort = {
    submitCandidate: vi.fn(async (_input: SubmittedCandidate): Promise<PathMintOutcome> => "applied")
  };
  return {
    deps: {
      memoryRepo: { findById, searchByKeyword, findByIds },
      pathCandidatePort
    },
    findById,
    searchByKeyword,
    findByIds,
    pathCandidatePort
  };
}

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

  // invariant (codex spine-review B5): a TRANSIENT "failed" outcome on any
  // candidate must surface as a throw so the bulk-enrich worker keeps the row
  // pending and a later cycle retries. Swallowing it would let the worker
  // markProcessed an owed path away.
  it("B5: throws when a path candidate returns the transient failed outcome", async () => {
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

  // invariant (codex spine-review B5 x B3): a PERMANENT "rejected" outcome is a
  // decided no (bad anchor) — retrying cannot help — so it must NOT throw. The
  // worker then markProcessed the row instead of looping on a poison pill.
  it("B5xB3: does NOT throw when a path candidate is permanently rejected", async () => {
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

  it("uses bounded local search only and has no external provider dependency", async () => {
    const newMemory = createMemoryEntry();
    const neighbors = Array.from({ length: 20 }, (_, index) =>
      createMemoryEntry({
        object_id: `memory-neighbor-${index}`,
        content: `RTK shell command workflow neighbor ${index}`,
        domain_tags: ["rtk", "workflow"]
      })
    );
    const { deps, searchByKeyword, findByIds } = createDeps([newMemory, ...neighbors]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(searchByKeyword).toHaveBeenCalledWith("workspace-1", newMemory.content, 12);
    expect(findByIds.mock.calls[0][0]).toHaveLength(12);
  });
});
