import { createHash } from "node:crypto";
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

  it("keeps semantic enrichment task ids stable across profile field order", () => {
    const canonical = canonicalizeSemanticExtractionProfile(profile);
    const reordered = canonicalizeSemanticExtractionProfile({
      outputSchema: profile.outputSchema,
      promptRevision: profile.promptRevision,
      requestProfile: profile.requestProfile,
      model: profile.model,
      capability: profile.capability
    });
    const left = enrichmentTaskId("ws", "obj", "rev", canonical);
    const right = enrichmentTaskId("ws", "obj", "rev", reordered);
    expect(left).toBe(right);
  });
});

function enrichmentTaskId(
  workspaceId: string,
  objectId: string,
  revision: string,
  profile: SemanticExtractionProfile
): string {
  return `semantic:${digest(JSON.stringify([
    workspaceId,
    objectId,
    revision,
    ...semanticExtractionProfilePreimage(profile)
  ]))}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
