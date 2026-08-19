import { describe, expect, it } from "vitest";
import {
  materializeOpenSemanticFactorFormation
} from "../../../semantic/open-semantic-factor-formation.js";
import {
  materializeOpenSemanticFactorCompatibility,
  verifyOpenSemanticFactorCompatibilityReceipt
} from "../../../recall/field/open-semantic-factors/compatibility.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../recall/field/open-semantic-factors/composition.js";
import {
  argument,
  evidenceProposal,
  factor,
  personEvidence,
  proposal,
  queryProposal,
  semanticProposition,
  semanticQueryProposition
} from "./open-semantic-factor-tracer/fixture.js";

describe("open semantic factor tracer", () => {
  it("maps a query variable through shared proposition bindings", () => {
    const evidence = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Atlas for research.",
      proposal: proposal("I used Atlas for research.", evidenceProposal())
    });
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What do I use for research?",
      proposal: proposal("What do I use for research?", queryProposal())
    });

    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    });

    expect(receipt.status).toBe("compatible");
    expect(receipt.proposition_matches).toEqual([{
      query_proposition_id: "use-query",
      evidence_proposition_id: "use-event",
      predicate_alignment: {
        query_factor_id: "query-predicate",
        evidence_factor_id: "predicate",
        operator_id: "exact_semantic_identity_v1"
      },
      argument_mappings: [
        {
          binding_identity: "agent",
          evidence_binding_identity: "agent",
          binding_alignment_operator_id: "exact_binding_identity_v1",
          query_position: 0,
          evidence_position: 0,
          query_reference_kind: "factor",
          query_reference_id: "query-actor",
          evidence_factor_id: "actor",
          evidence_semantic_identity: "i",
          evidence_surface: "I",
          evidence_source_span: [0, 1],
          operator_id: "exact_semantic_identity_v1"
        },
        {
          binding_identity: "object",
          evidence_binding_identity: "object",
          binding_alignment_operator_id: "exact_binding_identity_v1",
          query_position: 1,
          evidence_position: 1,
          query_reference_kind: "variable",
          query_reference_id: "answer",
          evidence_factor_id: "object",
          evidence_semantic_identity: "atlas",
          evidence_surface: "Atlas",
          evidence_source_span: [7, 12],
          operator_id: "variable_binding_v1"
        },
        {
          binding_identity: "purpose",
          evidence_binding_identity: "purpose",
          binding_alignment_operator_id: "exact_binding_identity_v1",
          query_position: 2,
          evidence_position: 2,
          query_reference_kind: "factor",
          query_reference_id: "query-purpose",
          evidence_factor_id: "purpose",
          evidence_semantic_identity: "research",
          evidence_surface: "research",
          evidence_source_span: [17, 25],
          operator_id: "exact_semantic_identity_v1"
        }
      ]
    }]);
    expect(verifyOpenSemanticFactorCompatibilityReceipt({
      receipt,
      evidence_capture: evidence,
      query_capture: query
    })).toBe(receipt);
  });

  it("rejects predicate or positional binding mismatches", () => {
    const evidence = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Atlas for research.",
      proposal: proposal("I used Atlas for research.", evidenceProposal())
    });
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What do I prefer for research?",
      proposal: proposal("What do I prefer for research?", {
        ...queryProposal(),
        factors: [
          factor("query-actor", "I", 8, 9),
          factor("query-predicate", "prefer", 10, 16),
          factor("query-purpose", "research", 21, 29)
        ]
      })
    });

    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({ status: "incompatible", proposition_matches: [] });
  });

  it("rejects semantic argument reordering even when binding names match", () => {
    const evidence = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Atlas for research.",
      proposal: proposal("I used Atlas for research.", evidenceProposal())
    });
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What do I use for research?",
      proposal: proposal("What do I use for research?", {
        ...queryProposal(),
        propositions: [{
          proposition_id: "use-query",
          predicate_factor_id: "query-predicate",
          arguments: [
            argument(0, "variable", "answer", "object"),
            argument(1, "factor", "query-purpose", "purpose"),
            argument(2, "factor", "query-actor", "agent")
          ]
        }]
      })
    });

    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({ status: "incompatible" });
  });

  it("requires repeated query variables to bind consistently across propositions", () => {
    const evidenceText = "Alice likes tea. Bob owns mug.";
    const queryText = "Who likes tea and owns mug?";
    const evidence = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: evidenceText,
      proposal: proposal(evidenceText, {
        schema_version: 1,
        source_kind: "evidence",
        factors: [
          factor("alice", "Alice", 0, 5, "alice"),
          factor("likes", "likes", 6, 11, "like"),
          factor("tea", "tea", 12, 15, "tea"),
          factor("bob", "Bob", 17, 20, "bob"),
          factor("owns", "owns", 21, 25, "own"),
          factor("mug", "mug", 26, 29, "mug")
        ],
        variables: [],
        result_variable_ids: [],
        propositions: [
          semanticProposition("likes-tea", "likes", ["alice", "tea"]),
          semanticProposition("owns-mug", "owns", ["bob", "mug"])
        ]
      })
    });
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: queryText,
      proposal: proposal(queryText, {
        schema_version: 1,
        source_kind: "query",
        factors: [
          factor("query-likes", "likes", 4, 9, "like"),
          factor("query-tea", "tea", 10, 13, "tea"),
          factor("query-owns", "owns", 18, 22, "own"),
          factor("query-mug", "mug", 23, 26, "mug")
        ],
        variables: [{ variable_id: "person", surface: "Who" }],
        result_variable_ids: ["person"],
        propositions: [
          semanticQueryProposition("likes-tea", "query-likes", "query-tea"),
          semanticQueryProposition("owns-mug", "query-owns", "query-mug")
        ]
      })
    });

    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1,
      proposition_matches: [{ query_proposition_id: "owns-mug" }]
    });
  });

  it("joins compatible propositions across independently attributed evidence", () => {
    const queryText = "Who likes tea and owns mug?";
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: queryText,
      proposal: proposal(queryText, {
        schema_version: 1,
        source_kind: "query",
        factors: [
          factor("query-likes", "likes", 4, 9, "like"),
          factor("query-tea", "tea", 10, 13, "tea"),
          factor("query-owns", "owns", 18, 22, "own"),
          factor("query-mug", "mug", 23, 26, "mug")
        ],
        variables: [{ variable_id: "person", surface: "Who" }],
        result_variable_ids: ["person"],
        propositions: [
          semanticQueryProposition("likes-tea", "query-likes", "query-tea"),
          semanticQueryProposition("owns-mug", "query-owns", "query-mug")
        ]
      })
    });
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        likes: personEvidence("Alice likes tea.", "likes", "tea", "like"),
        owns: personEvidence("Alice owns mug.", "owns", "mug", "own")
      }
    });
    expect(trace.entries.map((entry) =>
      entry.receipt.proposition_match_candidates.length)).toEqual([1, 1]);
    expect(trace.entries.flatMap((entry) =>
      entry.receipt.proposition_match_candidates.map((match) =>
        match.query_proposition_id))).toEqual(["likes-tea", "owns-mug"]);

    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    })).toMatchObject({
      status: "composed",
      solution_count: 1,
      variable_collections: [{
        variable_id: "person",
        distinct_value_count: 1,
        values: [{ semantic_identity: "alice", evidence_ids: ["likes", "owns"] }]
      }]
    });
  });

  it("collects distinct variable bindings across independent evidence", () => {
    const atlas = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Atlas for research.",
      proposal: proposal("I used Atlas for research.", evidenceProposal())
    });
    const novaGraph = evidenceProposal();
    const nova = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Nova for research.",
      proposal: proposal("I used Nova for research.", {
        ...novaGraph,
        factors: novaGraph.factors.map((item) => {
          if (item.factor_id === "object") {
            return factor("object", "Nova", 7, 11, "nova");
          }
          return item.factor_id === "purpose"
            ? factor("purpose", "research", 16, 24, "research")
            : item;
        })
      })
    });
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What do I use for research?",
      proposal: proposal("What do I use for research?", queryProposal())
    });
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { atlas, nova }
    });
    expect(trace.entries.map((entry) =>
      entry.receipt.proposition_match_candidates.length)).toEqual([1, 1]);

    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    })).toMatchObject({
      status: "composed",
      binding_observation_count: 2,
      variable_collections: [{
        variable_id: "answer",
        distinct_value_count: 2,
        values: [
          { semantic_identity: "atlas", evidence_ids: ["atlas"] },
          { semantic_identity: "nova", evidence_ids: ["nova"] }
        ]
      }]
    });
  });
});
