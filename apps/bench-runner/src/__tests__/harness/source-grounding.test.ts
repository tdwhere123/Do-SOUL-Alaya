import { describe, expect, it } from "vitest";
import type { BenchSignalSeedInput } from "../../harness/daemon.js";
import { attachCompileSourceGrounding } from "../../harness/seeding/source-grounding.js";

describe("compile source grounding revalidation", () => {
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
