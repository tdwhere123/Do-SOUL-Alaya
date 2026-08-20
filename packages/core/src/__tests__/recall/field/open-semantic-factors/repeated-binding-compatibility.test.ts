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

describe("open semantic repeated binding compatibility", () => {
  it("enumerates parallel evidence values without inventing numbered roles", () => {
    const evidence = parallelEvidence();
    const query = parallelQuery("object");

    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    });
    expect(receipt.status).toBe("compatible");
    expect(receipt.proposition_match_candidates.map((candidate) =>
      candidate.argument_mappings[1]?.evidence_factor_id)).toEqual(["atlas", "gaia"]);
    expect(receipt.proposition_match_candidates.map((candidate) =>
      candidate.argument_mappings[1]?.binding_alignment_operator_id))
      .toEqual([
        "exact_binding_identity_v1",
        "position_anchored_binding_group_v1"
      ]);

    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { combined: evidence }
    });
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    })).toMatchObject({
      status: "composed",
      solution_count: 2,
      variable_collections: [{
        variable_id: "answer",
        distinct_value_count: 2,
        values: [
          { semantic_identity: "atlas", evidence_ids: ["combined"] },
          { semantic_identity: "gaia", evidence_ids: ["combined"] }
        ]
      }]
    });
  });

  it("expands the position-anchored evidence group when query role labels drift", () => {
    const evidence = parallelEvidence();
    const query = parallelQuery("obtained");
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    });

    expect(receipt.proposition_match_candidates.map((candidate) =>
      candidate.argument_mappings[1]?.evidence_factor_id)).toEqual(["atlas", "gaia"]);
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { combined: evidence }
    });
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    })).toMatchObject({
      status: "composed",
      solution_count: 2,
      variable_collections: [{
        variable_id: "answer",
        distinct_value_count: 2
      }]
    });
  });

  it("requires exact arity for a current certified query producer", () => {
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: parallelEvidence(),
      query_capture: parallelQuery("obtained", QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID)
    });
    expect(receipt).toMatchObject({
      status: "incompatible",
      proposition_match_candidates: []
    });
  });

  it("requires exact surface at a certified constraint position", () => {
    const tail = "a $5 coupon on coffee creamer";
    const query = constrainedQuery(tail);
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: constrainedEvidence(tail),
      query_capture: query
    }).status).toBe("compatible");

    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: constrainedEvidence("a $5 coupon on tea"),
      query_capture: query
    });

    expect(receipt).toMatchObject({
      status: "incompatible",
      proposition_match_candidates: []
    });
  });
});

function constrainedEvidence(tailSurface: string) {
  return formation("evidence", `I redeemed ${tailSurface} at Target.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeemed", "redeem"),
      factor("tail", tailSurface, "coupon"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "redeem-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "factor", "location")
      ]
    }]
  });
}

function constrainedQuery(tailSurface: string) {
  return formation("query", `Where did I redeem ${tailSurface}?`, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeem", "redeem"),
      factor("tail", tailSurface, "coupon")
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

function parallelEvidence() {
  return formation("evidence", "I use Atlas and Gaia.", {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "use", "use"),
      factor("atlas", "Atlas", "atlas"),
      factor("gaia", "Gaia", "gaia")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "factor", "actor"),
        argument(1, "object", "factor", "atlas"),
        argument(2, "object", "factor", "gaia")
      ]
    }]
  });
}

function parallelQuery(bindingIdentity: string, producerOperatorId?: string) {
  return formation("query", "What do I use?", {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("query-actor", "I", "i"),
      factor("query-predicate", "use", "use")
    ],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "use-query",
      predicate_factor_id: "query-predicate",
      arguments: [
        argument(0, "agent", "factor", "query-actor"),
        argument(1, bindingIdentity, "variable", "answer")
      ]
    }]
  }, producerOperatorId);
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
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
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
