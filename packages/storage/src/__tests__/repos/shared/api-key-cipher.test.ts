import fs, { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setApiKeyCipherKeyMaterialForTests,
  __setMachineKeyIdPathForTests,
  decryptApiKeyAtRest,
  encryptApiKeyAtRest,
  isEncryptedApiKeyAtRest
} from "../../../repos/shared/api-key-cipher.js";

// __setApiKeyCipherKeyMaterialForTests is process-global; vitest runs storage
// tests in a single worker thread so overrides do not race across files.
afterEach(() => {
  __setApiKeyCipherKeyMaterialForTests(null);
  __setMachineKeyIdPathForTests(null);
});

describe("api-key-cipher", () => {
  it("round-trips api keys and hides plaintext at rest", () => {
    __setApiKeyCipherKeyMaterialForTests("test-machine:test-user:do-soul-alaya:engine-binding-api-key:v1");

    const plaintext = "sk-live-secret-value";
    const encrypted = encryptApiKeyAtRest(plaintext);

    expect(isEncryptedApiKeyAtRest(encrypted)).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptApiKeyAtRest(encrypted)).toBe(plaintext);
  });

  it("preserves empty api keys for ref-only bindings", () => {
    expect(encryptApiKeyAtRest("")).toBe("");
    expect(decryptApiKeyAtRest("")).toBe("");
  });

  it("passes through legacy plaintext until migration encrypts it", () => {
    expect(decryptApiKeyAtRest("sk-legacy-plaintext")).toBe("sk-legacy-plaintext");
    expect(isEncryptedApiKeyAtRest("sk-legacy-plaintext")).toBe(false);
  });

  it("rejects decryption when key material drifts from the encryption host", () => {
    __setApiKeyCipherKeyMaterialForTests("machine-a:test-user:do-soul-alaya:engine-binding-api-key:v1");
    const encrypted = encryptApiKeyAtRest("sk-live-secret-value");
    __setApiKeyCipherKeyMaterialForTests("machine-b:test-user:do-soul-alaya:engine-binding-api-key:v1");

    expect(() => decryptApiKeyAtRest(encrypted)).toThrow(
      /machine- and user-bound/i
    );
  });

  it("reads Linux machine-id when present", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      return filePath === "/etc/machine-id";
    });
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
      if (filePath === "/etc/machine-id") {
        return "linux-machine-id\n";
      }
      throw new Error(`unexpected read: ${String(filePath)}`);
    });

    const encrypted = encryptApiKeyAtRest("sk-live-secret-value");
    __setApiKeyCipherKeyMaterialForTests(null);
    existsSync.mockImplementation((filePath) => filePath === "/etc/machine-id");
    readFileSync.mockImplementation((filePath) => {
      if (filePath === "/etc/machine-id") {
        return "linux-machine-id\n";
      }
      throw new Error(`unexpected read: ${String(filePath)}`);
    });

    expect(decryptApiKeyAtRest(encrypted)).toBe("sk-live-secret-value");

    existsSync.mockRestore();
    readFileSync.mockRestore();
    vi.unstubAllEnvs();
  });

  it("creates a durable machine-key-id when platform ids are missing", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const durablePath = path.join(os.tmpdir(), `alaya-machine-key-${process.pid}.id`);
    __setMachineKeyIdPathForTests(durablePath);
    fs.rmSync(durablePath, { force: true });

    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      if (filePath === durablePath) {
        try {
          statSync(filePath);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    });

    const encrypted = encryptApiKeyAtRest("sk-live-secret-value");
    expect(fs.readFileSync(durablePath, "utf8").trim().length).toBeGreaterThan(0);
    expect(decryptApiKeyAtRest(encrypted)).toBe("sk-live-secret-value");

    existsSync.mockRestore();
    fs.rmSync(durablePath, { force: true });
    vi.unstubAllEnvs();
  });
});
