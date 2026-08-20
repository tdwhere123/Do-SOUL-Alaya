import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";

const QUERY_TEXT = "How long is my daily commute to work?";

describe("duration structural role aliases", () => {
  it.each(["时长", "持续时间"] as const)(
    "binds a protocol duration-role alias %s",
    (role) => {
      expect(materializeOpenSemanticFactorCompatibility({
        evidence_capture: durationEvidence(role),
        query_capture: copularDurationQuery()
      })).toMatchObject({
        status: "compatible",
        matched_query_proposition_count: 1
      });
    }
  );

  it("still rejects a duration-shaped briefing object", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: briefingObject(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });
});

function copularDurationQuery() {
  return formation("query", QUERY_TEXT, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("predicate", "is", "be"),
      factor("subject", "my daily commute to work", "my daily commute to work")
    ],
    variables: [{ variable_id: "answer", surface: "How long" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "commute-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function durationEvidence(role: string) {
  return formation("evidence", "My daily commute to work takes 45 minutes.", {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("predicate", "takes", "duration"),
      factor("subject", "daily commute to work", "daily commute to work"),
      factor("value", "45 minutes", "45 minutes")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "duration-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, role, "factor", "value")
      ]
    }]
  });
}

function briefingObject() {
  return formation(
    "evidence",
    "I scheduled a 45-minute briefing about my daily commute to work.",
    {
      schema_version: 2,
      source_kind: "evidence",
      factors: [
        factor("predicate", "scheduled", "schedule"),
        factor("object", "45-minute", "45 minutes"),
        factor("theme", "daily commute to work", "daily commute to work")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "object", "factor", "object"),
          argument(1, "theme", "factor", "theme")
        ]
      }]
    }
  );
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
