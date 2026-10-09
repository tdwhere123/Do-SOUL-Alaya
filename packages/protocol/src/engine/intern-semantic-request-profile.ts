import { isStepSemanticRequestProfile, type StepSemanticRequestProfile } from "./step-semantic-request-profile.js";

export const INTERN_SEMANTIC_REQUEST_MODEL = "Agents-A1" as const;
export const INTERN_SEMANTIC_REQUEST_PROFILE = "intern-agents-a1-json-guidance-v1" as const;
export const INTERN_SEMANTIC_PROVIDER_URL = "https://discovery-api.intern-ai.org.cn/v1" as const;
export type InternSemanticRequestProfile = typeof INTERN_SEMANTIC_REQUEST_PROFILE;

export function isInternSemanticRequestProfile(value: unknown): value is InternSemanticRequestProfile {
  return value === INTERN_SEMANTIC_REQUEST_PROFILE;
}

/** These native chat profiles share named schemas, inclusive usage and retained HTTP evidence. */
export function isChatSemanticRequestProfile(value: unknown): value is StepSemanticRequestProfile | InternSemanticRequestProfile {
  return isStepSemanticRequestProfile(value) || isInternSemanticRequestProfile(value);
}
