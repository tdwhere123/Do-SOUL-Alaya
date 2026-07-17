import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import {
  assertProductDefaultBiEncoderEnvironment,
  assertProductDefaultBiEncoderSupplement
} from "../../../longmemeval/promotion/product/product-bi-encoder-policy.js";

describe("LongMemEval product bi-encoder policy", () => {
  it("accepts the implicit and explicit local ONNX product identity", () => {
    expect(() => assertProductDefaultBiEncoderEnvironment({}, "cell B"))
      .not.toThrow();
    expect(() => assertProductDefaultBiEncoderEnvironment({
      ALAYA_LOCAL_EMBEDDING_MODEL: DEFAULT_LOCAL_ONNX_MODEL_ID,
      ALAYA_RECALL_D2Q: "false"
    }, "cell B")).not.toThrow();
    expect(() => assertProductDefaultBiEncoderSupplement({
      enabled: true,
      provider_kind: "local_onnx",
      effective_model_id: DEFAULT_LOCAL_ONNX_MODEL_ID,
      model_artifact_sha256: "a".repeat(64),
      effective_schema_version: 1,
      d2q_input: "raw_content"
    }, "cell B")).not.toThrow();
  });

  it.each([
    ["custom model", { ALAYA_LOCAL_EMBEDDING_MODEL: "custom/model" }],
    ["D2Q", { ALAYA_RECALL_D2Q: "true" }],
    ["ONNX thread override", { ALAYA_LOCAL_ONNX_THREADS: "64" }]
  ])("rejects %s as non-product evidence", (_label, env) => {
    expect(() => assertProductDefaultBiEncoderEnvironment(env, "cell B"))
      .toThrow(/product-default bi-encoder/u);
  });
});
