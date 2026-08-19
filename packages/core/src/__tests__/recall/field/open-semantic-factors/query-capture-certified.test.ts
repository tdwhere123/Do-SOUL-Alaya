import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  certifyQueryOsfSemanticCompleteness,
  queryOsfSemanticCompletenessReceiptPreimage,
  type QueryOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../../recall/field/open-semantic-factors/query-obligation.js";
import { captureCertifiedRecallQueryOpenSemanticFactors } from
  "../../../../recall/field/open-semantic-factors/query-capture.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";

const QUERY = "What degree did I graduate with?";

describe("certified recall query OSF capture", () => {
  it("accepts only a complete capture with its exact current receipt", async () => {
    const obligation = await queryObligation();
    const graph = completeGraph();
    const receipt = certifyQueryOsfSemanticCompleteness({
      query_text: QUERY, graph, obligation,
      producer_operator_id: "open_semantic_factor_query_compiler_v6", sha256
    })!;
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "query", source_text: QUERY,
      proposal: { schema_version: 1,
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
        source_text: QUERY, graph }
    });
    const correct = await prepared(capture, receipt, obligation);
    expect(correct).toMatchObject({ formation: { status: "formed" },
      receipt: { receipt_digest: receipt.receipt_digest } });

    await expect(prepared(capture, undefined, obligation)).resolves.toMatchObject({
      formation: { status: "unavailable" }, receipt: null
    });
    await expect(prepared(capture, { ...receipt,
      query_digest: digest("foreign") }, obligation)).resolves.toMatchObject({
      formation: { status: "unavailable" }, receipt: null
    });
    await expect(prepared(capture, oldReceipt(receipt) as never, obligation))
      .resolves.toMatchObject({ formation: { status: "unavailable" }, receipt: null });
    const foreignCapture = materializeOpenSemanticFactorFormation({
      source_kind: "query", source_text: QUERY,
      proposal: { schema_version: 1, producer_operator_id: "foreign_query_v6",
        source_text: QUERY, graph }
    });
    await expect(prepared(foreignCapture, receipt, obligation)).resolves.toMatchObject({
      formation: { status: "unavailable" }, receipt: null
    });
  });

  it("preserves the extraction port receiver for stateful implementations", async () => {
    const obligation = await queryObligation();
    const graph = completeGraph();
    const port = new StatefulPort(graph, obligation);
    await expect(captureCertifiedRecallQueryOpenSemanticFactors({
      query_text: QUERY, obligation, port
    })).resolves.toMatchObject({ formation: { status: "formed" } });
    expect(port.calls).toBe(1);
  });
});

class StatefulPort {
  public readonly operator_id = "open_semantic_factor_query_compiler_v6";
  public calls = 0;
  public constructor(
    private readonly graph: ReturnType<typeof completeGraph>,
    private readonly obligation: Awaited<ReturnType<typeof queryObligation>>
  ) {}
  public async extract() { return null; }
  public async extractCertifiedQuery() {
    this.calls += 1;
    const receipt = certifyQueryOsfSemanticCompleteness({
      query_text: QUERY, graph: this.graph, obligation: this.obligation,
      producer_operator_id: this.operator_id, sha256
    })!;
    return { schema_version: 1 as const, producer_operator_id: this.operator_id,
      graph: this.graph, semantic_completeness_receipt: receipt };
  }
}

async function queryObligation() {
  const factFrameCapture = await captureRecallQueryFactFrames({
    query_text: QUERY, port: new RuleBasedQueryFactFrameExtractor()
  });
  return deriveQueryFactFrameOsfObligation({
    query_text: QUERY, fact_frame_capture: factFrameCapture
  })!;
}

function oldReceipt(receipt: QueryOsfSemanticCompletenessReceipt) {
  const { receipt_digest: _digest, ...currentBody } = receipt;
  const body = { ...currentBody,
    operator_id: "query_osf_semantic_completeness_v0" };
  return { ...body,
    receipt_digest: digest(queryOsfSemanticCompletenessReceiptPreimage(body as never)) };
}

async function prepared(capture: ReturnType<typeof materializeOpenSemanticFactorFormation>,
  receipt: Readonly<QueryOsfSemanticCompletenessReceipt> | undefined,
  obligation: Awaited<ReturnType<typeof queryObligation>>) {
  return await captureCertifiedRecallQueryOpenSemanticFactors({
    query_text: QUERY, obligation, prepared_capture: capture,
    ...(receipt === undefined ? {} : { prepared_receipt: receipt })
  });
}

function completeGraph() {
  return {
    schema_version: 2 as const, source_kind: "query" as const,
    factors: [factor("predicate", "graduate", "graduate"),
      factor("subject", "I", "i")],
    variables: [{ variable_id: "answer", surface: "What degree" }],
    result_variable_ids: ["answer"],
    propositions: [{ proposition_id: "query", predicate_factor_id: "predicate",
      arguments: [argument(0, "factor", "subject"),
        argument(1, "variable", "answer")] }]
  };
}

function factor(id: string, surface: string, identity: string) {
  return { factor_id: id, surface, semantic_identity: identity };
}

function argument(position: number, kind: "factor" | "variable", id: string) {
  return { position, binding_identity: position === 0 ? "agent" : "credential",
    reference_kind: kind, reference_id: id };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${sha256(value)}`;
}
