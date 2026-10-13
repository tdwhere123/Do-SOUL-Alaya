import { describe, expect, it } from "vitest";
import {
  canonicalizeSemanticExtractionProfile,
  semanticExtractionProfilePreimage,
  semanticExtractionProfilesEqual,
  type SemanticExtractionProfile
} from "../../garden/semantic-extraction-profile.js";

describe("semantic extraction profile canonicalizer", () => {
  const profile: SemanticExtractionProfile = {
    capability: "official-api-signals",
    model: "official-api-interactive",
    requestProfile: "logical-request-v1",
    promptRevision: "official-api-system-prompt",
    outputSchema: "official-api-signals-v1"
  };

  it("rejects incomplete profiles", () => {
    expect(() => canonicalizeSemanticExtractionProfile({ ...profile, model: "  " }))
      .toThrow("incomplete semantic extraction profile");
  });

  it("ignores object field order when building the array preimage", () => {
    const reordered: SemanticExtractionProfile = {
      outputSchema: profile.outputSchema,
      promptRevision: profile.promptRevision,
      requestProfile: profile.requestProfile,
      model: profile.model,
      capability: profile.capability
    };
    expect(semanticExtractionProfilePreimage(reordered))
      .toEqual(semanticExtractionProfilePreimage(profile));
    expect(semanticExtractionProfilesEqual(reordered, profile)).toBe(true);
  });

  it("defines the ordered semantic profile preimage consumed by task identity", () => {
    expect(semanticExtractionProfilePreimage(profile)).toEqual([
      "official-api-signals", "official-api-interactive", "logical-request-v1",
      "official-api-system-prompt", "official-api-signals-v1"
    ]);
  });
});
