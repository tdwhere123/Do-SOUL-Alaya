import { describe, expect, it } from "vitest";
import { parseOfficialApiSignals } from
  "../../../garden/official-api-signal-parser.js";
import { groundOfficialApiDraft } from
  "../../../garden/official-api/source-grounding.js";
import {
  GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
  buildOpenSemanticFactorFormationProposal
} from "../../../garden/grounding/semantic-factors/formation-proposal.js";

const SOURCE = "I used Atlas for research.";

describe("open semantic factor formation proposal", () => {
  it("preserves source observation while grounding a separate semantic projection", () => {
    const [draft] = parseOfficialApiSignals(JSON.stringify({
      signals: [signalJson(semanticGraph())]
    }));
    if (draft === undefined) throw new Error("signal fixture must parse");

    const grounded = groundOfficialApiDraft(draft, SOURCE);
    expect(grounded.status).toBe("grounded");
    if (grounded.status !== "grounded") return;
    expect(grounded.draft.semantic_factor_graph).toMatchObject({
      source_kind: "evidence",
      factors: expect.arrayContaining([
        expect.objectContaining({ surface: "used", semantic_identity: "use" })
      ])
    });

    expect(buildOpenSemanticFactorFormationProposal({
      source_assertion: SOURCE,
      source_grounding: grounded.audit,
      semantic_factor_graph: grounded.draft.semantic_factor_graph
    })).toEqual({
      schema_version: 1,
      producer_operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
      source_text: SOURCE,
      graph: grounded.draft.semantic_factor_graph
    });
  });

  it("removes a graph whose exact surface is absent from the source", () => {
    const [draft] = parseOfficialApiSignals(JSON.stringify({
      signals: [signalJson({
        ...semanticGraph(),
        factors: [
          factor("actor", "I", 0, 1, "speaker"),
          factor("predicate", "uses", 2, 6, "use"),
          factor("object", "Atlas", 7, 12, "atlas")
        ],
        propositions: [{
          proposition_id: "use-event",
          predicate_factor_id: "predicate",
          arguments: [
            argument(0, "actor"),
            argument(1, "object")
          ]
        }]
      })]
    }));
    if (draft === undefined) throw new Error("signal fixture must parse");

    const grounded = groundOfficialApiDraft(draft, SOURCE);
    expect(grounded.status).toBe("grounded");
    if (grounded.status !== "grounded") return;
    expect(grounded.draft.semantic_factor_graph).toBeUndefined();
    expect(grounded.audit).toMatchObject({
      reasons: expect.arrayContaining(["proposed_semantic_factor_graph_not_source_grounded"])
    });
  });
});

function signalJson(graph: unknown) {
  return {
    signal_kind: "potential_claim",
    object_kind: "activity",
    confidence: 0.9,
    matched_text: SOURCE,
    evidence_refs: [],
    source_memory_refs: [],
    semantic_factor_graph: graph
  };
}

function semanticGraph() {
  return {
    schema_version: 1 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("actor", "I", 0, 1, "speaker"),
      factor("predicate", "used", 2, 6, "use"),
      factor("object", "Atlas", 7, 12, "atlas"),
      factor("purpose", "research", 17, 25, "research")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "actor"),
        argument(1, "object"),
        argument(2, "purpose")
      ]
    }]
  };
}

function factor(
  factorId: string,
  surface: string,
  _start: number,
  _end: number,
  semanticIdentity: string
) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}

function argument(position: number, referenceId: string) {
  return {
    position,
    binding_identity: position === 0 ? "agent" : position === 1 ? "object" : "purpose",
    reference_kind: "factor" as const,
    reference_id: referenceId
  };
}
