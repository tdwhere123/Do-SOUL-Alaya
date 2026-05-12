import type {
  KeychainAvailabilityResult,
  KeychainReadResult,
  KeychainSubprocessRunner,
  KeychainWriteResult
} from "./index.js";

export function readLinuxKeychainSecret(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainReadResult {
  const result = runner("secret-tool", ["lookup", "service", service, "account", account]);
  if (result.error?.code === "ENOENT") {
    return {
      kind: "keychain_tooling_unavailable",
      service,
      account,
      reason: "secret-tool was not found on PATH; install the libsecret-tools package."
    };
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
    { input: value }
  );
  if (result.error?.code === "ENOENT") {
    return linuxToolingUnavailable(service, account);
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
  const result = runner("secret-tool", ["--help"]);
  return result.error?.code === "ENOENT" ? linuxToolingUnavailable(service, account) : { ok: true };
}

function linuxToolingUnavailable(service: string, account: string): Extract<KeychainAvailabilityResult, { kind: "keychain_tooling_unavailable" }> {
  return {
    kind: "keychain_tooling_unavailable",
    service,
    account,
    reason: "secret-tool was not found on PATH; install the libsecret-tools package."
  };
}
