import { spawnSync } from "node:child_process";
import { checkLinuxKeychainAvailable, readLinuxKeychainSecret, writeLinuxKeychainSecret } from "./linux.js";
import { checkMacosKeychainAvailable, readMacosKeychainSecret, writeMacosKeychainSecret } from "./macos.js";
import { checkWindowsKeychainAvailable, readWindowsKeychainSecret, writeWindowsKeychainSecret } from "./windows.js";
import { KEYCHAIN_SUBPROCESS_TIMEOUT_MS } from "./constants.js";

export interface KeychainSubprocessOptions {
  readonly timeoutMs?: number;
  readonly input?: string;
}

export interface KeychainSubprocessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException;
  readonly signal?: NodeJS.Signals | null;
}

export type KeychainSubprocessRunner = (
  command: string,
  args: readonly string[],
  options?: KeychainSubprocessOptions
) => KeychainSubprocessResult;

export type KeychainReadError =
  | { kind: "keychain_tooling_unavailable"; service: string; account: string; reason: string }
  | { kind: "keychain_entry_not_found"; service: string; account: string; reason: string };

export type KeychainReadResult = string | KeychainReadError;

export type KeychainWriteError =
  | { kind: "keychain_tooling_unavailable"; service: string; account: string; reason: string }
  | { kind: "keychain_write_failed"; service: string; account: string; reason: string };

export type KeychainWriteResult = { readonly ok: true } | KeychainWriteError;

export type KeychainAvailabilityResult = { readonly ok: true } | Extract<KeychainWriteError, { kind: "keychain_tooling_unavailable" }>;

export function readPlatformKeychainSecret(
  service: string,
  account: string,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly runner?: KeychainSubprocessRunner;
  } = {}
): KeychainReadResult {
  const { platform, runner } = resolveKeychainDispatchInput(input);

  switch (platform) {
    case "darwin":
      return readMacosKeychainSecret(service, account, runner);
    case "linux":
      return readLinuxKeychainSecret(service, account, runner);
    case "win32":
      return readWindowsKeychainSecret(service, account, runner);
    default:
      return {
        kind: "keychain_tooling_unavailable",
        service,
        account,
        reason: `No keychain adapter is available for platform ${platform}.`
      };
  }
}

export function writePlatformKeychainSecret(
  service: string,
  account: string,
  value: string,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly runner?: KeychainSubprocessRunner;
  } = {}
): KeychainWriteResult {
  const { platform, runner } = resolveKeychainDispatchInput(input);

  switch (platform) {
    case "darwin":
      return writeMacosKeychainSecret(service, account, value, runner);
    case "linux":
      return writeLinuxKeychainSecret(service, account, value, runner);
    case "win32":
      return writeWindowsKeychainSecret(service, account, value, runner);
    default:
      return {
        kind: "keychain_tooling_unavailable",
        service,
        account,
        reason: `No keychain adapter is available for platform ${platform}.`
      };
  }
}

export function checkPlatformKeychainAvailable(
  service: string,
  account: string,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly runner?: KeychainSubprocessRunner;
  } = {}
): KeychainAvailabilityResult {
  const { platform, runner } = resolveKeychainDispatchInput(input);

  switch (platform) {
    case "darwin":
      return checkMacosKeychainAvailable(service, account, runner);
    case "linux":
      return checkLinuxKeychainAvailable(service, account, runner);
    case "win32":
      return checkWindowsKeychainAvailable(service, account, runner);
    default:
      return {
        kind: "keychain_tooling_unavailable",
        service,
        account,
        reason: `No keychain adapter is available for platform ${platform}.`
      };
  }
}

function resolveKeychainDispatchInput(input: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: KeychainSubprocessRunner;
}): { readonly platform: NodeJS.Platform; readonly runner: KeychainSubprocessRunner } {
  if (input.platform !== undefined && input.runner === undefined) {
    throw new Error("keychain platform override is test-only and requires an explicit subprocess runner.");
  }
  return {
    platform: input.platform ?? process.platform,
    runner: input.runner ?? defaultKeychainSubprocessRunner
  };
}

export function defaultKeychainSubprocessRunner(
  command: string,
  args: readonly string[],
  options: KeychainSubprocessOptions = {}
): KeychainSubprocessResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? KEYCHAIN_SUBPROCESS_TIMEOUT_MS,
    windowsHide: true
  });

  return {
    code: typeof result.status === "number" ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error as NodeJS.ErrnoException | undefined,
    signal: result.signal
  };
}
