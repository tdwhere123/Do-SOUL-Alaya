import { describe, expect, it, vi } from "vitest";
import {
  checkPlatformKeychainAvailable,
  defaultKeychainSubprocessRunner,
  readPlatformKeychainSecret,
  writePlatformKeychainSecret,
  type KeychainSubprocessResult,
  type KeychainSubprocessRunner
} from "../../secrets/keychain/index.js";
import { checkLinuxKeychainAvailable, readLinuxKeychainSecret, writeLinuxKeychainSecret } from "../../secrets/keychain/linux.js";
import { readMacosKeychainSecret, writeMacosKeychainSecret } from "../../secrets/keychain/macos.js";
import {
  checkWindowsKeychainAvailable,
  readWindowsKeychainSecret,
  writeWindowsKeychainSecret
} from "../../secrets/keychain/windows.js";

describe("keychain adapters", () => {
  it("builds the macOS security argv and maps success", () => {
    const runner = stubRunner({ code: 0, stdout: "mac-secret\n", stderr: "" });

    expect(readMacosKeychainSecret("svc", "acct", runner)).toBe("mac-secret");
    expect(runner).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "svc", "-a", "acct", "-w"], {
      timeoutMs: 10_000
    });
  });

  it("maps macOS tooling and not-found failures", () => {
    expect(
      readMacosKeychainSecret("svc", "acct", stubRunner({ code: null, stdout: "", stderr: "", error: enoent() }))
    ).toMatchObject({ kind: "keychain_tooling_unavailable", service: "svc", account: "acct" });

    expect(readMacosKeychainSecret("svc", "acct", stubRunner({ code: 44, stdout: "", stderr: "not found" }))).toEqual({
      kind: "keychain_entry_not_found",
      service: "svc",
      account: "acct",
      reason: "macOS Keychain item was not found for the requested service/account."
    });
  });

  it("builds the Linux secret-tool argv and maps outcomes", () => {
    const runner = stubRunner({ code: 0, stdout: "linux-secret\n", stderr: "" });

    expect(readLinuxKeychainSecret("svc", "acct", runner)).toBe("linux-secret");
    expect(runner).toHaveBeenCalledWith("secret-tool", ["lookup", "service", "svc", "account", "acct"], {
      timeoutMs: 10_000
    });
    expect(
      readLinuxKeychainSecret("svc", "acct", stubRunner({ code: null, stdout: "", stderr: "", error: enoent() }))
    ).toMatchObject({ kind: "keychain_tooling_unavailable" });
    expect(readLinuxKeychainSecret("svc", "acct", stubRunner({ code: 1, stdout: "", stderr: "" }))).toMatchObject({
      kind: "keychain_entry_not_found"
    });
    expect(readLinuxKeychainSecret("svc", "acct", stubRunner({ code: 0, stdout: "\n", stderr: "" }))).toMatchObject({
      kind: "keychain_entry_not_found"
    });
  });

  it("writes macOS secrets via security -i stdin and keeps the password out of argv", () => {
    const macRunner = stubRunner({ code: 0, stdout: "", stderr: "" });
    const secret = "secret-value";

    expect(writeMacosKeychainSecret("svc", "acct", secret, macRunner)).toEqual({ ok: true });
    expect(macRunner).toHaveBeenCalledWith("security", ["-i"], {
      input: expect.stringContaining(secret),
      timeoutMs: 10_000
    });
    expect(macRunner.mock.calls[0]![1]).toEqual(["-i"]);
    expect(macRunner.mock.calls[0]![1]).not.toContain(secret);
  });

  it("passes Linux/Windows secrets on stdin", () => {
    const linuxRunner = stubRunner({ code: 0, stdout: "", stderr: "" });
    expect(writeLinuxKeychainSecret("svc", "acct", "secret", linuxRunner)).toEqual({ ok: true });
    expect(linuxRunner).toHaveBeenCalledWith(
      "secret-tool",
      ["store", "--label=alaya", "service", "svc", "account", "acct"],
      { input: "secret", timeoutMs: 10_000 }
    );

    const windowsRunner = stubRunner({ code: 0, stdout: "", stderr: "" });
    expect(writeWindowsKeychainSecret("svc", "acct", "secret", windowsRunner)).toEqual({ ok: true });
    const [command, args, options] = windowsRunner.mock.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(args.join(" ")).toContain("PasswordVault");
    expect(options).toEqual({ input: "secret", timeoutMs: 10_000 });
  });

  it.each([
    { label: "single quote", secret: "sk'quote" },
    { label: "backtick", secret: "sk`cmd" },
    { label: "$PATH expansion text", secret: "$PATH:$HOME" },
    { label: "backslash", secret: "sk\\secret" },
    { label: "substitution text", secret: "$(secret)" }
  ])("rejects macOS password shell-meta for $label", ({ secret }) => {
    const runner = stubRunner({ code: 0, stdout: "", stderr: "" });

    expect(writeMacosKeychainSecret("svc", "acct", secret, runner)).toMatchObject({
      kind: "keychain_write_failed"
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    { label: "service quote", service: "svc'quote", account: "acct", secret: "sk" },
    { label: "service backtick", service: "svc`cmd", account: "acct", secret: "sk" },
    { label: "service substitution", service: "$(svc)", account: "acct", secret: "sk" },
    { label: "account quote", service: "svc", account: "acct'quote", secret: "sk" }
  ])("rejects injection-shaped macOS service/account for $label", ({ service, account, secret }) => {
    const runner = stubRunner({ code: 0, stdout: "", stderr: "" });

    expect(writeMacosKeychainSecret(service, account, secret, runner)).toMatchObject({
      kind: "keychain_write_failed"
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    { label: "value", service: "svc", account: "acct", secret: "sk\nadd-generic-password -s evil -a evil -w pwn -U" },
    { label: "CR value", service: "svc", account: "acct", secret: "sk\radd-generic-password" },
    { label: "service", service: "svc\nevil", account: "acct", secret: "sk" },
    { label: "account", service: "svc", account: "acct\nevil", secret: "sk" }
  ])("rejects macOS security write $label newlines", ({ service, account, secret }) => {
    const runner = stubRunner({ code: 0, stdout: "", stderr: "" });

    expect(writeMacosKeychainSecret(service, account, secret, runner)).toMatchObject({
      kind: "keychain_write_failed"
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("maps write tooling and command failures", () => {
    expect(writeLinuxKeychainSecret("svc", "acct", "secret", stubRunner({ code: null, stdout: "", stderr: "", error: enoent() }))).toMatchObject({
      kind: "keychain_tooling_unavailable"
    });
    expect(writeLinuxKeychainSecret("svc", "acct", "secret", stubRunner({ code: 1, stdout: "", stderr: "denied" }))).toMatchObject({
      kind: "keychain_write_failed",
      service: "svc",
      account: "acct"
    });
  });

  it("builds the Windows PowerShell PasswordVault argv and maps outcomes", () => {
    const runner = stubRunner({ code: 0, stdout: "windows-secret", stderr: "" });

    expect(readWindowsKeychainSecret("svc", "acct", runner)).toBe("windows-secret");
    const [command, args] = runner.mock.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "svc", "acct"])
    );
    expect(args.join(" ")).toContain("PasswordVault");

    expect(
      readWindowsKeychainSecret("svc", "acct", stubRunner({ code: null, stdout: "", stderr: "", error: enoent() }))
    ).toMatchObject({ kind: "keychain_tooling_unavailable" });
    expect(readWindowsKeychainSecret("svc", "acct", stubRunner({ code: 1, stdout: "", stderr: "not found" }))).toMatchObject({
      kind: "keychain_entry_not_found"
    });
  });

  it("maps Windows PasswordVault load failures to tooling unavailable", () => {
    const stderr = "Unable to find type [Windows.Security.Credentials.PasswordVault].";

    expect(readWindowsKeychainSecret("svc", "acct", stubRunner({ code: 1, stdout: "", stderr }))).toMatchObject({
      kind: "keychain_tooling_unavailable",
      reason: expect.stringContaining("PasswordVault WinRT type is unavailable")
    });
    expect(writeWindowsKeychainSecret("svc", "acct", "secret", stubRunner({ code: 1, stdout: "", stderr }))).toMatchObject({
      kind: "keychain_tooling_unavailable",
      reason: expect.stringContaining("PasswordVault WinRT type is unavailable")
    });
    expect(checkWindowsKeychainAvailable("svc", "acct", stubRunner({ code: 1, stdout: "", stderr }))).toMatchObject({
      kind: "keychain_tooling_unavailable",
      reason: expect.stringContaining("PasswordVault WinRT type is unavailable")
    });
  });

  it("dispatches through the host-platform adapter table", () => {
    const runner = stubRunner({ code: 0, stdout: "linux-secret\n", stderr: "" });

    expect(readPlatformKeychainSecret("svc", "acct", { platform: "linux", runner })).toBe("linux-secret");
    expect(writePlatformKeychainSecret("svc", "acct", "secret", { platform: "linux", runner })).toEqual({ ok: true });
    expect(checkPlatformKeychainAvailable("svc", "acct", { platform: "linux", runner })).toEqual({ ok: true });
    expect(checkLinuxKeychainAvailable("svc", "acct", runner)).toEqual({ ok: true });
    expect(readPlatformKeychainSecret("svc", "acct", { platform: "freebsd", runner })).toMatchObject({
      kind: "keychain_tooling_unavailable",
      service: "svc",
      account: "acct"
    });
    expect(() => readPlatformKeychainSecret("svc", "acct", { platform: "linux" })).toThrow(
      "keychain platform override is test-only"
    );
  });

  it("maps timed-out keychain subprocesses to tooling-unavailable diagnostics", () => {
    const timedOut = stubRunner({ code: null, stdout: "", stderr: "", error: timeoutError() });

    expect(readLinuxKeychainSecret("svc", "acct", timedOut)).toMatchObject({
      kind: "keychain_tooling_unavailable",
      reason: expect.stringContaining("timed out")
    });
    expect(writeMacosKeychainSecret("svc", "acct", "secret", timedOut)).toMatchObject({
      kind: "keychain_tooling_unavailable",
      reason: expect.stringContaining("timed out")
    });
    expect(checkPlatformKeychainAvailable("svc", "acct", { platform: "win32", runner: timedOut })).toMatchObject({
      kind: "keychain_tooling_unavailable",
      reason: expect.stringContaining("timed out")
    });
  });

  it("runs keychain subprocesses with an allowlisted child environment", () => {
    process.env.ALAYA_KEYCHAIN_TEST_SECRET = "sk-env-leak";
    try {
      const result = defaultKeychainSubprocessRunner(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(1, process.env.ALAYA_KEYCHAIN_TEST_SECRET ?? 'missing')"
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("missing");
    } finally {
      delete process.env.ALAYA_KEYCHAIN_TEST_SECRET;
    }
  });
});

function stubRunner(result: KeychainSubprocessResult): KeychainSubprocessRunner & ReturnType<typeof vi.fn> {
  return vi.fn(() => result);
}

function enoent(): NodeJS.ErrnoException {
  const error = new Error("not found") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function timeoutError(): NodeJS.ErrnoException {
  const error = new Error("timed out") as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}
