import { describe, expect, it, vi } from "vitest";
import { TransitionCausedBy } from "@do-soul/alaya-protocol";
import { MemoryService } from "../../memory/memory-service.js";
import { createDependencies, createMemoryEntry } from "./memory-service-test-fixtures.js";

describe("MemoryService", () => {
it("autonomousTombstone translates a storage CAS refusal after a concurrent explicit keep", async () => {
    const storageRefusal = Object.assign(new Error("storage CAS matched zero rows"), {
      name: "StorageError",
      code: "NOT_FOUND"
    });
    const findById = vi
      .fn()
      .mockResolvedValueOnce(createMemoryEntry({ lifecycle_state: "dormant", evidence_refs: [], reinforcement_count: 0 }))
      .mockResolvedValueOnce(
        createMemoryEntry({
          lifecycle_state: "dormant",
          evidence_refs: [],
          reinforcement_count: 0,
          decay_profile: "pinned"
        })
      );
    const tombstoneSpy = vi.fn(async () => {
      throw storageRefusal;
    });
    const { dependencies, appendSpy, notifySpy } = createDependencies({
      memoryEntryRepo: {
        create: vi.fn(async (entry) => entry),
        findById,
        findByWorkspaceId: vi.fn(async () => []),
        findByRunId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        update: vi.fn(async () => {
          throw new Error("not used");
        }),
        archive: vi.fn(async () => {
          throw new Error("not used");
        }),
        autonomousTombstone: tombstoneSpy
      }
    });
    const service = new MemoryService(dependencies);

    await expect(
      service.autonomousTombstone(
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        "judged_useless",
        null,
        "autonomous_forget_sweep",
        TransitionCausedBy.DETERMINISTIC_RULE
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Autonomous tombstone refused: memory is explicitly protected (pinned/hazard/canon/consolidated)"
    });

    expect(findById).toHaveBeenCalledTimes(2);
    expect(tombstoneSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
