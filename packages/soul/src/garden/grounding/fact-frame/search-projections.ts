import {
  AssociativeFactFrameSchema,
  type CandidateMemorySignal,
  type AssociativeFactFrame,
  type EvidenceFactFrameFormationProposal
} from "@do-soul/alaya-protocol";

export const GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID =
  "garden_source_bound_fact_frame_proposal_v1";

export function buildFactFrameFormationProposal(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Readonly<EvidenceFactFrameFormationProposal> | undefined {
  const assertion = readText(rawPayload.source_assertion);
  if (assertion === null || !hasGroundedAssertionReceipt(rawPayload, assertion)) {
    return undefined;
  }
  const frame = readProposedFrame(rawPayload);
  return frame === null ? undefined : Object.freeze({
    schema_version: 1,
    producer_operator_id: GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
    source_assertion: assertion,
    fact_frame: frame
  });
}

function readProposedFrame(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Readonly<AssociativeFactFrame> | null {
  const direct = AssociativeFactFrameSchema.safeParse(rawPayload.fact_frame);
  if (direct.success) return direct.data;
  const grounding = readRecord(rawPayload.source_grounding);
  const proposed = AssociativeFactFrameSchema.safeParse(grounding?.proposed_fact_frame);
  return proposed.success ? proposed.data : null;
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

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
