import {
  ControlPlaneObjectKind,
  MemoryDimensionSchema,
  type MemoryDimension,
  type RecallPolicy,
  RecallPolicySchema,
  RetentionPolicy,
  ScopeClassSchema,
  type ScopeClass,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import {
  RECALL_TOTAL_CANDIDATE_CAP,
  normalizeRecallCandidateLimit
} from "./internal/recall-candidate-limit.js";

export { RECALL_TOTAL_CANDIDATE_CAP };

export type RecallPolicyFilterSpec = Readonly<{
  readonly scopeFilter: readonly ScopeClass[] | null;
  readonly dimensionFilter: readonly MemoryDimension[] | null;
  readonly domainTagFilter: readonly string[] | null;
}>;

export type RecallPolicyBuilderInput = Readonly<{
  readonly runtimeId: string;
  readonly taskSurfaceId: string;
  readonly maxResults: number;
  readonly filters: RecallPolicyFilterSpec;
  readonly conflictAwareness: boolean;
  readonly maxTotalTokens: number;
  readonly coarseFloor?: number;
  readonly embeddingInjectionCap?: number | null;
  readonly embeddingInjectionSimilarityFloor?: number | null;
  readonly embeddingSupplementEnabled?: boolean;
}>;

export type RecallPolicyEmbeddingStateInput = Readonly<{
  readonly embeddingEnabled: boolean;
  readonly injectionCap?: number | null;
  readonly injectionSimilarityFloor?: number | null;
}>;

export type MemorySearchRecallPolicyInput = Readonly<Pick<
  RecallPolicyBuilderInput,
  "runtimeId" | "taskSurfaceId" | "maxResults" | "filters"
>>;

export function buildMemorySearchRecallPolicy(
  input: MemorySearchRecallPolicyInput
): RecallPolicy {
  const policy = buildRecallPolicy({
    ...input,
    conflictAwareness: true,
    maxTotalTokens: 2_000
  });
  return applyRecallPolicyEmbeddingState(policy, { embeddingEnabled: false });
}

export function resolveRecallPolicyFiltersFromSearchRequest(
  request: Pick<SoulMemorySearchRequest, "scope_class" | "dimension" | "domain_tags">
): RecallPolicyFilterSpec {
  return {
    scopeFilter:
      request.scope_class === null ? null : [ScopeClassSchema.parse(request.scope_class)],
    dimensionFilter:
      request.dimension === null ? null : [MemoryDimensionSchema.parse(request.dimension)],
    domainTagFilter: request.domain_tags
  };
}

export function buildRecallPolicy(input: RecallPolicyBuilderInput): RecallPolicy {
  const maxResults = Math.max(input.maxResults, 1);
  const limits = resolveRecallPolicyCandidateLimits(input, maxResults);
  const semanticSupplementEnabled = input.embeddingSupplementEnabled ?? true;

  const basePolicy: RecallPolicy = {
    runtime_id: input.runtimeId,
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: input.taskSurfaceId,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: input.filters.scopeFilter,
        dimension_filter: input.filters.dimensionFilter,
        domain_tag_filter: input.filters.domainTagFilter
      },
      precomputed_rank: {
        max_candidates: limits.coarse,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: semanticSupplementEnabled,
        max_supplement: limits.semantic,
        embedding_enabled: semanticSupplementEnabled
      }
    },
    fine_assessment: {
      max_candidates: limits.fine,
      budgets: {
        max_total_tokens: input.maxTotalTokens,
        max_entries: maxResults,
        per_dimension_limits: null
      },
      conflict_awareness: input.conflictAwareness
    }
  };
  if (input.embeddingInjectionCap == null && input.embeddingInjectionSimilarityFloor == null) {
    return basePolicy;
  }
  return applyRecallPolicyEmbeddingState(basePolicy, {
    embeddingEnabled: semanticSupplementEnabled,
    injectionCap: input.embeddingInjectionCap,
    injectionSimilarityFloor: input.embeddingInjectionSimilarityFloor
  });
}

