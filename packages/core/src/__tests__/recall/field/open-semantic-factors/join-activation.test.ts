import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import {
  materializeOpenSemanticFactorActivation,
  resolveJoinActivation
} from "../../../../recall/field/open-semantic-factors/activation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";

const QUERY_TEXT = "Where did I redeem a $5 coupon on coffee creamer?";
const TAIL = "a $5 coupon on coffee creamer";

describe("join activation inherits constraint compatibility", () => {
  it("treats explicit zero as a value and missing provenance as fail-closed", () => {
    expect(resolveJoinActivation(0, 1, true)).toBe(0);
    expect(resolveJoinActivation(0.5, 1, true)).toBe(0.5);
    expect(resolveJoinActivation(undefined, 0.5, false)).toBe(0.5);
    expect(resolveJoinActivation(0, 0.5, false)).toBe(0.5);
    expect(resolveJoinActivation(undefined, undefined, false)).toBeNull();
    expect(resolveJoinActivation(undefined, 1, true)).toBeNull();
  });

  it("inherits a graded constraint fraction onto the join partner", () => {
    const query = twoPropositionWhereQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      partner: couponAtTargetEvidence()
    };
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: formations
    });
    expect(trace.entries.find((entry) => entry.evidence_id === "redeem")?.receipt)
      .toMatchObject({
        query_proposition_count: 2,
        matched_query_proposition_count: 1
      });
    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query,
      evidence_formations: formations
    });
    expect(composition.status).toBe("composed");
    const activation = materializeOpenSemanticFactorActivation({
      composition, trace, query_capture: query, evidence_formations: formations
    });
    expect(activation.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_id: "redeem", activation: 0.5, state: "observed" }),
      expect.objectContaining({
        evidence_id: "partner", activation: 0.5, state: "reconstructed"
      })
    ]));
  });
});

function twoPropositionWhereQuery() {
  return formation("query", QUERY_TEXT, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeem", "redeem"),
      factor("tail", TAIL, "coupon"),
      factor("aux", "did", "do")
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
    }, {
      proposition_id: "extra-query",
      predicate_factor_id: "aux",
      arguments: [argument(0, "object", "factor", "tail")]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function redeemSundayEvidence() {
  return formation("evidence", `I actually redeemed ${TAIL} last Sunday.`, {
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

function couponAtTargetEvidence() {
  return formation("evidence", `I used ${TAIL} at Target.`, {
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
        argument(2, "location", "factor", "location")
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
