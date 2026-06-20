import {
  ControlPlaneObjectKind,
  MemoryDimensionSchema,
  RetentionPolicy,
  ScopeClassSchema,
  type RecallPolicy,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";

export function dedupeDeliveredObjectIdentities(
  objects: readonly { readonly object_id: string; readonly object_kind: string }[]
): readonly { readonly object_id: string; readonly object_kind: string }[] {
  const seen = new Set<string>();
  const result: Array<{ readonly object_id: string; readonly object_kind: string }> = [];
  for (const object of objects) {
    const key = `${object.object_kind}\0${object.object_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(object);
  }
  return Object.freeze(result);
}

export function uniqueObjectIds(
  objects: readonly { readonly object_id: string }[]
): readonly string[] {
  return Object.freeze([...new Set(objects.map((object) => object.object_id))]);
}

export function buildRecallPolicy(
  request: SoulMemorySearchRequest,
  taskSurfaceId: string,
  policyId: string
): RecallPolicy {
  const maxResults = Math.max(request.max_results, 1);
  const coarseCandidateLimit = resolveRecallCoarseCandidateLimit(maxResults);
  const keywordCandidateLimit = resolveRecallKeywordCandidateLimit(maxResults, coarseCandidateLimit);

  return {
    runtime_id: policyId,
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: taskSurfaceId,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: request.scope_class === null ? null : [ScopeClassSchema.parse(request.scope_class)],
        dimension_filter: request.dimension === null ? null : [MemoryDimensionSchema.parse(request.dimension)],
        domain_tag_filter: request.domain_tags
      },
      precomputed_rank: {
        max_candidates: coarseCandidateLimit,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: keywordCandidateLimit,
        embedding_enabled: true
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: maxResults,
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  };
}

function resolveRecallCoarseCandidateLimit(maxResults: number): number {
  return Math.min(Math.max(maxResults * 10, maxResults), 1000);
}

function resolveRecallKeywordCandidateLimit(maxResults: number, coarseCandidateLimit: number): number {
  return Math.min(Math.max(coarseCandidateLimit, maxResults * 10, 1), 1000);
}
