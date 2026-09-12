import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { formatFileSecretRef } from "@do-soul/alaya-protocol";
import { resolveAlayaConfigPaths } from "../../cli/support/config-files.js";
import {
  normalizeRuntimeEmbeddingConfigPatch,
  normalizeRuntimeGardenComputeConfigPatch
} from "../../services/env-file/env-file-service.js";

describe("runtime file secret refs stay inside the secrets directory", () => {
  const paths = resolveAlayaConfigPaths(path.join(path.sep, "tmp", "alaya-config"));
  const containedPath = path.join(paths.secretsDir, "openai");

  it("accepts a file: ref under the secrets directory", () => {
    expect(
      normalizeRuntimeEmbeddingConfigPatch(
        { secret_ref: formatFileSecretRef(containedPath) },
        paths,
        "linux"
      )
    ).toEqual({
      patch: { secret_ref: formatFileSecretRef(path.resolve(containedPath)) },
      pastedSecret: null
    });
  });

  it("rejects a file: ref outside the secrets directory", () => {
    try {
      normalizeRuntimeEmbeddingConfigPatch(
        { secret_ref: "file:/etc/passwd" },
        paths,
        "linux"
      );
      expect.fail("expected embedding file: ref to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
    }
    try {
      normalizeRuntimeGardenComputeConfigPatch(
        {
          secret_ref_mode: "file",
          secret_value: "/etc/passwd"
        },
        paths,
        "linux"
      );
      expect.fail("expected garden file: ref to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
    }
  });

  it("rejects a private provider_url on runtime patches", () => {
    expect(() =>
      normalizeRuntimeEmbeddingConfigPatch(
        { provider_url: "http://169.254.169.254/latest/meta-data/" },
        paths,
        "linux"
      )
    ).toThrow(CoreError);
    expect(() =>
      normalizeRuntimeGardenComputeConfigPatch(
        { provider_url: "http://127.0.0.1:11434/v1" },
        paths,
        "linux"
      )
    ).toThrow(CoreError);
  });
});
