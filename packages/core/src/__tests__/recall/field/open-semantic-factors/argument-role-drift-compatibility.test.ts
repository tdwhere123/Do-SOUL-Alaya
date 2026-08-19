import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { verifyOpenSemanticFactorCompatibilityReceipt } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";

describe("open semantic argument role drift compatibility", () => {
  it("aligns compatible proposition structure when relation-local role labels drift", () => {
    const receipt = compatibility(
      evidenceGraph("degree"),
      queryGraph("degree")
    );

    expect(receipt).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(receipt.proposition_matches[0]?.argument_mappings).toMatchObject([
      {
        query_position: 0,
        evidence_position: 0,
        evidence_factor_id: "user",
        evidence_binding_identity: "user",
        binding_alignment_operator_id: "position_anchored_binding_group_v1"
      },
      {
        query_position: 1,
        evidence_position: 1,
        evidence_factor_id: "degree",
        evidence_binding_identity: "degree",
        binding_alignment_operator_id: "position_anchored_binding_group_v1"
      }
    ]);
  });

  it("keeps position authoritative when another evidence position reuses the query role", () => {
    const evidence = evidenceGraph("degree");
    evidence.propositions[0]!.arguments[1]!.binding_identity = "agent";
    const receipt = compatibility(evidence, queryGraph("degree"));

    expect(receipt).toMatchObject({ status: "compatible" });
    expect(receipt.proposition_matches[0]?.argument_mappings).toMatchObject([
      {
        query_position: 0,
        evidence_position: 0,
        evidence_factor_id: "user",
        binding_alignment_operator_id: "position_anchored_binding_group_v1"
      },
      {
        query_position: 1,
        evidence_position: 1,
        evidence_factor_id: "degree",
        binding_alignment_operator_id: "position_anchored_binding_group_v1"
      }
    ]);
  });

  it("rejects drifted roles when a constrained factor is incompatible", () => {
    expect(compatibility(evidenceGraph("bachelor-degree"), queryGraph("master-degree")))
      .toMatchObject({ status: "incompatible", proposition_match_candidates: [] });
  });

  it("rejects drifted roles when evidence lacks a constrained argument position", () => {
    const query = queryGraph("degree");
    query.factors.push(factor("year", "2020", "2020"));
    query.propositions[0]!.arguments.push(argument(2, "time", "factor", "year"));

    expect(compatibility(evidenceGraph("degree"), query))
      .toMatchObject({ status: "incompatible", proposition_match_candidates: [] });
  });

  it("rejects one repeated variable binding to incompatible evidence factors", () => {
    const query = queryGraph("degree");
    query.factors = [query.factors[0]!];
    query.propositions[0]!.arguments[1] = argument(1, "obtained", "variable", "answer");

    expect(compatibility(evidenceGraph("degree"), query))
      .toMatchObject({ status: "incompatible", proposition_match_candidates: [] });
  });

  it("rejects an internally consistent receipt from the prior alignment operator", () => {
    const evidenceCapture = formation(
      "evidence", "The user graduated with a bachelor degree and a degree.",
      evidenceGraph("degree")
    );
    const queryCapture = formation(
      "query", "Who graduated with a master degree and a degree in 2020?",
      queryGraph("degree")
    );
    const legacyReceipt = structuredClone(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidenceCapture,
      query_capture: queryCapture
    }));
    Reflect.set(legacyReceipt, "operator_id", "open_semantic_factor_compatibility_v2");
    for (const match of [
      ...legacyReceipt.proposition_match_candidates,
      ...legacyReceipt.proposition_matches
    ]) {
      for (const mapping of match.argument_mappings) {
        if (mapping.binding_alignment_operator_id ===
            "position_anchored_binding_group_v1") {
          Reflect.set(mapping, "binding_alignment_operator_id", "semantic_position_v1");
        }
      }
    }
    const { receipt_digest: _digest, ...legacyBody } = legacyReceipt;
    Reflect.set(legacyReceipt, "receipt_digest", digestRecallFieldIdentity(legacyBody));

    expect(() => verifyOpenSemanticFactorCompatibilityReceipt({
      receipt: legacyReceipt,
      evidence_capture: evidenceCapture,
      query_capture: queryCapture
    })).toThrow(/receipt digest mismatch/u);
  });
});

function compatibility(evidenceGraphValue: unknown, queryGraphValue: unknown) {
  return materializeOpenSemanticFactorCompatibility({
    evidence_capture: formation(
      "evidence",
      "The user graduated with a bachelor degree and a degree.",
      evidenceGraphValue
    ),
    query_capture: formation(
      "query",
      "Who graduated with a master degree and a degree in 2020?",
      queryGraphValue
    )
  });
}

function evidenceGraph(degreeIdentity: string) {
  return {
    schema_version: 1 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("predicate", "graduated", "graduate"),
      factor("user", "user", "user"),
      factor("degree", degreeSurface(degreeIdentity), degreeIdentity)
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "graduation",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "user", "factor", "user"),
        argument(1, "degree", "factor", "degree")
      ]
    }]
  };
}

function queryGraph(degreeIdentity: string) {
  return {
    schema_version: 1 as const,
    source_kind: "query" as const,
    factors: [
      factor("predicate", "graduated", "graduate"),
      factor("degree", degreeSurface(degreeIdentity), degreeIdentity)
    ],
    variables: [{ variable_id: "answer", surface: "Who" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "graduation-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "variable", "answer"),
        argument(1, "obtained", "factor", "degree")
      ]
    }]
  };
}

function formation(sourceKind: "evidence" | "query", sourceText: string, graph: unknown) {
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
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function degreeSurface(identity: string): string {
  return identity.replace("-", " ");
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
