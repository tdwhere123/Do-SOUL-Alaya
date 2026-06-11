import {
  PathPlasticityStateSchema,
  type DirectionBias,
  type PathAnchorRef,
  type PathGovernanceClass,
  type PathLifecycleStatus,
  type PathPlasticityState,
  type PathRelation,
  type StabilityClass,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import { classifyPathImportance } from "../importance-gate.js";
import type { PromotionPlan } from "../path-graph/path-manifestation-policy.js";
import { PATH_PLASTICITY_CONSTANTS } from "./constants.js";
import type {
  MutableObjectUsageCounts,
  PathPlasticityRepoUpdate,
  RedirectionPublication
} from "./types.js";

export function clampStrength(value: number): number {
  return Math.min(
    PATH_PLASTICITY_CONSTANTS.STRENGTH_CEILING,
    Math.max(PATH_PLASTICITY_CONSTANTS.STRENGTH_FLOOR, value)
  );
}

export function maxIsoNullable(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export function computeUsedSignalWeight(
  record: Readonly<UsageProofRecord>,
  priorUsedCountForPath: number
): number {
  const repeatWeight = Math.pow(
    PATH_PLASTICITY_CONSTANTS.REPEATED_USED_DECAY_FACTOR,
    priorUsedCountForPath
  );
  const trustWeight =
    record.trust_mode === "automatic"
      ? PATH_PLASTICITY_CONSTANTS.AUTOMATIC_TRUST_USED_MULTIPLIER
      : 1;
  return repeatWeight * trustWeight;
}

export function parsePlasticityState(value: PathPlasticityState): Readonly<PathPlasticityState> {
  return PathPlasticityStateSchema.parse(value);
}

export function selectDirectionBias(
  current: DirectionBias,
  counts: Readonly<MutableObjectUsageCounts>
): DirectionBias {
  if (counts.sourceAnchorUsage > 0 && counts.targetAnchorUsage > 0) {
    return "bidirectional_asymmetric";
  }
  if (counts.targetAnchorUsage > 0) {
    return "source_to_target";
  }
  if (counts.sourceAnchorUsage > 0) {
    return "target_to_source";
  }
  return current;
}

export function createRedirectionPublication(
  previousDirectionBias: DirectionBias,
  newDirectionBias: DirectionBias,
  counts: Readonly<MutableObjectUsageCounts>,
  occurredAt: string
): RedirectionPublication | undefined {
  if (previousDirectionBias === newDirectionBias) {
    return undefined;
  }
  return {
    previousDirectionBias,
    newDirectionBias,
    sourceUsageCount: counts.sourceAnchorUsage,
    targetUsageCount: counts.targetAnchorUsage,
    occurredAt
  };
}

export function isRetiredPath(path: Readonly<PathRelation>): boolean {
  return (path.lifecycle as PathLifecycleWithStatus).status === "retired";
}

export function isDormantPath(path: Readonly<PathRelation>): boolean {
  return (path.lifecycle as PathLifecycleWithStatus).status === "dormant";
}

// invariant: recall_bias sign is the path-family discriminator for dormancy vs retirement.
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts:CO_RECALLED_SEED_PROFILE
export function isPositiveAssociativeFamily(path: Readonly<PathRelation>): boolean {
  return path.effect_vector.recall_bias > 0;
}

// invariant: only mergeable negative/neutral paths terminally retire; all others go dormant.
// see also: packages/core/src/importance-gate.ts:classifyPathImportance
export function shouldRouteToDormant(path: Readonly<PathRelation>): boolean {
  if (isPositiveAssociativeFamily(path)) {
    return true;
  }
  return classifyPathImportance(path).disposition !== "mergeable";
}

export function withClearedSalience(
  effectVector: PathRelation["effect_vector"]
): PathRelation["effect_vector"] {
  return Object.freeze({
    ...effectVector,
    salience: 0
  });
}

export function withRestoredSalience(
  effectVector: PathRelation["effect_vector"],
  salience: number
): PathRelation["effect_vector"] {
  return Object.freeze({
    ...effectVector,
    salience
  });
}

export function isObjectAnchor(anchor: PathAnchorRef, objectId: string): boolean {
  return anchor.kind === "object" && anchor.object_id === objectId;
}

export function isMemoryEntryAnchorUsage(
  usage: NonNullable<UsageProofRecord["per_anchor_usage"]>[number]
): boolean {
  return (usage.object_kind ?? "memory_entry") === "memory_entry";
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function withLifecycleStatus(
  lifecycle: PathRelation["lifecycle"],
  status: NonNullable<PathLifecycleWithStatus["status"]>
): PathRelation["lifecycle"] {
  return {
    ...lifecycle,
    status
  } as PathRelation["lifecycle"];
}

// invariant: PromotionPlan rewrites only stability_class and governance_class.
// see also: packages/core/src/path-graph/path-manifestation-policy.ts:PromotionPlan
export function buildUpdatesWithPromotion(params: {
  readonly path: Readonly<PathRelation>;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly lifecycleStatus: NonNullable<PathLifecycleWithStatus["status"]>;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
  readonly effectVector?: PathRelation["effect_vector"];
}): PathPlasticityRepoUpdate {
  const plasticityWithPromotion =
    params.promotion.stability === null
      ? params.nextPlasticity
      : PathPlasticityStateSchema.parse({
          ...params.nextPlasticity,
          stability_class: params.promotion.stability.next as StabilityClass
        });

  const legitimacyUpdate =
    params.promotion.governance === null
      ? null
      : {
          legitimacy: {
            ...params.path.legitimacy,
            governance_class: params.promotion.governance.next as PathGovernanceClass
          }
        };

  return Object.freeze({
    plasticity_state: plasticityWithPromotion,
    lifecycle: withLifecycleStatus(params.path.lifecycle, params.lifecycleStatus),
    updated_at: params.occurredAt,
    ...(legitimacyUpdate ?? {}),
    ...(params.effectVector === undefined ? {} : { effect_vector: params.effectVector })
  });
}

type PathLifecycleWithStatus = PathRelation["lifecycle"] & {
  readonly status?: PathLifecycleStatus;
};

export function throwIfPathPlasticityAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "Path plasticity compute aborted."
  );
  error.name = "AbortError";
  throw error;
}
