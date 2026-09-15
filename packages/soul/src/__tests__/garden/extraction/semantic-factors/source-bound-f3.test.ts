import { describe, expect, it } from "vitest";
import type { OpenSemanticFactorGraphProposal } from "@do-soul/alaya-protocol";
import {
  SELECTED_SOURCE_BOUND_F3_CAPABILITY,
  sourceBoundF3Seal
} from "../../../../garden/extraction/semantic-factors/source-bound-seal.js";
import { traceSourceBoundF3Proposal } from "../../../../garden/extraction/semantic-factors/source-bound-tracer.js";

const SOURCE = "I learned to cook pasta.";

const LOCKED_SOURCE_BOUND_F3_SEAL = {
  evidence_prompt_sha256: "56a88218012b2cbbd0817ab93346c516ac1086dd61a4fc3f02e81ad8534de404",
  query_prompt_sha256: "747e5bac75b445dc0b6ec2a1441684ef103bf9903270f8153b4846e67c4da66d",
  evidence_request_template_sha256:
    "29e7757ea3ff0ac1f4c3211df9932f6e1911f5880067f26b066dde65e4220bc9",
  query_request_template_sha256:
    "649ea5aca1bcfc427433e708afe5428d44f070ab315deed1a9f614177de7db00"
} as const;

describe("source-bound F3 seal", () => {
  it("freezes identities-only as the smallest membership capability", () => {
    const seal = sourceBoundF3Seal();
    expect(seal.selected_capability).toBe("identities_only");
    expect(seal.membership_capability).toBe("identities_only");
    expect(seal.prompt_asks).toBe("identities_only");
    expect(seal.schema_version).toBe(2);
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
      .toBe("official-api-identity-observation-v1");
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

  it("treats overlapping surface occurrence 1 as invented", () => {
    const overlapping = traceSourceBoundF3Proposal({
      sourceText: "aaa",
      capability: "identities_only",
      proposal: identitiesProposal([
        { factor_id: "f0", surface: "aa", semantic_identity: "aa", source_occurrence: 1 }
      ])
    });
    expect(overlapping.rejected).toContain("invented_surface:aa");
    expect(overlapping.membership_identities).toEqual([]);

    const first = traceSourceBoundF3Proposal({
      sourceText: "aaa",
      capability: "identities_only",
      proposal: identitiesProposal([
        { factor_id: "f0", surface: "aa", semantic_identity: "aa", source_occurrence: 0 }
      ])
    });
    expect(first.membership_identities).toEqual(["aa"]);
    expect(first.invented_surface_rate).toBe(0);
  });

  it("accepts ordinary repeated words at later non-overlapping occurrences", () => {
    const source = "I cook and I cook pasta.";
    const second = traceSourceBoundF3Proposal({
      sourceText: source,
      capability: "identities_only",
      proposal: identitiesProposal([
        { factor_id: "f0", surface: "cook", semantic_identity: "cook", source_occurrence: 1 }
      ])
    });
    expect(second.membership_identities).toEqual(["cook"]);
    expect(second.invented_surface_rate).toBe(0);

    const missing = traceSourceBoundF3Proposal({
      sourceText: source,
      capability: "identities_only",
      proposal: identitiesProposal([
        { factor_id: "f0", surface: "cook", semantic_identity: "cook", source_occurrence: 2 }
      ])
    });
    expect(missing.rejected).toContain("invented_surface:cook");
    expect(missing.membership_identities).toEqual([]);
  });

  it("accepts a CJK surface at its UTF-16 occurrence", () => {
    const cjk = traceSourceBoundF3Proposal({
      sourceText: "我学了烹饪。",
      capability: "identities_only",
      proposal: identitiesProposal([
        { factor_id: "f0", surface: "烹饪", semantic_identity: "cook", source_occurrence: 0 }
      ])
    });
    expect(cjk.membership_identities).toEqual(["cook"]);
    expect(cjk.invented_surface_rate).toBe(0);
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

function identitiesProposal(
  factors: OpenSemanticFactorGraphProposal["factors"]
): OpenSemanticFactorGraphProposal {
  return {
    schema_version: 2,
    source_kind: "evidence",
    factors,
    variables: [],
    result_variable_ids: [],
    propositions: []
  };
}
