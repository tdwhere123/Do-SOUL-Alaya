export const FORMATION_CONFIDENCE_MAP = Object.freeze({
  extracted: 0.6,
  explicit: 0.9,
  inferred: 0.4,
  derived: 0.5,
  imported: 0.7
} as const);

export type FormationConfidenceMap = typeof FORMATION_CONFIDENCE_MAP;
