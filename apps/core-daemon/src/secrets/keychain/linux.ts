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

export function readLinuxKeychainSecret(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainReadResult {
  const result = runner("secret-tool", ["lookup", "service", service, "account", account], {
    timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS
  });
  if (result.error?.code === "ENOENT") {
    return linuxToolingUnavailable(service, account);
  }

  if (isKeychainSubprocessTimeout(result)) {
    return linuxToolingUnavailable(service, account, keychainSubprocessTimeoutReason("secret-tool"));
  }

  if (result.code !== 0 || result.stdout.trim().length === 0) {
    return {
      kind: "keychain_entry_not_found",
      service,
      account,
      reason: "libsecret did not return an entry for the requested service/account."
    };
  }

  return result.stdout.trimEnd();
}

export function writeLinuxKeychainSecret(
  service: string,
  account: string,
  value: string,
  runner: KeychainSubprocessRunner
): KeychainWriteResult {
  const result = runner(
    "secret-tool",
    ["store", "--label=alaya", "service", service, "account", account],
    { input: value, timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS }
  );
  if (result.error?.code === "ENOENT") {
    return linuxToolingUnavailable(service, account);
  }
  if (isKeychainSubprocessTimeout(result)) {
    return linuxToolingUnavailable(service, account, keychainSubprocessTimeoutReason("secret-tool"));
  }
  if (result.code !== 0) {
    return {
      kind: "keychain_write_failed",
      service,
      account,
      reason: "secret-tool failed to store the requested libsecret item."
    };
  }
  return { ok: true };
}

export function checkLinuxKeychainAvailable(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainAvailabilityResult {
  const result = runner("secret-tool", ["--help"], { timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS });
  return result.error?.code === "ENOENT" || isKeychainSubprocessTimeout(result)
    ? linuxToolingUnavailable(
        service,
        account,
        isKeychainSubprocessTimeout(result) ? keychainSubprocessTimeoutReason("secret-tool") : undefined
      )
    : { ok: true };
}

function linuxToolingUnavailable(
  service: string,
  account: string,
  reason = "secret-tool was not found on PATH; install the libsecret-tools package."
): Extract<KeychainAvailabilityResult, { kind: "keychain_tooling_unavailable" }> {
  return {
    kind: "keychain_tooling_unavailable",
    service,
    account,
    reason
  };
}
