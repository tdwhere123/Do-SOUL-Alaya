import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setApiKeyCipherKeyMaterialForTests,
  __setExecFileSyncForTests,
  __setMachineKeyIdPathForTests,
  __setPlatformMachineIdForTests,
  decryptApiKeyAtRest,
  encryptApiKeyAtRest,
  isEncryptedApiKeyAtRest,
  rotateApiKeyCipherGeneration
} from "../../../repos/control/api-key-cipher.js";

const APP_SALT = "do-soul-alaya:engine-binding-api-key:v1";
const temporaryRoots: string[] = [];
const hostLinuxMachineId = readHostLinuxMachineId();

afterEach(() => {
  __setApiKeyCipherKeyMaterialForTests(null);
  __setExecFileSyncForTests(null);
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

  it("does not rotate an existing machine-key-id when the file cannot be read", () => {
    __setPlatformMachineIdForTests(null);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-machine-key-"));
    temporaryRoots.push(temporaryRoot);
    const durablePath = path.join(temporaryRoot, "machine-key-id");
    const existingId = "11111111-2222-4333-8444-555555555555";
    fs.writeFileSync(durablePath, `${existingId}\n`, { encoding: "utf8", mode: 0o600 });
    __setMachineKeyIdPathForTests(durablePath);

    const originalRead = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      options?: BufferEncoding | fs.ReadSyncOptions | null
    ) => {
      if (path.resolve(String(file)) === path.resolve(durablePath)) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return originalRead(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);

    try {
      expect(() => encryptApiKeyAtRest("sk-live-secret-value")).toThrow(
        /refusing to mint a replacement key/i
      );
    } finally {
      readSpy.mockRestore();
    }

    expect(fs.readFileSync(durablePath, "utf8").trim()).toBe(existingId);
  });

  it("keeps ciphertext decryptable only at the current explicit generation", () => {
    __setPlatformMachineIdForTests(null);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-machine-key-"));
    temporaryRoots.push(temporaryRoot);
    const durablePath = path.join(temporaryRoot, "machine-key-id");
    __setMachineKeyIdPathForTests(durablePath);

    const encrypted = encryptApiKeyAtRest("sk-live-secret-value");
    const durableId = fs.readFileSync(durablePath, "utf8").trim();
    expect(encrypted.startsWith("$alaya$v1$")).toBe(true);
    expect(encrypted.startsWith("$alaya$v1$g")).toBe(false);

    expect(rotateApiKeyCipherGeneration()).toBe(2);
    expect(fs.readFileSync(durablePath, "utf8").trim()).toBe(durableId);
    expect(() => decryptApiKeyAtRest(encrypted)).toThrow(/key rotation must be explicit/i);

    const rotated = encryptApiKeyAtRest("sk-live-secret-value");
    expect(rotated.startsWith("$alaya$v1$g2$")).toBe(true);
    expect(decryptApiKeyAtRest(rotated)).toBe("sk-live-secret-value");
  });

  it("bounds macOS and Windows machine-id probes with a timeout", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-machine-key-"));
    temporaryRoots.push(temporaryRoot);
    __setMachineKeyIdPathForTests(path.join(temporaryRoot, "machine-key-id"));
    const calls: Array<readonly [string, readonly string[], object]> = [];
    __setExecFileSyncForTests(((file: string, args: readonly string[], options: object) => {
      calls.push([file, args, options]);
      if (file === "ioreg") {
        return '"IOPlatformUUID" = "macos-machine-id"\n';
      }
      return "MachineGuid    REG_SZ    windows-machine-id\n";
    }) as typeof childProcess.execFileSync);
    const platformSpy = vi.spyOn(process, "platform", "get");

    try {
      platformSpy.mockReturnValue("darwin");
      expect(encryptApiKeyAtRest("sk-live-secret-value")).toMatch(/^\$alaya\$v1\$/);
      expect(calls[0]?.[0]).toBe("ioreg");
      expect(calls[0]?.[1]).toEqual(["-rd1", "-c", "IOPlatformExpertDevice"]);
      expect(calls[0]?.[2]).toEqual(expect.objectContaining({ timeout: 2_000 }));

      calls.length = 0;
      platformSpy.mockReturnValue("win32");
      expect(decryptApiKeyAtRest(encryptApiKeyAtRest("sk-live-secret-value"))).toBe(
        "sk-live-secret-value"
      );
      expect(calls[0]?.[0]).toBe("reg");
      expect(calls[0]?.[1]).toEqual([
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid"
      ]);
      expect(calls[0]?.[2]).toEqual(expect.objectContaining({ timeout: 2_000 }));
    } finally {
      platformSpy.mockRestore();
    }
  });
});
