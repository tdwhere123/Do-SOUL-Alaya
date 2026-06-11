import type { DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";

export function summarizeError(error: unknown, fallback = "worker runtime failure"): string {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "CONFLICT":
        return "request conflict";
      case "NOT_FOUND":
        return "resource not found";
      case "VALIDATION":
      default:
        return "invalid request";
    }
  }

  return fallback;
}

export function toErrorOptions(cause: unknown): ErrorOptions | undefined {
  return cause instanceof Error ? { cause } : undefined;
}

export function summarizeTerminalRecoveryFailure(
  originalEventType: RuntimeEvent["type"],
  terminalEvent: Extract<RuntimeEvent, { readonly type: "session_finished" }>,
  error: unknown
): string {
  if (terminalEvent.type === originalEventType) {
    return `${originalEventType}: ${summarizeError(error, "terminal recovery failure")}`;
  }

  return `session_finished after ${originalEventType}: ${summarizeError(
    error,
    "terminal recovery failure"
  )}`;
}

export function isTerminalWorkerState(state: DelegatedWorkerRun["state"]): boolean {
  return state === "completed" || state === "aborted" || state === "frozen";
}

export function isObligationViolationError(error: unknown): error is CoreError {
  return error instanceof CoreError && error.code === "OBLIGATION_VIOLATION";
}