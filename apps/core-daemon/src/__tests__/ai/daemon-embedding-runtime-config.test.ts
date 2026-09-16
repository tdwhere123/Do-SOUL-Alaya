import { describe, expect, it, vi } from "vitest";
import {
  isD2qActive,
  readEmbeddingRuntimeConfig,
  resolveEffectiveEmbeddingPosture
} from "../../ai/daemon-embedding-runtime-config.js";
import type { LocalOnnxTransformersProbe } from "@do-soul/alaya-core";

const EXTRA_AVAILABLE: LocalOnnxTransformersProbe = () => ({ availability: "available" });
const EXTRA_MISSING: LocalOnnxTransformersProbe = () => ({
  availability: "unavailable",
  code: "ERR_MODULE_NOT_FOUND"
});

describe("readEmbeddingRuntimeConfig fail-closed openai", () => {
  it("throws when explicit openai is on and the secret cannot be resolved", () => {
    expect(() => readEmbeddingRuntimeConfig(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "openai"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
      ["ALAYA_OPENAI_SECRET_REF", "env:ALAYA_MISSING_OPENAI_EMBEDDING_KEY"]
    ]), vi.fn(), EXTRA_MISSING)).toThrow(/ALAYA_OPENAI_SECRET_REF/);
  });

  it("throws when explicit openai is on and no secret ref is written", () => {
    expect(() => readEmbeddingRuntimeConfig(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "openai"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"]
    ]), vi.fn(), EXTRA_MISSING)).toThrow(/ALAYA_EMBEDDING_PROVIDER=openai requires a resolvable ALAYA_OPENAI_SECRET_REF/);
  });

  it("does not require an openai secret when the implicit provider is local_onnx", () => {
    const warn = vi.fn();
    const config = readEmbeddingRuntimeConfig(new Map(), warn, EXTRA_AVAILABLE);
    expect(config.embeddingProviderKind).toBe("local_onnx");
    expect(config.embeddingSupplementEnabled).toBe(true);
    expect(config.embeddingApiKey).toBeNull();
    expect(warn).toHaveBeenCalledWith("effective embedding runtime", {
      provider_kind: "local_onnx",
      embedding_supplement_enabled: true,
      local_onnx_availability: "available"
    });
  });

  it("does not enable the supplement when the local extra cannot be resolved", () => {
    const warn = vi.fn();
    const config = readEmbeddingRuntimeConfig(new Map(), warn, EXTRA_MISSING);
    expect(config.embeddingProviderKind).toBe("off");
    expect(config.embeddingSupplementEnabled).toBe(false);
    expect(config.recallPolicyEmbeddingEnabled).toBe(false);
    expect(isD2qActive({ ...config, d2qEnabled: true })).toBe(false);
    expect(warn).toHaveBeenCalledWith("effective embedding runtime", {
      provider_kind: "off",
      embedding_supplement_enabled: false,
      local_onnx_availability: "unavailable"
    });
  });
});

describe("resolveEffectiveEmbeddingPosture", () => {
  it("defaults supplement on for implicit local_onnx only when the extra resolves", () => {
    expect(resolveEffectiveEmbeddingPosture(() => undefined, EXTRA_AVAILABLE)).toEqual({
      providerKind: "local_onnx",
      embeddingSupplementEnabled: true,
      providerWasExplicit: false,
      localOnnxAvailability: "available"
    });
  });

  it("honors an explicit supplement off", () => {
    expect(resolveEffectiveEmbeddingPosture((key) =>
      key === "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT" ? "false" : undefined,
    EXTRA_AVAILABLE).embeddingSupplementEnabled).toBe(false);
  });

  it("keeps explicit local_onnx off when ERR_MODULE_NOT_FOUND even if the supplement flag is on", () => {
    expect(resolveEffectiveEmbeddingPosture((key) => {
      if (key === "ALAYA_EMBEDDING_PROVIDER") return "local_onnx";
      if (key === "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT") return "true";
      return undefined;
    }, EXTRA_MISSING)).toEqual({
      providerKind: "off",
      embeddingSupplementEnabled: false,
      providerWasExplicit: true,
      localOnnxAvailability: "unavailable"
    });
  });

  it("does not consult the local extra when openai is explicit", () => {
    expect(resolveEffectiveEmbeddingPosture((key) =>
      key === "ALAYA_EMBEDDING_PROVIDER" ? "openai" : undefined,
    EXTRA_MISSING)).toMatchObject({
      providerKind: "openai",
      embeddingSupplementEnabled: false,
      localOnnxAvailability: "not_applicable"
    });
  });
});
