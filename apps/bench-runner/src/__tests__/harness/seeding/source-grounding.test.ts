import { describe, expect, it } from "vitest";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import { attachCompileSourceGrounding } from "../../../harness/seeding/source-grounding.js";

describe("compile source grounding revalidation", () => {
  it("preserves the same unique verbatim assertion accepted by the provider", () => {
    const turnContent =
      "User: I redeemed a coupon last Sunday, which surprised me because I had forgotten it.\n" +
      "Assistant: Nice find.";
    const matchedText = "I redeemed a coupon last Sunday";
    const payload = attachCompileSourceGrounding(
      { matched_text: matchedText, distilled_fact: "User redeemed a coupon." },
      signalInput(turnContent, matchedText),
      turnContent
    );

    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: matchedText
    });
    expect(payload.distilled_fact).toBe(matchedText);
  });

  it("replays the provider locator instead of the model proposal", () => {
    const assertion = "I graduated with a degree in Business Administration.";
    const turnContent = `User: ${assertion}\nAssistant: Congratulations.`;
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        source_assertion: assertion,
        proposed_matched_text: assertion,
        full_turn_content: turnContent,
        source_locator: assertionLocator(1),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: assertion,
          proposed_matched_text: assertion,
          reasons: ["matched_text_expanded_to_source_assertion"]
        }
      },
      signalInput(turnContent, assertion),
      turnContent
    );

    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: assertion,
      proposed_matched_text: assertion
    });
    expect(payload.distilled_fact).toBe(assertion);
  });

  it("rejects a locator that selects an Assistant assertion", () => {
    const turnContent = "User: I moved to Paris.\nAssistant: You live in Berlin.";
    const payload = attachCompileSourceGrounding(
      {
        matched_text: "You live in Berlin.",
        source_assertion: "You live in Berlin.",
        proposed_matched_text: "LOCATOR_ONLY",
        full_turn_content: turnContent,
        source_locator: assertionLocator(2),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: "You live in Berlin.",
          proposed_matched_text: "LOCATOR_ONLY",
          reasons: []
        }
      },
      signalInput(turnContent, "You live in Berlin."),
      turnContent
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none",
      proposed_matched_text: "LOCATOR_ONLY"
    });
  });

  it.each([
    ["I moved to Berlin, e.g. for work.", "for work"],
    ["Alice chose Berlin over Paris. The former is cheaper.", "The former is cheaper."]
  ])("rejects a cached proposal that is not a self-contained assertion: %s", (turnContent, matchedText) => {
    const payload = attachCompileSourceGrounding(
      { matched_text: matchedText, distilled_fact: matchedText },
      signalInput(turnContent, matchedText),
      turnContent
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(payload).not.toHaveProperty("distilled_fact");
  });
});

function signalInput(turnContent: string, matchedText: string): BenchSignalSeedInput {
  return {
    signalKind: "potential_claim",
    objectKind: "activity",
    confidence: 0.9,
    distilledFact: matchedText,
    turnContent,
    matchedText,
    evidenceRef: "message-1",
    turnSeedIndex: 0,
    extractionProvider: "official_api_compile"
  };
}

function assertionLocator(assertionId: number) {
  return {
    contract_version: 2,
    kind: "assertion_catalog",
    assertion_id: assertionId
  };
}
