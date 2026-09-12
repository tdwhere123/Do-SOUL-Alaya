import { describe, expect, it } from "vitest";
import { materializeEvidenceFactFrameFormation } from
  "../../../memory/evidence-fact-frame-formation.js";
import {
  FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID,
  certifyEvidenceSemanticCompleteness
} from "../../../memory/evidence-create/evidence-semantic-completeness.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../semantic/open-semantic-factor-formation.js";
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
              semantic_identity: "with a degree in business administration, which has definitely helped me in my new role"
            })
          ])
        }
      }
    });
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
  ])("certifies the source-grounded $name formation", ({ evidence, slots }) => {
    const upstream = rematerializeG8LiveFormation(evidence);
    const source = evidence === "q2_evidence"
      ? "I've been listening to audiobooks during my daily commute, which takes 45 minutes each way."
      : "I actually redeemed a $5 coupon on coffee creamer last Sunday";
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: factFrame(source, slots),
      semanticFormation: upstream
    });

    expect(certified).toMatchObject({
      receipt: { status: "certified" },
      semanticFormation: { status: "formed" }
    });
  });

  it("does not reject a formed Garden graph when the fact-frame never formed", () => {
    const source = "I graduated with a degree in Business Administration, which has definitely helped me in my new role.";
    const semanticFormation = formation(source, graduationGraph());
    const factFrame = unavailableFrame(source);
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame,
      semanticFormation
    });

    expect(semanticFormation.status).toBe("formed");
    expect(factFrame.status).not.toBe("formed");
    expect(certified).toMatchObject({
      receipt: { status: "not_applicable", reason_code: "upstream_not_formed" },
      semanticFormation: { status: "unavailable", graph: null }
    });
  });
});

function unavailableFrame(source: string) {
  return materializeEvidenceFactFrameFormation({
    sourceAssertion: source,
    sourceHash: "sha256:test-source"
  }).capture;
}

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

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return {
    factor_id: factorId,
    surface,
    source_occurrence: 0,
    semantic_identity: semanticIdentity
  };
}
