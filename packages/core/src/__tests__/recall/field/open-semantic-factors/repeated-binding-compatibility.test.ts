import { describe, expect, it } from "vitest";
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
});

function parallelEvidence() {
  return formation("evidence", "I use Atlas and Gaia.", {
    schema_version: 1,
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

function parallelQuery(bindingIdentity: string) {
  return formation("query", "What do I use?", {
    schema_version: 1,
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
  });
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
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
