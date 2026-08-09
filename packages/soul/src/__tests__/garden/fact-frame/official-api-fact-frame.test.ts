import { describe, expect, it } from "vitest";
import { parseOfficialApiSignals } from "../../../garden/official-api-signal-parser.js";
import { groundOfficialApiDraft } from "../../../garden/official-api/source-grounding.js";
import { withOpenSemanticFactorGraph } from "../compute-provider-fixtures.js";

function envelope(factFrame: unknown): string {
  return JSON.stringify({
    signals: [withOpenSemanticFactorGraph({
      signal_kind: "potential_claim",
      object_kind: "fact",
      confidence: 0.9,
      matched_text: "I started using Atlas for research in March.",
      distilled_fact: "I started using Atlas for research in March.",
      evidence_refs: [],
      source_memory_refs: [],
      fact_frame: factFrame
    })]
  });
}

const validFactFrame = {
  schema_version: 1,
  slots: [
    { role: "subject", text: "I" },
    { role: "relation", text: "started using" },
    { role: "value", text: "Atlas" },
    { role: "qualifier", text: "for research" },
    { role: "time", text: "in March" }
  ]
} as const;

describe("official API associative fact frame", () => {
  it("preserves a structurally valid proposal through parsing", () => {
    const [draft] = parseOfficialApiSignals(envelope(validFactFrame));

    expect(draft?.fact_frame).toEqual(validFactFrame);
  });

  it("keeps only a frame grounded in the selected source assertion", () => {
    const [draft] = parseOfficialApiSignals(envelope(validFactFrame));
    const grounded = groundOfficialApiDraft(
      draft!,
      "I started using Atlas for research in March."
    );

    expect(grounded.status).toBe("grounded");
    expect(grounded.draft.fact_frame).toEqual(validFactFrame);
    expect(grounded.audit.proposed_fact_frame).toEqual(validFactFrame);
  });

  it("removes the complete frame when one proposed slot is not source grounded", () => {
    const [draft] = parseOfficialApiSignals(envelope({
      ...validFactFrame,
      slots: validFactFrame.slots.map((slot) =>
        slot.role === "value" ? { ...slot, text: "Nova" } : slot
      )
    }));
    const grounded = groundOfficialApiDraft(
      draft!,
      "I started using Atlas for research in March."
    );

    expect(grounded.status).toBe("grounded");
    expect(grounded.draft.fact_frame).toBeUndefined();
    expect(grounded.audit.reasons).toContain("proposed_fact_frame_not_source_grounded");
  });
});
