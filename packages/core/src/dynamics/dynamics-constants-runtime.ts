import { clamp01 } from "../shared/clamp.js";
import {
  DYNAMICS_CONSTANTS,
  FORMATION_CONFIDENCE_MAP,
  type DecayProfile,
  type FormationKind,
  type ManifestationState,
  type MemoryDimension
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const FRESHNESS_DECAY_DAYS = 30;
export const INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR = 0.6;

export const DIMENSION_DEFAULT_DECAY_PROFILE: Readonly<Record<MemoryDimension, DecayProfile>> =
  Object.freeze({
    preference: "stable",
    constraint: "stable",
    decision: "normal",
    procedure: "stable",
    fact: "normal",
    hazard: "hazard",
    glossary: "pinned",
    episode: "volatile"
  });

export function computeDecayedRetention(params: {
  readonly initialConfidence: number;
  readonly karmaSumAmount: number;
  readonly halfLifeMs: number;
  readonly rMin: number;
  readonly elapsedMs: number;
}): number {
  const initialConfidence = clamp01(params.initialConfidence);
  const karmaSumAmount = parseFinite(params.karmaSumAmount, "karmaSumAmount");
  const halfLifeMs = parseHalfLifeMs(params.halfLifeMs);
  const rMin = clamp01(params.rMin);
  const elapsedMs = Math.max(0, parseFinite(params.elapsedMs, "elapsedMs"));

  if (!Number.isFinite(halfLifeMs)) {
    return clamp01(Math.max(rMin, initialConfidence + karmaSumAmount));
  }

  const base = initialConfidence * Math.pow(2, -elapsedMs / halfLifeMs);
  return clamp01(Math.max(rMin, base + karmaSumAmount));
}

export function computeRetentionFromProfile(params: {
  readonly decayProfile: DecayProfile;
  readonly formationKind: FormationKind;
  readonly karmaSumAmount: number;
  readonly createdAt: string;
  readonly now?: string;
}): number {
  const profile = DYNAMICS_CONSTANTS.decay_profiles[params.decayProfile];

  if (profile === undefined) {
    throw new CoreError("VALIDATION", `Unknown decay profile: ${params.decayProfile}`);
  }

  const initialConfidence = FORMATION_CONFIDENCE_MAP[params.formationKind];

  if (initialConfidence === undefined) {
    throw new CoreError("VALIDATION", `Unknown formation kind: ${params.formationKind}`);
  }

  const nowIso = params.now ?? new Date().toISOString();
  const elapsedMs = toElapsedMs(params.createdAt, nowIso);

  return computeDecayedRetention({
    initialConfidence,
    karmaSumAmount: params.karmaSumAmount,
    halfLifeMs: profile.half_life,
    rMin: profile.r_min,
    elapsedMs
  });
}

export function determineManifestation(activationScore: number): ManifestationState {
  const score = clamp01(activationScore);
  const thresholds = DYNAMICS_CONSTANTS.manifestation_thresholds;

  if (score < thresholds.hidden_max) {
    return "hidden";
  }

  if (score < thresholds.hint_max) {
    return "hint";
  }

  if (score < thresholds.excerpt_max) {
    return "excerpt";
  }

  return "full_eligible";
}

export function computeFreshnessFactor(params: {
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly now?: string;
}): number {
  const nowIso = params.now ?? new Date().toISOString();
  const referenceIso = params.lastUsedAt ?? params.createdAt;
  const elapsedMs = toElapsedMs(referenceIso, nowIso);
  const daysSince = elapsedMs / MS_PER_DAY;

  return clamp01(1 - Math.min(1, daysSince / FRESHNESS_DECAY_DAYS));
}

function toElapsedMs(startIso: string, endIso: string): number {
  const startMs = parseIsoTimestamp(startIso, "startIso");
  const endMs = parseIsoTimestamp(endIso, "endIso");
  return Math.max(0, endMs - startMs);
}

function parseIsoTimestamp(value: string, field: string): number {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", `${field} is required`);
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new CoreError("VALIDATION", `${field} must be a valid ISO datetime`);
  }

  return timestamp;
}

function parseFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new CoreError("VALIDATION", `${field} must be a finite number`);
  }

  return value;
}

function parseHalfLifeMs(value: number): number {
  if (value === Infinity) {
    return value;
  }

  const parsed = parseFinite(value, "halfLifeMs");

  if (parsed <= 0) {
    throw new CoreError("VALIDATION", "halfLifeMs must be positive or Infinity");
  }

  return parsed;
}

export { clamp01 };
