import { describe, expect, it } from "vitest";
import {
  parseOfficialApiSignals,
  parseOfficialApiSignalsReceipt
} from "../../../garden/ingestion/official-api-signal-parser.js";
import { withOpenSemanticFactorGraph } from "./compute-provider-fixtures.js";

function validEntry(matchedText: string): string {
  return JSON.stringify(withOpenSemanticFactorGraph({
    signal_kind: "potential_preference",
    object_kind: "user_preference",
    confidence: 0.9,
    matched_text: matchedText,
    distilled_fact: `The operator stated: ${matchedText}`,
    reason: "stated_preference"
  }));
}

describe("parseOfficialApiSignalsReceipt", () => {
  it("persists recoveryKind none and discardedCount 0 for a strict envelope", () => {
    const receipt = parseOfficialApiSignalsReceipt(
      `{"signals":[${validEntry("Call me Ash")}]}`
    );
    expect(receipt.recoveryKind).toBe("none");
    expect(receipt.discardedCount).toBe(0);
    expect(receipt.drafts).toHaveLength(1);
  });

  it("persists salvage recoveryKind and counts a truncated final element as discarded", () => {
    const envelope =
      `{"signals":[` +
      validEntry("First complete fact") +
      `,{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"this got cut off mid str`;
    const receipt = parseOfficialApiSignalsReceipt(envelope);
    expect(receipt.recoveryKind).toBe("salvage");
    expect(receipt.discardedCount).toBe(1);
    expect(receipt.drafts.map((draft) => draft.matched_text)).toEqual(["First complete fact"]);
    expect(parseOfficialApiSignals(envelope)).toEqual(receipt.drafts);
  });

  it("does not invent closers for a truncated-only envelope", () => {
    const envelope =
      `{"signals":[{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"`;
    expect(() => parseOfficialApiSignalsReceipt(envelope)).toThrow(
      /signals envelope unparseable and no element recoverable/u
    );
  });
});
