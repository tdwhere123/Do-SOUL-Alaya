import {
  OpenSemanticFactorGraphProposalSchema,
  type CandidateMemorySignal,
  type OpenSemanticFactorFormationProposal
} from "@do-soul/alaya-protocol";

export const GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID =
  "garden_source_bound_open_semantic_factor_v2";

export function buildOpenSemanticFactorFormationProposal(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Readonly<OpenSemanticFactorFormationProposal> | undefined {
  const assertion = readText(rawPayload.source_assertion);
  if (assertion === null || !hasGroundedAssertionReceipt(rawPayload, assertion)) {
    return undefined;
  }
  const graph = OpenSemanticFactorGraphProposalSchema.safeParse(
    rawPayload.semantic_factor_graph
  );
  if (!graph.success || graph.data.source_kind !== "evidence") return undefined;
  return Object.freeze({
    schema_version: 1,
    producer_operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
    source_text: assertion,
    graph: graph.data
  });
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
