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
  const coarseFloor = Number.isFinite(input.coarseFloor ?? 0)
    ? Math.max(input.coarseFloor ?? 0, 0)
    : 0;
  const coarseCandidateLimit = Math.min(Math.max(maxResults * 10, maxResults, coarseFloor), 1000);
  const keywordCandidateLimit = Math.min(
    Math.max(coarseCandidateLimit, maxResults * 10, 1),
    1000
  );

  return {
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
        max_candidates: coarseCandidateLimit,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: input.embeddingSupplementEnabled ?? true,
        max_supplement: keywordCandidateLimit,
        embedding_enabled: true,
        ...(input.embeddingInjectionCap === undefined || input.embeddingInjectionCap === null
          ? {}
          : { injection_cap: input.embeddingInjectionCap }),
        ...(input.embeddingInjectionSimilarityFloor == null
          ? {}
          : { injection_similarity_floor: input.embeddingInjectionSimilarityFloor })
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: input.maxTotalTokens,
        max_entries: maxResults,
        per_dimension_limits: null
      },
      conflict_awareness: input.conflictAwareness
    }
  };
}

export function parseRecallPolicy(value: RecallPolicy): Readonly<RecallPolicy> {
  try {
    return Object.freeze(RecallPolicySchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid recall policy payload", { cause: error });
  }
}
