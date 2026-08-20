import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  certifyQueryOsfSemanticCompleteness,
  queryOsfSemanticCompletenessReceiptPreimage,
  type QueryOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import { replayFineAssessmentSelectionBoundary } from
  "../../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../semantic/open-semantic-factor-formation.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../recall/field/open-semantic-factors/query-obligation.js";
import { captureFineAssessmentSelectionBoundary } from
  "../selection-boundary-live-capture-fixture.js";

const QUERY = "What degree did I graduate with?";

describe("selection boundary query completeness authority", () => {
  it("replays the exact certified query and unavailable queries", async () => {
    const certified = await certifiedBoundary();
    expect(() => replayFineAssessmentSelectionBoundary(certified)).not.toThrow();
    expect(() => replayFineAssessmentSelectionBoundary(
      captureFineAssessmentSelectionBoundary("unsupported-query")
    )).not.toThrow();
  });

  it.each([
    ["missing receipt", (data: any) => { delete data.queryOpenSemanticFactorCompletenessReceipt; }],
    ["missing formation", (data: any) => { delete data.queryOpenSemanticFactorFormation; }],
    ["changed graph", (data: any) => {
      data.queryOpenSemanticFactorFormation.graph.factors[0].semantic_identity = "foreign";
    }],
    ["changed query", (data: any) => { data.queryProbes.normalized_query = "foreign"; }],
    ["changed fact frame", (data: any) => {
      data.queryFactFrameExtraction.frames[0].slots[0].text = "foreign";
    }],
    ["changed span", (data: any) => mutateReceipt(data, (receipt) => {
      receipt.subject.source_span = [0, 1];
    })],
    ["changed arity", (data: any) => mutateReceipt(data, (receipt) => {
      receipt.arity = 3;
    })],
    ["old receipt", (data: any) => mutateReceipt(data, (receipt) => {
      receipt.operator_id = "query_osf_semantic_completeness_v0";
    })]
  ])("rejects %s even when the boundary is otherwise current", async (_, mutate) => {
    const boundary = structuredClone(await certifiedBoundary()) as any;
    mutate(boundary.input.supplementary_data);
    expect(() => replayFineAssessmentSelectionBoundary(boundary))
      .toThrow(/selection boundary fidelity mismatch|schema_version|digest/u);
  });

  it("rejects the prior boundary schema", async () => {
    const old = { ...await certifiedBoundary(), schema_version: 4 };
    expect(() => replayFineAssessmentSelectionBoundary(old as never)).toThrow();
  });
});

async function certifiedBoundary() {
  const factFrame = await captureRecallQueryFactFrames({
    query_text: QUERY, port: new RuleBasedQueryFactFrameExtractor()
  });
  const obligation = deriveQueryFactFrameOsfObligation({
    query_text: QUERY, fact_frame_capture: factFrame
  });
  if (obligation === null) throw new Error("expected query obligation");
  const graph = completeGraph();
  const receipt = certifyQueryOsfSemanticCompleteness({ query_text: QUERY, graph,
    obligation, producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID, sha256 });
  if (receipt === null) throw new Error("expected query completeness receipt");
  const formation = materializeOpenSemanticFactorFormation({
    source_kind: "query", source_text: QUERY,
    proposal: { schema_version: 1,
      producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
      source_text: QUERY, graph }
  });
  return captureFineAssessmentSelectionBoundary("certified-query", {
    queryProbes: compileRecallQueryProbes(QUERY),
    queryFactFrameExtraction: factFrame,
    queryOpenSemanticFactorFormation: formation,
    queryOpenSemanticFactorCompletenessReceipt: receipt
  });
}

function mutateReceipt(
  data: any,
  mutate: (receipt: any) => void
): void {
  const receipt = data.queryOpenSemanticFactorCompletenessReceipt;
  mutate(receipt);
  const { receipt_digest: _digest, ...body } = receipt;
  receipt.receipt_digest = digest(
    queryOsfSemanticCompletenessReceiptPreimage(
      body as Omit<QueryOsfSemanticCompletenessReceipt, "receipt_digest">
    )
  );
}

function completeGraph() {
  return {
    schema_version: 2 as const, source_kind: "query" as const,
    factors: [factor("predicate", "graduate", "graduate"), factor("subject", "I", "i")],
    variables: [{ variable_id: "answer", surface: "What degree" }],
    result_variable_ids: ["answer"],
    propositions: [{ proposition_id: "query", predicate_factor_id: "predicate",
      arguments: [argument(0, "factor", "subject"),
        argument(1, "variable", "answer")] }]
  };
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(position: number, referenceKind: "factor" | "variable", referenceId: string) {
  return { position, binding_identity: `slot-${position}`,
    reference_kind: referenceKind, reference_id: referenceId };
}

function digest(value: string): `sha256:${string}` { return `sha256:${sha256(value)}`; }
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
