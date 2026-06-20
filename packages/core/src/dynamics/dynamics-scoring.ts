import {
  DYNAMICS_CONSTANTS,
  type ManifestationState,
  type MemoryEntry,
  type RetentionState,
  type ScopeClass
} from "@do-soul/alaya-protocol";

import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  MS_PER_DAY,
  clamp01,
  computeFreshnessFactor,
  computeRetentionFromProfile,
  determineManifestation
} from "./dynamics-constants-runtime.js";

import { computeDomainMatch } from "./dynamics-service-ports.js";

export interface ResolveRetentionStateParams {
  readonly memory: Readonly<MemoryEntry>;
  readonly retentionScore: number;
  readonly reinforcementCount: number;
  readonly lifecycleState: MemoryEntry["lifecycle_state"];
  readonly supersededBy: string | null;
  readonly currentRetentionState: RetentionState | null;
  readonly now: string;
}

export interface ActivationContext {
  readonly currentScopeClass: ScopeClass;
  readonly currentDomainTags: readonly string[];
  readonly now: string;
}

export function resolveRetentionState(params: ResolveRetentionStateParams): RetentionState {
  if (params.lifecycleState === "tombstone") {
    return "tombstoned";
  }

  if (params.lifecycleState === "archived") {
    return params.supersededBy === null ? "archived" : "tombstoned";
  }

  const ageMs = Math.max(0, Date.parse(params.now) - Date.parse(params.memory.created_at));
  const ageDays = ageMs / MS_PER_DAY;

  if (params.retentionScore >= 0.7 && params.reinforcementCount >= 3 && ageDays >= 30) {
    return "canon";
  }

  // Entry threshold: working -> consolidated at retention >= 0.5 (spec: task-4b-2 line 102).
  if (params.retentionScore >= 0.5 && params.reinforcementCount >= 1 && ageDays >= 7) {
    return "consolidated";
  }

  // Hysteresis band: consolidated -> working only when retention drops below 0.4.
  if (params.currentRetentionState === "consolidated" && params.retentionScore >= 0.4) {
    return "consolidated";
  }

  return "working";
}

export function computeRetentionFromKarma(memory: Readonly<MemoryEntry>, karmaSum: number, now: string): number {
  const decayProfile = memory.decay_profile ?? DIMENSION_DEFAULT_DECAY_PROFILE[memory.dimension];

  return computeRetentionFromProfile({
    decayProfile,
    formationKind: memory.formation_kind,
    karmaSumAmount: karmaSum,
    createdAt: memory.created_at,
    now
  });
}

export function computeActivationScore(memory: Readonly<MemoryEntry>, context: ActivationContext): number {
  const weights = DYNAMICS_CONSTANTS.activation_weights_phase1b;

  const scopeMatch = memory.scope_class === context.currentScopeClass ? 1 : 0.5;
  const domainMatch = computeDomainMatch(memory.domain_tags, context.currentDomainTags);
  const retention = memory.retention_score ?? 0;
  const freshness = computeFreshnessFactor({
    lastUsedAt: memory.last_used_at,
    createdAt: memory.created_at,
    now: context.now
  });

  return clamp01(
    scopeMatch * weights.scope_match +
      domainMatch * weights.domain_match +
      retention * weights.retention +
      freshness * weights.freshness
  );
}

export { determineManifestation };
export type { ManifestationState };
