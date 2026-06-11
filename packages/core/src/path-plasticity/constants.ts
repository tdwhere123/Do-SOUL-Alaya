import { DYNAMICS_CONSTANTS } from "@do-soul/alaya-protocol";

// invariant: path-plasticity tuning mirrors protocol dynamics constants.
export const PATH_PLASTICITY_CONSTANTS = Object.freeze({
  USED_DELTA: DYNAMICS_CONSTANTS.path_plasticity.reinforcement_increment,
  SKIPPED_DELTA: Math.abs(DYNAMICS_CONSTANTS.path_plasticity.weakening_decrement),
  REPEATED_USED_DECAY_FACTOR: 0.5,
  AUTOMATIC_TRUST_USED_MULTIPLIER: 0.5,
  STRENGTH_FLOOR: DYNAMICS_CONSTANTS.path_plasticity.strength_floor,
  STRENGTH_CEILING: DYNAMICS_CONSTANTS.path_plasticity.strength_ceiling,
  RETIREMENT_STRENGTH_THRESHOLD: DYNAMICS_CONSTANTS.path_plasticity.retirement_strength_threshold,
  RETIREMENT_INACTIVITY_MS: DYNAMICS_CONSTANTS.path_plasticity.retirement_inactivity_ms,
  REVIVE_STRENGTH: DYNAMICS_CONSTANTS.path_plasticity.revive_strength
} as const);
