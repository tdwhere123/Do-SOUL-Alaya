import { describe, expect, it } from "vitest";
import { buildOfficialApiSourceAssertions } from "../../garden/grounding/source-locator.js";

describe("official API source locator direct-question boundary", () => {
  it.each([
    "Do you have recommendations for a collar brand or type that suits a Golden Retriever?",
    "By the way, do you know whether Max is a Golden Retriever?",
    "I am getting Max a collar, do you know whether Max is a Golden Retriever?",
    "I am thinking about Max, would a Golden Retriever need a large collar?",
    "By the way: do you know whether Max is a Golden Retriever?",
    "By the way — do you know whether Max is a Golden Retriever?",
    "By the way do you know whether Max is a Golden Retriever?",
    "Just wondering: what breed is Max?",
    "Quick question — is Max a Golden Retriever?"
  ])("does not publish a top-level direct question: %s", (source) => {
    expect(buildOfficialApiSourceAssertions(source)).toEqual([]);
  });

  it("keeps one bounded first-person assertion followed by an indirect question", () => {
    const source = "I'm thinking of visiting my sister Emily in Denver, and I was wondering if you knew any attractions there?";
    expect(buildOfficialApiSourceAssertions(source).map(({ text }) => text)).toEqual([
      "I'm thinking of visiting my sister Emily in Denver"
    ]);
  });

  it("publishes a self-contained declaration before a bounded conversational tail question", () => {
    const source = "The play I attended was actually a production of The Glass Menagerie, have you heard of it?";
    expect(buildOfficialApiSourceAssertions(source).map(({ text }) => text)).toEqual([
      "The play I attended was actually a production of The Glass Menagerie"
    ]);
  });

  it.each([
    "Can I reserve a hotel, have you heard of it?",
    "What movie should I watch, have you heard of it?",
    "I was wondering whether I should reserve a hotel, have you heard of it?",
    "I am curious whether I should reserve a hotel, have you heard of it?",
    "I need to know whether I should reserve a hotel, have you heard of it?",
    "I would like to know whether I should reserve a hotel, have you heard of it?",
    "Tell me a hotel, have you heard of it?",
    "Please tell me a hotel, have you heard of it?",
    "The best hotel, have you heard of it?",
    "My hotel, have you heard of it?",
    "The book I read, have you heard of it?",
    "The place I went, have you heard of it?",
    "The hotel you recommend is good, have you heard of it?",
    "The book you suggest is interesting, have you heard of it?",
    "The book was any good, have you heard of it?",
    "The book was good at all, have you heard of it?",
    "The book was a good read or not, have you heard of it?"
  ])("does not mistake a direct question for a conversational tail declaration: %s", (source) => {
    expect(buildOfficialApiSourceAssertions(source)).toEqual([]);
  });

  it("does not publish a typed prefix when a bare comma would expand it back to the question", () => {
    const source = "I am thinking of visiting our cousin Alex in New York City soon, I was wondering whether you knew any museums there?";
    expect(buildOfficialApiSourceAssertions(source)).toEqual([]);
  });

  it.each([
    "I moved to Denver, and I was wondering whether Denver is expensive, should I reserve a hotel?",
    "I moved to Denver, and I was wondering whether Denver is expensive, what is the rent?",
    "I moved to Denver, and I was wondering whether Denver is expensive: should I reserve a hotel?"
  ])("does not wrap a direct question in the indirect-question allowance: %s", (source) => {
      expect(buildOfficialApiSourceAssertions(source)).toEqual([]);
    });

  it.each([
    "I moved to Denver, should I reserve a hotel, and I was wondering whether Denver is expensive?",
    "I moved to Denver: should I reserve a hotel, and I was wondering whether Denver is expensive?",
    "I moved to Denver — should I reserve a hotel, and I was wondering whether Denver is expensive?",
    "I moved to Denver - should I reserve a hotel, and I was wondering whether Denver is expensive?",
    "I moved to Denver (should I reserve a hotel), and I was wondering whether Denver is expensive?",
    "I moved to Denver [should I reserve a hotel], and I was wondering whether Denver is expensive?",
    "I moved to Denver / should I reserve a hotel, and I was wondering whether Denver is expensive?",
    "I moved to Denver，should I reserve a hotel, and I was wondering whether Denver is expensive?"
  ])("does not publish a direct question embedded in an indirect-question prefix: %s", (source) => {
    expect(buildOfficialApiSourceAssertions(source)).toEqual([]);
  });
});
