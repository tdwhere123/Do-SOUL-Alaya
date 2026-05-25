import { describe, expect, it, vi } from "vitest";
import {
  EdgeProposalTriggerSource,
  MemoryDimension,
  MemoryGraphEdgeType,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { EdgeAutoProducerService } from "../edge-auto-producer-service.js";

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
  const graphEdgePort = {
    createEdge: vi.fn(async () => undefined)
  };
  return {
    deps: {
      memoryRepo: { findById, searchByKeyword, findByIds },
      graphEdgePort
    },
    findById,
    searchByKeyword,
    findByIds,
    graphEdgePort
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
    const { deps, graphEdgePort } = createDeps([newMemory, neighbor]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(graphEdgePort.createEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMemoryId: "memory-new",
        targetMemoryId: "memory-existing",
        edgeType: MemoryGraphEdgeType.SUPPORTS,
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        triggerSource: EdgeProposalTriggerSource.SYSTEM
      })
    );
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
    const { deps, graphEdgePort } = createDeps([newMemory, neighbor]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(graphEdgePort.createEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMemoryId: "memory-new",
        targetMemoryId: "memory-source",
        edgeType: MemoryGraphEdgeType.DERIVES_FROM,
        confidence: expect.any(Number)
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
    const { deps, graphEdgePort } = createDeps([newMemory, oldMemory]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(graphEdgePort.createEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMemoryId: "memory-new",
        targetMemoryId: "memory-old",
        edgeType: MemoryGraphEdgeType.SUPERSEDES,
        confidence: expect.any(Number)
      })
    );
    const confidence = graphEdgePort.createEdge.mock.calls[0][0].confidence;
    expect(confidence).toBeGreaterThanOrEqual(0.55);
    expect(confidence).toBeLessThanOrEqual(0.85);
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
    const { deps, graphEdgePort } = createDeps([newMemory, weak, crossDimension, crossScope]);
    const service = new EdgeAutoProducerService(deps);

    await service.produceForNewMemory({
      newMemoryId: newMemory.object_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });

    expect(graphEdgePort.createEdge).not.toHaveBeenCalled();
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
