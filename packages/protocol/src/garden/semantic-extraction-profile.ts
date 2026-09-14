import type { SemanticExtractionProfile } from "./semantic-artifact.js";

export type { SemanticExtractionProfile };

export function canonicalizeSemanticExtractionProfile(
  profile: SemanticExtractionProfile
): SemanticExtractionProfile {
  const canonical: SemanticExtractionProfile = {
    capability: profile.capability,
    model: profile.model,
    requestProfile: profile.requestProfile,
    promptRevision: profile.promptRevision,
    outputSchema: profile.outputSchema
  };
  if (Object.values(canonical).some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("incomplete semantic extraction profile");
  }
  return canonical;
}

export function semanticExtractionProfilesEqual(
  left: SemanticExtractionProfile,
  right: SemanticExtractionProfile
): boolean {
  const a = canonicalizeSemanticExtractionProfile(left);
  const b = canonicalizeSemanticExtractionProfile(right);
  return a.capability === b.capability && a.model === b.model &&
    a.requestProfile === b.requestProfile && a.promptRevision === b.promptRevision &&
    a.outputSchema === b.outputSchema;
}

export function semanticExtractionProfilePreimage(
  profile: SemanticExtractionProfile
): readonly [string, string, string, string, string] {
  const canonical = canonicalizeSemanticExtractionProfile(profile);
  return [
    canonical.capability,
    canonical.model,
    canonical.requestProfile,
    canonical.promptRevision,
    canonical.outputSchema
  ];
}
