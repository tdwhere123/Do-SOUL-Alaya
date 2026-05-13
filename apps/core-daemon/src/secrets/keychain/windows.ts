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

const PASSWORD_VAULT_READ_SCRIPT = [
  // PasswordVault can read credentials that were written through the Windows Credential Manager WinRT API.
  "[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null",
  "$service = $args[0]",
  "$account = $args[1]",
  "$vault = [Windows.Security.Credentials.PasswordVault]::new()",
  "$credential = $vault.Retrieve($service, $account)",
  "$credential.RetrievePassword()",
  "[Console]::Out.Write($credential.Password)"
].join("; ");

const PASSWORD_VAULT_WRITE_SCRIPT = [
  // PasswordVault write mirrors the read path and avoids cmdkey, which cannot read secrets back.
  "[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null",
  "$service = $args[0]",
  "$account = $args[1]",
  "$password = [Console]::In.ReadToEnd()",
  "$vault = [Windows.Security.Credentials.PasswordVault]::new()",
  "$credential = [Windows.Security.Credentials.PasswordCredential]::new($service, $account, $password)",
  "$vault.Add($credential)"
].join("; ");

export function readWindowsKeychainSecret(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainReadResult {
  const result = runner("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    PASSWORD_VAULT_READ_SCRIPT,
    service,
    account
  ], { timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS });

  if (result.error?.code === "ENOENT") {
    return windowsToolingUnavailable(service, account);
  }

  if (isKeychainSubprocessTimeout(result)) {
    return windowsToolingUnavailable(service, account, keychainSubprocessTimeoutReason("PowerShell PasswordVault"));
  }

  if (result.code !== 0) {
    return {
      kind: "keychain_entry_not_found",
      service,
      account,
      reason: "Windows PasswordVault did not return an entry for the requested service/account."
    };
  }

  return result.stdout.trimEnd();
}

export function writeWindowsKeychainSecret(
  service: string,
  account: string,
  value: string,
  runner: KeychainSubprocessRunner
): KeychainWriteResult {
  const result = runner(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      PASSWORD_VAULT_WRITE_SCRIPT,
      service,
      account
    ],
    { input: value, timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS }
  );

  if (result.error?.code === "ENOENT") {
    return windowsToolingUnavailable(service, account);
  }

  if (isKeychainSubprocessTimeout(result)) {
    return windowsToolingUnavailable(service, account, keychainSubprocessTimeoutReason("PowerShell PasswordVault"));
  }

  if (result.code !== 0) {
    return {
      kind: "keychain_write_failed",
      service,
      account,
      reason: "Windows PasswordVault failed to write the requested service/account."
    };
  }

  return { ok: true };
}

export function checkWindowsKeychainAvailable(
  service: string,
  account: string,
  runner: KeychainSubprocessRunner
): KeychainAvailabilityResult {
  const result = runner("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()"
  ], { timeoutMs: KEYCHAIN_SUBPROCESS_TIMEOUT_MS });
  return result.error?.code === "ENOENT" || isKeychainSubprocessTimeout(result)
    ? windowsToolingUnavailable(
        service,
        account,
        isKeychainSubprocessTimeout(result) ? keychainSubprocessTimeoutReason("PowerShell PasswordVault") : undefined
      )
    : { ok: true };
}

function windowsToolingUnavailable(
  service: string,
  account: string,
  reason = "PowerShell was not found on PATH; Windows keychain access requires PowerShell PasswordVault access."
): Extract<KeychainAvailabilityResult, { kind: "keychain_tooling_unavailable" }> {
  return {
    kind: "keychain_tooling_unavailable",
    service,
    account,
    reason
  };
}
