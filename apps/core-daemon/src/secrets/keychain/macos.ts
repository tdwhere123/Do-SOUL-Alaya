import type {
  KeychainAvailabilityResult,
  KeychainReadResult,
  KeychainSubprocessRunner,
  KeychainWriteResult
} from "./index.js";
import {
  KEYCHAIN_SUBPROCESS_TIMEOUT_MS,
  isKeychainSubprocessTimeout,
  keychainSubprocessTimeoutReason
} from "./constants.js";

const CONTROL_CHARS = /[\0\r\n]/;
const SHELL_META_IN_IDENTIFIER = /[`'"$\\;&|<>()]/;

export function readMacosKeychainSecret(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainReadResult {
  const result = runner("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS
  });
  if (result.error?.code === "ENOENT") {
    return macosToolingUnavailable(service, account);
  }

  if (isKeychainSubprocessTimeout(result)) {
    return macosToolingUnavailable(service, account, keychainSubprocessTimeoutReason("macOS security"));
  }

  if (result.code !== 0) {
    return {
      kind: "keychain_entry_not_found",
      service,
      account,
      reason: "macOS Keychain item was not found for the requested service/account."
    };
  }

  return result.stdout.trimEnd();
}

export function writeMacosKeychainSecret(
  service: string,
  account: string,
  value: string,
  runner: KeychainSubprocessRunner
): KeychainWriteResult {
  const validationError = rejectInvalidMacosKeychainWriteFields(service, account, value);
  if (validationError !== null) {
    return validationError;
  }

  const result = runner("security", ["-i"], {
    input: buildMacosKeychainWriteScript(service, account, value),
    timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS
  });
  if (result.error?.code === "ENOENT") {
    return macosToolingUnavailable(service, account);
  }
  if (isKeychainSubprocessTimeout(result)) {
    return macosToolingUnavailable(service, account, keychainSubprocessTimeoutReason("macOS security"));
  }
  if (result.code !== 0) {
    return {
      kind: "keychain_write_failed",
      service,
      account,
      reason: "macOS security failed to write the requested Keychain item."
    };
  }
  return { ok: true };
}

export function checkMacosKeychainAvailable(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainAvailabilityResult {
  const result = runner("security", ["-h"], { timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS });
  return result.error?.code === "ENOENT" || isKeychainSubprocessTimeout(result)
    ? macosToolingUnavailable(
        service,
        account,
        isKeychainSubprocessTimeout(result) ? keychainSubprocessTimeoutReason("macOS security") : undefined
      )
    : { ok: true };
}

function rejectInvalidMacosKeychainWriteFields(
  service: string,
  account: string,
  value: string
): Extract<KeychainWriteResult, { kind: "keychain_write_failed" }> | null {
  if (CONTROL_CHARS.test(service) || CONTROL_CHARS.test(account) || CONTROL_CHARS.test(value)) {
    return macosWriteFailed(service, account, "Keychain fields must not contain null bytes or line breaks.");
  }
  if (SHELL_META_IN_IDENTIFIER.test(service)) {
    return macosWriteFailed(service, account, "Keychain service contains unsupported characters.");
  }
  if (SHELL_META_IN_IDENTIFIER.test(account)) {
    return macosWriteFailed(service, account, "Keychain account contains unsupported characters.");
  }
  // security -i is not a shell: stdin is parsed as security(1) commands only.
  // Reject shell-meta in the password so quoting cannot be broken inside -i.
  if (SHELL_META_IN_IDENTIFIER.test(value)) {
    return macosWriteFailed(service, account, "Keychain password contains unsupported characters.");
  }
  return null;
}

function buildMacosKeychainWriteScript(service: string, account: string, password: string): string {
  return `add-generic-password -s ${escapeSecurityInteractiveArg(service)} -a ${escapeSecurityInteractiveArg(account)} -w ${escapeSecurityInteractiveArg(password)} -U\n`;
}

function escapeSecurityInteractiveArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macosWriteFailed(
  service: string,
  account: string,
  reason: string
): Extract<KeychainWriteResult, { kind: "keychain_write_failed" }> {
  return {
    kind: "keychain_write_failed",
    service,
    account,
    reason
  };
}

function macosToolingUnavailable(
  service: string,
  account: string,
  reason = "macOS security command was not found on PATH."
): Extract<KeychainAvailabilityResult, { kind: "keychain_tooling_unavailable" }> {
  return {
    kind: "keychain_tooling_unavailable",
    service,
    account,
    reason
  };
}
