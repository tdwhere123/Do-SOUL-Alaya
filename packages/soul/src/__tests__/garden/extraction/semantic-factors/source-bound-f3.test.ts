import { describe, expect, it } from "vitest";
import type { OpenSemanticFactorGraphProposal } from "@do-soul/alaya-protocol";
import {
  SELECTED_SOURCE_BOUND_F3_CAPABILITY,
  sourceBoundF3Seal
} from "../../../../garden/extraction/semantic-factors/source-bound-seal.js";
import { traceSourceBoundF3Proposal } from "../../../../garden/extraction/semantic-factors/source-bound-tracer.js";

const SOURCE = "I learned to cook pasta.";

const LOCKED_SOURCE_BOUND_F3_SEAL = {
  evidence_prompt_sha256: "bf255feebdf99106871e33241f7bba3260e3f02874f0eefe36db803cc95d7705",
  query_prompt_sha256: "747e5bac75b445dc0b6ec2a1441684ef103bf9903270f8153b4846e67c4da66d",
  evidence_request_template_sha256:
    "67de86ee33c7315698963950647eef568c1ee864bb2508775009632c6e96d396",
  query_request_template_sha256:
    "649ea5aca1bcfc427433e708afe5428d44f070ab315deed1a9f614177de7db00"
} as const;

describe("source-bound F3 seal", () => {
  it("freezes identities-only as the smallest membership capability", () => {
    const seal = sourceBoundF3Seal();
    expect(seal.selected_capability).toBe("identities_only");
    expect(seal.membership_capability).toBe("identities_only");
    expect(seal.prompt_asks).toBe("identities_and_topology");
    expect(SELECTED_SOURCE_BOUND_F3_CAPABILITY).toBe("identities_only");
    expect(
      seal.evidence_prompt_sha256,
      "source-bound F3 evidence prompt changed; bump this lock after reviewing the extraction contract"
    ).toBe(LOCKED_SOURCE_BOUND_F3_SEAL.evidence_prompt_sha256);
    expect(
      seal.query_prompt_sha256,
      "source-bound F3 query prompt changed; bump this lock after reviewing the extraction contract"
    ).toBe(LOCKED_SOURCE_BOUND_F3_SEAL.query_prompt_sha256);
    expect(
      seal.evidence_request_template_sha256,
      "source-bound F3 evidence request template changed; bump this lock after reviewing the extraction contract"
    ).toBe(LOCKED_SOURCE_BOUND_F3_SEAL.evidence_request_template_sha256);
    expect(
      seal.query_request_template_sha256,
      "source-bound F3 query request template changed; bump this lock after reviewing the extraction contract"
    ).toBe(LOCKED_SOURCE_BOUND_F3_SEAL.query_request_template_sha256);
    expect(seal.evidence_operator_id)
      .toBe("garden_source_bound_open_semantic_factor_v3");
    expect(seal.query_operator_id).toBe("open_semantic_factor_query_compiler_v9");
    expect(seal.forbidden_writes).toContain("RelationAssertion");
    expect(seal.forbidden_writes).toContain("PathRelation");
  });
});

describe("source-bound F3 tracer", () => {
  it("keeps F0-F2 only empty of F3 membership identities", () => {
    const trace = traceSourceBoundF3Proposal({
      sourceText: SOURCE,
      capability: "f0_f2_only",
      proposal: groundedProposal()
    });
    expect(trace.membership_identities).toEqual([]);
    expect(trace.physical_calls).toBe(0);
    expect(trace.used_topology).toBe(false);
  });

  it("accepts grounded identities without requiring proposition topology", () => {
    const identities = traceSourceBoundF3Proposal({
      sourceText: SOURCE,
      capability: "identities_only",
      proposal: identitiesOnlyProposal()
    });
    expect(identities.membership_identities).toEqual(["learn", "cook"]);
    expect(identities.invented_surface_rate).toBe(0);
    expect(identities.used_topology).toBe(false);

    const topology = traceSourceBoundF3Proposal({
      sourceText: SOURCE,
      capability: "identities_and_topology",
      proposal: identitiesOnlyProposal()
    });
    expect(topology.membership_identities).toEqual([]);
    expect(topology.rejected).toContain("topology_ungrounded");
  });

  it("rejects invented surfaces and forbidden durable writes", () => {
    const invented = traceSourceBoundF3Proposal({
      sourceText: SOURCE,
      capability: "identities_only",
      proposal: {
        ...groundedProposal(),
        factors: [
          ...groundedProposal().factors,
          { factor_id: "ghost", surface: "quantum foam",
            semantic_identity: "quantum foam", source_occurrence: 0 }
        ]
      }
    });
    expect(invented.rejected).toContain("invented_surface:quantum foam");
    expect(invented.invented_surface_rate).toBeGreaterThan(0);

    const forbidden = traceSourceBoundF3Proposal({
      sourceText: SOURCE,
      capability: "identities_only",
      proposal: groundedProposal(),
      rawProposal: { ...groundedProposal(), PathRelation: { path_id: "p" } }
    });
    expect(forbidden.rejected).toContain("PathRelation");
    expect(forbidden.membership_identities).toEqual([]);
  });
});

function groundedProposal(): OpenSemanticFactorGraphProposal {
  return {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      { factor_id: "f0", surface: "learned", semantic_identity: "learn", source_occurrence: 0 },
      { factor_id: "f1", surface: "cook", semantic_identity: "cook", source_occurrence: 0 }
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "p0",
      predicate_factor_id: "f0",
      arguments: [{
        position: 0,
        binding_identity: "skill",
        reference_kind: "factor",
        reference_id: "f1"
      }]
    }]
  };
}

function identitiesOnlyProposal(): OpenSemanticFactorGraphProposal {
  return {
    ...groundedProposal(),
    propositions: []
  };
}
