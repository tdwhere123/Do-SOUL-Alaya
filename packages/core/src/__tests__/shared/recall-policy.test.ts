import { describe, expect, it } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import {
  buildRecallPolicy,
  resolveRecallPolicyFiltersFromSearchRequest
} from "../../shared/recall-policy.js";

describe("buildRecallPolicy", () => {
  it("builds production-style policy from request filters", () => {
    const request: Pick<
      SoulMemorySearchRequest,
      "scope_class" | "dimension" | "domain_tags"
    > = {
      scope_class: ScopeClass.GLOBAL_CORE,
      dimension: MemoryDimension.HAZARD,
      domain_tags: ["bench-open-tag"]
    };
    const policy = buildRecallPolicy({
      runtimeId: "policy-mcp",
      taskSurfaceId: "surface-mcp",
      maxResults: 12,
      filters: resolveRecallPolicyFiltersFromSearchRequest(request),
      conflictAwareness: true,
      maxTotalTokens: 2000
    });

    expect(policy.object_kind).toBe(ControlPlaneObjectKind.RECALL_POLICY);
    expect(policy.task_surface_ref).toBe("surface-mcp");
    expect(policy.retention_policy).toBe(RetentionPolicy.SESSION_ONLY);
    expect(policy.coarse_filter.deterministic_match).toMatchObject({
      scope_filter: [ScopeClass.GLOBAL_CORE],
      dimension_filter: [MemoryDimension.HAZARD],
      domain_tag_filter: ["bench-open-tag"]
    });
    expect(policy.coarse_filter.precomputed_rank.max_candidates).toBe(120);
    expect(policy.coarse_filter.precomputed_rank.min_activation_score).toBeNull();
    expect(policy.coarse_filter.semantic_supplement).toMatchObject({
      enabled: true,
      max_supplement: 120,
      embedding_enabled: true
    });
    expect(policy.fine_assessment.budgets).toMatchObject({
      max_total_tokens: 2000,
      max_entries: 12,
      per_dimension_limits: null
    });
    expect(policy.fine_assessment.conflict_awareness).toBe(true);
    expect(policy.fine_assessment.max_candidates).toBe(240);
  });

  it("supports open filters and diagnostic overrides for bench-style policies", () => {
    const policy = buildRecallPolicy({
      runtimeId: "policy-bench",
      taskSurfaceId: "surface-bench",
      maxResults: 3,
      filters: {
        scopeFilter: null,
        dimensionFilter: null,
        domainTagFilter: null
      },
      conflictAwareness: false,
      maxTotalTokens: 4096,
      coarseFloor: 25,
      embeddingInjectionCap: 7,
      embeddingInjectionSimilarityFloor: 0.33
    });

    expect(policy.coarse_filter.deterministic_match).toMatchObject({
      scope_filter: null,
      dimension_filter: null,
      domain_tag_filter: null
    });
    expect(policy.coarse_filter.precomputed_rank.max_candidates).toBe(30);
    expect(policy.coarse_filter.precomputed_rank.min_activation_score).toBeNull();
    expect(policy.fine_assessment.budgets).toMatchObject({
      max_total_tokens: 4096,
      max_entries: 3
    });
    expect(policy.fine_assessment.conflict_awareness).toBe(false);
    expect(policy.fine_assessment.max_candidates).toBe(67);
    expect(policy.coarse_filter.semantic_supplement.injection_cap).toBe(7);
    expect(policy.coarse_filter.semantic_supplement.injection_similarity_floor).toBe(0.33);
  });

  it("omits embedding injection knobs when not provided", () => {
    const policy = buildRecallPolicy({
      runtimeId: "policy-minimal",
      taskSurfaceId: "surface-minimal",
      maxResults: 1,
      filters: {
        scopeFilter: null,
        dimensionFilter: null,
        domainTagFilter: null
      },
      conflictAwareness: true,
      maxTotalTokens: 2000
    });

    expect(policy.coarse_filter.semantic_supplement).not.toHaveProperty("injection_cap");
    expect(policy.coarse_filter.semantic_supplement).not.toHaveProperty(
      "injection_similarity_floor"
    );
  });
});
