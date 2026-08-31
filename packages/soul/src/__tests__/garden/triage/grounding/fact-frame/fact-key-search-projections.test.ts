import { describe, expect, it } from "vitest";
import {
  GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
  buildFactFrameFormationProposal
} from
  "../../../../../garden/triage/grounding/fact-frame/search-projections.js";

describe("fact-frame formation proposal", () => {
  it("proposes only a frame grounded in the verified assertion", () => {
    expect(buildFactFrameFormationProposal({
      source_assertion: "I use Atlas for research.",
      source_grounding: {
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: "I use Atlas for research."
      },
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "use" },
          { role: "value", text: "Atlas" },
          { role: "qualifier", text: "for research" }
        ]
      }
    })).toEqual({
      schema_version: 1,
      producer_operator_id: GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
      source_assertion: "I use Atlas for research.",
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "use" },
          { role: "value", text: "Atlas" },
          { role: "qualifier", text: "for research" }
        ]
      }
    });
  });

  it("preserves an ungrounded proposal for the canonical Core rejection", () => {
    expect(buildFactFrameFormationProposal({
      source_assertion: "I use Atlas.",
      source_grounding: {
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: "I use Atlas."
      },
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "use" },
          { role: "value", text: "Nova" }
        ]
      }
    })).toEqual(expect.objectContaining({
      producer_operator_id: GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
      source_assertion: "I use Atlas.",
      fact_frame: expect.objectContaining({
        slots: expect.arrayContaining([
          { role: "value", text: "Nova" }
        ])
      })
    }));
  });

  it("recovers a source-grounding-rejected proposal without changing Signal truth", () => {
    const proposedFactFrame = {
      schema_version: 1 as const,
      slots: [
        { role: "subject" as const, text: "I" },
        { role: "relation" as const, text: "use" },
        { role: "value" as const, text: "Nova" }
      ]
    };

    expect(buildFactFrameFormationProposal({
      source_assertion: "I use Atlas.",
      source_grounding: {
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: "I use Atlas.",
        proposed_fact_frame: proposedFactFrame,
        reasons: ["proposed_fact_frame_not_source_grounded"]
      }
    })).toEqual({
      schema_version: 1,
      producer_operator_id: GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
      source_assertion: "I use Atlas.",
      fact_frame: proposedFactFrame
    });
  });

  it("keeps a true upstream omission unavailable", () => {
    expect(buildFactFrameFormationProposal({
      source_assertion: "I use Atlas.",
      source_grounding: {
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: "I use Atlas."
      }
    })).toBeUndefined();
  });
});
