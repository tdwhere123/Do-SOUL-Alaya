import { describe, expect, it } from "vitest";
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

describe("open semantic graded compatibility", () => {
  it("matches a proposition when normalized surfaces overlap even if identities differ", () => {
    const evidence = formation("evidence", "I bought three books.", {
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("actor", "I", "i"),
        factor("predicate", "bought", "buy"),
        factor("object", "books", "book")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "buy-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "agent", "factor", "actor"),
          argument(1, "object", "factor", "object")
        ]
      }]
    });
    const query = formation("query", "Which books have I bought?", {
      schema_version: 1,
      source_kind: "query",
      factors: [
        factor("query-actor", "I", "i"),
        factor("query-predicate", "bought", "purchase"),
        factor("query-object", "books", "book")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "buy-query",
        predicate_factor_id: "query-predicate",
        arguments: [
          argument(0, "agent", "factor", "query-actor"),
          argument(1, "object", "factor", "query-object")
        ]
      }]
    });

    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({
      status: "compatible",
      query_proposition_count: 1,
      matched_query_proposition_count: 1
    });
  });

  it("scores partial proposition overlap instead of requiring every query proposition", () => {
    const { evidence, query } = conflictingPersonGraphs();
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    });

    expect(receipt).toMatchObject({
      status: "compatible",
      query_proposition_count: 2,
      matched_query_proposition_count: 1
    });

    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { people: evidence }
    });
    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    });
    expect(composition.status).toBe("composed");
    expect(composition.solution_count).toBeGreaterThan(0);

    const activation = materializeOpenSemanticFactorActivation({
      composition,
      trace,
      query_capture: query
    });
    expect(activation.status).toBe("composed");
    expect(activation.entries[0]).toMatchObject({
      evidence_id: "people",
      state: "observed",
      activation: 0.5
    });
  });

  it("does not zero a proposition when a query answer variable has no evidence counterpart", () => {
    const evidence = formation("evidence", "I used Atlas for research.", {
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("actor", "I", "i"),
        factor("predicate", "used", "use"),
        factor("object", "Atlas", "atlas"),
        factor("purpose", "research", "research")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "use-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "agent", "factor", "actor"),
          argument(1, "object", "factor", "object"),
          argument(2, "purpose", "factor", "purpose")
        ]
      }]
    });
    const query = formation("query", "How long did I use Atlas for research?", {
      schema_version: 1,
      source_kind: "query",
      factors: [
        factor("query-actor", "I", "i"),
        factor("query-predicate", "use", "use"),
        factor("query-object", "Atlas", "atlas"),
        factor("query-purpose", "research", "research")
      ],
      variables: [{ variable_id: "answer", surface: "How" }],
      result_variable_ids: ["answer"],
      propositions: [{
        proposition_id: "use-query",
        predicate_factor_id: "query-predicate",
        arguments: [
          argument(0, "agent", "factor", "query-actor"),
          argument(1, "object", "factor", "query-object"),
          argument(2, "purpose", "factor", "query-purpose"),
          argument(3, "duration", "variable", "answer")
        ]
      }]
    });

    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
  });

  it("keeps missing query or evidence factors as an inactive seal, not a zero score", () => {
    const evidence = formation("evidence", "I used Atlas for research.", {
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("actor", "I", "i"),
        factor("predicate", "used", "use")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "use-event",
        predicate_factor_id: "predicate",
        arguments: [argument(0, "agent", "factor", "actor")]
      }]
    });
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What do I use?"
    });

    expect(query.status).toBe("unavailable");
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({
      status: "unavailable",
      query_proposition_count: 0,
      matched_query_proposition_count: 0,
      proposition_matches: []
    });
  });
});

function conflictingPersonGraphs() {
  const evidenceText = "Alice likes tea. Bob owns mug.";
  const queryText = "Who likes tea and owns mug?";
  return {
    evidence: formation("evidence", evidenceText, {
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("alice", "Alice", "alice"),
        factor("likes", "likes", "like"),
        factor("tea", "tea", "tea"),
        factor("bob", "Bob", "bob"),
        factor("owns", "owns", "own"),
        factor("mug", "mug", "mug")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [
        semanticProposition("likes-tea", "likes", ["alice", "tea"]),
        semanticProposition("owns-mug", "owns", ["bob", "mug"])
      ]
    }),
    query: formation("query", queryText, {
      schema_version: 1,
      source_kind: "query",
      factors: [
        factor("query-likes", "likes", "like"),
        factor("query-tea", "tea", "tea"),
        factor("query-owns", "owns", "own"),
        factor("query-mug", "mug", "mug")
      ],
      variables: [{ variable_id: "person", surface: "Who" }],
      result_variable_ids: ["person"],
      propositions: [
        semanticQueryProposition("likes-tea", "query-likes", "query-tea"),
        semanticQueryProposition("owns-mug", "query-owns", "query-mug")
      ]
    })
  };
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

function semanticProposition(
  propositionId: string,
  predicateFactorId: string,
  argumentIds: readonly string[]
) {
  return {
    proposition_id: propositionId,
    predicate_factor_id: predicateFactorId,
    arguments: argumentIds.map((referenceId, position) =>
      argument(position, position === 0 ? "agent" : `argument-${position}`, "factor", referenceId))
  };
}

function semanticQueryProposition(
  propositionId: string,
  predicateFactorId: string,
  valueFactorId: string
) {
  return {
    proposition_id: propositionId,
    predicate_factor_id: predicateFactorId,
    arguments: [
      argument(0, "agent", "variable", "person"),
      argument(1, "argument-1", "factor", valueFactorId)
    ]
  };
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
