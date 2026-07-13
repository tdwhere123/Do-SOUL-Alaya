import { describe, expect, it, vi } from "vitest";
import { warmLongMemEvalEmbeddingCaches } from "../../longmemeval/embedding-cache-warmup.js";

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

const querySummary = {
  status: "ready" as const,
  requested_count: 1,
  ready_count: 1,
  cache_hit_count: 0,
  provider_requested_count: 1,
  missing_count: 0,
  provider_kind: "local_onnx",
  model_id: "Xenova/test",
  schema_version: 1,
  d2q_input: "raw_content" as const
};

const localEnv = {
  ALAYA_EMBEDDING_PROVIDER: "local_onnx",
  ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/test"
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

  it("requires persisted document vectors before warming the query", async () => {
    const order: string[] = [];
    const workspace = {
      warmEmbeddingCache: vi.fn(async () => {
        order.push("vectors");
        return vectorSummary;
      }),
      warmQueryEmbeddingCache: vi.fn(async () => {
        order.push("query");
        return querySummary;
      })
    };

    await expect(warmLongMemEvalEmbeddingCaches({
      embeddingMode: "env",
      workspace,
      objectIds: ["m-1", "m-2"],
      queryText: "question",
      env: localEnv
    })).resolves.toEqual({
      embeddingWarmup: vectorSummary,
      queryEmbeddingWarmup: querySummary
    });
    expect(order).toEqual(["vectors", "query"]);
  });

  it.each([
    ["partial", { ...querySummary, ready_count: 0, missing_count: 1 }],
    ["not requested", {
      ...querySummary,
      status: "not_requested" as const,
      ready_count: 0,
      provider_requested_count: 0,
      missing_count: 1,
      provider_kind: null,
      model_id: null,
      schema_version: null,
      d2q_input: null
    }],
    ["provider error", { ...querySummary, ready_count: 0, missing_count: 1, last_error: "offline" }]
  ] as const)("fails before recall when query warmup is %s", async (_case, summary) => {
    const recall = vi.fn();
    const workspace = {
      warmEmbeddingCache: vi.fn(async () => vectorSummary),
      warmQueryEmbeddingCache: vi.fn(async () => summary)
    };

    await expect((async () => {
      await warmLongMemEvalEmbeddingCaches({
        embeddingMode: "env",
        workspace,
        objectIds: ["m-1", "m-2"],
        queryText: "question",
        env: localEnv
      });
      await recall();
    })()).rejects.toThrow(/query embedding warmup not ready/u);
    expect(recall).not.toHaveBeenCalled();
  });

  it("rejects a query vector produced by the wrong model", async () => {
    const workspace = {
      warmEmbeddingCache: vi.fn(async () => vectorSummary),
      warmQueryEmbeddingCache: vi.fn(async () => ({
        ...querySummary,
        model_id: "Xenova/other"
      }))
    };

    await expect(warmLongMemEvalEmbeddingCaches({
      embeddingMode: "env",
      workspace,
      objectIds: ["m-1", "m-2"],
      queryText: "question",
      env: localEnv
    })).rejects.toThrow(/model=Xenova\/other expected_model=Xenova\/test/u);
  });

  it.each([
    ["schema", { schema_version: 2 }],
    ["D2Q input", { d2q_input: "content_plus_hq" as const }]
  ])("rejects a query vector with the wrong %s identity", async (_label, drift) => {
    const workspace = {
      warmEmbeddingCache: vi.fn(async () => vectorSummary),
      warmQueryEmbeddingCache: vi.fn(async () => ({ ...querySummary, ...drift }))
    };
    await expect(warmLongMemEvalEmbeddingCaches({
      embeddingMode: "env",
      workspace,
      objectIds: ["m-1"],
      queryText: "question",
      env: localEnv
    })).rejects.toThrow(/query embedding warmup not ready/u);
  });

  it("keeps OpenAI on raw-content schema when D2Q is enabled", async () => {
    const openAiQuery = {
      ...querySummary,
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    };
    const workspace = {
      warmEmbeddingCache: vi.fn(async () => vectorSummary),
      warmQueryEmbeddingCache: vi.fn(async () => openAiQuery)
    };
    await expect(warmLongMemEvalEmbeddingCaches({
      embeddingMode: "env",
      workspace,
      objectIds: ["m-1"],
      queryText: "question",
      env: { ALAYA_EMBEDDING_PROVIDER: "openai", ALAYA_RECALL_D2Q: "true" }
    })).resolves.toMatchObject({ queryEmbeddingWarmup: openAiQuery });
  });
});
