export const KEYCHAIN_SUBPROCESS_TIMEOUT_MS = 10_000;

export interface KeychainSubprocessTimeoutCandidate {
  readonly error?: NodeJS.ErrnoException;
  readonly signal?: NodeJS.Signals | null;
}

export function isKeychainSubprocessTimeout(result: KeychainSubprocessTimeoutCandidate): boolean {
  return result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
}

export function keychainSubprocessTimeoutReason(toolName: string): string {
  return `${toolName} timed out after ${KEYCHAIN_SUBPROCESS_TIMEOUT_MS}ms; unlock the platform keychain or retry when keychain UI is available.`;
}
