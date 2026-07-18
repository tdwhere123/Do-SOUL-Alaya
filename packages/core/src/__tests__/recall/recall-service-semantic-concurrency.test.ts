import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../config/install-core-config.js";
import { addSemanticSupplementCandidates } from "../../recall/coarse-filter/coarse-filter-semantic.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildRecallPolicy } from "../../shared/recall-policy.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("semantic supplement concurrency", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("starts split-anchor searches together but admits their matches in anchor order", async () => {
    installCoreConfigFromProcessEnv({
      ALAYA_RECALL_SEMANTIC_ANCHOR_LANE: "1",
      ALAYA_RECALL_SEMANTIC_SUBQUERY: "1"
    });
    const first = createMemoryEntry({ object_id: "memory-first-anchor" });
    const second = createMemoryEntry({ object_id: "memory-second-anchor" });
    const releases = new Map<string, (hits: readonly { object_id: string; normalized_rank: number }[]) => void>();
    const searchByAnchorWithinObjectIds = vi.fn(
      async (_workspaceId: string, anchors: readonly string[]) =>
        await new Promise<readonly { object_id: string; normalized_rank: number }[]>((resolve) => {
          releases.set(anchors[0]!, resolve);
        })
    );
    const admitted: string[] = [];
    const policy = buildRecallPolicy({
      runtimeId: "runtime-anchor-concurrency",
      taskSurfaceId: "surface-anchor-concurrency",
      maxResults: 5,
      filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: true,
      maxTotalTokens: 2_000,
      embeddingSupplementEnabled: true
    });

    const pending = addSemanticSupplementCandidates({
      context: {
        dependencies: {
          memoryRepo: {
            findByWorkspaceId: vi.fn(async () => []),
            findByDimension: vi.fn(async () => []),
            findByScopeClass: vi.fn(async () => []),
            searchByKeywordWithinObjectIds: vi.fn(async () => []),
            searchByAnchorWithinObjectIds
          },
          slotRepo: { findByWorkspace: vi.fn(async () => []) },
          eventLogRepo: {
            append: vi.fn(),
            queryByEntity: vi.fn(async () => [])
          }
        },
        warn: vi.fn()
      },
      workspaceId: "workspace-1",
      config: policy.coarse_filter,
      queryText: "first and second",
      queryProbes: compileRecallQueryProbes("first and second"),
      anchors: { required: ["first", "second"], optional: [] },
      intent: "multi_fact",
      tier: "hot",
      tierScopedSearchEligible: false,
      byId: new Map([
        [first.object_id, first],
        [second.object_id, second]
      ]),
      addCandidate: (entry) => {
        admitted.push(entry.object_id);
      },
      ftsRanks: new Map(),
      trigramFtsRanks: new Map(),
      evidenceFtsRanks: new Map(),
      evidenceFtsRanksPerRef: new Map()
    });

    await vi.waitFor(() => expect(searchByAnchorWithinObjectIds).toHaveBeenCalledTimes(2));
    releases.get("second")?.([{ object_id: second.object_id, normalized_rank: 0.8 }]);
    releases.get("first")?.([{ object_id: first.object_id, normalized_rank: 0.7 }]);
    await pending;

    expect(searchByAnchorWithinObjectIds.mock.calls.map((call) => call[1])).toEqual([
      ["first"],
      ["second"]
    ]);
    expect(admitted).toEqual([first.object_id, second.object_id]);
  });

  it("preserves prior-anchor admission before an ordered split search failure", async () => {
    installCoreConfigFromProcessEnv({
      ALAYA_RECALL_ANCHOR_LANE: "1",
      ALAYA_RECALL_SUBQUERY: "1"
    });
    const first = createMemoryEntry({ object_id: "memory-first-anchor" });
    const second = createMemoryEntry({ object_id: "memory-second-anchor" });
    const searchByAnchorWithinObjectIds = vi.fn(async (_workspaceId: string, anchors: readonly string[]) => {
      if (anchors[0] === "first") {
        return [{ object_id: first.object_id, normalized_rank: 0.7 }];
      }
      throw new Error("second anchor failed");
    });
    const admitted: string[] = [];
    const policy = buildRecallPolicy({
      runtimeId: "runtime-anchor-failure",
      taskSurfaceId: "surface-anchor-failure",
      maxResults: 5,
      filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: true,
      maxTotalTokens: 2_000,
      embeddingSupplementEnabled: true
    });

    await expect(addSemanticSupplementCandidates({
      context: {
        dependencies: {
          memoryRepo: {
            findByWorkspaceId: vi.fn(async () => []),
            findByDimension: vi.fn(async () => []),
            findByScopeClass: vi.fn(async () => []),
            searchByKeywordWithinObjectIds: vi.fn(async () => []),
            searchByAnchorWithinObjectIds
          },
          slotRepo: { findByWorkspace: vi.fn(async () => []) },
          eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => []) }
        },
        warn: vi.fn()
      },
      workspaceId: "workspace-1",
      config: policy.coarse_filter,
      queryText: "first and second",
      queryProbes: compileRecallQueryProbes("first and second"),
      anchors: { required: ["first", "second"], optional: [] },
      intent: "multi_fact",
      tier: "hot",
      tierScopedSearchEligible: false,
      byId: new Map([
        [first.object_id, first],
        [second.object_id, second]
      ]),
      addCandidate: (entry) => {
        admitted.push(entry.object_id);
      },
      ftsRanks: new Map(),
      trigramFtsRanks: new Map(),
      evidenceFtsRanks: new Map(),
      evidenceFtsRanksPerRef: new Map()
    })).rejects.toThrow("second anchor failed");

    expect(searchByAnchorWithinObjectIds).toHaveBeenCalledTimes(2);
    expect(admitted).toEqual([first.object_id]);
  });
});
