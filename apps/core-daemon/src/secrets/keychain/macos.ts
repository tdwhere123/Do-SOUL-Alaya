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
  // `security -i` parses stdin line-by-line; a newline in any field splits the
  // interactive command, so reject CR/LF rather than smuggle a second command.
  rejectInteractiveNewlines({ service, account, value });
  const result = runner("security", ["-i"], {
    // Secrets stay off argv, but any host-level shell transcript or terminal
    // recording that captures interactive stdin can still observe this input.
    // Alaya never enables such recording; operators must treat it as an
    // external host-policy risk, the same way the Windows adapter does.
    input: `add-generic-password -s ${quoteSecurityInteractiveArg(service)} -a ${quoteSecurityInteractiveArg(account)} -w ${quoteSecurityInteractiveArg(value)} -U\n`,
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

function quoteSecurityInteractiveArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function rejectInteractiveNewlines(fields: Record<string, string>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (/[\r\n]/u.test(value)) {
      throw new Error(`macOS Keychain ${name} must not contain newline characters.`);
    }
  }
}
