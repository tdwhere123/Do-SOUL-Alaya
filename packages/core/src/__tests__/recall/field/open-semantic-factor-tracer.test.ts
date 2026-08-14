import { describe, expect, it } from "vitest";
import {
  materializeOpenSemanticFactorFormation
} from "../../../semantic/open-semantic-factor-formation.js";
import {
  materializeOpenSemanticFactorCompatibility,
  verifyOpenSemanticFactorCompatibilityReceipt
} from "../../../recall/field/open-semantic-factors/compatibility.js";
import { captureRecallQueryOpenSemanticFactors } from
  "../../../recall/field/open-semantic-factors/query-capture.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../recall/field/open-semantic-factors/composition.js";

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

  it("aligns open argument bindings independently of serialization order", () => {
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
    })).toMatchObject({ status: "compatible" });
  });

  it("keeps unavailable formation explicit instead of guessing structure", () => {
    const unavailable = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "What did I buy?",
    });

    expect(unavailable).toMatchObject({ status: "unavailable", graph: null });
  });

  it("captures query structure through the shared open compiler port", async () => {
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: "What do I use for research?",
      port: {
        operator_id: "open-factor-test-producer-v1",
        extract: async () => queryProposal()
      }
    });

    expect(query).toMatchObject({
      status: "formed",
      producer_operator_id: "open-factor-test-producer-v1",
      graph: { source_kind: "query" }
    });
  });

  it("reuses a prepared query proposal without invoking the extraction port", async () => {
    let extractionCalls = 0;
    const queryText = "What do I use for research?";
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: queryText,
      port: {
        operator_id: "open-factor-test-producer-v1",
        extract: async () => {
          extractionCalls += 1;
          return null;
        }
      },
      prepared_proposal: {
        schema_version: 1,
        producer_operator_id: "open-factor-test-producer-v1",
        source_text: queryText,
        graph: queryProposal()
      }
    });

    expect(extractionCalls).toBe(0);
    expect(query).toMatchObject({ status: "formed", graph: { source_kind: "query" } });
  });

  it("rejects a prepared query proposal for a different source", async () => {
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: "What do I use for research?",
      prepared_proposal: {
        schema_version: 1,
        producer_operator_id: "open-factor-test-producer-v1",
        source_text: "What do I buy?",
        graph: queryProposal()
      }
    });

    expect(query).toMatchObject({ status: "rejected", graph: null });
  });

  it("reuses a validated query formation capture without invoking the port", async () => {
    const queryText = "What do I use for research?";
    const prepared = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: queryText,
      proposal: proposal(queryText, queryProposal())
    });
    let extractionCalls = 0;
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: queryText,
      port: {
        operator_id: "unused-query-port-v1",
        extract: async () => {
          extractionCalls += 1;
          return null;
        }
      },
      prepared_capture: prepared
    });

    expect(extractionCalls).toBe(0);
    expect(query).toEqual(prepared);
  });

  it("bounds a non-ranking compatibility trace by evidence identity", async () => {
    const evidence = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I used Atlas for research.",
      proposal: proposal("I used Atlas for research.", evidenceProposal())
    });
    const query = await captureRecallQueryOpenSemanticFactors({
      query_text: "What do I use for research?",
      port: {
        operator_id: "open-factor-test-producer-v1",
        extract: async () => queryProposal()
      }
    });

    expect(materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { "evidence-atlas": evidence }
    })).toMatchObject({
      observed_evidence_count: 1,
      evaluated_evidence_count: 1,
      truncated: false,
      entries: [{ evidence_id: "evidence-atlas", receipt: { status: "compatible" } }]
    });
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

function evidenceProposal() {
  return {
    schema_version: 1 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("actor", "I", 0, 1),
      factor("predicate", "used", 2, 6, "use"),
      factor("object", "Atlas", 7, 12),
      factor("purpose", "research", 17, 25)
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
      argument(0, "factor", "actor"),
      argument(1, "factor", "object", "object"),
      argument(2, "factor", "purpose", "purpose")
      ]
    }]
  };
}

function queryProposal() {
  return {
    schema_version: 1 as const,
    source_kind: "query" as const,
    factors: [
      factor("query-actor", "I", 8, 9),
      factor("query-predicate", "use", 10, 13),
      factor("query-purpose", "research", 18, 26)
    ],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "use-query",
      predicate_factor_id: "query-predicate",
      arguments: [
      argument(0, "factor", "query-actor"),
      argument(1, "variable", "answer", "object"),
      argument(2, "factor", "query-purpose", "purpose")
      ]
    }]
  };
}

function personEvidence(
  sourceText: string,
  predicateSurface: string,
  valueSurface: string,
  predicateIdentity: string
) {
  const predicateStart = sourceText.indexOf(predicateSurface);
  const valueStart = sourceText.indexOf(valueSurface);
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: sourceText,
    proposal: proposal(sourceText, {
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("person", "Alice", 0, 5, "alice"),
        factor("predicate", predicateSurface, predicateStart,
          predicateStart + predicateSurface.length, predicateIdentity),
        factor("value", valueSurface, valueStart, valueStart + valueSurface.length)
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [semanticProposition("statement", "predicate", ["person", "value"])]
    })
  });
}

function proposal(sourceText: string, graph: unknown) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "open-factor-test-producer-v1",
    source_text: sourceText,
    graph
  };
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
      argument(position, "factor", referenceId))
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
      argument(0, "variable", "person"),
      argument(1, "factor", valueFactorId)
    ]
  };
}

function factor(
  factorId: string,
  surface: string,
  _start: number,
  _end: number,
  semanticIdentity = surface.toLocaleLowerCase()
) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}

function argument(
  position: number,
  referenceKind: "factor" | "variable",
  referenceId: string,
  bindingIdentity = position === 0 ? "agent" : `argument-${position}`
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
