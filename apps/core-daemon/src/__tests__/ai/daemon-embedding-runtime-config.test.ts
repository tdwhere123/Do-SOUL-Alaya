import { describe, expect, it, vi } from "vitest";
import {
  readEmbeddingRuntimeConfig,
  resolveEffectiveEmbeddingPosture
} from "../../ai/daemon-embedding-runtime-config.js";

describe("readEmbeddingRuntimeConfig fail-closed openai", () => {
  it("throws when explicit openai is on and the secret cannot be resolved", () => {
    expect(() => readEmbeddingRuntimeConfig(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "openai"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
      ["ALAYA_OPENAI_SECRET_REF", "env:ALAYA_MISSING_OPENAI_EMBEDDING_KEY"]
    ]), vi.fn())).toThrow(/ALAYA_OPENAI_SECRET_REF/);
  });

  it("throws when explicit openai is on and no secret ref is written", () => {
    expect(() => readEmbeddingRuntimeConfig(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "openai"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"]
    ]), vi.fn())).toThrow(/ALAYA_EMBEDDING_PROVIDER=openai requires a resolvable ALAYA_OPENAI_SECRET_REF/);
  });

  it("does not require an openai secret when the implicit provider is local_onnx", () => {
    const warn = vi.fn();
    const config = readEmbeddingRuntimeConfig(new Map(), warn);
    expect(config.embeddingProviderKind).toBe("local_onnx");
    expect(config.embeddingSupplementEnabled).toBe(true);
    expect(config.embeddingApiKey).toBeNull();
    expect(warn).toHaveBeenCalledWith("effective embedding runtime", {
      provider_kind: "local_onnx",
      embedding_supplement_enabled: true
    });
  });
});

describe("resolveEffectiveEmbeddingPosture", () => {
  it("defaults supplement on for implicit local_onnx", () => {
    expect(resolveEffectiveEmbeddingPosture(() => undefined)).toEqual({
      providerKind: "local_onnx",
      embeddingSupplementEnabled: true,
      providerWasExplicit: false
    });
  });

  it("honors an explicit supplement off", () => {
    expect(resolveEffectiveEmbeddingPosture((key) =>
      key === "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT" ? "false" : undefined
    ).embeddingSupplementEnabled).toBe(false);
  });
});
