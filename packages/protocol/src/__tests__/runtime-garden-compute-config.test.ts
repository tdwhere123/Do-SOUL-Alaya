import { describe, expect, it } from "vitest";
import {
  RuntimeGardenComputeConfigPatchSchema,
  RuntimeGardenComputeConfigSchema
} from "../app-config.js";

describe("RuntimeGardenComputeConfig schema (C1)", () => {
  it("accepts a fully-specified official_api config", () => {
    const value = {
      provider_kind: "official_api",
      model_id: "gpt-4.1-mini",
      provider_url: "https://api.openai.com/v1",
      secret_ref: "env:ALAYA_OFFICIAL_GARDEN_API_KEY",
      enabled: true
    };
    expect(RuntimeGardenComputeConfigSchema.parse(value)).toEqual(value);
  });

  it("accepts local_heuristics with all-null compute fields", () => {
    const value = {
      provider_kind: "local_heuristics",
      model_id: null,
      provider_url: null,
      secret_ref: null,
      enabled: false
    };
    expect(RuntimeGardenComputeConfigSchema.parse(value)).toEqual(value);
  });

  it("accepts host_worker (deferred to v0.1.2)", () => {
    const value = {
      provider_kind: "host_worker",
      model_id: null,
      provider_url: null,
      secret_ref: null,
      enabled: false
    };
    expect(RuntimeGardenComputeConfigSchema.parse(value)).toEqual(value);
  });

  it("rejects an unknown provider_kind", () => {
    expect(() =>
      RuntimeGardenComputeConfigSchema.parse({
        provider_kind: "bedrock",
        model_id: null,
        provider_url: null,
        secret_ref: null,
        enabled: false
      })
    ).toThrow();
  });

  it("rejects a malformed secret_ref", () => {
    expect(() =>
      RuntimeGardenComputeConfigSchema.parse({
        provider_kind: "official_api",
        model_id: null,
        provider_url: null,
        secret_ref: "not-a-valid-prefix",
        enabled: true
      })
    ).toThrow();
  });

  it("accepts env: secret_ref with valid env name", () => {
    expect(() =>
      RuntimeGardenComputeConfigSchema.parse({
        provider_kind: "official_api",
        model_id: null,
        provider_url: null,
        secret_ref: "env:ALAYA_OFFICIAL_GARDEN_API_KEY",
        enabled: true
      })
    ).not.toThrow();
  });

  it("accepts file: secret_ref with absolute path", () => {
    expect(() =>
      RuntimeGardenComputeConfigSchema.parse({
        provider_kind: "official_api",
        model_id: null,
        provider_url: null,
        secret_ref: "file:/etc/alaya/secrets/garden",
        enabled: true
      })
    ).not.toThrow();
  });
});

describe("RuntimeGardenComputeConfigPatch schema (C1)", () => {
  it("accepts an empty partial patch", () => {
    expect(RuntimeGardenComputeConfigPatchSchema.parse({})).toEqual({});
  });

  it("accepts each field individually", () => {
    expect(
      RuntimeGardenComputeConfigPatchSchema.parse({ provider_kind: "official_api" })
    ).toEqual({ provider_kind: "official_api" });
    expect(RuntimeGardenComputeConfigPatchSchema.parse({ enabled: true })).toEqual({
      enabled: true
    });
    expect(
      RuntimeGardenComputeConfigPatchSchema.parse({ model_id: "gpt-4.1" })
    ).toEqual({ model_id: "gpt-4.1" });
    expect(RuntimeGardenComputeConfigPatchSchema.parse({ secret_ref: null })).toEqual({
      secret_ref: null
    });
  });

  it("rejects unknown patch fields via .strict()", () => {
    expect(() =>
      RuntimeGardenComputeConfigPatchSchema.parse({ provider_kind: "official_api", foo: "bar" })
    ).toThrow();
  });
});
