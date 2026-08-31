import { describe, expect, it } from "vitest";
import { resolveGardenSignalGrounding } from "../../../garden/triage/grounding/signal-source-grounding.js";
import { createSignal } from "../materialization/materialization-router-fixture.js";

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

  it("replays a rejected locator proposal from its source corpus", () => {
    const assertion = "I graduated with a degree in Business Administration.";
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        full_turn_content: `User: ${assertion}\nAssistant: Congratulations.`,
        source_locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 1
        },
        source_grounding: {
          version: 1,
          status: "rejected",
          content_basis: "none",
          proposed_matched_text: assertion,
          reasons: ["source_grounding_rejected"]
        }
      }
    });

    expect(resolveGardenSignalGrounding(signal)).toEqual({ status: "grounded", assertion });
  });

  it("preserves a concrete rejection while replaying a rejected proposal", () => {
    const assertion =
      "It's been super helpful for me, especially on days when I can't make it to Serenity Yoga.";
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        proposed_matched_text: assertion,
        full_turn_content: `User: ${assertion}`,
        source_grounding: {
          version: 1,
          status: "rejected",
          content_basis: "none",
          proposed_matched_text: assertion,
          reasons: ["source_grounding_rejected"]
        }
      }
    });

    expect(resolveGardenSignalGrounding(signal)).toEqual({
      status: "rejected",
      reason: "source_assertion_not_self_contained"
    });
  });
});
