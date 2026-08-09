import { createHash } from "node:crypto";
import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  OpenSemanticFactorFormationCaptureSchema,
  OpenSemanticFactorFormationProposalSchema,
  groundOpenSemanticFactorGraph,
  openSemanticFactorFormationCapturePreimage,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationCaptureBody
} from "@do-soul/alaya-protocol";

export function materializeOpenSemanticFactorFormation(params: Readonly<{
  readonly source_kind: "evidence" | "query";
  readonly source_text: string | null;
  readonly proposal?: unknown;
}>): OpenSemanticFactorFormationCapture {
  const source = params.source_text;
  if (source === null || source.trim().length === 0) {
    return createCapture("ineligible", null, null, null);
  }
  const sourceSha256 = `sha256:${sha256(source)}`;
  if (params.proposal === undefined) {
    return createCapture("unavailable", null, sourceSha256, null);
  }
  const proposal = OpenSemanticFactorFormationProposalSchema.safeParse(params.proposal);
  if (!proposal.success || proposal.data.source_text !== source) {
    return createCapture("rejected", null, sourceSha256, null);
  }
  const graph = groundOpenSemanticFactorGraph(proposal.data.graph, source);
  if (graph === null || graph.source_kind !== params.source_kind) {
    return createCapture(
      "rejected",
      proposal.data.producer_operator_id,
      sourceSha256,
      null
    );
  }
  return createCapture("formed", proposal.data.producer_operator_id, sourceSha256, graph);
}

function createCapture(
  status: OpenSemanticFactorFormationCapture["status"],
  producerOperatorId: string | null,
  sourceSha256: string | null,
  graph: OpenSemanticFactorFormationCapture["graph"]
): OpenSemanticFactorFormationCapture {
  const body: OpenSemanticFactorFormationCaptureBody = {
    schema_version: 1,
    operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
    status,
    producer_operator_id: producerOperatorId,
    source_sha256: sourceSha256,
    graph
  };
  return OpenSemanticFactorFormationCaptureSchema.parse(Object.freeze({
    ...body,
    capture_digest: `sha256:${sha256(
      openSemanticFactorFormationCapturePreimage(body)
    )}`
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
