import { describe, expect, it, vi } from "vitest";
import { StorageTier } from "@do-soul/alaya-protocol";
import {
  hydrateMemoriesById,
  hydrateQueryEvidenceRefMemories
} from "../../../recall/coarse-filter/pagination/recall-id-hydrate.js";
import type { RecallDegradationReason } from
  "../../../recall/runtime/recall-service-types.js";
import type { RecallServiceMemoryRepoPort } from
  "../../../recall/runtime/recall-service-ports.js";
import { createFieldBackedRecallService } from "../fixtures/keyword-field-fixture.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";
import {
  createDependencies,
  createMemoryEntry as createScoringMemory,
  createTaskSurface
} from "../recall-8factor-test-fixtures.js";

function stubRepo(
  overrides: Partial<RecallServiceMemoryRepoPort> = {}
): RecallServiceMemoryRepoPort {
  return {
    findByWorkspaceId: async () => [],
    findByDimension: async () => [],
    findByScopeClass: async () => [],
    ...overrides
  };
}

describe("hydrateMemoriesById lookup failure", () => {
  it("skips named ids when findByIds throws instead of aborting", async () => {
    const byId = new Map();
    const warn = vi.fn();
    const degradationReasons = new Set<RecallDegradationReason>();

    await expect(hydrateMemoriesById({
      memoryRepo: stubRepo({
        findByIds: async () => {
          throw new Error("memory id lookup unavailable");
        }
      }),
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      byId,
      objectIds: ["memory-2"],
      warn,
      degradationReasons
    })).resolves.toBeUndefined();

    expect(byId.size).toBe(0);
    expect(degradationReasons).toEqual(new Set(["memory_id_hydrate_failed"]));
    expect(warn).toHaveBeenCalledWith("memory hydrate lookup failed", expect.objectContaining({
      workspace_id: "workspace-1",
      operation: "findByIds",
      errorName: "Error",
      error: "memory id lookup unavailable"
    }));
  });

  it("still inserts a successful findByIds row", async () => {
    const live = createMemoryEntry({ object_id: "memory-live" });
    const byId = new Map();

    await hydrateMemoriesById({
      memoryRepo: stubRepo({
        findByIds: async () => [live]
      }),
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      byId,
      objectIds: [live.object_id]
    });

    expect(byId.get(live.object_id)).toBe(live);
  });
});

describe("hydrateQueryEvidenceRefMemories lookup failure", () => {
  it("skips evidence-ref hydration when findByEvidenceRefs throws", async () => {
    const byId = new Map();
    const warn = vi.fn();
    const degradationReasons = new Set<RecallDegradationReason>();

    await expect(hydrateQueryEvidenceRefMemories({
      memoryRepo: stubRepo({
        findByEvidenceRefs: async () => {
          throw new Error("evidence ref lookup unavailable");
        }
      }),
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      byId,
      evidenceObjectIds: ["evidence-1"],
      warn,
      degradationReasons
    })).resolves.toBeUndefined();

    expect(byId.size).toBe(0);
    expect(degradationReasons).toEqual(new Set(["memory_id_hydrate_failed"]));
    expect(warn).toHaveBeenCalledWith("memory hydrate lookup failed", expect.objectContaining({
      workspace_id: "workspace-1",
      operation: "findByEvidenceRefs",
      error: "evidence ref lookup unavailable"
    }));
  });
});

describe("live recall memory hydrate lookup failure", () => {
  it("records memory_id_hydrate_failed when lexical findByIds throws", async () => {
    const { dependencies } = createDependencies([
      createScoringMemory({ object_id: "memory-1" })
    ]);
    const findByIds = vi.fn(async () => {
      throw new Error("memory id lookup unavailable");
    });
    const service = createFieldBackedRecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => [
          { object_id: "fts-only", normalized_rank: 1 }
        ]),
        findByIds
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Implement recall"),
      workspaceId: "workspace-1",
      strategy: "build",
      diagnosticCapture: "answer_features"
    });

    expect(findByIds).toHaveBeenCalledWith("workspace-1", ["fts-only"]);
    expect(result.diagnostics?.degradation_reasons).toEqual(["memory_id_hydrate_failed"]);
  });
});
