import { describe, expect, it } from "vitest";
import { resolveSourceAssertion } from "../../../garden/grounding/source-assertion.js";

describe("source assertion boundaries", () => {
  it.each([
    [
      "I redeemed a coupon last Sunday, which surprised me because I had forgotten it.",
      "I redeemed a coupon last Sunday",
      "I redeemed a coupon last Sunday"
    ],
    [
      "By the way, it took me and my friends around 5 hours to move everything into the " +
        "new apartment, but it was worth it to be closer to work.",
      "it took me and my friends around 5 hours to move everything into the new apartment",
      "it took me and my friends around 5 hours to move everything into the new apartment"
    ]
  ])("accepts a bounded assertion without model punctuation: %s", (
    source,
    matchedText,
    assertion
  ) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({ status: "grounded", assertion });
  });

  it.each([
    ["I moved to Berlin.", "I moved to"],
    ["My favorite dog is a Golden Retriever.", "Golden Retriever"],
    ["I work remotely, when my office is closed.", "I work remotely"]
  ])("expands a fragment to the complete safe assertion: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({
      status: "grounded",
      assertion: source
    });
  });

  it.each([
    ["I selected the primary option. I think I'll use it", "I think I'll use it"],
    ["I like Berlin only when it rains.", "I like Berlin"],
    ["For Sophia, it was a cafe, and he lives there.", "For Sophia, it was a cafe, and he lives there"]
  ])("rejects a conditional or unresolved reference: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({ status: "rejected" });
  });

  it.each([
    ["AI moved to Berlin, which surprised users.", "I moved to Berlin"],
    ["bit took me five hours, but it was worth the effort.", "it took me five hours"]
  ])("rejects a match that begins inside another token: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({
      status: "rejected",
      reason: "matched_text_absent"
    });
  });
});
