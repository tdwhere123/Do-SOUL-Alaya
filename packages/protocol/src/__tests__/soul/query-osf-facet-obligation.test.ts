import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
  QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
  QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS,
  QUERY_OBLIGATION_FACET_IDS,
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  QueryFactFrameOsfFacetReceiptSchema,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  queryFactFrameOsfFacetReceiptPreimage,
  type QueryObligationFacet
} from "../../index.js";

const DIGEST_A = digest("query");
const DIGEST_B = digest("capture");

describe("query OSF facet obligation receipt", () => {
  it("accepts mixed formed rule-based hard slots without a planted obligation digest", () => {
    const receipt = sealed(facets({
      predicate: formed("predicate", "graduate", [18, 26]),
      subject: formed("subject", "I", [16, 17]),
      answer_variable: formed("answer_variable", "What degree", [0, 11]),
      type_constraint: formed("type_constraint", "degree", [5, 11]),
      time: pending("time", "ineligible", "not_requested"),
      answer_operator: formed("answer_operator", "What", [0, 4])
    }));
    expect(receipt.operator_id).toBe(QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID);
    expect("certified_obligation_digest" in receipt).toBe(false);
    expect(byId(receipt, "predicate").constraint_class).toBe("hard_constraint");
  });

  it("rejects a model-fallback facet that stamps the rule-based producer", () => {
    expect(parseForgedProducer(RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID).success)
      .toBe(false);
  });

  it("rejects a model-fallback facet that stamps the query OSF graph compiler", () => {
    expect(parseForgedProducer(QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID).success)
      .toBe(false);
  });

  it("rejects formed model_fallback with a free-form producer", () => {
    expect(parseForgedProducer("other_model_v1").success).toBe(false);
  });

  it("accepts formed model_fallback only with the fallback producer", () => {
    const receipt = sealed(facets({
      predicate: pending("predicate", "unavailable", "no_parse"),
      subject: pending("subject", "unavailable", "no_parse"),
      answer_variable: pending("answer_variable", "unavailable", "no_parse"),
      type_constraint: pending("type_constraint", "ineligible", "not_requested"),
      time: formed(
        "time", "When", [0, 4],
        MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID, "model_fallback"
      ),
      answer_operator: pending("answer_operator", "unavailable", "no_parse")
    }));
    expect(byId(receipt, "time").producer_operator_id)
      .toBe(MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID);
  });
});

function parseForgedProducer(producer: string) {
  const forged = unsigned(facets({
    predicate: pending("predicate", "unavailable", "no_parse"),
    subject: pending("subject", "unavailable", "no_parse"),
    answer_variable: pending("answer_variable", "unavailable", "no_parse"),
    type_constraint: pending("type_constraint", "ineligible", "not_requested"),
    time: {
      facet_id: "time",
      status: "formed",
      constraint_class: "soft_constraint",
      producer_kind: "model_fallback",
      producer_operator_id: producer,
      surface: "When",
      source_span: [0, 4],
      reason: null
    },
    answer_operator: pending("answer_operator", "unavailable", "no_parse")
  }));
  return QueryFactFrameOsfFacetReceiptSchema.safeParse({
    ...forged,
    receipt_digest: digest(queryFactFrameOsfFacetReceiptPreimage(forged))
  });
}

function sealed(facetList: readonly QueryObligationFacet[]) {
  const body = unsigned(facetList);
  return QueryFactFrameOsfFacetReceiptSchema.parse({
    ...body,
    receipt_digest: digest(queryFactFrameOsfFacetReceiptPreimage(body))
  });
}

function unsigned(facetList: readonly QueryObligationFacet[]) {
  return {
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
    query_digest: DIGEST_A,
    fact_frame_producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
    fact_frame_capture_digest: DIGEST_B,
    facets: facetList
  };
}

function facets(byId: Record<typeof QUERY_OBLIGATION_FACET_IDS[number], QueryObligationFacet>) {
  return QUERY_OBLIGATION_FACET_IDS.map((id) => byId[id]);
}

function byId(
  receipt: ReturnType<typeof sealed>,
  id: typeof QUERY_OBLIGATION_FACET_IDS[number]
) {
  return receipt.facets.find((facet) => facet.facet_id === id)!;
}

function formed(
  id: QueryObligationFacet["facet_id"],
  surface: string,
  sourceSpan: [number, number],
  producer: string = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  kind: QueryObligationFacet["producer_kind"] = "rule_based"
): QueryObligationFacet {
  return {
    facet_id: id,
    status: "formed",
    constraint_class: QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[id],
    producer_kind: kind,
    producer_operator_id: producer,
    surface,
    source_span: sourceSpan,
    reason: null
  };
}

function pending(
  id: QueryObligationFacet["facet_id"],
  status: "unavailable" | "ineligible" | "rejected" | "ambiguous",
  reason: NonNullable<QueryObligationFacet["reason"]>
): QueryObligationFacet {
  return {
    facet_id: id,
    status,
    constraint_class: QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[id],
    producer_kind: "absent",
    producer_operator_id: null,
    surface: null,
    source_span: null,
    reason
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
