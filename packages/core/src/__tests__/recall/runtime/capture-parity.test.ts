import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import {
  CAPTURE_PARITY_GEOMETRY_BASIS,
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

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

describe("capture parity comparer", () => {
  it("reports parity when capture-off and capture-on views match", async () => {
    const { off, on } = await recallCapturePair();

    const report = compareCaptureParity([off], [on], 1);

    expect(report.parity).toBe(true);
    expect(report.schema_version).toBe(2);
    expect(report.geometry_basis).toBe(CAPTURE_PARITY_GEOMETRY_BASIS);
    expect(report.sidecar_question_count).toBe(1);
    expect(report.window_length).toBe(1);
    expect("demand" in off.geometry).toBe(false);
    expect(report.summary).toMatchObject({
      channels: "pass",
      geometry: "pass",
      membership: "pass"
    });
    expect(report.first_difference).toBeNull();
    expect(report.questions[0]?.digests.off.channels).toMatch(DIGEST);
    expect(report.questions[0]?.digests.on.channels).toBe(
      report.questions[0]?.digests.off.channels
    );
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

    const report = compareCaptureParity([off], [mutated], 1);

    expect(report.parity).toBe(false);
    expect(report.summary.membership).toBe("fail");
    expect(report.first_difference?.axis).toBe("membership");
    expect(report.first_difference?.message).toContain("injected-member");
    expect(report.questions[0]?.digests.off.membership).toMatch(DIGEST);
    expect(report.questions[0]?.digests.on.membership).not.toBe(
      report.questions[0]?.digests.off.membership
    );
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

    const report = compareCaptureParity([withEmbedding], [withoutEmbedding], 1);

    expect(report.parity).toBe(true);
    expect(report.summary.channels).toBe("pass");
    expect(report.summary.exercised_masks).toContain("embedding_observation");
    expect(report.questions[0]?.exercised_masks).toContain("embedding_observation");
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

    const report = compareCaptureParity([hydrated], [computed], 1);

    expect(report.parity).toBe(true);
    expect(report.summary.exercised_masks).toContain("hydrate_vs_compute");
    expect(report.questions[0]?.exercised_masks).toContain("hydrate_vs_compute");
  });

  it("does not excuse a lexical channel mismatch when embedding observation is masked", async () => {
    const { off } = await recallCapturePair();
    const observed = withLexical(
      withEmbeddingChannel(off),
      ["lexical-original"]
    );
    const maskedAndDrifted = withLexical(
      createCaptureParityView({
        ...observed,
        channels: observed.channels.filter(
          (channel) => channel.channel_id !== "object_embedding_pool"
        )
      }),
      ["lexical-drifted"]
    );

    const report = compareCaptureParity([observed], [maskedAndDrifted], 1);

    expect(report.parity).toBe(false);
    expect(report.summary.channels).toBe("fail");
    expect(report.summary.exercised_masks).toContain("embedding_observation");
    expect(report.questions[0]?.exercised_masks).toContain("embedding_observation");
    expect(report.first_difference?.axis).toBe("channels");
    expect(report.first_difference?.message).toContain("lexical-drifted");
  });

  it("throws on an empty compare window", () => {
    expect(() => compareCaptureParity([], [], 0)).toThrow(
      /sidecar_question_count must be a positive integer|window is empty/
    );
    expect(() => compareCaptureParity([], [], 1)).toThrow(/window is empty/);
  });

  it("throws when the window does not match sidecar question count", async () => {
    const { off, on } = await recallCapturePair();

    expect(() => compareCaptureParity([off], [on], 2)).toThrow(
      /window_length=1 does not match sidecar_question_count=2/
    );
  });

  it("throws when retrieval_field_captures are absent", async () => {
    const result = await recallYoga();
    const absent = {
      ...result,
      diagnostics: {
        ...result.diagnostics!,
        retrieval_field_captures: undefined
      }
    };

    expect(() => extractCaptureParityView("yoga-place", absent)).toThrow(
      /retrieval_field_captures missing/
    );
    expect(() => extractCaptureParityView("yoga-place", {
      ...result,
      diagnostics: {
        ...result.diagnostics!,
        retrieval_field_captures: null as never
      }
    })).toThrow(/retrieval_field_captures missing/);
    expect(() => extractCaptureParityView("yoga-place", {
      ...result,
      diagnostics: {
        ...result.diagnostics!,
        retrieval_field_captures: []
      }
    })).toThrow(/retrieval_field_captures missing/);
  });

  it("throws when query_probes are absent", async () => {
    const result = await recallYoga();

    expect(() => extractCaptureParityView("yoga-place", {
      ...result,
      diagnostics: {
        ...result.diagnostics!,
        query_probes: null as never
      }
    })).toThrow(/query probes missing/);
    expect(() => extractCaptureParityView("yoga-place", {
      ...result,
      diagnostics: {
        ...result.diagnostics!,
        query_probes: undefined as never
      }
    })).toThrow(/query probes missing/);
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

async function recallYoga() {
  const memory = createMemoryEntry({
    content: "I take yoga classes at Serenity Yoga."
  });
  const { dependencies } = createDependencies([memory]);
  const service = new RecallService(dependencies);
  return service.recall({
    taskSurface: {
      ...createTaskSurface(),
      display_name: "Where do I take yoga classes?"
    },
    workspaceId: "workspace-1",
    strategy: "analyze"
  });
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

function withLexical(
  view: CaptureParityView,
  observationKeys: readonly string[]
): CaptureParityView {
  return createCaptureParityView({
    ...view,
    channels: [
      ...view.channels.filter((channel) => channel.channel_id !== "lexical_relaxed_exact"),
      {
        channel_id: "lexical_relaxed_exact",
        status: "complete",
        observation_keys: [...observationKeys]
      }
    ]
  });
}
