import { describe, expect, it } from "vitest";
import {
  assertBenchEmbeddingModeMatchesEffective,
  resolveSourceRefRobust
} from "../../../harness/daemon/daemon-environment.js";

describe("bench embeddingMode vs effective supplement", () => {
  it("rejects disabled when local_onnx default would leave supplement on", () => {
    expect(() => assertBenchEmbeddingModeMatchesEffective("disabled", {
      ALAYA_EMBEDDING_PROVIDER: "local_onnx"
    })).toThrow(/embeddingMode=disabled but effective embedding supplement is on/);
  });

  it("accepts disabled when supplement is explicitly off", () => {
    expect(() => assertBenchEmbeddingModeMatchesEffective("disabled", {
      ALAYA_EMBEDDING_PROVIDER: "local_onnx",
      ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false"
    })).not.toThrow();
  });
});

describe("resolveSourceRefRobust", () => {
  it("treats unset as false", () => {
    expect(resolveSourceRefRobust(undefined)).toBe(false);
    expect(resolveSourceRefRobust("true")).toBe(true);
    expect(() => resolveSourceRefRobust("maybe")).toThrow(/ALAYA_RECALL_SOURCE_REF_ROBUST/);
  });
});
