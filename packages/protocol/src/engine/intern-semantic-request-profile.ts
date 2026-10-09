import { isStepSemanticRequestProfile, type StepSemanticRequestProfile } from "./step-semantic-request-profile.js";

export const INTERN_SEMANTIC_REQUEST_MODEL = "Agents-A1" as const;
export const INTERN_SEMANTIC_REQUEST_PROFILE = "intern-agents-a1-json-guidance-v1" as const;
export const INTERN_SEMANTIC_PROVIDER_URL = "https://discovery-api.intern-ai.org.cn/v1" as const;
export type InternSemanticRequestProfile = typeof INTERN_SEMANTIC_REQUEST_PROFILE;

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
  return INTERN_PROTOCOL_PROBE_PROFILES.find(row => row.profile === profile)?.responseFormat;
}

export function isInternSemanticRequestProfile(value: unknown): value is InternSemanticRequestProfile {
  return value === INTERN_SEMANTIC_REQUEST_PROFILE;
}

/** These native chat profiles share named schemas, inclusive usage and retained HTTP evidence. */
export function isChatSemanticRequestProfile(value: unknown): value is StepSemanticRequestProfile | InternSemanticRequestProfile {
  return isStepSemanticRequestProfile(value) || isInternSemanticRequestProfile(value);
}
