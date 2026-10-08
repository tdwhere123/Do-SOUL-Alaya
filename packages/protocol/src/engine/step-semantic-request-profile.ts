import { AlayaError } from "../shared/alaya-error.js";

export const STEP_SEMANTIC_REQUEST_MODEL = "step-3.5-flash-2603" as const;
export const STEP_SEMANTIC_REQUEST_PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
export const STEP_SEMANTIC_HIGH_REQUEST_PROFILE = "step-3.5-2603-high-json-schema-v1" as const;
export const STEP_PREVIEW_REQUEST_PROFILE = "step-5-preview-low-json-schema-v1" as const;

const bindings = Object.freeze({
  [STEP_SEMANTIC_REQUEST_PROFILE]: { model: STEP_SEMANTIC_REQUEST_MODEL, effort: "low" },
  [STEP_SEMANTIC_HIGH_REQUEST_PROFILE]: { model: STEP_SEMANTIC_REQUEST_MODEL, effort: "high" },
  [STEP_PREVIEW_REQUEST_PROFILE]: { model: "step-5-preview", effort: "low" }
} as const);
export type StepSemanticRequestProfile = keyof typeof bindings;
export const STEP_SEMANTIC_REQUEST_PROFILES = Object.freeze(
  Object.keys(bindings) as StepSemanticRequestProfile[]
);

export function isStepSemanticRequestProfile(value: unknown): value is StepSemanticRequestProfile {
  return typeof value === "string" && Object.hasOwn(bindings, value);
}

/** A profile's effort is part of its persisted request identity, never an override. */
export function stepSemanticReasoningEffort(profile: StepSemanticRequestProfile): "low" | "high" {
  if (!isStepSemanticRequestProfile(profile)) throw new AlayaError("VALIDATION", "unsupported Step semantic request profile");
  return bindings[profile].effort;
}

/** Transport, catalog and cost admission bind a profile to this exact model. */
export function stepSemanticRequestModel(profile: StepSemanticRequestProfile) {
  if (!isStepSemanticRequestProfile(profile)) throw new AlayaError("VALIDATION", "unsupported Step semantic request profile");
  return bindings[profile].model;
}
