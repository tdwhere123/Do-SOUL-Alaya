import { describe, expect, it } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import {
  materializeFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryPendingCapture
} from
  "../../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("recall answer-shape selection capture", () => {
  it("uses the selection-boundary capture decision for request diagnostics", async () => {
    const { ordinary, captured, pendingCaptures } = await recallYogaCapturePair();

    expect(ordinary.diagnostics?.answer_shape_plan).toEqual(
      captured.diagnostics?.answer_shape_plan
    );
    expect(pendingCaptures).toHaveLength(1);
    expect(captured.diagnostics?.answer_shape_plan).toMatchObject({
      status: "high_confidence",
      shape: "place"
    });
  });

  it("keeps selected keys identical without enabling answer-feature capture", async () => {
    const { ordinary, captured, pendingCaptures } = await recallYogaCapturePair();

    expect(captured.candidates.map((candidate) => candidate.object_id)).toEqual(
      ordinary.candidates.map((candidate) => candidate.object_id)
    );
    expect(ordinary.diagnostics?.candidates).toEqual([]);
    expect(captured.diagnostics?.candidates).toEqual([]);
    expect(pendingCaptures).toHaveLength(1);
    expect(pendingCaptures[0]?.params.captureAnswerFeatures).toBe(false);
    const boundary = materializeFineAssessmentSelectionBoundary(pendingCaptures[0]!);
    expect(boundary.schema_version).toBe(5);
    expect(boundary.expected.pre_projection?.admission_actions.length)
      .toBeGreaterThan(0);
  });
});

async function recallYogaCapturePair() {
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
  const pendingCaptures: FineAssessmentSelectionBoundaryPendingCapture[] = [];
  const captured = await service.recall({
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze",
    selectionBoundaryObserver: (pending) => {
      pendingCaptures.push(pending);
      return undefined;
    }
  });
  return { ordinary, captured, pendingCaptures };
}