function resolveRecallPolicyCandidateLimits(
  input: RecallPolicyBuilderInput,
  maxResults: number
): Readonly<{ coarse: number; semantic: number; fine: number }> {
  const coarseFloor = Number.isFinite(input.coarseFloor ?? 0)
    ? Math.max(input.coarseFloor ?? 0, 0)
    : 0;
  const coarse = Math.min(
    Math.max(maxResults * 10, maxResults, coarseFloor),
    RECALL_TOTAL_CANDIDATE_CAP
  );
  const keywordCandidateLimit = Math.min(
    Math.max(coarse, maxResults * 10, 1),
    RECALL_TOTAL_CANDIDATE_CAP
  );
  const semanticSupplementEnabled = input.embeddingSupplementEnabled ?? true;
  const fine = coarse +
    (semanticSupplementEnabled ? keywordCandidateLimit : 0);
  return Object.freeze({
    coarse,
    semantic: keywordCandidateLimit,
    fine: Math.min(fine, RECALL_TOTAL_CANDIDATE_CAP)
  });
}

export function applyRecallPolicyEmbeddingState(
  policy: Readonly<RecallPolicy>,
  input: RecallPolicyEmbeddingStateInput
): RecallPolicy {
  const semantic = policy.coarse_filter.semantic_supplement;
  const semanticEnabled = input.embeddingEnabled || semantic.enabled;
  const configuredCap = resolveConfiguredInjectionCap(input.injectionCap, semantic.injection_cap);
  const effectiveCap = input.embeddingEnabled
    ? resolveEffectiveInjectionCap(policy, semanticEnabled, configuredCap)
    : configuredCap;
  const floor = input.injectionSimilarityFloor ?? semantic.injection_similarity_floor;
  const fineMax = input.embeddingEnabled && effectiveCap !== undefined
    ? resolveEmbeddingFineCandidateBudget(policy, semanticEnabled, effectiveCap)
    : policy.fine_assessment.max_candidates;

  return {
    ...policy,
    coarse_filter: {
      ...policy.coarse_filter,
      semantic_supplement: {
        ...semantic,
        enabled: semanticEnabled,
        embedding_enabled: input.embeddingEnabled,
        ...(effectiveCap === undefined ? {} : { injection_cap: effectiveCap }),
        ...(floor === undefined ? {} : { injection_similarity_floor: floor })
      }
    },
    fine_assessment: {
      ...policy.fine_assessment,
      ...(fineMax === undefined ? {} : { max_candidates: fineMax })
    }
  };
}

function resolveConfiguredInjectionCap(
  requested: number | null | undefined,
  existing: number | undefined
): number | undefined {
  const configured = requested ?? existing;
  return configured === undefined ? undefined : normalizeRecallCandidateLimit(configured);
}

function resolveEffectiveInjectionCap(
  policy: Readonly<RecallPolicy>,
  semanticEnabled: boolean,
  configuredCap: number | undefined
): number | undefined {
  if (configuredCap === undefined) return undefined;
  const directBudget = resolveDirectCandidateBudget(policy, semanticEnabled);
  return Math.min(configuredCap, RECALL_TOTAL_CANDIDATE_CAP - directBudget);
}

function resolveEmbeddingFineCandidateBudget(
  policy: Readonly<RecallPolicy>,
  semanticEnabled: boolean,
  injectionCap: number
): number {
  const directBudget = resolveDirectCandidateBudget(policy, semanticEnabled);
  const existing = normalizeRecallCandidateLimit(policy.fine_assessment.max_candidates ?? 0);
  return Math.max(existing, directBudget + injectionCap);
}

function resolveDirectCandidateBudget(
  policy: Readonly<RecallPolicy>,
  semanticEnabled: boolean
): number {
  const semantic = policy.coarse_filter.semantic_supplement;
  return normalizeRecallCandidateLimit(Math.max(
    policy.fine_assessment.budgets.max_entries,
    policy.coarse_filter.precomputed_rank.max_candidates +
      (semanticEnabled ? semantic.max_supplement : 0)
  ));
}

export function parseRecallPolicy(value: RecallPolicy): Readonly<RecallPolicy> {
  try {
    return Object.freeze(RecallPolicySchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid recall policy payload", { cause: error });
  }
}
