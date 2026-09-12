import { describe, expect, it } from "vitest";
import {
  RuntimeEmbeddingConfigPatchSchema,
  RuntimeEmbeddingConfigSchema,
  RuntimeGardenComputeConfigSchema,
  assertPublicHttpProviderUrl,
  isContainedFileSecretPath,
  isSafeFileSecretRefPath
} from "../../index.js";

describe("runtime provider_url and file secret refs", () => {
  it("rejects a private or metadata provider_url on garden and embedding schemas", () => {
    for (const provider_url of [
      "http://127.0.0.1:11434/v1",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.8/v1",
      "file:///etc/passwd"
    ]) {
      expect(
        RuntimeEmbeddingConfigPatchSchema.safeParse({ provider_url }).success,
        provider_url
      ).toBe(false);
      expect(
        RuntimeGardenComputeConfigSchema.safeParse({
          provider_kind: "official_api",
          model_id: null,
          provider_url,
          secret_ref: null,
          enabled: true
        }).success,
        provider_url
      ).toBe(false);
    }
  });

  it("rejects IPv6-mapped private and metadata provider hosts", () => {
    for (const provider_url of [
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:7f00:1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://[::ffff:0:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/"
    ]) {
      expect(() => assertPublicHttpProviderUrl(provider_url), provider_url).toThrow(
        /private, loopback, link-local, or metadata/u
      );
      expect(
        RuntimeEmbeddingConfigPatchSchema.safeParse({ provider_url }).success,
        provider_url
      ).toBe(false);
    }
  });

  it("accepts a public https provider_url and still allows a null endpoint", () => {
    expect(
      RuntimeEmbeddingConfigSchema.parse({
        provider_url: "https://api.openai.com/v1",
        secret_ref: "env:OPENAI_API_KEY",
        model_id: "text-embedding-3-small",
        embedding_enabled: true
      }).provider_url
    ).toBe("https://api.openai.com/v1");
    expect(RuntimeEmbeddingConfigPatchSchema.parse({ provider_url: null })).toEqual({
      provider_url: null
    });
    expect(() => assertPublicHttpProviderUrl("https://api.openai.com/v1")).not.toThrow();
  });

  it("rejects file: secret refs that escape with ..", () => {
    expect(
      RuntimeGardenComputeConfigSchema.safeParse({
        provider_kind: "official_api",
        model_id: null,
        provider_url: null,
        secret_ref: "file:/var/lib/alaya/secrets/../passwd",
        enabled: true
      }).success
    ).toBe(false);
    expect(isSafeFileSecretRefPath("/var/lib/alaya/secrets/../passwd")).toBe(false);
  });

  it("treats only descendants of the secrets directory as contained file refs", () => {
    expect(isContainedFileSecretPath("/var/lib/alaya/secrets/openai", "/var/lib/alaya/secrets")).toBe(true);
    expect(isContainedFileSecretPath("/etc/passwd", "/var/lib/alaya/secrets")).toBe(false);
    expect(isContainedFileSecretPath("/var/lib/alaya/secrets", "/var/lib/alaya/secrets")).toBe(false);
    expect(isContainedFileSecretPath("/var/lib/alaya/secrets/../passwd", "/var/lib/alaya/secrets")).toBe(false);
  });
});
