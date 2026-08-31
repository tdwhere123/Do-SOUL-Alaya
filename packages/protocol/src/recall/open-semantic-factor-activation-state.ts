import { z } from "zod";

// Join reconstruction is a first-class provenance, not a bench-only widening.
// Authority-lane phase schema is a different operator family — do not copy it here.
export const OPEN_SEMANTIC_FACTOR_ACTIVATION_STATES = [
  "observed",
  "reconstructed"
] as const;

export const OpenSemanticFactorActivationStateSchema = z.enum(
  OPEN_SEMANTIC_FACTOR_ACTIVATION_STATES
);

export type OpenSemanticFactorActivationState =
  typeof OPEN_SEMANTIC_FACTOR_ACTIVATION_STATES[number];
