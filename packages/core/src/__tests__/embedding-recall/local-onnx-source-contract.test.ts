import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SourceIndexProfile } from "@do-soul/alaya-protocol";
import { localOnnxSourceModelContract } from "../../embedding-recall/local-onnx-source-contract.js";
import { decodeLocalOnnxIpcVectors, decodeLocalOnnxSourceResults } from "../../embedding-recall/local-onnx-process/vectors.js";

describe("local Source model selection", () => {
  it("selects CLS and 1024 dimensions only for the named Source-only encoder", () => {
    expect(localOnnxSourceModelContract("Xenova/bge-m3")).toMatchObject({
      modelType: "xlm-roberta", pooling: "cls", dimensions: 1024, maxInputTokens: 8192, sourceOnly: true
    });
    expect(localOnnxSourceModelContract("Xenova/paraphrase-multilingual-MiniLM-L12-v2")).toMatchObject({
      modelType: "bert", pooling: "mean", dimensions: 384, sourceOnly: false
    });
  });

  it("decodes Source rows against the bound profile while legacy vectors remain 384-dimensional", () => {
    const profile: SourceIndexProfile = { provider_kind: "local_onnx", model_id: "Xenova/bge-m3", model_revision: "fixture",
      artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fixture", dimensions: 1024,
      preprocessing: "raw", normalization: "cls.l2.q8.v1", max_input_tokens: 8192,
      windowing: "recorded-message-windows.v1", window_bytes: 8184 };
    const input = { input_id: "source", text: "exact source" }, vector = Array(1024).fill(0);
    vector[0] = 1;
    const digest = createHash("sha256").update(input.text, "utf8").digest("hex");
    const rows = [{ status: "embedded" as const, input_id: input.input_id, input_digest: `sha256:${digest}`,
      token_count: 3, truncated: false as const, vector }];
    const decoded = decodeLocalOnnxSourceResults(rows, [input], profile);
    expect(decoded[0]).toMatchObject({ status: "embedded", token_count: 3 });
    if (decoded[0]?.status !== "embedded") throw new Error("Source vector required");
    expect(decoded[0].vector).toHaveLength(1024);
    expect(() => decodeLocalOnnxSourceResults([{ ...rows[0]!, vector: [1, 0] }], [input], profile)).toThrow(/dimensions/);
    expect(() => decodeLocalOnnxIpcVectors([vector], 1)).toThrow(/expected 384/);
  });
});
