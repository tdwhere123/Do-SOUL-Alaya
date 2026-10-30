import { describe, expect, it } from "vitest";
import { parseOfficialApiSignals } from "../../../garden/ingestion/compute-provider.js";
import { openSignal } from "./compute-provider-fixtures.js";

describe("retained signal parser", () => {
  it("inspects historical signals without requiring distilled_fact", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({ signals: [
      openSignal({ signal_kind: "potential_claim", object_kind: "decision", confidence: 0.7,
        matched_text: "We decided to ship on Friday" }),
      openSignal({ signal_kind: "potential_preference", object_kind: "user_preference", confidence: 0.8,
        matched_text: "Call me Ash", distilled_fact: "The operator prefers to be called Ash." }, 2),
      openSignal({ signal_kind: "potential_claim", object_kind: "fact", confidence: 0.6,
        matched_text: "The build runs nightly" }, 3)
    ] }));
    expect(drafts).toHaveLength(3);
  });

  it("preserves valid historical siblings when one entry is malformed", () => {
    const drafts = parseOfficialApiSignals(JSON.stringify({ signals: [
      openSignal({ signal_kind: "potential_preference", object_kind: "user_preference", confidence: 0.8,
        matched_text: "I prefer dark mode", distilled_fact: "The operator prefers dark mode in the editor." }),
      null,
      openSignal({ signal_kind: "potential_claim", object_kind: "decision", confidence: 0.75,
        matched_text: "we use TypeScript", distilled_fact: "The team uses TypeScript." }, 2)
    ] }));
    expect(drafts).toHaveLength(2);
  });
});
