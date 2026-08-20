import { describe, expect, it, vi } from "vitest";
import {
  FieldGenerationEventType,
  MemoryGovernanceEventType,
  formatVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER } from
  "../../memory/fact-frame-formation/declarative-normalizer.js";
import {
  createCreationHarness,
  createEvidenceInput
} from "./evidence-service-fixture.js";

describe("EvidenceService creation", () => {
  it("materializes a source-bound FactFrame through the canonical projection owner", async () => {
    const { service, create } = createCreationHarness();
    const assertion = "I use Atlas for research.";

    await service.create(
      createEvidenceInput({ excerpt: assertion }),
      [],
      {
        schema_version: 1,
        producer_operator_id: "structured_fact_frame_v1",
        source_assertion: assertion,
        fact_frame: {
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "use" },
            { role: "value", text: "Atlas" },
            { role: "qualifier", text: "for research" }
          ]
        }
      },
      {
        schema_version: 1,
        producer_operator_id: "structured_open_semantic_factor_v1",
        source_text: assertion,
        graph: semanticGraph(assertion)
      }
    );

    expect(create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({ projection_id: 1, content: "I use Atlas for research" }),
        expect.objectContaining({ projection_id: 5, content: "I use Atlas" })
      ]),
      expect.objectContaining({
        status: "formed",
        producer_operator_id: "structured_fact_frame_v1",
        source_hash: "sha256:abc"
      }),
      expect.objectContaining({
        status: "formed",
        producer_operator_id: "structured_open_semantic_factor_v1",
        graph: expect.objectContaining({ source_kind: "evidence" })
      })
    );
    expect(create.mock.calls[0]?.[1]).toHaveLength(5);
  });

  it("persists explicit rejected semantic formation without a graph", async () => {
    const { service, create } = createCreationHarness();

    await service.create(
      createEvidenceInput({ excerpt: "I use Atlas for research." }),
      [],
      undefined,
      { kind: "rejected" }
    );

    expect(create.mock.calls[0]?.[3]).toMatchObject({
      status: "rejected",
      graph: null,
      producer_operator_id: null
    });
  });

  it.each([
    { status: "unavailable" },
    { status: "rejected" },
    { graph: { schema_version: 2 } },
    { status: "rejected", graph: { schema_version: 2 } },
    { kind: "rejected", graph: { schema_version: 2 } },
    { kind: "unavailable" }
  ] as const)("does not treat a malformed admission object as rejected or formed", async (malformed) => {
    const { service, create } = createCreationHarness();

    await service.create(
      createEvidenceInput({ excerpt: "I use Atlas for research." }),
      [],
      undefined,
      malformed as never
    );

    expect(create.mock.calls[0]?.[3]).toMatchObject({
      status: "unavailable",
      graph: null,
      producer_operator_id: null
    });
    expect(create.mock.calls[0]?.[3]).not.toMatchObject({ status: "rejected" });
    expect(create.mock.calls[0]?.[3]).not.toMatchObject({ status: "formed" });
  });

  it("normalizes only verified atomic assertion evidence", async () => {
    const fallback = createCreationHarness();
    await fallback.service.create(createEvidenceInput({
      excerpt: "I use Atlas. I prefer quiet rooms.",
      source_hash: `sha256:garden-source-turn-fallback-v2:${"a".repeat(64)}`
    }));

    expect(fallback.create.mock.calls[0]?.[1]).toEqual([]);
    expect(fallback.create.mock.calls[0]?.[2]).toMatchObject({
      status: "unavailable"
    });

    const assertion = createCreationHarness({
      factFrameProposalNormalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
    });
    await assertion.service.create(createEvidenceInput({
      excerpt: "I have a dog.",
      source_hash: formatVerifiedUserAssertionSourceHash("b".repeat(64))
    }));

    expect(assertion.create.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ projection_kind: "fact_key", content: "I have a dog" })
    ]));
    expect(assertion.create.mock.calls[0]?.[2]).toMatchObject({
      status: "formed",
      producer_operator_id: "rule_based_evidence_fact_frame_normalizer_v1"
    });
  });

  it("drops caller-authored fact keys without losing the root evidence", async () => {
    const warn = vi.fn();
    const { service, create, append } = createCreationHarness({ warn });

    const created = await service.create(createEvidenceInput(), [{
      projection_id: 1,
      projection_kind: "fact_key",
      content: "unsealed key"
    }]);

    expect(append.mock.calls.map(([event]) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
      FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED
    ]);
    expect(create).toHaveBeenCalledWith(
      created,
      [],
      expect.anything(),
      expect.anything()
    );
    expect(warn).toHaveBeenCalledWith(
      "optional evidence formation failed",
      expect.objectContaining({ evidence_object_id: created.object_id })
    );
  });
});

function semanticGraph(_source: string) {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("actor", "I", 0, 1, "speaker"),
      factor("predicate", "use", 2, 5, "use"),
      factor("object", "Atlas", 6, 11, "atlas"),
      factor("purpose", "research", 16, 24, "research")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        { position: 0, binding_identity: "agent", reference_kind: "factor" as const,
          reference_id: "actor" },
        { position: 1, binding_identity: "object", reference_kind: "factor" as const,
          reference_id: "object" },
        { position: 2, binding_identity: "purpose", reference_kind: "factor" as const,
          reference_id: "purpose" }
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
