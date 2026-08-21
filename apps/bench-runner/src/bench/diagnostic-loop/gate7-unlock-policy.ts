import type { DiagnosticLoopRequest } from "./types.js";

export const GATE7_CANARY_LIMIT = 3;

export function gate7UnlockRequired(
  request: Pick<DiagnosticLoopRequest, "limit" | "requestedKeys">
): boolean {
  return (request.limit ?? request.requestedKeys.length) > GATE7_CANARY_LIMIT;
}
