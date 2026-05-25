import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { ConflictDetectionService } from "../conflict-detection-service.js";

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const base: MemoryEntry = {
    object_id: overrides.object_id ?? "memory-existing",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "I prefer dark roast coffee.",
    domain_tags: ["coffee", "preference"],
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
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
  return { ...base, ...overrides };
}

describe("ConflictDetectionService", () => {
  it("writes a contradicts edge when same-dimension peer has tag overlap and low token overlap", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findByWorkspaceId: vi.fn(async () => [existing])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const service = new ConflictDetectionService({ memoryRepo, graphEdgePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(graphEdgePort.createEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMemoryId: "mem-B",
        targetMemoryId: "mem-A",
        edgeType: "contradicts",
        workspaceId: "workspace-1",
        triggerSource: "conflict_detection",
        confidence: 0.5
      })
    );
  });

  it("skips contradicts when content is nearly identical (high token overlap)", async () => {
    const existing = createMemoryEntry({ object_id: "mem-A" });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findByWorkspaceId: vi.fn(async () => [existing])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const service = new ConflictDetectionService({ memoryRepo, graphEdgePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer dark roast coffee daily.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    const contradictsCalls = graphEdgePort.createEdge.mock.calls.filter(
      (call: any[]) => call[0].edgeType === "contradicts"
    );
    expect(contradictsCalls).toHaveLength(0);
  });

  it("writes an incompatible_with edge across dimensions when tags overlap", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      dimension: MemoryDimension.CONSTRAINT,
      content: "Hard rule about beans.",
      domain_tags: ["coffee"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => []),
      findByWorkspaceId: vi.fn(async () => [existing])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const service = new ConflictDetectionService({ memoryRepo, graphEdgePort });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer instant coffee.",
      newMemoryDomainTags: ["coffee"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    const incompatibleCalls = graphEdgePort.createEdge.mock.calls.filter(
      (call: any[]) => call[0].edgeType === "incompatible_with"
    );
    expect(incompatibleCalls).toHaveLength(1);
    expect(incompatibleCalls[0][0]).toMatchObject({
      sourceMemoryId: "mem-B",
      targetMemoryId: "mem-A"
    });
  });

  it("calls LLM port for ambiguous neighbors only when rule produced no contradicts", async () => {
    // tag overlap of {coffee, alpha} vs {coffee, beta} is 1/3 ≈ 0.333:
    // above the LLM threshold (0.25) but below the rule threshold (0.5),
    // so the rule path does not fire but LLM gets a chance.
    const ambiguous = createMemoryEntry({
      object_id: "mem-A",
      content: "Generic coffee preference text.",
      domain_tags: ["coffee", "alpha"]
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ambiguous]),
      findByWorkspaceId: vi.fn(async () => [])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const llmPort = {
      classifyPair: vi.fn(async () => "contradicts" as const)
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      graphEdgePort,
      llmPort,
      llmMaxPairsPerNewMemory: 4
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "Different but related coffee fact.",
      newMemoryDomainTags: ["coffee", "beta"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(llmPort.classifyPair).toHaveBeenCalled();
  });

  it("skips LLM when rule path already produced a contradicts edge", async () => {
    // tag overlap = 1.0 + token overlap << 0.35 → rule fires contradicts;
    // LLM must not run because LLM-only-on-no-rule is the documented
    // invariant.
    const ruleHit = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [ruleHit]),
      findByWorkspaceId: vi.fn(async () => [])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const llmPort = {
      classifyPair: vi.fn(async () => "contradicts" as const)
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      graphEdgePort,
      llmPort
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(llmPort.classifyPair).not.toHaveBeenCalled();
    const contradictsCalls = graphEdgePort.createEdge.mock.calls.filter(
      (call: any[]) => call[0].edgeType === "contradicts"
    );
    expect(contradictsCalls).toHaveLength(1);
  });

  it("does not throw when memoryRepo fails to read same-dimension peers", async () => {
    const memoryRepo = {
      findByDimension: vi.fn(async () => {
        throw new Error("repo down");
      }),
      findByWorkspaceId: vi.fn(async () => [])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const service = new ConflictDetectionService({ memoryRepo, graphEdgePort });

    await expect(
      service.detectAndLinkConflicts({
        newMemoryId: "mem-B",
        newMemoryDimension: MemoryDimension.PREFERENCE,
        newMemoryScopeClass: ScopeClass.PROJECT,
        newMemoryContent: "fact",
        newMemoryDomainTags: ["coffee"],
        workspaceId: "workspace-1",
        runId: "run-1"
      })
    ).resolves.toBeUndefined();
  });

  it("ruleEnabled=false skips rule-path edges so only the LLM port produces contradicts", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findByWorkspaceId: vi.fn(async () => [existing])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const llmPort = {
      classifyPair: vi.fn(async () => "contradicts" as const)
    };
    const service = new ConflictDetectionService({
      memoryRepo,
      graphEdgePort,
      llmPort,
      ruleEnabled: false
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(llmPort.classifyPair).toHaveBeenCalled();
    expect(graphEdgePort.createEdge).toHaveBeenCalledTimes(1);
    expect(graphEdgePort.createEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMemoryId: "mem-B",
        targetMemoryId: "mem-A",
        edgeType: "contradicts"
      })
    );
  });

  it("ruleEnabled=false with no llmPort produces no edges", async () => {
    const existing = createMemoryEntry({
      object_id: "mem-A",
      content: "I prefer dark roast coffee."
    });
    const memoryRepo = {
      findByDimension: vi.fn(async () => [existing]),
      findByWorkspaceId: vi.fn(async () => [existing])
    };
    const graphEdgePort = { createEdge: vi.fn(async () => undefined) };
    const service = new ConflictDetectionService({
      memoryRepo,
      graphEdgePort,
      ruleEnabled: false
    });

    await service.detectAndLinkConflicts({
      newMemoryId: "mem-B",
      newMemoryDimension: MemoryDimension.PREFERENCE,
      newMemoryScopeClass: ScopeClass.PROJECT,
      newMemoryContent: "I prefer light roast tea instead.",
      newMemoryDomainTags: ["coffee", "preference"],
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(graphEdgePort.createEdge).not.toHaveBeenCalled();
  });
});
