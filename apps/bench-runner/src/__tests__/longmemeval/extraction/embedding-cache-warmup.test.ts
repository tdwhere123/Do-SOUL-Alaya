import { describe, expect, it, vi } from "vitest";
import { warmLongMemEvalEmbeddingCaches } from "../../../longmemeval/provenance/embedding/embedding-cache-warmup.js";

const vectorSummary = {
  status: "ready" as const,
  expected_count: 2,
  ready_count: 2,
  ready_rate: 1,
  pass_count: 1,
  missing_object_ids: [],
  provider_kind: "local_onnx",
  model_id: "Xenova/test",
  schema_version: 1,
  d2q_input: "raw_content" as const
};

describe("warmLongMemEvalEmbeddingCaches", () => {
  it("keeps the disabled arm free of embedding side effects", async () => {
    const workspace = {
      warmEmbeddingCache: vi.fn(),
      warmQueryEmbeddingCache: vi.fn()
    };

    await expect(warmLongMemEvalEmbeddingCaches({
      embeddingMode: "disabled",
      workspace,
      objectIds: ["m-1"],
      queryText: "question"
    })).resolves.toEqual({ embeddingWarmup: null, queryEmbeddingWarmup: null });
    expect(workspace.warmEmbeddingCache).not.toHaveBeenCalled();
    expect(workspace.warmQueryEmbeddingCache).not.toHaveBeenCalled();
  });

  it("warms document vectors only and leaves query encode to timed recall", async () => {
    const workspace = {
      warmEmbeddingCache: vi.fn(async () => vectorSummary),
      warmQueryEmbeddingCache: vi.fn()
    };

    await expect(warmLongMemEvalEmbeddingCaches({
      embeddingMode: "env",
      workspace,
      objectIds: ["m-1", "m-2"],
      queryText: "question"
    })).resolves.toEqual({
      embeddingWarmup: vectorSummary,
      queryEmbeddingWarmup: null
    });
    expect(workspace.warmEmbeddingCache).toHaveBeenCalledWith(["m-1", "m-2"]);
    expect(workspace.warmQueryEmbeddingCache).not.toHaveBeenCalled();
  });
});
