import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setApiKeyCipherKeyMaterialForTests,
  __setMachineKeyIdPathForTests,
  __setPlatformMachineIdForTests,
  decryptApiKeyAtRest,
  encryptApiKeyAtRest,
  isEncryptedApiKeyAtRest
} from "../../../repos/control/api-key-cipher.js";

const APP_SALT = "do-soul-alaya:engine-binding-api-key:v1";
const temporaryRoots: string[] = [];
const hostLinuxMachineId = readHostLinuxMachineId();

afterEach(() => {
  __setApiKeyCipherKeyMaterialForTests(null);
  __setMachineKeyIdPathForTests(null);
  __setPlatformMachineIdForTests(undefined);
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function readHostLinuxMachineId(): string | null {
  if (process.platform !== "linux") return null;
  for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const machineId = fs.readFileSync(filePath, "utf8").trim();
      if (machineId.length > 0) return machineId;
    } catch {
      // Match the production fallback to the next platform machine-id path.
    }
  }
  return null;
}

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

  it.runIf(hostLinuxMachineId !== null)("reads Linux machine-id when present", () => {
    const encrypted = encryptApiKeyAtRest("sk-live-secret-value");
    if (hostLinuxMachineId === null) throw new Error("Linux machine-id fixture is unavailable");
    __setApiKeyCipherKeyMaterialForTests(
      `${hostLinuxMachineId}:${os.userInfo().username}:${APP_SALT}`
    );

    expect(decryptApiKeyAtRest(encrypted)).toBe("sk-live-secret-value");
  });

  it("creates a durable machine-key-id when platform ids are missing", () => {
    __setPlatformMachineIdForTests(null);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-machine-key-"));
    temporaryRoots.push(temporaryRoot);
    const durablePath = path.join(temporaryRoot, "machine-key-id");
    __setMachineKeyIdPathForTests(durablePath);

    const encrypted = encryptApiKeyAtRest("sk-live-secret-value");
    expect(fs.readFileSync(durablePath, "utf8").trim().length).toBeGreaterThan(0);
    expect(decryptApiKeyAtRest(encrypted)).toBe("sk-live-secret-value");
  });
});
