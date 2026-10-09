import { LONGMEMEVAL_EXTRACTION_REQUEST_PROFILES } from "@do-soul/alaya-eval/authority";
import { isInternSemanticRequestProfile, isStepSemanticRequestProfile } from "@do-soul/alaya-protocol";

export const EXTRACTION_REQUEST_PROFILES = LONGMEMEVAL_EXTRACTION_REQUEST_PROFILES;

export const CURRENT_EXTRACTION_REQUEST_PROFILES = Object.freeze(
  EXTRACTION_REQUEST_PROFILES.filter((profile) => profile !== "deepseek-v4-nonthinking-v1")
);

export type ExtractionRequestProfile =
  (typeof EXTRACTION_REQUEST_PROFILES)[number];
export type CurrentExtractionRequestProfile =
  (typeof CURRENT_EXTRACTION_REQUEST_PROFILES)[number];

export function isExtractionRequestProfile(
  value: unknown
): value is ExtractionRequestProfile {
  return typeof value === "string" &&
    (EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value);
}

export function isCurrentExtractionRequestProfile(
  value: unknown
): value is CurrentExtractionRequestProfile {
  return typeof value === "string" &&
    (CURRENT_EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value);
}

export type NativeGeminiRequestProfile = Extract<ExtractionRequestProfile, `gemini-${string}`>;

export function isNativeGeminiRequestProfile(value: unknown): value is NativeGeminiRequestProfile {
  return isExtractionRequestProfile(value) && value.startsWith("gemini-");
}

/** Persisted transport vocabulary keeps each provider family explicit. */
export function interactiveSourceTransportBinding(profile: string) {
  if (isInternSemanticRequestProfile(profile)) return {
    kind: "intern_chat_completion", transport: "intern-chat-completion"
  } as const;
  if (isStepSemanticRequestProfile(profile)) return {
    kind: "step_chat_completion", transport: "step-chat-completion"
  } as const;
  return { kind: "gemini_generate_content", transport: "gemini-generate-content" } as const;
}
