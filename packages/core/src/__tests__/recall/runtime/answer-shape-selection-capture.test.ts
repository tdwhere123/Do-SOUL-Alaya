import { describe, expect, it } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("recall answer-shape selection capture", () => {
  it("does not attach prefix_sk ranking or capture_execution on live recall", async () => {
    const { ordinary, captured } = await recallYogaPair();

    expect(ordinary.ranking_authority).not.toBe("prefix_sk");
    expect(captured.ranking_authority).not.toBe("prefix_sk");
    expect(ordinary.capture_execution).toBeUndefined();
    expect(captured.capture_execution).toBeUndefined();
    expect(ordinary.diagnostics?.answer_shape_plan).toBeUndefined();
    expect(captured.diagnostics?.answer_shape_plan).toBeUndefined();
    expect(ordinary.provider_calls).toBe(0);
    expect(ordinary.garden_enqueue).toBe(0);
    expect(ordinary.index).toBeDefined();
    expect(captured.index).toEqual(ordinary.index);
    expect(ordinary.index.completeness.logical_index === "complete"
      || ordinary.index.completeness.logical_index === "open"
      || ordinary.index.completeness.logical_index === "unavailable").toBe(true);
  });

  it("delivers the information index without answer-feature capture", async () => {
    const { ordinary, captured } = await recallYogaPair();

    expect(captured.candidates.map((candidate) => candidate.object_id)).toEqual(
      ordinary.candidates.map((candidate) => candidate.object_id)
    );
    expect(ordinary.diagnostics).toBeUndefined();
    expect(captured.diagnostics).toBeUndefined();
    expect(ordinary.index.entries.map((entry) => entry.object_id)).toEqual(
      captured.index.entries.map((entry) => entry.object_id)
    );
    expect(JSON.stringify(ordinary)).not.toContain("prefix_sk");
  });
});

async function recallYogaPair() {
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
  const captured = await service.recall({
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze",
    diagnosticCapture: "answer_features"
  });
  return { ordinary, captured };
}
