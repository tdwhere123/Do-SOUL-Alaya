import { createHash } from "node:crypto";
import {
  SOURCE_ENRICHMENT_CONTRACT,
  canonicalizeSemanticExtractionProfile,
  semanticExtractionProfilesEqual,
  type SemanticExtractionProfile
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION } from "./formation-audit.js";
import { OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION } from "../official-api-signal-parser.js";
import { capabilityIdentity, OFFICIAL_API_SIGNALS_CAPABILITY, resolveExtractionCapability } from "./extraction-capability.js";
import { officialApiExtractionRequestTemplatePreimage } from "./extraction-request.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "./system-prompt.js";
import { OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE } from "./response-schema.js";

export {
  SOURCE_ENRICHMENT_CONTRACT,
  canonicalizeSemanticExtractionProfile,
  semanticExtractionProfilesEqual
};

export function computeSemanticArtifactKey(
  semanticKey: string,
  profile: SemanticExtractionProfile
): string {
  const canonical = canonicalizeSemanticExtractionProfile(profile);
  resolveExtractionCapability(canonical.capability);
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
    OFFICIAL_API_FORMATION_AUDIT_SEMANTICS_VERSION,
    createHash("sha256").update(OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE, "utf8").digest("hex"),
    createHash("sha256").update(OFFICIAL_API_SYSTEM_PROMPT, "utf8").digest("hex"),
    createHash("sha256").update(officialApiExtractionRequestTemplatePreimage(), "utf8").digest("hex")
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
