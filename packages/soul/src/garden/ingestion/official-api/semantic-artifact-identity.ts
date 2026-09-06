import { createHash } from "node:crypto";
import type { SemanticExtractionProfile } from "@do-soul/alaya-protocol";
import { OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION } from "./formation-audit.js";
import { OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION } from "../official-api-signal-parser.js";
import { capabilityIdentity, OFFICIAL_API_SIGNALS_CAPABILITY } from "./extraction-capability.js";

export const SOURCE_ENRICHMENT_CONTRACT = "source_enrichment.v1";

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

export function computeSemanticArtifactKey(
  semanticKey: string,
  profile: SemanticExtractionProfile
): string {
  const canonical = canonicalizeSemanticExtractionProfile(profile);
  if (!/^[a-f0-9]{64}$/u.test(semanticKey)) {
    throw new Error("semantic artifact key requires an assertion semantic key");
  }
  return createHash("sha256").update(JSON.stringify([
    semanticKey,
    canonical.capability,
    canonical.model,
    canonical.requestProfile,
    canonical.promptRevision,
    canonical.outputSchema,
    OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
    OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION
  ]), "utf8").digest("hex");
}

export function defaultSourceEnrichmentProfile(input: {
  readonly model?: string;
  readonly promptRevision?: string;
} = {}): SemanticExtractionProfile {
  return canonicalizeSemanticExtractionProfile({
    capability: capabilityIdentity(OFFICIAL_API_SIGNALS_CAPABILITY),
    model: input.model ?? "official-api-interactive",
    requestProfile: "logical-request-v1",
    promptRevision: input.promptRevision ?? "official-api-system-prompt",
    outputSchema: "official-api-signals-v1"
  });
}

export function tenantArtifactReuseAllowed(
  artifactWorkspaceId: string,
  requestWorkspaceId: string
): boolean {
  return artifactWorkspaceId === requestWorkspaceId;
}
