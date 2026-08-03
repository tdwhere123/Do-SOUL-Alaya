import {
  buildAssociativeFactKeyProjections,
  groundAssociativeFactFrame,
  type CandidateMemorySignal,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";

export function buildFactKeySearchProjections(
  rawPayload: CandidateMemorySignal["raw_payload"]
): readonly Readonly<EvidenceSearchProjection>[] {
  const assertion = readText(rawPayload.source_assertion);
  if (assertion === null || !hasGroundedAssertionReceipt(rawPayload, assertion)) {
    return Object.freeze([]);
  }
  const frame = groundAssociativeFactFrame(rawPayload.fact_frame, assertion);
  return frame === null
    ? Object.freeze([])
    : buildAssociativeFactKeyProjections(frame);
}

function hasGroundedAssertionReceipt(
  rawPayload: CandidateMemorySignal["raw_payload"],
  assertion: string
): boolean {
  const grounding = rawPayload.source_grounding;
  return typeof grounding === "object" && grounding !== null && !Array.isArray(grounding) &&
    (grounding as Record<string, unknown>).status === "grounded" &&
    (grounding as Record<string, unknown>).content_basis === "source_assertion" &&
    (grounding as Record<string, unknown>).source_assertion === assertion;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
