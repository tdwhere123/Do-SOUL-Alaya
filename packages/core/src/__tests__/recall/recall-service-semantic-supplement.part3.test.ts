import { describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { runCoarseFilter } from "../../recall/coarse-filter/coarse-filter.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("RecallService semantic supplement", () => {
  it("keeps the keyword supplement enabled for chat and analyze", () => {
    const service = new RecallService(createDependencies([]).dependencies);
    const expected = {
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    };

    expect(
      service.buildDefaultPolicy("chat", createTaskSurface().runtime_id)
        .coarse_filter.semantic_supplement
    ).toEqual(expected);
    expect(
      service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id)
        .coarse_filter.semantic_supplement
    ).toEqual(expected);
  });

  it("merges supplement candidates without duplicating existing matches", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.2,
        content: "General workspace procedure."
      }),
      createMemoryEntry({
        object_id: "memory-2",
        dimension: MemoryDimension.PREFERENCE,
        activation_score: 0.2,
        content: "Implement recall supplement."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-1", normalized_rank: 0.1 },
      { object_id: "memory-2", normalized_rank: 1.0 }
    ]);
    dependencies.memoryRepo.searchByKeyword = searchByKeyword;
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("build", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: { enabled: true, max_supplement: 5 }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build",
      policyOverride: policy
    });

    expect(searchByKeyword).toHaveBeenCalledWith("workspace-1", "Implement recall", 5);
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-2", "memory-1"]);
    expect(new Set(result.candidates.map((candidate) => candidate.object_id)).size)
      .toBe(result.candidates.length);
  });

  it("uses tier-scoped supplement search so short-token fallback cannot starve live matches", async () => {
    const memories = [createMemoryEntry({
      object_id: "memory-hot",
      dimension: MemoryDimension.PREFERENCE,
      activation_score: 0.2,
      content: "Go keep the hot supplement candidate alive."
    })];
    const { dependencies } = createDependencies(memories);
    const searchByKeyword = vi.fn(async () => [
      { object_id: "memory-cold-1", normalized_rank: 1 },
      { object_id: "memory-cold-2", normalized_rank: 1 }
    ]);
    const searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: "memory-hot", normalized_rank: 1 }
    ]);
    const searchByKeywordWithinTier = vi.fn(async () => [
      { object_id: "memory-hot", normalized_rank: 1 }
    ]);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword,
        searchByKeywordWithinTier,
        searchByKeywordWithinObjectIds
      }
    });
    const basePolicy = service.buildDefaultPolicy("chat", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: { enabled: true, max_supplement: 5 }
      }
    });

    const result = await service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "Go review" },
      workspaceId: "workspace-1",
      strategy: "chat",
      policyOverride: policy
    });

    expect(searchByKeywordWithinTier).toHaveBeenCalledWith("workspace-1", "Go review", 5, "hot");
    expect(searchByKeywordWithinObjectIds).not.toHaveBeenCalled();
    expect(searchByKeyword).not.toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-hot"]);
  });

  it("uses exact loaded ids when a time filter narrows the tier window", async () => {
    const valid = createMemoryEntry({
      object_id: "memory-in-window",
      created_at: "2026-07-01T00:00:00.000Z"
    });
    const excluded = createMemoryEntry({
      object_id: "memory-before-window",
      created_at: "2025-07-01T00:00:00.000Z"
    });
    const { dependencies } = createDependencies([valid, excluded]);
    const searchByKeywordWithinTier = vi.fn(async () => [
      { object_id: excluded.object_id, normalized_rank: 1 }
    ]);
    const searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: valid.object_id, normalized_rank: 0.8 }
    ]);
    const service = new RecallService(dependencies);
    const policy = semanticPolicy(service);

    await runCoarseFilter({
      dependencies: {
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinTier,
          searchByKeywordWithinObjectIds
        }
      },
      warn: vi.fn()
    }, "workspace-1", policy.coarse_filter, "window needle", {
      timeFilter: { since: "2026-01-01T00:00:00.000Z" }
    });

    expect(searchByKeywordWithinTier).not.toHaveBeenCalled();
    expect(searchByKeywordWithinObjectIds).toHaveBeenCalledWith(
      "workspace-1", "window needle", 5, [valid.object_id]
    );
  });

  it("uses exact loaded ids when the tier window is truncated", async () => {
    const valid = createMemoryEntry({ object_id: "memory-loaded-window" });
    const { dependencies } = createDependencies([valid]);
    const searchByKeywordWithinTier = vi.fn(async () => [
      { object_id: "memory-ahead-of-window", normalized_rank: 1 }
    ]);
    const searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: valid.object_id, normalized_rank: 0.8 }
    ]);
    const service = new RecallService(dependencies);
    const policy = semanticPolicy(service);

    await runCoarseFilter({
      dependencies: {
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findRecallTierWindow: vi.fn(async () => ({
            memories: [valid],
            next_cursor: null,
            truncated: true
          })),
          searchByKeywordWithinTier,
          searchByKeywordWithinObjectIds
        }
      },
      warn: vi.fn()
    }, "workspace-1", policy.coarse_filter, "truncated needle");

    expect(searchByKeywordWithinTier).not.toHaveBeenCalled();
    expect(searchByKeywordWithinObjectIds).toHaveBeenCalledWith(
      "workspace-1", "truncated needle", 5, [valid.object_id]
    );
  });

  it("returns empty candidates for an empty workspace", async () => {
    const { dependencies } = createDependencies([]);
    const result = await new RecallService(dependencies).recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "chat"
    });

    expect(result.candidates).toEqual([]);
    expect(result.total_scanned).toBe(0);
    expect(result.working_projection).toBeNull();
  });
});

function semanticPolicy(service: RecallService) {
  const basePolicy = service.buildDefaultPolicy("chat", createTaskSurface().runtime_id);
  return overridePolicy(basePolicy, {
    coarse_filter: {
      ...basePolicy.coarse_filter,
      semantic_supplement: { enabled: true, max_supplement: 5 }
    }
  });
}
