import { describe, expect, it } from "vitest";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { resolvePolicy } from "../../recall/runtime/orchestration.js";

function makePolicy(overrides?: Partial<RecallPolicy>): RecallPolicy {
  return {
    runtime_id: "00000000-0000-4000-8000-000000000001",
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: "00000000-0000-4000-8000-000000000002",
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: 100,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: 100,
        embedding_enabled: false
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: 10,
        per_dimension_limits: null
      },
      conflict_awareness: true
    },
    ...overrides
  };
}

describe("resolvePolicy", () => {
  it("applies defaultPolicyDecorator when policyOverride is present", () => {
    const override = makePolicy();
    const resolved = resolvePolicy({
      strategy: "chat",
      taskSurfaceRef: "00000000-0000-4000-8000-000000000002",
      policyOverride: override,
      buildDefaultPolicy: () => makePolicy({ runtime_id: "00000000-0000-4000-8000-000000000099" }),
      defaultPolicyDecorator: (policy) => ({
        ...policy,
        scoring_weight_overrides: {
          fusion_weights: {
            embedding_similarity: 12
          }
        }
      })
    });

    expect(resolved.scoring_weight_overrides?.fusion_weights?.embedding_similarity).toBe(12);
    expect(resolved.runtime_id).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("preserves caller fusion weight overrides over decorator defaults", () => {
    const override = makePolicy({
      scoring_weight_overrides: {
        fusion_weights: {
          embedding_similarity: 4
        }
      }
    });
    const resolved = resolvePolicy({
      strategy: "chat",
      taskSurfaceRef: "surface-1",
      policyOverride: override,
      buildDefaultPolicy: () => makePolicy(),
      defaultPolicyDecorator: (policy) => ({
        ...policy,
        scoring_weight_overrides: {
          fusion_weights: {
            embedding_similarity: 12,
            ...(policy.scoring_weight_overrides?.fusion_weights ?? {})
          }
        }
      })
    });

    expect(resolved.scoring_weight_overrides?.fusion_weights?.embedding_similarity).toBe(4);
  });
});
