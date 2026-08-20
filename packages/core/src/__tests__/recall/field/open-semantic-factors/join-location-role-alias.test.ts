import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";

const QUERY_TEXT = "Where did I redeem a $5 coupon on coffee creamer?";
const REDEEM_TEXT =
  "I actually redeemed a $5 coupon on coffee creamer last Sunday.";
const COUPON_TARGET_TEXT =
  "I used a $5 coupon on coffee creamer at Target.";
const TAIL = "a $5 coupon on coffee creamer";

describe("join location structural role aliases", () => {
  it.each(["place", "地点", "位置"] as const)(
    "joins a protocol location-role alias %s",
    (role) => {
      const query = whereRedeemQuery();
      const formations = {
        redeem: redeemSundayEvidence(),
        partner: couponAtTargetEvidence(role)
      };
      const composition = materializeOpenSemanticFactorComposition({
        trace: materializeOpenSemanticFactorCompatibilityTrace({
          query_capture: query,
          evidence_formations: formations
        }),
        query_capture: query,
        evidence_formations: formations
      });
      expect(composition.status).toBe("composed");
      expect(composition.solutions[0]?.result_bindings[0]).toMatchObject({
        variable_id: "answer",
        semantic_identity: "target"
      });
    }
  );

  it("does not join a place surface used as an open role name", () => {
    const query = whereRedeemQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      partner: couponAtTargetEvidence("target")
    };
    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: formations
      }),
      query_capture: query,
      evidence_formations: formations
    });
    expect(composition).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
  });
});

function whereRedeemQuery() {
  return formation("query", QUERY_TEXT, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeem", "redeem"),
      factor("tail", TAIL, "coupon")
    ],
    variables: [{ variable_id: "answer", surface: "Where" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "redeem-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function redeemSundayEvidence() {
  return formation("evidence", REDEEM_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeemed", "redeem"),
      factor("tail", TAIL, "coupon"),
      factor("when", "last Sunday", "last sunday")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "redeem-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "time", "factor", "when")
      ]
    }]
  });
}

function couponAtTargetEvidence(role: string) {
  return formation("evidence", COUPON_TARGET_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "used", "use"),
      factor("tail", TAIL, "coupon"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, role, "factor", "location")
      ]
    }]
  });
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown,
  producerOperatorId = "open-factor-test-producer-v1"
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: producerOperatorId,
      source_text: sourceText,
      graph
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
