import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("recall answer-shape selection capture", () => {
  it("uses the selection-boundary capture decision for request diagnostics", async () => {
    const memory = createMemoryEntry({
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService(dependencies);
    const taskSurface = {
      ...createTaskSurface(),
      display_name: "Where do I take yoga classes?"
    };

    const ordinary = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    const selectionBoundaryObserver = vi.fn(() => undefined);
    const captured = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      selectionBoundaryObserver
    });

    expect(ordinary.diagnostics?.answer_shape_plan).toBeUndefined();
    expect(selectionBoundaryObserver).toHaveBeenCalledOnce();
    expect(captured.diagnostics?.answer_shape_plan).toMatchObject({
      status: "high_confidence",
      shape: "place"
    });
  });
});
