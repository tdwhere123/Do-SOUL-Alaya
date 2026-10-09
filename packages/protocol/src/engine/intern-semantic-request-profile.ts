import { isStepSemanticRequestProfile, type StepSemanticRequestProfile } from "./step-semantic-request-profile.js";

export const INTERN_SEMANTIC_REQUEST_MODEL = "Agents-A1" as const;
export const INTERN_SEMANTIC_REQUEST_PROFILE = "intern-agents-a1-json-guidance-v1" as const;
const INTERN_STRICT_SCHEMA_REQUEST_PROFILE = "intern-agents-a1-json-schema-v1" as const;
export const INTERN_SEMANTIC_REQUEST_PROFILES = [
  INTERN_SEMANTIC_REQUEST_PROFILE, INTERN_STRICT_SCHEMA_REQUEST_PROFILE
] as const;
export const INTERN_SEMANTIC_PROVIDER_URL = "https://discovery-api.intern-ai.org.cn/v1" as const;
export type InternSemanticRequestProfile = (typeof INTERN_SEMANTIC_REQUEST_PROFILES)[number];

/** Diagnostic requests only: provider acceptance and enforcement are unverified. */
export const INTERN_PROTOCOL_PROBE_PROFILES = [
  { profile: "intern-agents-a1-probe-json-object-v1", responseFormat: "json_object" },
  { profile: "intern-agents-a1-probe-json-schema-v1", responseFormat: "json_schema" }
] as const;
export type InternProtocolProbeProfile = (typeof INTERN_PROTOCOL_PROBE_PROFILES)[number]["profile"];

export function isInternProviderRequestProfile(value: unknown): value is InternSemanticRequestProfile | InternProtocolProbeProfile {
  return isInternSemanticRequestProfile(value) || INTERN_PROTOCOL_PROBE_PROFILES.some(row => row.profile === value);
}

export function internProviderResponseFormat(profile: InternSemanticRequestProfile | InternProtocolProbeProfile) {
  if (profile === INTERN_STRICT_SCHEMA_REQUEST_PROFILE) return "json_schema" as const;
  return INTERN_PROTOCOL_PROBE_PROFILES.find(row => row.profile === profile)?.responseFormat;
}

export function isInternSemanticRequestProfile(value: unknown): value is InternSemanticRequestProfile {
  return INTERN_SEMANTIC_REQUEST_PROFILES.some(profile => profile === value);
}

/** These native chat profiles share named schemas, inclusive usage and retained HTTP evidence. */
export function isChatSemanticRequestProfile(value: unknown): value is StepSemanticRequestProfile | InternSemanticRequestProfile {
  return isStepSemanticRequestProfile(value) || isInternSemanticRequestProfile(value);
}
