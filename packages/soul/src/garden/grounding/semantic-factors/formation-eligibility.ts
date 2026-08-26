import {
  groundOpenSemanticFactorGraph,
  type CandidateMemorySignal,
  type OpenSemanticFactorFormationProposal,
  type OpenSemanticFactorGraphProposal
} from "@do-soul/alaya-protocol";
import {
  hasGroundedAssertionReceipt,
  readTrimmedText
} from "../source-assertion/grounded-assertion-receipt.js";
import {
  inspectOfficialApiSemanticFactorGraphProjection,
  parseOfficialApiSemanticFactorGraphProjectionAudit,
  type OfficialApiSemanticFactorGraphProjectionReason
} from "../../official-api/semantic-factor-projection.js";

export const GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID =
  "garden_source_bound_open_semantic_factor_v3";

export type OpenSemanticFactorFormationEligibility = Readonly<
  | {
    readonly kind: "propose";
    readonly proposal: OpenSemanticFactorFormationProposal;
  }
  | {
    readonly kind: "unavailable";
    readonly reason: "semantic_factor_graph_missing" | "source_assertion_absent";
  }
  | {
    readonly kind: "rejected";
    readonly reason: OfficialApiSemanticFactorGraphProjectionReason |
      "source_grounding_rejected";
  }
>;

export function classifyOpenSemanticFactorFormationEligibility(
  rawPayload: CandidateMemorySignal["raw_payload"]
): OpenSemanticFactorFormationEligibility {
  const projection = parseOfficialApiSemanticFactorGraphProjectionAudit(
    rawPayload.semantic_factor_graph_projection
  );
  if (isRejectedGrounding(rawPayload.source_grounding)) {
    return rejected(rejectedGraphReason(rawPayload, projection) ?? "source_grounding_rejected");
  }
  if (projection?.status === "rejected") return rejected(projection.reason);
  if (projection?.status === "unavailable") {
    return unavailable("semantic_factor_graph_missing");
  }
  return classifySourceBoundGraph(rawPayload);
}

function classifySourceBoundGraph(
  rawPayload: CandidateMemorySignal["raw_payload"]
): OpenSemanticFactorFormationEligibility {
  const assertion = readTrimmedText(rawPayload.source_assertion);
  const inspected = inspectGraph(rawPayload);
  if (inspected.reason !== undefined) return rejected(inspected.reason);
  if (inspected.graph === undefined) {
    return unavailable(assertion === null
      ? "source_assertion_absent"
      : "semantic_factor_graph_missing");
  }
  if (assertion === null || !hasGroundedAssertionReceipt(rawPayload, assertion)) {
    return rejected("source_grounding_rejected");
  }
  const grounded = groundOpenSemanticFactorGraph(inspected.graph, assertion);
  if (grounded === null || grounded.source_kind !== "evidence") {
    return rejected("semantic_factor_graph_not_source_grounded");
  }
  return Object.freeze({
    kind: "propose",
    proposal: Object.freeze({
      schema_version: 1 as const,
      producer_operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
      source_text: assertion,
      graph: inspected.graph
    })
  });
}

function inspectGraph(rawPayload: CandidateMemorySignal["raw_payload"]): Readonly<{
  readonly graph?: OpenSemanticFactorGraphProposal;
  readonly reason?: OfficialApiSemanticFactorGraphProjectionReason;
}> {
  const inspected = inspectOfficialApiSemanticFactorGraphProjection(
    rawPayload.semantic_factor_graph
  );
  if (inspected.audit?.status === "rejected") return { reason: inspected.audit.reason };
  return inspected.graph === undefined ? {} : { graph: inspected.graph };
}

function rejectedGraphReason(
  rawPayload: CandidateMemorySignal["raw_payload"],
  projection: ReturnType<typeof parseOfficialApiSemanticFactorGraphProjectionAudit>
): OfficialApiSemanticFactorGraphProjectionReason | undefined {
  if (projection?.status === "rejected") return projection.reason;
  return inspectGraph(rawPayload).reason;
}

function isRejectedGrounding(value: unknown): boolean {
  return isRecord(value) && value.status === "rejected";
}

function rejected(
  reason: Extract<OpenSemanticFactorFormationEligibility, { readonly kind: "rejected" }>["reason"]
): OpenSemanticFactorFormationEligibility {
  return Object.freeze({ kind: "rejected", reason });
}

function unavailable(
  reason: "semantic_factor_graph_missing" | "source_assertion_absent"
): OpenSemanticFactorFormationEligibility {
  return Object.freeze({ kind: "unavailable", reason });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
