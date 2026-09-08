import { describe, expect, it } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("RecallService provider isolation", () => {
  it("keeps the frozen synthesis port unused during ordinary recall", async () => {
    const memory = createMemoryEntry({ object_id: "selected-memory" });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      runId: "run-1"
    });

    expect(result.synthesis).toEqual({ status: "absent" });
    expect(result.index).toBeDefined();
  });
});
