import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { formatFileSecretRef } from "@do-soul/alaya-protocol";
import { resolveAlayaConfigPaths } from "../../cli/config-files.js";
import { normalizeRuntimeEmbeddingConfigPatch } from "../../services/env-file-service.js";

describe("normalizeRuntimeEmbeddingConfigPatch paste platform policy", () => {
  const paths = resolveAlayaConfigPaths(path.join(path.sep, "tmp", "alaya-config"));
  const secretPath = path.join(paths.secretsDir, "openai");

  it.each([
    { platform: "linux" as const, supported: true },
    { platform: "darwin" as const, supported: true },
    { platform: "win32" as const, supported: false }
  ])("paste mode on $platform", ({ platform, supported }) => {
    const patch = {
      secret_ref_mode: "paste",
      secret_value: "sk-test-plaintext-secret"
    };

    if (supported) {
      expect(normalizeRuntimeEmbeddingConfigPatch(patch, paths, platform)).toEqual({
        patch: {
          secret_ref: formatFileSecretRef(secretPath)
        },
        pastedSecret: {
          path: secretPath,
          value: "sk-test-plaintext-secret"
        }
      });
      return;
    }

    expect(() => normalizeRuntimeEmbeddingConfigPatch(patch, paths, platform)).toThrow(CoreError);
    expect(() => normalizeRuntimeEmbeddingConfigPatch(patch, paths, platform)).toThrow(
      "paste mode is not supported on win32"
    );
  });
});
