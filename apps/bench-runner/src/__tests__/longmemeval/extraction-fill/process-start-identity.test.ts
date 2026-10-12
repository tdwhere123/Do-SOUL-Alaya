import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  nonCredentialChildEnv,
  readProcessStartIdentity
} from "../../../runs/extraction/fill/manifest/writer-lock.js";
import {
  interpretWindowsProcessStartOutput,
  windowsCreationDateToTicks,
  windowsProcessStartCommand,
  windowsStartIdentityFailure
} from "../../../runs/extraction/fill/manifest/windows-process-start.js";

function thrownIdentity(output: string): unknown {
  try {
    interpretWindowsProcessStartOutput(output);
  } catch (error) {
    return error;
  }
  throw new Error(`expected identity output ${output} to fail`);
}

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

  it("keeps credential and profile keys out of child processes", () => {
    setEnv("APPDATA", "C:\\Users\\runner\\AppData\\Roaming");
    setEnv("ALAYA_FIXTURE_TOKEN", "secret");
    setEnv("AWS_SECRET_ACCESS_KEY", "secret");
    const child = nonCredentialChildEnv();
    expect(child.APPDATA).toBeUndefined();
    expect(child.ALAYA_FIXTURE_TOKEN).toBeUndefined();
    expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(child.PATH ?? child.Path).toBe(process.env.PATH ?? process.env.Path);
    for (const key of Object.keys(child)) {
      expect(key).not.toMatch(/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu);
    }
  });

  it("does not treat a Windows start that never finishes as a dead writer", () => {
    const timeout = windowsStartIdentityFailure(Object.assign(
      new Error("spawnSync powershell.exe ETIMEDOUT"),
      { code: "ETIMEDOUT", status: null, signal: "SIGTERM", stdout: "", stderr: "" }
    ));
    expect(timeout).not.toMatchObject({ code: "ENOENT" });
    const missingHost = windowsStartIdentityFailure(Object.assign(
      new Error("spawnSync cscript.exe ENOENT"),
      { code: "ENOENT", status: null }
    ));
    expect(missingHost).not.toMatchObject({ code: "ENOENT" });
    const unrecognized = windowsStartIdentityFailure(Object.assign(
      new Error("Command failed: cscript.exe"),
      { status: 1, stderr: "Access is denied" }
    ));
    expect(unrecognized).not.toMatchObject({ code: "ENOENT" });
  });

  it("treats a missing Windows process as absent and keeps a WMI creation date", () => {
    expect(thrownIdentity("absent")).toMatchObject({ code: "ENOENT" });
    const unixMs = Date.parse("2020-01-01T00:00:00.000Z");
    const expected = (BigInt(unixMs) * 10_000n + 621355968000000000n).toString();
    expect(windowsCreationDateToTicks("20200101000000.000000+000")).toBe(expected);
    expect(windowsCreationDateToTicks("20200101080000.000000+480")).toBe(expected);
    expect(interpretWindowsProcessStartOutput("20200101000000.000000+000")).toBe(expected);
    expect(thrownIdentity("not-a-date")).not.toMatchObject({ code: "ENOENT" });
  });

  it("asks Windows for the process start time without PowerShell", () => {
    const [program, args] = windowsProcessStartCommand(process.pid);
    expect(program.toLowerCase().endsWith("cscript.exe")).toBe(true);
    expect(program.toLowerCase()).not.toContain("powershell");
    expect(args.slice(0, 3)).toEqual(["//B", "//nologo", "//E:jscript"]);
    expect(args.at(-1)).toBe(String(process.pid));
    const script = readFileSync(String(args[3]), "utf8");
    expect(script).toContain("WbemScripting.SWbemLocator");
    expect(script).toContain("WScript.StdOut.WriteLine('absent')");
    expect(script).toContain("WScript.StdOut.WriteLine(String(created))");
    expect(script).not.toMatch(/WScript\.Echo\(/u);
    expect(script.toLowerCase()).not.toContain("powershell");
  });

  it("reads this process start identity", () => {
    const first = readProcessStartIdentity(process.pid);
    expect(first).toMatch(/^\d+$/u);
    expect(readProcessStartIdentity(process.pid)).toBe(first);
  });
});
