import { describe, expect, it } from "vitest";
import {
  MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
  QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS,
  QueryFactFrameOsfFacetReceiptSchema,
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
  deriveQueryFactFrameOsfFacetReceipt
} from "../../../../recall/field/open-semantic-factors/query-obligation-facets.js";

const extractor = new RuleBasedQueryFactFrameExtractor();

describe("query fact-frame OSF facet obligation receipt", () => {
  it("forms do-support hard slots and answer-shape facets without weakening certification", async () => {
    const query = "What degree did I graduate with?";
    const { receipt, certified } = await deriveBoth(query);
    expect(certified).not.toBeNull();
    expect(receipt.certified_obligation_digest).toBe(certified!.obligation_digest);
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
    const query = "When is the meeting?";
    const { receipt, certified } = await deriveBoth(query);
    expect(certified).toBeNull();
    expect(receipt.certified_obligation_digest).toBeNull();
    expect(byId(receipt, "predicate")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "subject")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "answer_variable")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "type_constraint")).toMatchObject({ status: "ineligible" });
    expect(byId(receipt, "time")).toMatchObject({ status: "unavailable" });
    expect(byId(receipt, "answer_operator")).toMatchObject({ status: "unavailable" });
    expect(receipt.facets.every((facet) => facet.status !== "formed")).toBe(true);
  });

  it("marks declarative no-parse forms ineligible rather than silently null", async () => {
    const query = "Golden is a color.";
    const { receipt, certified } = await deriveBoth(query);
    expect(certified).toBeNull();
    expect(receipt.certified_obligation_digest).toBeNull();
    for (const facet of receipt.facets) {
      expect(facet.status).toBe("ineligible");
      expect(facet.producer_operator_id).toBeNull();
      expect(facet.surface).toBeNull();
    }
  });

  it("keeps certified deriveQueryFactFrameOsfObligation null when layout is missing", async () => {
    const query = "What did Alice buy at the market?";
    const { receipt, certified } = await deriveBoth(query);
    expect(certified).toBeNull();
    expect(receipt.certified_obligation_digest).toBeNull();
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
    const { receipt, certified } = await deriveBoth("When is the meeting?");
    expect(certified).toBeNull();
    const impersonated = applyQueryObligationFacetFallback({
      receipt,
      producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
      fills: [{ facet_id: "time", surface: "When", source_span: [0, 4] }]
    });
    expect(byId(impersonated, "time")).toMatchObject({
      status: "rejected",
      producer_kind: "absent",
      producer_operator_id: null,
      reason: "model_fallback_rule_based_impersonation"
    });
    expect(impersonated.certified_obligation_digest).toBeNull();
    const forged = {
      ...receipt,
      facets: receipt.facets.map((facet) => facet.facet_id === "time"
        ? {
          ...facet,
          status: "formed" as const,
          producer_kind: "model_fallback" as const,
          producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
          surface: "When",
          source_span: [0, 4] as [number, number],
          reason: null
        }
        : facet)
    };
    expect(QueryFactFrameOsfFacetReceiptSchema.safeParse(forged).success).toBe(false);
  });

  it("lets a model fill an eligible missing facet without completing certification", async () => {
    const query = "When is the meeting?";
    const { receipt } = await deriveBoth(query);
    const filled = applyQueryObligationFacetFallback({
      receipt,
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
    expect(filled.certified_obligation_digest).toBeNull();
    expect(filled.facets.every((facet) =>
      facet.producer_kind !== "rule_based" ||
      facet.producer_operator_id === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
    )).toBe(true);
  });

  it("does not let fallback overwrite certified rule-based facets", async () => {
    const { receipt, certified } = await deriveBoth("What degree did I graduate with?");
    const filled = applyQueryObligationFacetFallback({
      receipt,
      producer_operator_id: MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
      fills: [{ facet_id: "predicate", surface: "earned", source_span: [18, 26] }]
    });
    expect(byId(filled, "predicate")).toMatchObject({
      status: "formed",
      producer_kind: "rule_based",
      surface: "graduate"
    });
    expect(filled.certified_obligation_digest).toBe(certified!.obligation_digest);
  });

  it("stamps constraint classes for every facet id", async () => {
    const { receipt } = await deriveBoth("How long is my daily commute to work?");
    for (const facet of receipt.facets) {
      expect(facet.constraint_class).toBe(
        QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[facet.facet_id]
      );
    }
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
  id: keyof typeof QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS
) {
  return receipt.facets.find((facet) => facet.facet_id === id)!;
}
