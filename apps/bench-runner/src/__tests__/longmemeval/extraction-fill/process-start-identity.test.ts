import { afterEach, describe, expect, it } from "vitest";
import {
  nonCredentialChildEnv,
  readProcessStartIdentity,
  WINDOWS_SHELL_ENV_KEYS,
  windowsStartIdentityFailure
} from "../../../runs/extraction/fill/manifest/writer-lock.js";

describe("process start identity", () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
  });

  function setEnv(key: string, value: string): void {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  it("copies profile paths on Windows and never copies credential keys", () => {
    setEnv("APPDATA", "C:\\Users\\runner\\AppData\\Roaming");
    setEnv("ALAYA_FIXTURE_TOKEN", "secret");
    setEnv("AWS_SECRET_ACCESS_KEY", "secret");
    const child = nonCredentialChildEnv();
    expect(child.ALAYA_FIXTURE_TOKEN).toBeUndefined();
    expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(child.PATH ?? child.Path).toBe(process.env.PATH ?? process.env.Path);
    if (process.platform === "win32") {
      expect(child.APPDATA).toBe("C:\\Users\\runner\\AppData\\Roaming");
    } else {
      expect(child.APPDATA).toBeUndefined();
    }
    for (const key of WINDOWS_SHELL_ENV_KEYS) {
      expect(key).not.toMatch(/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu);
    }
  });

  it("treats a Windows identity timeout as unknown liveness", () => {
    const timeout = windowsStartIdentityFailure(Object.assign(
      new Error("spawnSync powershell.exe ETIMEDOUT"),
      { code: "ETIMEDOUT", status: null }
    ));
    expect(timeout).not.toMatchObject({ code: "ENOENT" });
    const unrecognized = windowsStartIdentityFailure(Object.assign(
      new Error("Command failed: powershell.exe"),
      { status: 1, stderr: "Access is denied" }
    ));
    expect(unrecognized).not.toMatchObject({ code: "ENOENT" });
  });

  it("treats a missing Windows process as absent", () => {
    const failure = windowsStartIdentityFailure(Object.assign(
      new Error("Command failed: powershell.exe"),
      {
        status: 1,
        stderr: "Get-Process : Cannot find a process with the process identifier 9.\n" +
          "FullyQualifiedErrorId : NoProcessFoundForGivenId"
      }
    ));
    expect(failure).toMatchObject({ code: "ENOENT" });
  });

  it("reads this process start identity", () => {
    const first = readProcessStartIdentity(process.pid);
    expect(first).toMatch(/^\d+$/u);
    expect(readProcessStartIdentity(process.pid)).toBe(first);
  });
});
