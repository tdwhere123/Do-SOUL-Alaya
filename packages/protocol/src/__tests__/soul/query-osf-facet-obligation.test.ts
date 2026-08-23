import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
  QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
  QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS,
  QUERY_OBLIGATION_FACET_IDS,
  QueryFactFrameOsfFacetReceiptSchema,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  queryFactFrameOsfFacetReceiptPreimage,
  type QueryObligationFacet
} from "../../index.js";

const DIGEST_A = digest("query");
const DIGEST_B = digest("capture");
const DIGEST_C = digest("obligation");

describe("query OSF facet obligation receipt", () => {
  it("accepts mixed formed rule-based hard slots and ineligible answer-shape facets", () => {
    const receipt = sealed(facets({
      predicate: formed("predicate", "graduate", [18, 26]),
      subject: formed("subject", "I", [16, 17]),
      answer_variable: formed("answer_variable", "What degree", [0, 11]),
      type_constraint: formed("type_constraint", "degree", [5, 11]),
      time: pending("time", "ineligible", "not_requested"),
      answer_operator: formed("answer_operator", "What", [0, 4])
    }), DIGEST_C);
    expect(receipt.operator_id).toBe(QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID);
    expect(receipt.facets.map((facet) => facet.constraint_class)).toEqual(
      QUERY_OBLIGATION_FACET_IDS.map((id) => QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[id])
    );
  });

  it("rejects a model-fallback facet that stamps the rule-based producer", () => {
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
        producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
        surface: "When",
        source_span: [0, 4],
        reason: null
      },
      answer_operator: pending("answer_operator", "unavailable", "no_parse")
    }), null);
    expect(QueryFactFrameOsfFacetReceiptSchema.safeParse({
      ...forged,
      receipt_digest: digest(queryFactFrameOsfFacetReceiptPreimage(forged))
    }).success).toBe(false);
  });

  it("rejects a complete certified digest once any facet is model-filled", () => {
    const body = unsigned(facets({
      predicate: formed("predicate", "graduate", [18, 26]),
      subject: formed("subject", "I", [16, 17]),
      answer_variable: formed("answer_variable", "What", [0, 4]),
      type_constraint: pending("type_constraint", "ineligible", "not_requested"),
      time: formed(
        "time", "When", [0, 4],
        MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID, "model_fallback"
      ),
      answer_operator: formed("answer_operator", "What", [0, 4])
    }), DIGEST_C);
    expect(QueryFactFrameOsfFacetReceiptSchema.safeParse({
      ...body,
      receipt_digest: digest(queryFactFrameOsfFacetReceiptPreimage(body))
    }).success).toBe(false);
  });
});

function sealed(
  facetList: readonly QueryObligationFacet[],
  certified: `sha256:${string}` | null
) {
  const body = unsigned(facetList, certified);
  return QueryFactFrameOsfFacetReceiptSchema.parse({
    ...body,
    receipt_digest: digest(queryFactFrameOsfFacetReceiptPreimage(body))
  });
}

function unsigned(
  facetList: readonly QueryObligationFacet[],
  certified: `sha256:${string}` | null
) {
  return {
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
    query_digest: DIGEST_A,
    fact_frame_producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
    fact_frame_capture_digest: DIGEST_B,
    certified_obligation_digest: certified,
    facets: facetList
  };
}

function facets(byId: Record<typeof QUERY_OBLIGATION_FACET_IDS[number], QueryObligationFacet>) {
  return QUERY_OBLIGATION_FACET_IDS.map((id) => byId[id]);
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
  reason: QueryObligationFacet["reason"] & string
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
