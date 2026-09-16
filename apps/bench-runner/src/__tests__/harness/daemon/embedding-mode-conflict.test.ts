import { describe, expect, it } from "vitest";
import { resolveEffectiveEmbeddingPosture } from "@do-soul/alaya";
import {
  assertBenchEmbeddingModeMatchesEffective,
  resolveSourceRefRobust
} from "../../../harness/daemon/daemon-environment.js";

describe("bench embeddingMode vs effective supplement", () => {
  it("rejects disabled only when the probed local_onnx supplement is on", () => {
    const environment = { ALAYA_EMBEDDING_PROVIDER: "local_onnx" };
    const run = () => assertBenchEmbeddingModeMatchesEffective("disabled", environment);
    if (resolveEffectiveEmbeddingPosture((key) => environment[key]).embeddingSupplementEnabled) {
      expect(run).toThrow(/embeddingMode=disabled but effective embedding supplement is on/);
      return;
    }
    expect(run).not.toThrow();
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
