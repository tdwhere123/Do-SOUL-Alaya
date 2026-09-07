import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createFieldBackedRecallService,
  withKeywordFieldFixturePorts
} from
  "./fixtures/keyword-field-fixture.js";
import { runCoarseFilter } from "../../recall/coarse-filter/coarse-filter.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("retained component contracts", () => {
it("keeps the keyword supplement enabled for chat and analyze", () => {
    const service = createFieldBackedRecallService(createDependencies([]).dependencies);
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
    const service = createFieldBackedRecallService(dependencies);
    const policy = semanticPolicy(service);

    await runCoarseFilter({
      dependencies: withKeywordFieldFixturePorts({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinTier,
          searchByKeywordWithinObjectIds
        }
      }),
      warn: vi.fn()
    }, "workspace-1", policy.coarse_filter, "window needle", {
      timeFilter: { since: "2026-01-01T00:00:00.000Z", field: "created_at" }
    });

    expect(searchByKeywordWithinTier).not.toHaveBeenCalled();
    expect(searchByKeywordWithinObjectIds).toHaveBeenCalledWith(
      "workspace-1", "window needle", 5, [valid.object_id]
    );
  });

it("uses exact validated ids when a later cursor page is invalid", async () => {
    const valid = createMemoryEntry({ object_id: "memory-loaded-window" });
    const { dependencies } = createDependencies([valid]);
    const searchByKeywordWithinTier = vi.fn(async () => [
      { object_id: "memory-ahead-of-window", normalized_rank: 1 }
    ]);
    const searchByKeywordWithinObjectIds = vi.fn(async () => [
      { object_id: valid.object_id, normalized_rank: 0.8 }
    ]);
    const service = createFieldBackedRecallService(dependencies);
    const policy = semanticPolicy(service);

    await runCoarseFilter({
      dependencies: withKeywordFieldFixturePorts({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findRecallTierWindow: vi.fn(async (query: Readonly<{
            cursor?: Readonly<{ created_at: string; object_id: string }>;
          }>) => {
            const cursor = { created_at: valid.created_at, object_id: valid.object_id };
            return query.cursor === undefined
              ? { memories: [valid], next_cursor: cursor, truncated: true }
              : {
                  memories: [createMemoryEntry({ object_id: "invalid-page-row" })],
                  next_cursor: cursor,
                  truncated: true
                };
          }),
          searchByKeywordWithinTier,
          searchByKeywordWithinObjectIds
        }
      }),
      warn: vi.fn()
    }, "workspace-1", policy.coarse_filter, "truncated needle");

    expect(searchByKeywordWithinTier).not.toHaveBeenCalled();
    expect(searchByKeywordWithinObjectIds).toHaveBeenCalledWith(
      "workspace-1", "truncated needle", 5, [valid.object_id]
    );
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
