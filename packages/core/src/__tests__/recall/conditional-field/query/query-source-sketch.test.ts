import { describe, expect, it } from "vitest";
import { CONDITIONAL_FIELD_SCHEMA_VERSION } from "@do-soul/alaya-protocol";
import {
  compileQuerySourceSketch,
  decodeSourceProposalPredicate
} from "../../../../recall/conditional-field/query/query-source-sketch.js";
import { UNINTERPRETED_HOLE_ID } from "../../../../recall/conditional-field/query/ordinary-language.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView
} from "../reference/deployment.fixture.js";

describe("query source sketch adapter", () => {
  it("adopts a relation sketch without claiming complete natural-language interpretation", () => {
    const original = "What corporate aspiration did SHADOW hold for all audiences, including unparsed extras?";
    const interpretation = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: {
        original_query: original,
        relation: {
          predicate: "corporate aspiration",
          arguments: [{ role: "content", phrase: "human potential" }],
          qualifiers: [{ role: "audience", phrase: "all audiences" }]
        },
        unresolved_alternatives: ["achieved capability"]
      }
    });
    expect(interpretation.status).toBe("partial");
    expect(interpretation.program.kind).toBe("epsilon");
    expect(interpretation.holes.some((hole) => hole.hole_id === UNINTERPRETED_HOLE_ID)).toBe(true);
    expect(interpretation.holes.some((hole) => hole.hole_id === "hole.query.alternative.1")).toBe(true);
    const adopted = decodeSourceProposalPredicate(
      interpretation.interpretation_proposal?.conditions?.[0]?.predicate_name
    );
    expect(adopted).toMatchObject({
      lookup_mode: "proposal",
      predicate_key: "corporate aspiration",
      arguments: [{ role: "content", phrase: "human potential" }],
      qualifiers: [{ role: "audience", phrase: "all audiences" }]
    });
    expect(interpretation.query_id).toBe(compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: {
        original_query: original,
        relation: {
          predicate: "corporate aspiration",
          arguments: [{ role: "content", phrase: "human potential" }],
          qualifiers: [{ role: "audience", phrase: "all audiences" }]
        },
        unresolved_alternatives: ["achieved capability"]
      }
    }).query_id);
  });

  it("keeps source-text lookup mode distinct from proposal lookup", () => {
    const sketch = {
      original_query: "find the full PC access context",
      relation: {
        predicate: "access",
        arguments: [{ role: "capability", phrase: "full PC" }]
      },
      lookup_mode: "source_text" as const
    };
    const interpretation = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      sketch
    });
    expect(decodeSourceProposalPredicate(
      interpretation.interpretation_proposal?.conditions?.[0]?.predicate_name
    )?.lookup_mode).toBe("source_text");
  });

  it("does not treat parse success as a resolved ordinary-language program", () => {
    const interpretation = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      sketch: { original_query: "show related sources" }
    });
    expect(interpretation.status).toBe("partial");
    expect(interpretation.program.kind).toBe("epsilon");
    expect(interpretation.interpretation_proposal).toBeUndefined();
    expect(interpretation.schema_version).toBe(CONDITIONAL_FIELD_SCHEMA_VERSION);
  });
});
