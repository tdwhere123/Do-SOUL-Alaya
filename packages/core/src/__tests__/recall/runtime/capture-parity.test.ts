import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import {
  compareCaptureParity,
  createCaptureParityView,
  extractCaptureParityView,
  type CaptureParityView
} from "../../../recall/runtime/capture-parity.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("capture parity comparer", () => {
  it("reports parity when capture-off and capture-on views match", async () => {
    const { off, on } = await recallCapturePair();

    const report = compareCaptureParity([off], [on]);

    expect(report.parity).toBe(true);
    expect(report.summary).toMatchObject({
      channels: "pass",
      geometry: "pass",
      membership: "pass"
    });
    expect(report.first_difference).toBeNull();
  });

  it("fails closed on an injected membership difference", async () => {
    const { off } = await recallCapturePair();
    const mutated = createCaptureParityView({
      ...off,
      membership: [
        ...off.membership,
        { object_kind: "memory_entry", object_id: "injected-member" }
      ]
    });

    const report = compareCaptureParity([off], [mutated]);

    expect(report.parity).toBe(false);
    expect(report.summary.membership).toBe("fail");
    expect(report.first_difference?.axis).toBe("membership");
    expect(report.first_difference?.message).toContain("injected-member");
  });

  it("does not fail when the only difference is embedding absence", async () => {
    const { off } = await recallCapturePair();
    const withEmbedding = withEmbeddingChannel(off);
    const withoutEmbedding = createCaptureParityView({
      ...withEmbedding,
      channels: withEmbedding.channels.filter(
        (channel) => channel.channel_id !== "object_embedding_pool"
      )
    });

    const report = compareCaptureParity([withEmbedding], [withoutEmbedding]);

    expect(report.parity).toBe(true);
    expect(report.summary.channels).toBe("pass");
    expect(report.summary.exercised_masks).toContain("embedding_observation");
  });

  it("does not fail when the only difference is hydrate versus compute", async () => {
    const { off } = await recallCapturePair();
    const hydrated = createCaptureParityView({
      ...off,
      assessment_path: "snapshot"
    });
    const computed = createCaptureParityView({
      ...off,
      assessment_path: "legacy"
    });

    const report = compareCaptureParity([hydrated], [computed]);

    expect(report.parity).toBe(true);
    expect(report.summary.exercised_masks).toContain("hydrate_vs_compute");
  });
});

async function recallCapturePair(): Promise<{
  readonly off: CaptureParityView;
  readonly on: CaptureParityView;
}> {
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
    selectionBoundaryObserver: vi.fn(() => undefined)
  });
  return {
    off: extractCaptureParityView("yoga-place", ordinary),
    on: extractCaptureParityView("yoga-place", captured)
  };
}

function withEmbeddingChannel(view: CaptureParityView): CaptureParityView {
  return createCaptureParityView({
    ...view,
    channels: [
      ...view.channels,
      {
        channel_id: "object_embedding_pool",
        status: "complete",
        observation_keys: ["embedding-candidate"]
      }
    ]
  });
}
