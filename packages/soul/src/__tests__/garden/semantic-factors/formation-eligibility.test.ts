import { describe, expect, it, vi } from "vitest";
import {
  classifyOpenSemanticFactorFormationEligibility,
  GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID
} from "../../../garden/grounding/semantic-factors/formation-eligibility.js";
import { createSignalEvidence } from
  "../../../garden/materialization-router/evidence/create-signal-evidence.js";
import type { EvidenceMaterializationPort } from
  "../../../garden/materialization-router/contracts.js";
import { createSignal } from "../materialization-router-fixture.js";

const SOURCE = "I used Atlas for research.";

describe("open semantic factor formation eligibility", () => {
  it("proposes only a source-bound evidence graph with a grounded assertion receipt", () => {
    const eligibility = classifyOpenSemanticFactorFormationEligibility(
      groundedPayload({ semantic_factor_graph: semanticGraph() })
    );

    expect(eligibility).toEqual({
      kind: "propose",
      proposal: {
        schema_version: 1,
        producer_operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
        source_text: SOURCE,
        graph: expect.objectContaining({ source_kind: "evidence" })
      }
    });
  });

  it("keeps graphless identity-only payloads unavailable instead of formed", () => {
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({}))).toEqual({
      kind: "unavailable",
      reason: "semantic_factor_graph_missing"
    });
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({
      semantic_factor_graph_projection: {
        status: "unavailable",
        reason: "semantic_factor_graph_missing"
      }
    }))).toEqual({
      kind: "unavailable",
      reason: "semantic_factor_graph_missing"
    });
  });

  it.each([
    ["absent frame", { fact_frame: undefined }],
    ["malformed frame", { fact_frame: { schema_version: 1, slots: [
      { role: "subject", text: "I" }, { role: "value", text: "Atlas" }
    ] } }]
  ])("keeps %s outside Garden graph-proposal authority", (_name, override) => {
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({
      semantic_factor_graph: semanticGraph(),
      ...override
    }))).toMatchObject({ kind: "propose" });
  });

  it("rejects unbound nodes at the formation gate", () => {
    const graph = semanticGraph();
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({
      semantic_factor_graph: {
        ...graph,
        factors: [
          ...graph.factors,
          {
            factor_id: "unused",
            surface: "Atlas",
            semantic_identity: "atlas"
          }
        ]
      }
    }))).toEqual({
      kind: "rejected",
      reason: "semantic_factor_graph_invalid_unbound"
    });
  });

  it("rejects a non-canonical identity graph", () => {
    const graph = semanticGraph();
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({
      semantic_factor_graph: {
        ...graph,
        factors: graph.factors.map((factor) => factor.factor_id === "predicate"
          ? { ...factor, semantic_identity: "Use" }
          : factor)
      }
    }))).toEqual({
      kind: "rejected",
      reason: "semantic_factor_graph_invalid_identity"
    });
  });

  it("rejects grounding before a graph can become a formation proposal", () => {
    expect(classifyOpenSemanticFactorFormationEligibility({
      source_assertion: SOURCE,
      source_grounding: {
        status: "rejected",
        content_basis: "none",
        reasons: ["source_grounding_rejected"]
      },
      semantic_factor_graph: semanticGraph()
    })).toEqual({
      kind: "rejected",
      reason: "source_grounding_rejected"
    });
  });

  it("rejects a source_kind evidence graph that cannot ground in the assertion", () => {
    const graph = semanticGraph();
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({
      semantic_factor_graph: {
        ...graph,
        factors: graph.factors.map((factor) => factor.factor_id === "object"
          ? { ...factor, surface: "NotInSource" }
          : factor)
      }
    }))).toEqual({
      kind: "rejected",
      reason: "semantic_factor_graph_not_source_grounded"
    });
  });

  it("does not reconstruct a proposal from a gold-shaped extra graph field", () => {
    expect(classifyOpenSemanticFactorFormationEligibility(groundedPayload({
      gold_semantic_factor_graph: semanticGraph(),
      gold_osf_ids: ["gold-atlas"]
    }))).toEqual({
      kind: "unavailable",
      reason: "semantic_factor_graph_missing"
    });
  });

  it("passes rejected admission into evidence materialization", async () => {
    const create = vi.fn(async () => ({
      object_kind: "evidence_capsule",
      object_id: "evidence-1"
    }));
    const signal = createSignal({
      raw_payload: {
        source_assertion: SOURCE,
        source_grounding: {
          status: "rejected",
          content_basis: "none",
          reasons: ["source_grounding_rejected"]
        },
        semantic_factor_graph: semanticGraph()
      }
    });

    await createSignalEvidence({ create }, signal, evidenceInput());

    expect(create).toHaveBeenCalledWith(
      evidenceInput(),
      [],
      undefined,
      { kind: "rejected" }
    );
  });

  it("omits semantic admission when the graph is unavailable", async () => {
    const create = vi.fn(async (
      ..._args: Parameters<EvidenceMaterializationPort["create"]>
    ) => ({
      object_kind: "evidence_capsule",
      object_id: "evidence-1"
    }));
    const signal = createSignal({
      raw_payload: groundedPayload({})
    });

    await createSignalEvidence({ create }, signal, evidenceInput());

    expect(create.mock.calls[0]?.[3]).toBeUndefined();
  });
});

function groundedPayload(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    source_assertion: SOURCE,
    source_grounding: {
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: SOURCE
    },
    fact_frame: factFrame(),
    ...overrides
  };
}

function factFrame() {
  return { schema_version: 1 as const, slots: [
    { role: "subject" as const, text: "I" },
    { role: "relation" as const, text: "used" },
    { role: "qualifier" as const, text: "Atlas" },
    { role: "value" as const, text: "research" }
  ] };
}

function semanticGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("actor", "I", "speaker"),
      factor("predicate", "used", "use"),
      factor("object", "Atlas", "atlas"),
      factor("purpose", "research", "research")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "actor"),
        argument(1, "object", "object"),
        argument(2, "purpose", "purpose")
      ]
    }]
  };
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(position: number, bindingIdentity: string, referenceId: string) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: "factor" as const,
    reference_id: referenceId
  };
}

function evidenceInput() {
  return {
    created_by: "garden_compile" as const,
    evidence_kind: "conversation_excerpt" as const,
    semantic_anchor: { topic: "atlas", keywords: ["atlas"], summary: SOURCE },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: null
    },
    evidence_health_state: "verified" as const,
    gist: `User: ${SOURCE}`,
    excerpt: SOURCE,
    source_hash: "sha256:abc",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}
