import { describe, expect, it } from "vitest";
import { resolveGardenSignalGrounding } from "../../garden/grounding/signal-source-grounding.js";
import { createSignal } from "./materialization-router-fixture.js";

describe("resolveGardenSignalGrounding product trust boundary", () => {
  const FULL_TURN = "I moved to Berlin last year and still work remotely.";
  const MATCH = "I moved to Berlin last year";

  it("rejects grounding when only bench_full_turn_content is present", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        proposed_matched_text: MATCH,
        bench_full_turn_content: FULL_TURN
      }
    });
    expect(resolveGardenSignalGrounding(signal)).toEqual({
      status: "rejected",
      reason: "source_grounding_missing"
    });
  });

  it("grounds when bench content is projected into full_turn_content", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        proposed_matched_text: MATCH,
        full_turn_content: FULL_TURN
      }
    });
    const grounding = resolveGardenSignalGrounding(signal);
    expect(grounding.status).toBe("grounded");
  });
});
