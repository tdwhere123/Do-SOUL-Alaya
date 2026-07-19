import { describe, expect, it, vi } from "vitest";

const embedTexts = vi.fn(async () => [[0.25, 0.75]]);

vi.mock("@do-soul/alaya-core", () => ({
  LocalOnnxEmbeddingClient: class {
    readonly modelId = "test-local-onnx";
    readonly embedTexts = embedTexts;
  }
}));

import { preflightEmbeddingProvider } from "../../../harness/embedding/embedding-provider-preflight.js";

describe("embedding provider preflight", () => {
  it("defaults to the local ONNX provider", async () => {
    const result = await preflightEmbeddingProvider({ env: {} });

    expect(result).toEqual({
      ok: true,
      message: "embedding provider preflight ok: provider=local_onnx model=test-local-onnx dims=2"
    });
    expect(embedTexts).toHaveBeenCalledOnce();
  });

  it("uses OpenAI only when selected explicitly", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await preflightEmbeddingProvider({
      env: {
        ALAYA_EMBEDDING_PROVIDER: "openai",
        ALAYA_OPENAI_SECRET_REF: "env:TEST_OPENAI_KEY",
        TEST_OPENAI_KEY: "test-key"
      },
      secretRefReader: {
        readEnv: (name) => name === "TEST_OPENAI_KEY" ? "test-key" : undefined,
        readFile: () => {
          throw new Error("not used");
        },
        readKeychain: () => {
          throw new Error("not used");
        }
      },
      fetchImpl
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed for an unsupported provider", async () => {
    const result = await preflightEmbeddingProvider({
      env: { ALAYA_EMBEDDING_PROVIDER: "unknown" }
    });

    expect(result).toEqual({
      ok: false,
      message: "embedding provider preflight failed: unsupported provider unknown"
    });
  });
});
