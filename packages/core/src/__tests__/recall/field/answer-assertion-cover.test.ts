import { describe, expect, it } from "vitest";

import type { CandidateCoverageReceipt } from
  "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import { materializeAttributedFacilityMatches } from
  "../../../recall/field/facility/match-materialization.js";
import {
  projectFactFrameSemanticFactors,
  STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID
} from "../../../recall/field/fact-frame-semantic-factors.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../../recall/field/query-facility-demand.js";

const VOLUNTEER_DEMAND_ID = "facility:relation:frame:0:slot:0:relation:volunteer";

describe("answer-assertion facility cover", () => {
  it("covers relation volunteer from a stored value slot and not from an unrelated capsule", () => {
    const demand = materializeAttributedQueryFacilityDemand({
      query_demand: { schema_version: 1, atoms: [] },
      weights: unitWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "relation", text: "volunteer" }
      ], 0)
    });
    const matches = materializeAttributedFacilityMatches({
      demand,
      candidates: [
        factCandidate("candidate-a", "had", "had volunteered at the clinic"),
        factCandidate("candidate-b", "likes", "a red apple")
      ]
    });

    expect(matches.get("candidate-a")).toContainEqual(expect.objectContaining({
      demand_atom_id: VOLUNTEER_DEMAND_ID,
      alignment_operator_id: STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID
    }));
    expect(matches.get("candidate-b")!.some((match) =>
      match.demand_atom_id === VOLUNTEER_DEMAND_ID
    )).toBe(false);
  });

  it("does not cover typed qualifier demand from an evidence value slot", () => {
    const demand = materializeAttributedQueryFacilityDemand({
      query_demand: { schema_version: 1, atoms: [] },
      weights: unitWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "qualifier", text: "Japan" }
      ], 0)
    });
    const matches = materializeAttributedFacilityMatches({
      demand,
      candidates: [
        factCandidate("candidate-a", "holds", "I was in Japan for two weeks")
      ]
    }).get("candidate-a")!;

    expect(matches.some((match) =>
      match.demand_atom_id === "facility:entity:frame:0:slot:0:qualifier:japan"
    )).toBe(false);
  });
});

function unitWeights() {
  return Object.freeze({
    entity: 1,
    relation: 1,
    time: 1,
    logical_object: 1,
    independent_evidence: 1
  });
}

function factCandidate(
  candidateKey: string,
  relationText: string,
  valueText: string
) {
  return {
    candidate_key: candidateKey,
    object_id: candidateKey,
    coverage: factCoverage(candidateKey, relationText, valueText)
  };
}

function factCoverage(
  candidateKey: string,
  relationText: string,
  valueText: string
): Readonly<CandidateCoverageReceipt> {
  return Object.freeze({
    schema_version: 1,
    operator_id: "attributed_coverage_atoms_v1",
    candidate_key: candidateKey,
    activation: Object.freeze({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "absent",
      score: null,
      winner: null,
      observations: Object.freeze([]),
      missing_channel_policy: "no_op"
    }),
    evidence_semantic_completeness: "not_observed",
    projection_match_count: 1,
    atoms: Object.freeze([
      Object.freeze({
        atom_id: `fact:${candidateKey}:7`,
        kind: "fact_projection" as const,
        strength: 0.8,
        independence_key: `evidence:${candidateKey}`,
        evidence_object_id: candidateKey,
        document_identity: "fact_key:7",
        projection: Object.freeze({
          projection_id: 7,
          projection_kind: "fact_key" as const,
          matched_fact_key_forms: Object.freeze([{ kind: "complete" as const }]),
          fact_slots: Object.freeze([
            Object.freeze({ role: "subject" as const, text: "I" }),
            Object.freeze({ role: "relation" as const, text: relationText }),
            Object.freeze({ role: "value" as const, text: valueText })
          ])
        }),
        demand_roles: Object.freeze(["complete"] as const),
        observation_channels: Object.freeze(["evidence_fts" as const]),
        matched_fts_lanes: Object.freeze(["porter" as const])
      })
    ])
  });
}
