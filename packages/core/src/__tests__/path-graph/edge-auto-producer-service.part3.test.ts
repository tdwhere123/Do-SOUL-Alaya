import { describe, expect, it } from "vitest";
import { EdgeAutoProducerService } from "../../path-graph/edge-auto-producer-service.js";
import { createDeps, createMemoryEntry } from "./edge-auto-producer-service-test-fixtures.js";

describe("EdgeAutoProducerService", () => {
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
