import type { DecayProfile, FormationKind, MemoryDimension } from "./memory-entry.js";

export const INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR = 0.6;
const legacyPolicy = (confidence: number) => Object.freeze({
  confidence, initial_retention: confidence,
  initial_activation: confidence * INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR
});
export const FORMATION_DYNAMICS_POLICY = Object.freeze({
  extracted: legacyPolicy(0.6), explicit: legacyPolicy(0.9),
  inferred: legacyPolicy(0.4), derived: legacyPolicy(0.5), imported: legacyPolicy(0.7)
});
export const DIMENSION_DEFAULT_DECAY_PROFILE: Readonly<Record<MemoryDimension, DecayProfile>> = Object.freeze({
  preference: "stable", constraint: "stable", decision: "normal", procedure: "stable",
  fact: "normal", hazard: "hazard", glossary: "pinned", episode: "volatile", observation: "normal"
});
export const OBSERVATION_DYNAMICS_POLICY = Object.freeze({
  confidence: null, initial_retention: 0.5, initial_activation: 0.3,
  decay_profile: DIMENSION_DEFAULT_DECAY_PROFILE.observation
});

export function resolveMemoryDynamicsPolicy(dimension: MemoryDimension, formationKind: FormationKind) {
  return dimension === "observation" ? OBSERVATION_DYNAMICS_POLICY : Object.freeze({
    ...FORMATION_DYNAMICS_POLICY[formationKind], decay_profile: DIMENSION_DEFAULT_DECAY_PROFILE[dimension]
  });
}

// Compatibility for consumers that explicitly ask for the historical formation
// score. Observation retention and activation never use this projection.
export const FORMATION_CONFIDENCE_MAP = Object.freeze({
  extracted: FORMATION_DYNAMICS_POLICY.extracted.confidence,
  explicit: FORMATION_DYNAMICS_POLICY.explicit.confidence,
  inferred: FORMATION_DYNAMICS_POLICY.inferred.confidence,
  derived: FORMATION_DYNAMICS_POLICY.derived.confidence,
  imported: FORMATION_DYNAMICS_POLICY.imported.confidence
});

export type FormationConfidenceMap = typeof FORMATION_CONFIDENCE_MAP;
