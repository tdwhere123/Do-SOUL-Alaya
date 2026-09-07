import { describe, expect, it } from "vitest";
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
  it("reports parity when capture-off and capture-on views match", () => {
    const off = syntheticView();
    const on = syntheticView();

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

  it("fails closed on an injected membership difference", () => {
    const off = syntheticView();
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

  it("does not fail when the only difference is embedding absence", () => {
    const off = syntheticView();
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

  it("does not fail when the only difference is hydrate versus compute", () => {
    const off = syntheticView();
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

  it("does not excuse a lexical channel mismatch when embedding observation is masked", () => {
    const off = syntheticView();
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

  it("throws when the window does not match sidecar question count", () => {
    const off = syntheticView();
    const on = syntheticView();

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
        retrieval_field_captures: [{
          channel: {
            channel_id: "lexical_relaxed_exact",
            status: "complete",
            observations: []
          }
        }],
        query_probes: null as never
      }
    })).toThrow(/query probes missing/);
    expect(() => extractCaptureParityView("yoga-place", {
      ...result,
      diagnostics: {
        retrieval_field_captures: [{
          channel: {
            channel_id: "lexical_relaxed_exact",
            status: "complete",
            observations: []
          }
        }],
        query_probes: undefined as never
      }
    })).toThrow(/query probes missing/);
  });

  it("live recall does not emit capture-parity diagnostics or prefix_sk ranking", async () => {
    const result = await recallYoga();
    expect(result.ranking_authority).not.toBe("prefix_sk");
    expect(result.capture_execution).toBeUndefined();
    expect(result.provider_calls).toBe(0);
    expect(result.garden_enqueue).toBe(0);
    expect(result.index).toBeDefined();
    expect(result.index.completeness.logical_index === "complete"
      || result.index.completeness.logical_index === "open"
      || result.index.completeness.logical_index === "unavailable").toBe(true);
    expect(() => extractCaptureParityView("yoga-place", result)).toThrow(
      /diagnostics missing|retrieval_field_captures missing/
    );
  });
});

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

function syntheticView(): CaptureParityView {
  return createCaptureParityView({
    question_id: "yoga-place",
    channels: [{
      channel_id: "lexical_relaxed_exact",
      status: "complete",
      observation_keys: ["lexical-original"]
    }],
    geometry: {
      answer_shape_plan: { status: "high_confidence", shape: "place" },
      probes: { lexical_terms: ["yoga"] }
    },
    membership: [{ object_kind: "memory_entry", object_id: "memory-canonical" }],
    assessment_path: null
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
