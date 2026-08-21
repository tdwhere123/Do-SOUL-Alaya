import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../recall/field/open-semantic-factors/activation.js";

const QUERY_TEXT = "Where did I redeem a $5 coupon on coffee creamer?";
const REDEEM_TEXT =
  "I actually redeemed a $5 coupon on coffee creamer last Sunday.";
const TARGET_TEXT = "I shopped at Target.";
const COUPON_TARGET_TEXT =
  "I used a $5 coupon on coffee creamer at Target.";
// Capability fixture only: live coupon evidence has no formed location partner.
const PHRASE_DIFF_TEXT =
  "I used the $5 coupon on coffee creamer at Target.";
const GOLD_TEXT = "I redeemed a $5 coupon on coffee creamer at Target.";

describe("cross-turn join identity and reconstruction source", () => {
  it("does not bind a Where result to a temporal evidence argument", () => {
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: redeemSundayEvidence(),
      query_capture: whereRedeemQuery()
    });
    const sundayBound = [...receipt.proposition_match_candidates, ...receipt.proposition_matches]
      .some((match) => match.argument_mappings.some((mapping) =>
        mapping.query_reference_kind === "variable" &&
        /sunday/iu.test(mapping.evidence_surface)));
    const locationBound = receipt.proposition_match_candidates.some((match) =>
      match.argument_mappings.some((mapping) => mapping.query_reference_kind === "variable"));

    expect(sundayBound).toBe(false);
    expect(locationBound).toBe(false);
  });

  it("joins a location from a second formed graph only via a non-generic source-bound identity", () => {
    const query = whereRedeemQuery();
    const redeem = redeemSundayEvidence();
    const partner = couponAtTargetEvidence();
    const formations = { redeem, partner };
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: formations
    });
    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query,
      evidence_formations: formations
    });
    expect(composition.status).toBe("composed");
    expect(composition.solutions[0]?.result_bindings[0]).toMatchObject({
      variable_id: "answer",
      semantic_identity: "target"
    });
    expect(composition.solutions[0]?.evidence_ids).toEqual(
      expect.arrayContaining(["partner", "redeem"])
    );
    expect(materializeOpenSemanticFactorActivation({
      composition, trace, query_capture: query, evidence_formations: formations
    })).toMatchObject({
      status: "composed",
      entries: expect.arrayContaining([
        expect.objectContaining({ evidence_id: "redeem", state: "observed" }),
        expect.objectContaining({ evidence_id: "partner", state: "reconstructed" })
      ])
    });
  });

  it("does not join when the only shared identity is a generic speaker", () => {
    const query = whereRedeemQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      shop: shopAtTargetEvidence()
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

  it("does not reconstruct a rejected or absent source graph from gold", () => {
    const query = whereRedeemQuery();
    const gold = goldSameTurnEvidence();
    const rejected = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: GOLD_TEXT,
      proposal: { schema_version: 1, producer_operator_id: "x", source_text: "other" }
    });
    const unavailable = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: GOLD_TEXT
    });
    expect(rejected.status).toBe("rejected");
    expect(unavailable.status).toBe("unavailable");

    const observed = {
      redeem: redeemSundayEvidence(),
      rejected,
      unavailable
    };
    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: observed,
        unavailable_evidence_ids: ["absent-gold"]
      }),
      query_capture: query,
      evidence_formations: { ...observed, "gold-unobserved": gold }
    });
    expect(composition.solutions.flatMap((solution) => solution.evidence_ids))
      .not.toEqual(expect.arrayContaining(["rejected", "unavailable", "absent-gold", "gold-unobserved"]));
    expect(composition.solution_count).toBe(0);
    // Rejected remainder seals the search; gold must not convert that into a match.
    expect(composition.status).toBe("rejected");
  });

  it("does not join when reconstruction source formations are omitted", () => {
    const query = whereRedeemQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      partner: couponAtTargetEvidence()
    };
    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: formations
      }),
      query_capture: query
    });
    expect(composition).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
  });

  it("does not take a place from a second coupon event", () => {
    const query = whereRedeemQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      partner: secondCouponAtWalmart()
    };
    expect(materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: formations
      }),
      query_capture: query,
      evidence_formations: formations
    })).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
  });

  it("does not join across a determiner-only coupon phrase difference", () => {
    const query = whereRedeemQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      partner: couponAtTargetEvidence("the $5 coupon on coffee creamer", PHRASE_DIFF_TEXT)
    };
    expect(materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: formations
      }),
      query_capture: query,
      evidence_formations: formations
    })).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
  });

  it("does not join a place on a different proposition in the same graph", () => {
    const query = whereRedeemQuery();
    const formations = {
      redeem: redeemSundayEvidence(),
      partner: splitPropositionPartner()
    };
    expect(materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: formations
      }),
      query_capture: query,
      evidence_formations: formations
    })).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
  });

  it("fails closed at the evidence boundary when session authority is absent", () => {
    const query = whereRedeemQuery();
    const redeem = redeemSundayEvidence();
    const partner = couponAtTargetEvidence();
    expect(redeem.graph).not.toHaveProperty("session_id");
    expect(partner.graph).not.toHaveProperty("session_id");
    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: { redeem }
      }),
      query_capture: query,
      evidence_formations: { redeem, partner }
    });
    expect(composition).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
    expect(composition.solutions.flatMap((solution) => solution.evidence_ids))
      .not.toContain("partner");
  });
});

function whereRedeemQuery() {
  const tail = "a $5 coupon on coffee creamer";
  return formation("query", QUERY_TEXT, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeem", "redeem"),
      factor("tail", tail, "coupon")
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
  const tail = "a $5 coupon on coffee creamer";
  return formation("evidence", REDEEM_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeemed", "redeem"),
      factor("tail", tail, "coupon"),
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

function shopAtTargetEvidence() {
  return formation("evidence", TARGET_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "shopped", "shop"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "shop-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "location", "factor", "location")
      ]
    }]
  });
}

function couponAtTargetEvidence(
  tail = "a $5 coupon on coffee creamer",
  sourceText = COUPON_TARGET_TEXT
) {
  return formation("evidence", sourceText, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "used", "use"),
      factor("tail", tail, "coupon"),
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

function secondCouponAtWalmart() {
  const coffee = "a $5 coupon on coffee creamer";
  const cereal = "a $10 coupon on cereal";
  return formation("evidence", `I used ${coffee}. I used ${cereal} at Walmart.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "used", "use"),
      factor("coffee", coffee, "coupon"),
      factor("cereal", cereal, "coupon"),
      factor("location", "Walmart", "walmart")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "coffee-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "coffee")
      ]
    }, {
      proposition_id: "cereal-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "cereal"),
        argument(2, "location", "factor", "location")
      ]
    }]
  });
}

function splitPropositionPartner() {
  const tail = "a $5 coupon on coffee creamer";
  return formation("evidence", `I used ${tail}. I shopped at Target.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("used", "used", "use"),
      factor("shopped", "shopped", "shop"),
      factor("tail", tail, "coupon"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "used",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail")
      ]
    }, {
      proposition_id: "shop-event",
      predicate_factor_id: "shopped",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "location", "factor", "location")
      ]
    }]
  });
}

function goldSameTurnEvidence() {
  const tail = "a $5 coupon on coffee creamer";
  return formation("evidence", GOLD_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeemed", "redeem"),
      factor("tail", tail, "coupon"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "gold-event",
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
