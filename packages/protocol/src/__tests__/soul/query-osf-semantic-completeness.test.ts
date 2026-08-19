import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  certifyQueryOsfSemanticCompleteness,
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  QueryFactFrameOsfObligationSchema,
  queryFactFrameOsfObligationPreimage
} from "../../soul/query-osf-semantic-completeness.js";

const QUERY = "What degree did I graduate with?";

describe("query OSF semantic completeness", () => {
  it("rejects unary, reversed, role-swapped, and repeated-surface drift", () => {
    expect(certify(unary())).toBeNull();
    expect(certify(binary("variable", "answer", "factor", "subject"))).toBeNull();
    expect(certify(binary("factor", "subject", "variable", "answer", [1, 0]))).toBeNull();
    expect(certify({
      ...binary("factor", "subject", "variable", "answer"),
      factors: [factor("predicate", "graduate", "graduate"), factor("subject", "I", "i", 1)]
    })).toBeNull();
  });

  it("certifies the correct binary result-variable layout", () => {
    expect(certify(binary("factor", "subject", "variable", "answer")))
      .toMatchObject({ operator_id: "query_osf_semantic_completeness_v1", arity: 2 });
  });

  it("rejects an explicit third argument", () => {
    const graph = binary("factor", "subject", "variable", "answer");
    expect(certify({
      ...graph,
      factors: [...graph.factors, factor("extra", "with", "with")],
      propositions: [{ ...graph.propositions[0]!, arguments: [
        ...graph.propositions[0]!.arguments,
        argument(2, "factor", "extra")
      ] }]
    })).toBeNull();
  });

  it("binds repeated surfaces to their certified occurrence", () => {
    const query = "What did echo echo?";
    const repeatedObligation = obligationFor(query, {
      predicate: { surface: "echo", source_span: [14, 18], position: 0 },
      subject: { surface: "echo", source_span: [9, 13], position: 0 },
      value: { surface: "What", source_span: [0, 4], position: 1 }
    });
    expect(certifyRepeated(query, repeatedObligation, 1, 0)).not.toBeNull();
    expect(certifyRepeated(query, repeatedObligation, 0, 1)).toBeNull();
  });
});

function certify(graph: ReturnType<typeof binary>) {
  return certifyQueryOsfSemanticCompleteness({
    query_text: QUERY,
    graph,
    obligation: obligation(),
    producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
    sha256
  });
}

function obligation() {
  return obligationFor(QUERY, {
    predicate: { surface: "graduate", source_span: [18, 26], position: 0 },
    subject: { surface: "I", source_span: [16, 17], position: 0 },
    value: { surface: "What degree", source_span: [0, 11], position: 1 }
  });
}

function obligationFor(query: string, slots: Readonly<{
  predicate: { surface: string; source_span: readonly [number, number]; position: 0 };
  subject: { surface: string; source_span: readonly [number, number]; position: 0 };
  value: { surface: string; source_span: readonly [number, number]; position: 1 };
}>) {
  const body = {
    schema_version: 1 as const,
    operator_id: "query_fact_frame_osf_obligation_v1" as const,
    query_digest: digest(query),
    fact_frame_producer_operator_id: "rule_based_query_fact_frame_extractor_v1",
    fact_frame_capture_digest: digest("capture"),
    predicate: slots.predicate,
    subject: slots.subject,
    value: slots.value,
    arity: 2 as const
  };
  return QueryFactFrameOsfObligationSchema.parse({
    ...body,
    obligation_digest: digest(queryFactFrameOsfObligationPreimage(body))
  });
}

function certifyRepeated(
  query: string,
  repeatedObligation: ReturnType<typeof obligationFor>,
  predicateOccurrence: number,
  subjectOccurrence: number
) {
  return certifyQueryOsfSemanticCompleteness({
    query_text: query,
    obligation: repeatedObligation,
    producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
    sha256,
    graph: {
      schema_version: 2, source_kind: "query",
      factors: [factor("predicate", "echo", "echo", predicateOccurrence),
        factor("subject", "echo", "echo", subjectOccurrence)],
      variables: [{ variable_id: "answer", surface: "What" }],
      result_variable_ids: ["answer"],
      propositions: [{ proposition_id: "query", predicate_factor_id: "predicate",
        arguments: [argument(0, "factor", "subject"),
          argument(1, "variable", "answer")] }]
    }
  });
}

function unary() {
  const graph = binary("factor", "subject", "variable", "answer");
  return { ...graph, propositions: [{ ...graph.propositions[0]!, arguments: [graph.propositions[0]!.arguments[1]!] }] };
}

function binary(
  firstKind: "factor" | "variable",
  firstId: string,
  secondKind: "factor" | "variable",
  secondId: string,
  positions: readonly [number, number] = [0, 1]
) {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [factor("predicate", "graduate", "graduate"), factor("subject", "I", "i")],
    variables: [{ variable_id: "answer", surface: "What degree" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(positions[0], firstKind, firstId),
        argument(positions[1], secondKind, secondId)
      ]
    }]
  };
}

function factor(id: string, surface: string, semantic: string, occurrence?: number) {
  return { factor_id: id, surface, semantic_identity: semantic,
    ...(occurrence === undefined ? {} : { source_occurrence: occurrence }) };
}

function argument(position: number, kind: "factor" | "variable", id: string) {
  return { position, binding_identity: `slot-${position}`,
    reference_kind: kind, reference_id: id };
}

function digest(value: string): `sha256:${string}` { return `sha256:${sha256(value)}`; }
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
