import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

export function hasGroundedAssertionReceipt(
  rawPayload: CandidateMemorySignal["raw_payload"],
  assertion: string
): boolean {
  const grounding = readRecord(rawPayload.source_grounding);
  return grounding !== null &&
    grounding.status === "grounded" &&
    grounding.content_basis === "source_assertion" &&
    grounding.source_assertion === assertion;
}

export function readTrimmedText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
