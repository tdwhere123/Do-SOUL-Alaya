import { describe, expect, it } from "vitest";
import { buildFactKeySearchProjections } from
  "../../../garden/grounding/fact-frame/search-projections.js";

describe("fact-key search projections", () => {
  it("rebuilds projections only from the grounded assertion and frame", () => {
    expect(buildFactKeySearchProjections({
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
    })).toEqual([
      { projection_id: 1, projection_kind: "fact_key", content: "I use Atlas for research" },
      { projection_id: 2, projection_kind: "fact_key", content: "use Atlas for research" },
      { projection_id: 3, projection_kind: "fact_key", content: "I Atlas for research" },
      { projection_id: 4, projection_kind: "fact_key", content: "I use for research" },
      { projection_id: 5, projection_kind: "fact_key", content: "I use Atlas" }
    ]);
  });

  it("produces no index when the frame is not grounded in the assertion", () => {
    expect(buildFactKeySearchProjections({
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
    })).toEqual([]);
  });
});
