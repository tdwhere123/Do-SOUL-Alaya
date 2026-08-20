import { describe, expect, it, vi } from "vitest";
import { StorageTier } from "@do-soul/alaya-protocol";
import { bindMainThreadHotReads } from "../../../runtime/recall-materialization/main-thread-hot-reads.js";
import type { RecallServiceMemoryRepoPort } from "@do-soul/alaya-core";

describe("bindMainThreadHotReads", () => {
  it("routes the HOT window and activation top-K to the main-thread repo", async () => {
    const workerWindow = vi.fn();
    const mainWindow = vi.fn(async () => ({
      memories: [],
      next_cursor: null,
      truncated: false
    }));
    const mainTopK = vi.fn(async () => []);
    const workerRepo = {
      findByWorkspaceId: vi.fn(async () => []),
      findByDimension: vi.fn(async () => []),
      findByScopeClass: vi.fn(async () => []),
      findRecallTierWindow: workerWindow
    } as unknown as RecallServiceMemoryRepoPort;
    const mainRepo = {
      findRecallTierWindow: mainWindow,
      findRecallActivationTopK: mainTopK
    };

    const bound = bindMainThreadHotReads(workerRepo, mainRepo);
    await bound.findRecallTierWindow?.({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 8
    });
    await bound.findRecallActivationTopK?.({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 3
    });

    expect(workerWindow).not.toHaveBeenCalled();
    expect(mainWindow).toHaveBeenCalledOnce();
    expect(mainTopK).toHaveBeenCalledOnce();
  });
});
