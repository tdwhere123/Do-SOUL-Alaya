import { describe, expect, it } from "vitest";
import { resolveSourceAssertion } from "../../../garden/grounding/source-assertion.js";

describe("source assertion boundaries", () => {
  it.each([
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
    [
      "I redeemed a coupon last Sunday, which was a nice surprise since I had forgotten it.",
      "I redeemed a coupon last Sunday",
      "I redeemed a coupon last Sunday"
    ],
    [
      "User: I redeemed a coupon last Sunday, which surprised me because I had forgotten it.\n" +
        "Assistant: Nice find.",
      "I redeemed a coupon last Sunday",
      "I redeemed a coupon last Sunday"
    ],
    [
      "For my sister's birthday, I got her a yellow dress and matching earrings.",
      "I got her a yellow dress and matching earrings",
      "For my sister's birthday, I got her a yellow dress and matching earrings."
    ],
    [
      "I'm thinking of going back to Hawaii, I loved it when I went with my family.",
      "I loved it when I went with my family",
      "I'm thinking of going back to Hawaii, I loved it when I went with my family."
    ],
    [
      "I made a lemon blueberry cake for my niece and it was a huge hit.",
      "I made a lemon blueberry cake for my niece and it was a huge hit.",
      "I made a lemon blueberry cake for my niece and it was a huge hit."
    ],
    [
      "I finally beat that last boss in the Dark Souls 3 DLC last weekend.",
      "I finally beat that last boss in the Dark Souls 3 DLC last weekend.",
      "I finally beat that last boss in the Dark Souls 3 DLC last weekend."
    ],
    [
      "I've been listening to this playlist on Spotify that I created, called Summer Vibes.",
      "I've been listening to this playlist on Spotify that I created, called Summer Vibes.",
      "I've been listening to this playlist on Spotify that I created, called Summer Vibes."
    ]
  ])("grounds source-verbatim assertions with a local antecedent: %s", (
    source,
    matchedText,
    assertion
  ) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({ status: "grounded", assertion });
  });

  it.each([
    [
      "User: I'm thinking of getting Max a new collar with a nice name tag. " +
        "Do you know a collar type that would suit a Golden Retriever like Max?",
      "I'm thinking of getting Max a new collar with a nice name tag. " +
        "Do you know a collar type that would suit a Golden Retriever like Max?"
    ]
  ])("grounds an exact assertion whose reference has one explicit local antecedent: %s", (
    source,
    assertion
  ) => {
    expect(resolveSourceAssertion(source, assertion)).toEqual({ status: "grounded", assertion });
  });

  it.each([
    [
      "The play I attended was actually a production of The Glass Menagerie, have you heard of it?",
      "The play I attended was actually a production of The Glass Menagerie",
      "The play I attended was actually a production of The Glass Menagerie"
    ],
    [
      "I have fished in Lake Michigan. I caught 12 largemouth bass on my last trip there.",
      "I caught 12 largemouth bass on my last trip there",
      "I have fished in Lake Michigan. I caught 12 largemouth bass on my last trip there."
    ],
    [
      "I made a lemon blueberry cake for my niece's birthday party and it was a huge hit.",
      "I made a lemon blueberry cake for my niece's birthday party and it was a huge hit.",
      "I made a lemon blueberry cake for my niece's birthday party and it was a huge hit."
    ],
    [
      "I got my new stand mixer as a birthday gift from my sister, and it's been a game-changer.",
      "I got my new stand mixer as a birthday gift from my sister, and it's been a game-changer.",
      "I got my new stand mixer as a birthday gift from my sister, and it's been a game-changer."
    ],
    [
      "I've been using a lavender shampoo that I picked up at Trader Joe's, and it's doing wonders.",
      "I've been using a lavender shampoo that I picked up at Trader Joe's, and it's doing wonders.",
      "I've been using a lavender shampoo that I picked up at Trader Joe's, and it's doing wonders."
    ],
    [
      "My recent trip was to Outer Banks in North Carolina - it took four hours to drive there.",
      "My recent trip was to Outer Banks in North Carolina - it took four hours to drive there.",
      "My recent trip was to Outer Banks in North Carolina - it took four hours to drive there."
    ],
    [
      "I've used my GPS, like when I drove for six hours to Washington D.C. recently, " +
        "but I'm not sure about my next route.",
      "I drove for six hours to Washington D.C. recently",
      "I've used my GPS, like when I drove for six hours to Washington D.C. recently"
    ],
    [
      "I stayed in a hostel in Tokyo that cost around $30 per night, so it's possible to find deals.",
      "I stayed in a hostel in Tokyo that cost around $30 per night",
      "I stayed in a hostel in Tokyo that cost around $30 per night, so it's possible to find deals."
    ],
    [
      "I've been listening to this one playlist on Spotify that I created, called Summer Vibes, " +
        "and it's got all these chill tracks that are perfect for relaxing.",
      "I've been listening to this one playlist on Spotify that I created, called Summer Vibes, " +
        "and it's got all these chill tracks that are perfect for relaxing.",
      "I've been listening to this one playlist on Spotify that I created, called Summer Vibes, " +
        "and it's got all these chill tracks that are perfect for relaxing."
    ],
    [
      "I've fished in Lake Michigan, and I've found that spinner lures work well. " +
        "I caught 12 largemouth bass on my last trip there, so you could target those as well.",
      "I caught 12 largemouth bass on my last trip there",
      "I've fished in Lake Michigan, and I've found that spinner lures work well. " +
        "I caught 12 largemouth bass on my last trip there, so you could target those as well."
    ]
  ])("closes compound assertions without rewriting their source: %s", (
    source,
    matchedText,
    assertion
  ) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({ status: "grounded", assertion });
    expect(source.includes(assertion)).toBe(true);
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

  it.each([
    ["I told Bob, who already knew, the secret.", "I told Bob"],
    ["I am, which is true.", "I am"],
    ["I think, which is fine.", "I think"],
    ["I almost quit, which I didn't.", "I almost quit"],
    ["I quit my job, which she later said wasn't what happened.", "I quit my job"],
    ["I quit my job, which was a lie.", "I quit my job"],
    ["I quit my job, which turned out to be a misunderstanding.", "I quit my job"],
    ["I almost quit; which I didn't.", "I almost quit"],
    ["I almost quit — which I didn't.", "I almost quit"],
    ["I almost quit (which I didn't).", "I almost quit"]
  ])("rejects relative-clause prefixes without classifying their semantics: %s", (
    source,
    matchedText
  ) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({ status: "rejected" });
  });

  it.each([
    ["I quit my job, which I didn't regret.", "I quit my job"],
    ["I quit my job, which I never did regret.", "I quit my job"],
    ["I chose the blue dress, which was wrong for the occasion.", "I chose the blue dress"],
    [
      "I redeemed a coupon last Sunday, which surprised me because I had forgotten it was fake.",
      "I redeemed a coupon last Sunday"
    ]
  ])("does not guess whether a relative suffix retracts its prefix: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({ status: "rejected" });
  });

  it("rejects the safe surprise wording when the proposed assertion is ambiguous", () => {
    const source =
      "I redeemed a coupon last Sunday. Later, I redeemed a coupon last Sunday, " +
      "which surprised me because I had forgotten it.";
    expect(resolveSourceAssertion(source, "I redeemed a coupon last Sunday")).toEqual({
      status: "rejected",
      reason: "matched_text_ambiguous"
    });
  });

  it.each([
    ["I think so", "I think so"],
    ["I am sure", "I am sure"],
    ["I'm sure", "I'm sure"],
    ["I’m sure", "I’m sure"],
    ["I guess so", "I guess so"],
    ["I want", "I want"],
    ["I need", "I need"],
    ["I hope", "I hope"],
    ["I believe", "I believe"],
    ["I was", "I was"],
    ["I can", "I can"],
    ["I should", "I should"],
    ["I will", "I will"],
    ["I do", "I do"],
    ["I'd say", "I'd say"]
  ])("rejects vacuous first-person stubs: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({ status: "rejected" });
  });

  it("rejects a duration prefix whose object is still an unresolved reference", () => {
    const source = "it took me 5 hours to finish it, but it was worth it";
    const matchedText = "it took me 5 hours to finish it";
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({
      status: "rejected",
      reason: "source_assertion_not_self_contained"
    });
  });

  it("grounds a self-contained cross-sentence verbatim match", () => {
    const source = "I bought a red bike yesterday. I paid two hundred dollars.";
    const matchedText = "I bought a red bike yesterday. I paid two hundred dollars.";
    expect(resolveSourceAssertion(source, matchedText)).toEqual({
      status: "grounded",
      assertion: matchedText
    });
  });

  it("keeps non-verbatim reporting paraphrases deferred", () => {
    const source = "I remember Alex telling me he marinated the BBQ ribs for 24 hours.";
    const matchedText = "Alex told me he marinated the BBQ ribs for 24 hours";
    expect(resolveSourceAssertion(source, matchedText)).toEqual({
      status: "rejected",
      reason: "matched_text_absent"
    });
  });

  it.each([
    [
      "I was thinking about my flea market find, and I realized that it's actually worth triple what I paid for it, which is amazing!",
      "I realized that it's actually worth triple what I paid for it, which is amazing!"
    ]
  ])("expands a uniquely typed local reference to its self-contained sentence: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({
      status: "grounded",
      assertion: source
    });
  });

  it("grounds a bounded template-slot assertion only when the field and subject are explicit", () => {
    const source = 'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a coffee shop in the city.';
    expect(resolveSourceAssertion(source, source)).toEqual({ status: "grounded", assertion: source });
  });

  it.each([
    ["My sister met my mother, and I gave her a gift.", "My sister met my mother, and I gave her a gift."],
    ["I traveled from Paris to Rome. I enjoyed it there.", "I enjoyed it there."],
    ["Alex and Jordan said he would call.", "Alex and Jordan said he would call."],
    ["I bought a vase and a painting, and it was expensive.", "I bought a vase and a painting, and it was expensive."],
    ["I bought my vase and painting, and it was expensive.", "I bought my vase and painting, and it was expensive."],
    [
      "I was thinking about my vase and painting, and I realized that it's worth triple what I paid for it.",
      "I realized that it's worth triple what I paid for it."
    ],
    [
      "I was thinking about my flea market find, and I realized that it's raining.",
      "I realized that it's raining."
    ],
    [
      "I was thinking about my photo of the painting, and I realized that it's worth triple what I paid for it.",
      "I realized that it's worth triple what I paid for it."
    ],
    [
      "I remember Alice telling me he marinated some ribs before grilling them.",
      "I remember Alice telling me he marinated some ribs before grilling them."
    ],
    [
      "I remember Alex telling me he cooked some ribs for friends before serving them.",
      "I remember Alex telling me he cooked some ribs for friends before serving them."
    ],
    [
      "I remember Alex and Jordan telling me he marinated some ribs before grilling them.",
      "I remember Alex and Jordan telling me he marinated some ribs before grilling them."
    ],
    [
      "I remember Alex telling me he marinated some ribs and vegetables before grilling them.",
      "I remember Alex telling me he marinated some ribs and vegetables before grilling them."
    ],
    [
      "By the way, I was thinking of trying out some BBQ ribs for my party, and I remember Alex telling me he marinated them in a special sauce for 24 hours before grilling them to perfection.",
      "I remember Alex telling me he marinated them in a special sauce for 24 hours before grilling them to perfection."
    ],
    [
      "Under How We Met, I'll include the location where I met them. For Sophia, it was a cafe.",
      "Under How We Met, I'll include the location where I met them. For Sophia, it was a cafe."
    ],
    [
      'Under "Favorite Color", I\'ll include the location where I met them. For Sophia, it was a cafe.',
      'Under "Favorite Color", I\'ll include the location where I met them. For Sophia, it was a cafe.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia and Mark, it was a cafe.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia and Mark, it was a cafe.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe she liked.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe she liked.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the former cafe.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the former cafe.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the same place.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the same place.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the aforementioned cafe.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the aforementioned cafe.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Them, it was a coffee shop.',
      'Under "How We Met", I\'ll include the location where I met them. For Them, it was a coffee shop.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near the park by its entrance.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near the park by its entrance.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the other cafe near the park.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the other cafe near the park.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the previous cafe.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the previous cafe.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe and the park.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe and the park.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near ours.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near ours.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near theirs.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near theirs.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the red one.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the red one.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a different one.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a different one.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the place.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was the place.'
    ],
    [
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near the place.',
      'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a cafe near the place.'
    ]
  ])("rejects a local pronoun with competing antecedents: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({
      status: "rejected",
      reason: "source_assertion_not_self_contained"
    });
  });
});
