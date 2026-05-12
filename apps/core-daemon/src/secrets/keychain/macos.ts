import type {
  KeychainAvailabilityResult,
  KeychainReadResult,
  KeychainSubprocessRunner,
  KeychainWriteResult
} from "./index.js";

export function readMacosKeychainSecret(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainReadResult {
  const result = runner("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (result.error?.code === "ENOENT") {
    return {
      kind: "keychain_tooling_unavailable",
      service,
      account,
      reason: "macOS security command was not found on PATH."
    };
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
  const result = runner("security", ["-i"], {
    input: `add-generic-password -s ${quoteSecurityInteractiveArg(service)} -a ${quoteSecurityInteractiveArg(account)} -w ${quoteSecurityInteractiveArg(value)} -U\n`
  });
  if (result.error?.code === "ENOENT") {
    return macosToolingUnavailable(service, account);
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
  const result = runner("security", ["-h"]);
  return result.error?.code === "ENOENT" ? macosToolingUnavailable(service, account) : { ok: true };
}

function macosToolingUnavailable(service: string, account: string): Extract<KeychainAvailabilityResult, { kind: "keychain_tooling_unavailable" }> {
  return {
    kind: "keychain_tooling_unavailable",
    service,
    account,
    reason: "macOS security command was not found on PATH."
  };
}

function quoteSecurityInteractiveArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
