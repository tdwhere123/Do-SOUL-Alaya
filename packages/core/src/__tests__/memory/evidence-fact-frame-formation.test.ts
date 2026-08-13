import { describe, expect, it } from "vitest";
import { verifyEvidenceFactFrameFormationCapture } from
  "@do-soul/alaya-protocol";
import { materializeEvidenceFactFrameFormation } from
  "../../memory/evidence-fact-frame-formation.js";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER } from
  "../../memory/fact-frame-formation/declarative-normalizer.js";
import { replayEvidenceFactFrameFormationCapture } from
  "../../memory/evidence-fact-frame-formation.js";
import { createHash } from "node:crypto";

const assertion = "I use Atlas for research.";
const proposal = {
  schema_version: 1 as const,
  producer_operator_id: "structured_formation_parser_v1",
  source_assertion: assertion,
  fact_frame: {
    schema_version: 1 as const,
    slots: [
      { role: "subject" as const, text: "I" },
      { role: "relation" as const, text: "use" },
      { role: "value" as const, text: "Atlas" },
      { role: "qualifier" as const, text: "for research" }
    ]
  }
};

describe("evidence fact-frame formation", () => {
  it("forms one sealed capture and derives the complete plus marginal keys", () => {
    const result = materializeEvidenceFactFrameFormation({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      proposal
    });

    expect(result.capture).toMatchObject({
      status: "formed",
      producer_operator_id: "structured_formation_parser_v1",
      source_hash: "sha256:source",
      fact_frame: proposal.fact_frame
    });
    expect(result.searchProjections.map(({ content }) => content)).toEqual([
      "I use Atlas for research",
      "use Atlas for research",
      "I Atlas for research",
      "I use for research",
      "I use Atlas"
    ]);
    expect(() => verifyEvidenceFactFrameFormationCapture(
      result.capture,
      sha256
    )).not.toThrow();
  });

  it.each([
    {
      name: "ineligible",
      input: { sourceAssertion: null, sourceHash: null },
      expected: "ineligible"
    },
    {
      name: "unavailable",
      input: {
        sourceAssertion: assertion,
        sourceHash: "sha256:source",
        normalizer: null
      },
      expected: "unavailable"
    },
    {
      name: "rejected",
      input: {
        sourceAssertion: "I use Nova.",
        sourceHash: "sha256:source",
        proposal
      },
      expected: "rejected"
    }
  ])("seals $name without deriving projections", ({ input, expected }) => {
    const result = materializeEvidenceFactFrameFormation(input);

    expect(result.capture.status).toBe(expected);
    expect(result.capture.fact_frame).toBeNull();
    expect(result.searchProjections).toEqual([]);
  });

  it("derives fact_key projections for a leading-adjunct first-person assertion", () => {
    const result = materializeEvidenceFactFrameFormation({
      sourceAssertion:
        "By the way, I took my niece to the Natural History Museum on 2/8",
      sourceHash: "sha256:source",
      normalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
    });

    expect(result.capture.status).toBe("formed");
    expect(result.searchProjections.length).toBeGreaterThan(0);
    expect(result.searchProjections.every(
      (projection) => projection.projection_kind === "fact_key"
    )).toBe(true);
  });

  it("leaves formation unavailable until a normalizer is explicitly injected", () => {
    const normalized = materializeEvidenceFactFrameFormation({
      sourceAssertion: "I bought a bookshelf from Target.",
      sourceHash: "sha256:source"
    });
    const injected = materializeEvidenceFactFrameFormation({
      sourceAssertion: "I bought a bookshelf from Target.",
      sourceHash: "sha256:source",
      normalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
    });
    const upstream = materializeEvidenceFactFrameFormation({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      proposal
    });

    expect(normalized.capture).toMatchObject({ status: "unavailable", producer_operator_id: null });
    expect(injected.capture).toMatchObject({
      status: "formed",
      producer_operator_id: "rule_based_evidence_fact_frame_normalizer_v1"
    });
    expect(upstream.capture.producer_operator_id)
      .toBe("structured_formation_parser_v1");
  });

  it("seals an injected normalizer identity and rejects mismatched output", () => {
    const result = materializeEvidenceFactFrameFormation({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      normalizer: {
        operator_id: "injected_normalizer_v1",
        propose: () => proposal
      }
    });

    expect(result.capture).toMatchObject({
      status: "rejected",
      producer_operator_id: "injected_normalizer_v1"
    });
    expect(result.searchProjections).toEqual([]);
  });

  it("records a normalizer invocation failure as rejected", () => {
    const result = materializeEvidenceFactFrameFormation({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      normalizer: {
        operator_id: "throwing_normalizer_v1",
        propose: () => { throw new Error("normalizer failed"); }
      }
    });

    expect(result.capture).toMatchObject({
      status: "rejected",
      producer_operator_id: "throwing_normalizer_v1"
    });
    expect(result.searchProjections).toEqual([]);
  });

  it("does not fabricate a producer identity for an oversized proposal id", () => {
    const result = materializeEvidenceFactFrameFormation({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      proposal: {
        ...proposal,
        producer_operator_id: "x".repeat(129)
      }
    });

    expect(result.capture).toMatchObject({
      status: "rejected",
      producer_operator_id: null
    });
  });

  it("replays a sealed formed capture through the same projection owner", () => {
    const formed = materializeEvidenceFactFrameFormation({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      proposal
    });

    const replayed = replayEvidenceFactFrameFormationCapture({
      sourceAssertion: assertion,
      sourceHash: "sha256:source",
      capture: formed.capture
    });

    expect(replayed).toEqual(formed);
    expect(() => replayEvidenceFactFrameFormationCapture({
      sourceAssertion: assertion,
      sourceHash: "sha256:other",
      capture: formed.capture
    })).toThrow("source hash mismatch");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
