import {
  type ActivationWeights,
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  PATH_PLASTICITY_WEIGHT,
  assertActivationWeightsSumToOne,
  clamp01,
  resolveActivationWeights,
  errorNameOf,
  toErrorMessage
} from "../runtime/recall-service-helpers.js";
import type { RecallServiceWarnPort } from "../runtime/recall-service-types.js";

const DEFAULT_ACTIVATION_WEIGHTS = resolveActivationWeights();
const pathPlasticityWeightCache = new WeakMap<Readonly<RecallPolicy>, number>();

export function computeMaxWeightTransferAmount(params: Readonly<{
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly graphAndPathColdScore: number;
  readonly warn: RecallServiceWarnPort;
}>): number {
  if (params.candidates.length === 0 || params.graphAndPathColdScore <= 0) {
    return 0;
  }
  const pathPlasticityWeight = resolvePathPlasticityWeight(params.policy);
  return clamp01(
    Math.max(
      ...params.candidates.map((candidate) => {
        const weights = resolveEffectiveActivationWeights(candidate, params.policy, params.warn);
        return (weights.graph_support + pathPlasticityWeight) * params.graphAndPathColdScore;
      })
    )
  );
}

export function resolveEffectiveActivationWeights(
  entry: Readonly<MemoryEntry>,
  policy: Readonly<RecallPolicy>,
  warn: RecallServiceWarnPort
): ActivationWeights {
  const overrides = policy.domain_weight_overrides;
  if (overrides === undefined) {
    return DEFAULT_ACTIVATION_WEIGHTS;
  }

  const matchedDomainTag = entry.domain_tags
    .filter((tag) => overrides[tag] !== undefined)
    .sort((left, right) => left.localeCompare(right))[0];

  if (matchedDomainTag === undefined) {
    return DEFAULT_ACTIVATION_WEIGHTS;
  }

  const resolved = resolveActivationWeights(overrides[matchedDomainTag]);
  try {
    assertActivationWeightsSumToOne(resolved);
    return resolved;
  } catch (error) {
    warn("ERROR: recall domain weight override invalid; falling back to base activation weights", {
      policy_id: policy.runtime_id,
      domain_tag: matchedDomainTag,
      operation: "recall_domain_weight_override_validation",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return DEFAULT_ACTIVATION_WEIGHTS;
  }
}

function resolvePathPlasticityWeight(policy: Readonly<RecallPolicy>): number {
  const cached = pathPlasticityWeightCache.get(policy);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = policy.scoring_weight_overrides?.additive?.PATH_PLASTICITY_WEIGHT
    ?? PATH_PLASTICITY_WEIGHT;
  pathPlasticityWeightCache.set(policy, resolved);
  return resolved;
}
