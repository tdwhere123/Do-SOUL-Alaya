import { AlayaError } from "../shared/alaya-error.js";

export const STEP_SEMANTIC_REQUEST_MODEL = "step-3.5-flash-2603" as const;
export const STEP_SEMANTIC_REQUEST_PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
export const STEP_SEMANTIC_HIGH_REQUEST_PROFILE = "step-3.5-2603-high-json-schema-v1" as const;

const reasoningEfforts = Object.freeze({
  [STEP_SEMANTIC_REQUEST_PROFILE]: "low",
  [STEP_SEMANTIC_HIGH_REQUEST_PROFILE]: "high"
} as const);
export type StepSemanticRequestProfile = keyof typeof reasoningEfforts;
export const STEP_SEMANTIC_REQUEST_PROFILES = Object.freeze(
  Object.keys(reasoningEfforts) as StepSemanticRequestProfile[]
);

export function isStepSemanticRequestProfile(value: unknown): value is StepSemanticRequestProfile {
  return typeof value === "string" && Object.hasOwn(reasoningEfforts, value);
}

/** A profile's effort is part of its persisted request identity, never an override. */
export function stepSemanticReasoningEffort(profile: StepSemanticRequestProfile): "low" | "high" {
  if (!isStepSemanticRequestProfile(profile)) throw new AlayaError("VALIDATION", "unsupported Step semantic request profile");
  return reasoningEfforts[profile];
}
