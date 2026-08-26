import type { DiagnosticLoopRequest } from "./types.js";

export const CANARY_QUESTION_LIMIT = 3;

export function canaryUnlockRequired(
  request: Pick<DiagnosticLoopRequest, "limit" | "requestedKeys">
): boolean {
  return (request.limit ?? request.requestedKeys.length) > CANARY_QUESTION_LIMIT;
}
