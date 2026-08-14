import { describe, expect, it } from "vitest";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../recall/field/open-semantic-factors/activation.js";
import { attributeOpenSemanticFactorActivations } from
  "../../../../recall/field/open-semantic-factors/candidate-attribution.js";
import { assertOpenSemanticCandidateActivations } from
  "../../../../recall/delivery/selection-boundary/validation/open-semantic-candidate-activation-receipt.js";
import { cloneSelectionBoundaryJson } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-json.js";
import type { CoarseRecallCandidate } from
  "../../../../recall/runtime/recall-service-types.js";
import type { SerializedRecallSupplementaryData } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-types.js";

describe("open semantic merged-solution attribution", () => {
  it("keeps both evidence proposition matches when solutions share a result key", () => {
    const query = giftQuery();
    const leftId = "4a47b15c-af07-44d3-825a-2c328b90a505";
    const rightId = "53ecd06e-4cbb-4e48-81ab-c4e20b438b11";
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        [leftId]: giftEvidence("My grandma gave me the silver necklace."),
        [rightId]: giftEvidence("My grandma gave me the silver necklace.")
      }
    });
    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    });

    expect(composition.status).toBe("composed");
    expect(composition.solution_count).toBe(1);
    expect(composition.solutions[0]?.evidence_ids).toEqual([leftId, rightId]);
    expect(composition.solutions[0]?.proposition_matches.map((match) => match.evidence_id))
      .toEqual([leftId, rightId]);

    const activation = materializeOpenSemanticFactorActivation({
      composition,
      trace,
      query_capture: query
    });
    expect(activation.truncated).toBe(false);
    expect(activation.entries).toEqual([
      expect.objectContaining({
        evidence_id: leftId,
        proposition_match_count: 1
      }),
      expect.objectContaining({
        evidence_id: rightId,
        proposition_match_count: 1
      })
    ]);

    const activations = attributeOpenSemanticFactorActivations({
      candidates: [
        memoryCandidate("memory-left", [leftId]),
        memoryCandidate("memory-right", [rightId]),
        memoryCandidate("memory-both", [rightId, leftId])
      ],
      activation
    });
    expect(activations.size).toBe(3);
    expect(() => assertOpenSemanticCandidateActivations(
      cloneSelectionBoundaryJson({
        openSemanticFactorCandidateActivationsByCandidateKey: [...activations]
      }) as SerializedRecallSupplementaryData
    )).not.toThrow();
  });
});

function giftQuery() {
  return formation("query", "How old was I when my grandma gave me the silver necklace?", {
    schema_version: 1,
    source_kind: "query",
    factors: [
      factor("predicate_age", "old", "old"),
      factor("factor_grandma", "my grandma", "my grandma"),
      factor("predicate_gave", "gave", "give"),
      factor("factor_necklace", "the silver necklace", "the silver necklace")
    ],
    variables: [{ variable_id: "answer", surface: "How old" }],
    result_variable_ids: ["answer"],
    propositions: [
      {
        proposition_id: "query_age",
        predicate_factor_id: "predicate_age",
        arguments: [argument(0, "subject", "variable", "answer")]
      },
      {
        proposition_id: "query_gave",
        predicate_factor_id: "predicate_gave",
        arguments: [
          argument(0, "giver", "factor", "factor_grandma"),
          argument(1, "recipient", "variable", "answer"),
          argument(2, "gift", "factor", "factor_necklace")
        ]
      }
    ]
  });
}

function giftEvidence(sourceText: string) {
  return formation("evidence", sourceText, {
    schema_version: 1,
    source_kind: "evidence",
    factors: [
      factor("f0", "grandma", "my grandma"),
      factor("f1", "gave", "give"),
      factor("f2", "me", "me"),
      factor("f3", "necklace", "the silver necklace")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "p0",
      predicate_factor_id: "f1",
      arguments: [
        argument(0, "giver", "factor", "f0"),
        argument(1, "recipient", "factor", "f2"),
        argument(2, "gift", "factor", "f3")
      ]
    }]
  });
}

function memoryCandidate(
  objectId: string,
  evidenceRefs: readonly string[]
): CoarseRecallCandidate {
  return Object.freeze({
    entry: createMemoryEntry({
      object_id: objectId,
      evidence_refs: [...evidenceRefs]
    }),
    originPlane: "workspace_local"
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
