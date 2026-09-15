import { describe, expect, it } from "vitest";
import type { OpenSemanticFactorGraphProposal } from "@do-soul/alaya-protocol";
import { materializeEvidenceFactFrameFormation } from
  "../../../memory/evidence-fact-frame-formation.js";
import {
  FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID,
  certifyEvidenceSemanticCompleteness,
  verifyEvidenceSemanticCompletenessReceipt
} from "../../../memory/evidence-create/evidence-semantic-completeness.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../semantic/open-semantic-factor-formation.js";
import { rematerializeG8LiveFormation } from
  "../../recall/field/open-semantic-factors/fixtures/g8-live-formation.js";

const GARDEN_PRODUCER = "garden_source_bound_open_semantic_factor_v3";

describe("evidence semantic completeness", () => {
  it("retains rejected nomination provenance without letting it veto independent source formation", () => {
    const source = "I like tea.";
    const upstream = materializeOpenSemanticFactorFormation({
      source_kind: "evidence", source_text: source, negative_status: "rejected"
    });
    const frame = factFrame(source, [["subject", "I"], ["relation", "like"], ["value", "tea"]]);
    const certified = certifyEvidenceSemanticCompleteness({ sourceText: source, factFrame: frame, semanticFormation: upstream });
    expect(certified.semanticFormation.status).toBe("formed");
    expect(certified.receipt.upstream_semantic_formation).toEqual(upstream);
    expect(verifyEvidenceSemanticCompletenessReceipt({ sourceText: source, factFrame: frame,
      semanticFormation: certified.semanticFormation, receipt: certified.receipt })).toEqual(certified.receipt);
    expect(() => verifyEvidenceSemanticCompletenessReceipt({ sourceText: source, factFrame: frame,
      semanticFormation: certified.semanticFormation,
      receipt: { ...certified.receipt, upstream_semantic_formation: { ...upstream, status: "unavailable" } }
    })).toThrow();
  });

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
            expect.objectContaining({ surface: "graduated", semantic_identity: "graduated" }),
            expect.objectContaining({ surface: "I", semantic_identity: "i" }),
            expect.objectContaining({
              surface: "with a degree in Business Administration, which has definitely helped me in my new role",
              semantic_identity: "with a degree in business administration, which has definitely helped me in my new role"
            })
          ])
        }
      }
    });
    const alteredGraph = graduationGraph();
    const altered = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: factFrame(source, [
        ["subject", "I"], ["relation", "graduated"],
        ["value", "with a degree in Business Administration, which has definitely helped me in my new role"]
      ]),
      semanticFormation: formation(source, { ...alteredGraph,
        factors: alteredGraph.factors.map((factor) => ({ ...factor, semantic_identity: "invented entity" })) })
    });
    expect(altered.semanticFormation).toEqual(certified.semanticFormation);
    expect(altered.receipt.upstream_semantic_formation).not.toEqual(certified.receipt.upstream_semantic_formation);
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

  it("compiles the same canonical graph whether the model graph is missing, legal, or carries an unrelated illegal factor", () => {
    const source = "I like tea.";
    const frame = factFrame(source, [["subject", "I"], ["relation", "like"], ["value", "tea"]]);
    const legal = legalLikeGraph();
    const missing = certifyEvidenceSemanticCompleteness({
      sourceText: source, factFrame: frame,
      semanticFormation: materializeOpenSemanticFactorFormation({ source_kind: "evidence", source_text: source })
    });
    const present = certifyEvidenceSemanticCompleteness({
      sourceText: source, factFrame: frame, semanticFormation: formation(source, legal)
    });
    const illegal = certifyEvidenceSemanticCompleteness({
      sourceText: source, factFrame: frame,
      semanticFormation: materializeOpenSemanticFactorFormation({
        source_kind: "evidence", source_text: source,
        proposal: {
          schema_version: 1, producer_operator_id: GARDEN_PRODUCER, source_text: source,
          graph: {
            ...legal,
            factors: [...legal.factors, {
              factor_id: "ghost", surface: "tea", semantic_identity: "NOT-CANONICAL", source_occurrence: 0
            }]
          }
        }
      })
    });
    expect(missing.semanticFormation.graph).toEqual(present.semanticFormation.graph);
    expect(illegal.semanticFormation.graph).toEqual(present.semanticFormation.graph);
    expect(present.semanticFormation.producer_operator_id).toBe(FACT_FRAME_CANONICAL_OSF_PRODUCER_OPERATOR_ID);
    expect(illegal.receipt.upstream_semantic_formation?.status).not.toBe("formed");
    expect(present.receipt.upstream_semantic_formation).not.toEqual(illegal.receipt.upstream_semantic_formation);
    expect(present.receipt.support_domain).toBe("supported");
  });

  it("does not mint a certified graph from verbatim mentions when no frame formed", () => {
    const source = "PostgreSQL and MySQL.";
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: unavailableFrame(source),
      semanticFormation: materializeOpenSemanticFactorFormation({ source_kind: "evidence", source_text: source })
    });
    expect(certified.receipt.status).not.toBe("certified");
    expect(certified.semanticFormation.graph).toBeNull();
    expect(certified.receipt.support_domain).not.toBe("supported");
  });

  it("refuses a typed claim that drops not, only, unless, or promise markers", () => {
    const cases = [
      { source: "I am not a doctor.", slots: [["subject", "I"], ["relation", "am"], ["value", "a doctor"]] as const },
      { source: "I like tea only on Sundays.", slots: [["subject", "I"], ["relation", "like"], ["value", "tea"]] as const },
      { source: "I enter the lab unless I lose my badge.", slots: [["subject", "I"], ["relation", "enter"], ["value", "the lab"]] as const },
      { source: "I promised to lend tools.", slots: [["subject", "I"], ["relation", "to lend"], ["value", "tools"]] as const }
    ] as const;
    for (const entry of cases) {
      const certified = certifyEvidenceSemanticCompleteness({
        sourceText: entry.source,
        factFrame: factFrame(entry.source, entry.slots),
        semanticFormation: materializeOpenSemanticFactorFormation({
          source_kind: "evidence", source_text: entry.source
        })
      });
      expect(certified.receipt.status, entry.source).not.toBe("certified");
      expect(certified.semanticFormation.graph, entry.source).toBeNull();
    }
  });

  it("does not force a product into the promiser role", () => {
    const source = "I promised to lend tools.";
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: factFrame(source, [["subject", "I"], ["relation", "promised"], ["value", "to lend tools"]]),
      semanticFormation: formation(source, {
        schema_version: 2, source_kind: "evidence",
        factors: [
          factor("promise", "promised", "promise"),
          factor("product", "tools", "tools")
        ],
        variables: [], result_variable_ids: [],
        propositions: [{
          proposition_id: "p", predicate_factor_id: "promise",
          arguments: [{ position: 0, binding_identity: "promiser", reference_kind: "factor", reference_id: "product" }]
        }]
      })
    });
    expect(certified.receipt.status).toBe("certified");
    expect(certified.semanticFormation.graph?.factors).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "I", semantic_identity: "i" }),
      expect.objectContaining({ surface: "promised" }),
      expect.objectContaining({ surface: "to lend tools" })
    ]));
    expect(certified.semanticFormation.graph?.propositions[0]?.arguments
      .some((argument) => argument.binding_identity === "promiser" && argument.reference_id === "product")).toBe(false);
  });

  it("does not treat a matching quote with the wrong lemma as semantic equality", () => {
    const source = "I use MySQL.";
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: factFrame(source, [["subject", "I"], ["relation", "use"], ["value", "MySQL"]]),
      semanticFormation: formation(source, {
        schema_version: 2, source_kind: "evidence",
        factors: [
          factor("predicate", "use", "use"),
          factor("product", "MySQL", "postgresql")
        ],
        variables: [], result_variable_ids: [],
        propositions: [{
          proposition_id: "p", predicate_factor_id: "predicate",
          arguments: [{ position: 0, binding_identity: "object", reference_kind: "factor", reference_id: "product" }]
        }]
      })
    });
    expect(certified.receipt.status).toBe("certified");
    expect(certified.semanticFormation.graph?.factors).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "MySQL", semantic_identity: "mysql" })
    ]));
    expect(certified.semanticFormation.graph?.factors.some((item) => item.semantic_identity === "postgresql")).toBe(false);
  });

  it("records an out-of-domain sample as unsupported instead of certifying a single proposition", () => {
    const source = "Alice Smith likes tea.";
    const certified = certifyEvidenceSemanticCompleteness({
      sourceText: source,
      factFrame: unavailableFrame(source),
      semanticFormation: materializeOpenSemanticFactorFormation({ source_kind: "evidence", source_text: source })
    });
    expect(certified.receipt.status).not.toBe("certified");
    expect(certified.receipt.support_domain).toBe("unsupported");
    expect(certified.semanticFormation.graph).toBeNull();
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

function legalLikeGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("predicate", "like", "like"),
      factor("object", "tea", "tea")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "p",
      predicate_factor_id: "predicate",
      arguments: [{
        position: 0,
        binding_identity: "object",
        reference_kind: "factor" as const,
        reference_id: "object"
      }]
    }]
  };
}

function formation(source: string, graph: OpenSemanticFactorGraphProposal) {
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
