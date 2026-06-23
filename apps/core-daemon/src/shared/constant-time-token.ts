import { timingSafeEqual } from "node:crypto";

// Length-independent constant-time compare: pads both sides to a common length
// so the early return never leaks the expected token length (mirrors
// apps/inspector/src/middleware/auth.ts constantTimeTokenEqual).
export function constantTimeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const maxLength = Math.max(providedBuffer.length, expectedBuffer.length, 1);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  providedBuffer.copy(paddedProvided);
  expectedBuffer.copy(paddedExpected);
  return timingSafeEqual(paddedProvided, paddedExpected) && providedBuffer.length === expectedBuffer.length;
}
