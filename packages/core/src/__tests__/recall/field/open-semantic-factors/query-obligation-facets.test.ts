import { describe, expect, it } from "vitest";
import {
  MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  QueryFactFrameOsfObligationSchema,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../../recall/field/open-semantic-factors/query-obligation.js";
import {
  applyQueryObligationFacetFallback,
  deriveQueryFactFrameOsfFacetReceipt,
  verifyQueryFactFrameOsfFacetReceipt
} from "../../../../recall/field/open-semantic-factors/query-obligation/facets.js";

const extractor = new RuleBasedQueryFactFrameExtractor();
const WHEN = "When is the meeting?";

describe("query fact-frame OSF facet obligation receipt", () => {
  it("forms do-support hard slots and answer-shape facets without weakening certification", async () => {
    const query = "What degree did I graduate with?";
    const { receipt, certified } = await deriveBoth(query);
    expect(certified).not.toBeNull();
    expect(byId(receipt, "predicate")).toMatchObject({
      status: "formed",
      constraint_class: "hard_constraint",
      producer_kind: "rule_based",
      producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
      surface: "graduate"
    });
    expect(byId(receipt, "subject")).toMatchObject({
      status: "formed", constraint_class: "hard_constraint", surface: "I"
    });
    expect(byId(receipt, "answer_variable")).toMatchObject({
      status: "formed", constraint_class: "answer_shape", surface: "What degree"
    });
    expect(byId(receipt, "type_constraint")).toMatchObject({
      status: "formed", constraint_class: "answer_shape", surface: "degree"
    });
    expect(byId(receipt, "time")).toMatchObject({
      status: "ineligible", constraint_class: "soft_constraint"
    });
    expect(byId(receipt, "answer_operator")).toMatchObject({
      status: "formed", constraint_class: "answer_shape", surface: "What"
    });
  });

  it("forms copular measure layout facets", async () => {
    const query = "How long is my daily commute to work?";
    const { receipt, certified } = await deriveBoth(query);
    expect(certified).not.toBeNull();
    expect(byId(receipt, "predicate")).toMatchObject({ status: "formed", surface: "is" });
    expect(byId(receipt, "subject")).toMatchObject({
      status: "formed", surface: "my daily commute to work"
    });
    expect(byId(receipt, "answer_variable")).toMatchObject({
      status: "formed", surface: "How long"
    });
    expect(byId(receipt, "type_constraint")).toMatchObject({ status: "ineligible" });
    expect(byId(receipt, "time")).toMatchObject({ status: "ineligible" });
    expect(byId(receipt, "answer_operator")).toMatchObject({
      status: "formed", surface: "How long"
    });
  });

  it("records no-parse interrogatives as unavailable instead of a fake formed OSF", async () => {
    const { receipt, certified } = await deriveBoth(WHEN);
    expect(certified).toBeNull();
    expect(byId(receipt, "predicate")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "subject")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "answer_variable")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "type_constraint")).toMatchObject({ status: "ineligible" });
    expect(byId(receipt, "time")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "answer_operator")).toMatchObject({ status: "unavailable" });
    expect(receipt.facets.every((facet) => facet.status !== "formed")).toBe(true);
  });

  it("marks declarative no-parse forms ineligible rather than silently null", async () => {
    const { receipt, certified } = await deriveBoth("Golden is a color.");
    expect(certified).toBeNull();
    for (const facet of receipt.facets) {
      expect(facet.status).toBe("ineligible");
      expect(facet.producer_operator_id).toBeNull();
      expect(facet.surface).toBeNull();
    }
  });

  it("keeps certified deriveQueryFactFrameOsfObligation null when layout is missing", async () => {
    const { receipt, certified } = await deriveBoth("What did Alice buy at the market?");
    expect(certified).toBeNull();
    expect(byId(receipt, "predicate")).toMatchObject({
      status: "formed",
      producer_kind: "rule_based",
      surface: "buy"
    });
    expect(byId(receipt, "subject")).toMatchObject({ status: "formed", surface: "Alice" });
    expect(byId(receipt, "answer_variable")).toMatchObject({
      status: "formed", surface: "What"
    });
  });

  it("marks coordinated WH answer facets ambiguous", async () => {
    const { receipt, certified } = await deriveBoth("What and where did Alice travel?");
    expect(certified).toBeNull();
    expect(byId(receipt, "answer_variable").status).toBe("ambiguous");
    expect(byId(receipt, "answer_operator").status).toBe("ambiguous");
    expect(byId(receipt, "predicate")).toMatchObject({ status: "formed", surface: "travel" });
  });

  it("cannot set a model-fallback producer_operator_id to RULE_BASED", async () => {
    const { receipt, certified } = await deriveBoth(WHEN);
    expect(certified).toBeNull();
    const impersonated = applyQueryObligationFacetFallback({
      receipt,
      query_text: WHEN,
      producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
      fills: [{ facet_id: "time", surface: "When", source_span: [0, 4] }]
    });
    expect(byId(impersonated, "time")).toMatchObject({
      status: "rejected",
      producer_kind: "absent",
      producer_operator_id: null,
      reason: "model_fallback_rule_based_impersonation"
    });
  });

  it("rejects the query OSF graph compiler as a fallback producer", async () => {
    const { receipt } = await deriveBoth(WHEN);
    const rejected = applyQueryObligationFacetFallback({
      receipt,
      query_text: WHEN,
      producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
      fills: [{ facet_id: "time", surface: "When", source_span: [0, 4] }]
    });
    expect(byId(rejected, "time")).toMatchObject({
      status: "rejected",
      reason: "model_fallback_certified_producer",
      producer_operator_id: null
    });
  });

  it("lets a model fill an eligible missing facet without completing certification", async () => {
    const { receipt, certified } = await deriveBoth(WHEN);
    const filled = applyQueryObligationFacetFallback({
      receipt,
      query_text: WHEN,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [{ facet_id: "time", surface: "When", source_span: [0, 4] }]
    });
    expect(byId(filled, "time")).toMatchObject({
      status: "formed",
      producer_kind: "model_fallback",
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      surface: "When"
    });
    expect(byId(filled, "predicate")).toMatchObject({ status: "unavailable" });
    expect(certified).toBeNull();
    expect(QueryFactFrameOsfObligationSchema.safeParse(filled).success).toBe(false);
  });

  it("does not let fallback overwrite certified rule-based facets", async () => {
    const query = "What degree did I graduate with?";
    const { receipt, certified } = await deriveBoth(query);
    const filled = applyQueryObligationFacetFallback({
      receipt,
      query_text: query,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [{ facet_id: "predicate", surface: "earned", source_span: [18, 26] }]
    });
    expect(certified).not.toBeNull();
    expect(byId(filled, "predicate")).toMatchObject({
      status: "formed",
      producer_kind: "rule_based",
      surface: "graduate"
    });
  });

  it("leaves an ineligible fill as a no-op", async () => {
    const { receipt } = await deriveBoth(WHEN);
    const filled = applyQueryObligationFacetFallback({
      receipt,
      query_text: WHEN,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [{ facet_id: "type_constraint", surface: "meeting", source_span: [11, 18] }]
    });
    expect(byId(filled, "type_constraint")).toMatchObject({ status: "ineligible" });
  });

  it("fails closed when apply query_text does not match receipt.query_digest", async () => {
    const { receipt } = await deriveBoth(WHEN);
    const standIn = "When did I graduate?";
    expect(standIn.slice(0, 4)).toBe("When");
    expect(() => applyQueryObligationFacetFallback({
      receipt,
      query_text: standIn,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [{ facet_id: "time", surface: "When", source_span: [0, 4] }]
    })).toThrow(/query digest mismatch/);
    expect(byId(receipt, "time").status).toBe("unavailable");
  });

  it("rejects ungrounded fills and tampered receipt digests", async () => {
    const { receipt } = await deriveBoth(WHEN);
    const ungrounded = applyQueryObligationFacetFallback({
      receipt,
      query_text: WHEN,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [{ facet_id: "time", surface: "When", source_span: [1, 5] }]
    });
    expect(byId(ungrounded, "time")).toMatchObject({
      status: "rejected", reason: "ungrounded_fill"
    });
    expect(() => verifyQueryFactFrameOsfFacetReceipt({
      ...receipt,
      receipt_digest: receipt.query_digest
    })).toThrow(/digest mismatch/);
  });

  it("does not recertify after filling every unavailable hard slot", async () => {
    const { receipt, certified, capture } = await deriveBoth(WHEN);
    expect(certified).toBeNull();
    const filled = applyQueryObligationFacetFallback({
      receipt,
      query_text: WHEN,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [
        { facet_id: "predicate", surface: "is", source_span: [5, 7] },
        { facet_id: "subject", surface: "the meeting", source_span: [8, 19] },
        { facet_id: "answer_variable", surface: "When", source_span: [0, 4] }
      ]
    });
    expect(byId(filled, "predicate").status).toBe("formed");
    expect(byId(filled, "subject").status).toBe("formed");
    expect(byId(filled, "answer_variable").status).toBe("formed");
    expect(deriveQueryFactFrameOsfObligation({
      query_text: WHEN, fact_frame_capture: capture
    })).toBeNull();
    expect(QueryFactFrameOsfObligationSchema.safeParse(filled).success).toBe(false);
  });
});

async function deriveBoth(query: string) {
  const capture = await captureRecallQueryFactFrames({
    query_text: query,
    port: extractor
  });
  return {
    capture,
    certified: deriveQueryFactFrameOsfObligation({
      query_text: query, fact_frame_capture: capture
    }),
    receipt: deriveQueryFactFrameOsfFacetReceipt({
      query_text: query, fact_frame_capture: capture
    })
  };
}

function byId(
  receipt: ReturnType<typeof deriveQueryFactFrameOsfFacetReceipt>,
  id: "predicate" | "subject" | "answer_variable" | "type_constraint" |
    "time" | "answer_operator"
) {
  return receipt.facets.find((facet) => facet.facet_id === id)!;
}
