import { describe, expect, it } from "vitest";
import { materializeEvidenceFactFrameFormation } from
  "../../../memory/evidence-fact-frame-formation.js";
import {
  FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID,
  certifyEvidenceSemanticCompleteness
} from "../../../memory/evidence-create/evidence-semantic-completeness.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../recall/field/open-semantic-factors/compatibility.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../recall/field/open-semantic-factors/composition.js";
import { rematerializeG8LiveFormation } from
  "../../recall/field/open-semantic-factors/fixtures/g8-live-formation.js";

const GARDEN_PRODUCER = "garden_source_bound_open_semantic_factor_v3";

describe("evidence semantic completeness", () => {
  it("canonicalizes a Garden graph that omitted the source-bound subject", () => {
    const source = "I graduated with a degree in Business Administration, which has definitely helped me in my new role.";
    const semanticFormation = formation(source, graduationGraph());
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: factFrame(source, [
        ["subject", "I"],
        ["relation", "graduated"],
        ["value", "with a degree in Business Administration, which has definitely helped me in my new role"]
      ]),
      semanticFormation
    });

    expect(certified).toMatchObject({
      receipt: { status: "certified", reason_code: "complete" },
      semanticFormation: {
        status: "formed",
        producer_operator_id: FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID,
        graph: {
          factors: expect.arrayContaining([
            expect.objectContaining({ surface: "graduated", semantic_identity: "graduate" }),
            expect.objectContaining({ surface: "I", semantic_identity: "i" }),
            expect.objectContaining({
              surface: "with a degree in Business Administration, which has definitely helped me in my new role",
              semantic_identity: "degree in business administration"
            })
          ])
        }
      }
    });
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: certified.semanticFormation,
      query_capture: graduationQueryFormation()
    })).toMatchObject({ status: "compatible", matched_query_proposition_count: 1 });
  });

  it.each([
    {
      name: "source-bound duration",
      query: "q2_query" as const,
      evidence: "q2_evidence" as const,
      slots: [
        ["subject", "I"],
        ["relation", "listening"],
        ["value", "to audiobooks during my daily commute, which takes 45 minutes each way"]
      ] as const
    },
    {
      name: "location join",
      query: "q3_query" as const,
      evidence: "q3_evidence" as const,
      slots: [
        ["subject", "I"],
        ["relation", "actually"],
        ["value", "redeemed a $5 coupon on coffee creamer last Sunday"]
      ] as const
    }
  ])("keeps the $name negative control at no_match", ({ query, evidence, slots }) => {
    const queryFormation = rematerializeG8LiveFormation(query);
    const upstream = rematerializeG8LiveFormation(evidence);
    const source = evidence === "q2_evidence"
      ? "I've been listening to audiobooks during my daily commute, which takes 45 minutes each way."
      : "I actually redeemed a $5 coupon on coffee creamer last Sunday";
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: factFrame(source, slots),
      semanticFormation: upstream
    });
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: queryFormation,
      evidence_formations: { evidence: certified.semanticFormation }
    });

    expect(certified).toMatchObject({
      receipt: { status: "certified" },
      semanticFormation: { status: "formed" }
    });
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: queryFormation,
      evidence_formations: { evidence: certified.semanticFormation }
    })).toMatchObject({ status: "no_match", solution_count: 0 });
  });
});

function factFrame(
  source: string,
  slots: readonly (readonly ["subject" | "relation" | "value", string])[]
) {
  return materializeEvidenceFactFrameFormation({
    sourceAssertion: source,
    sourceHash: "sha256:test-source",
    proposal: {
      schema_version: 1,
      producer_operator_id: "rule_based_evidence_fact_frame_normalizer_v1",
      source_assertion: source,
      fact_frame: {
        schema_version: 1,
        slots: slots.map(([role, text]) => ({ role, text }))
      }
    }
  }).capture;
}

function formation(source: string, graph: ReturnType<typeof graduationGraph>) {
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: source,
    proposal: {
      schema_version: 1,
      producer_operator_id: GARDEN_PRODUCER,
      source_text: source,
      graph
    }
  });
}

function graduationGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("graduate", "graduated", "graduate"),
      factor("degree", "a degree in Business Administration", "degree in business administration"),
      factor("help", "helped", "help"),
      factor("role", "my new role", "new role")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "graduation",
      predicate_factor_id: "graduate",
      arguments: [{
        position: 0,
        binding_identity: "graduate",
        reference_kind: "factor" as const,
        reference_id: "degree"
      }]
    }, {
      proposition_id: "helping",
      predicate_factor_id: "help",
      arguments: [{
        position: 0,
        binding_identity: "helper",
        reference_kind: "factor" as const,
        reference_id: "degree"
      }, {
        position: 1,
        binding_identity: "beneficiary",
        reference_kind: "factor" as const,
        reference_id: "role"
      }]
    }]
  };
}

function graduationQueryFormation() {
  const source = "What degree did I graduate with?";
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: source,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open_semantic_factor_query_compiler_v9",
      source_text: source,
      graph: {
        schema_version: 2,
        source_kind: "query",
        result_variable_ids: ["answer"],
        propositions: [{
          proposition_id: "query",
          predicate_factor_id: "predicate",
          arguments: [{
            position: 0,
            binding_identity: "graduatee",
            reference_kind: "factor",
            reference_id: "participant"
          }, {
            position: 1,
            binding_identity: "degree",
            reference_kind: "variable",
            reference_id: "answer"
          }]
        }],
        factors: [
          factor("participant", "I", "i"),
          factor("predicate", "graduate", "graduate")
        ],
        variables: [{ variable_id: "answer", surface: "What degree", source_occurrence: 0 }]
      }
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return {
    factor_id: factorId,
    surface,
    source_occurrence: 0,
    semantic_identity: semanticIdentity
  };
}
