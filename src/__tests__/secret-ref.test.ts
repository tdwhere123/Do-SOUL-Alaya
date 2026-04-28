import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "./helpers.js";
import {
  createEnvSecretRef,
  createLocalFileSecretRef,
  resolveSecretRef
} from "../secrets/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("secret refs", () => {
  it("resolves env refs to state without serializing the raw secret", async () => {
    const status = await resolveSecretRef(
      createEnvSecretRef({
        env_var: "ALAYA_PROVIDER_KEY",
        purpose: "provider_api_key",
        secret_ref: "secret:provider"
      }),
      {
        env: {
          ALAYA_PROVIDER_KEY: "sk-raw-secret-value"
        },
        now: () => now
      }
    );

    expect(status).toMatchObject({
      checked_at: now,
      reason: null,
      resolved: true,
      secret_ref: "secret:provider",
      source_type: "env",
      state: "resolved"
    });
    expect(JSON.stringify(status)).not.toContain("sk-raw-secret-value");
    expect(status).not.toHaveProperty("raw_secret");
    expect(status).not.toHaveProperty("value");
  });

  it("checks local-file refs without serializing file contents", async () => {
    const temp = await createTempDir("alaya-secret-ref-");
    try {
      const secretPath = join(temp.path, "provider-key.txt");
      await writeFile(secretPath, "file-raw-secret-value\n", "utf8");

      const status = await resolveSecretRef(
        createLocalFileSecretRef({
          file_path: secretPath,
          purpose: "provider_api_key",
          secret_ref: "secret:file-provider"
        }),
        { now: () => now }
      );

      expect(status).toMatchObject({
        checked_at: now,
        reason: null,
        resolved: true,
        secret_ref: "secret:file-provider",
        source_type: "local_file",
        state: "resolved"
      });
      expect(JSON.stringify(status)).not.toContain("file-raw-secret-value");
    } finally {
      await temp.cleanup();
    }
  });

  it("reports missing refs as explicit resolution state", async () => {
    const status = await resolveSecretRef(
      createEnvSecretRef({
        env_var: "ALAYA_MISSING_KEY",
        purpose: "provider_api_key",
        secret_ref: "secret:missing"
      }),
      {
        env: {},
        now: () => now
      }
    );

    expect(status).toMatchObject({
      reason: "env_var_missing",
      resolved: false,
      secret_ref: "secret:missing",
      source_key: "ALAYA_MISSING_KEY",
      source_type: "env",
      state: "missing"
    });
  });
});
