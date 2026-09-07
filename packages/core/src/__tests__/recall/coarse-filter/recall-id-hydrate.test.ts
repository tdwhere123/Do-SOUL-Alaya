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
import { createMemoryEntry } from "../recall-service-test-fixtures.js";
import { runConditionalFieldRecall } from "../../../recall/recall-service.js";
import { defaultBudget, SNAPSHOT_ID, INTERPRETATION_CLOCK } from
  "../conditional-field/reference/deployment.fixture.js";

describe("conditional field source hydration", () => {
  it("keeps a failed lexical source hydration unavailable instead of known empty", () => {
    const source = vi.fn(() => ({ row: null, rowsRead: 0, bytesRead: 0, unavailable: true }));
    const result = runConditionalFieldRecall({
      workspace_id: "workspace-1", query_text: "needle", budget: defaultBudget(),
      snapshot_id: SNAPSHOT_ID, interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK, expires_at: "2026-12-01T00:00:00.000Z",
      readers: {
        lexical: () => ({ ids: ["missing"], nativeVisits: 1, nativeBytes: 9,
          rowsRead: 1, bytesRead: 9, truncated: false }),
        source
      }
    });
    expect(source).toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.completeness.observed_coverage).toBe("unavailable");
    expect(result.completeness.logical_index).not.toBe("complete");
  });
});

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
