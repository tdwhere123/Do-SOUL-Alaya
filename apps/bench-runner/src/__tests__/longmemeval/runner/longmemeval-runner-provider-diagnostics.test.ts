import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from "../../../longmemeval/diagnostics.js";
import { resolveBenchEmbeddingProviderLabel } from "../../../longmemeval/runner.js";

describe("LongMemEval runner", () => {

  it("redacts arbitrary provider degradation text from diagnostics sidecars", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-secret-provider-text",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          provider: {
            state: "provider_failed",
            degradation_reason: "sk-live-secret file:/home/me/.config/alaya/secrets/openai"
          },
          candidates: []
        }
      }
    });

    expect(row.provider_state).toBe("provider_failed");
    expect(row.provider_degradation_reason).toBeNull();
    expect(JSON.stringify(row)).not.toContain("sk-live-secret");
    expect(JSON.stringify(row)).not.toContain("/home/me/.config/alaya/secrets/openai");
  });

  it("preserves allowlisted provider degradation reasons in diagnostics sidecars", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-provider-pending",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          embedding_provider_status: "provider_pending",
          provider_degradation_reason: "query_embedding_pending",
          candidates: []
        }
      }
    });

    expect(row.provider_state).toBe("provider_pending");
    expect(row.provider_degradation_reason).toBe("query_embedding_pending");
  });

  it("labels env embedding benchmarks with provider and model metadata", () => {
    expect(
      resolveBenchEmbeddingProviderLabel("env", {
        OPENAI_EMBEDDING_PROVIDER_URL: "https://api.yunwu.example/v1",
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-large"
      }, "openai")
    ).toBe("yunwu:text-embedding-3-large");
    expect(
      resolveBenchEmbeddingProviderLabel("env", {
        OPENAI_EMBEDDING_PROVIDER_URL: "https://embedding-proxy.example/v1",
        OPENAI_EMBEDDING_MODEL: "custom-embed"
      }, "openai")
    ).toBe("openai-compatible:custom-embed");
    expect(resolveBenchEmbeddingProviderLabel("env", {}, "openai")).toBe(
      "openai:text-embedding-3-small"
    );
    expect(resolveBenchEmbeddingProviderLabel("env", {})).toBe(
      "local_onnx:Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
    expect(resolveBenchEmbeddingProviderLabel("disabled", {})).toBe("none");
    // local_onnx is an on-device provider: labeled by the resolved local model,
    // never the OPENAI_* remote-endpoint env vars (which do not describe it).
    expect(resolveBenchEmbeddingProviderLabel("env", {}, "local_onnx")).toBe(
      "local_onnx:Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
    expect(
      resolveBenchEmbeddingProviderLabel(
        "env",
        {
          ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/custom-model",
          OPENAI_EMBEDDING_MODEL: "ignored-for-local"
        },
        "local_onnx"
      )
    ).toBe("local_onnx:Xenova/custom-model");
  });

});
