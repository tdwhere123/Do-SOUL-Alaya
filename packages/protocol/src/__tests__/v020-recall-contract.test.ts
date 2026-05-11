import { describe, expect, it } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass
} from "../index.js";
import { BudgetSnapshotSchema } from "../soul/budget-snapshot.js";
import { SoulMemorySearchRequestSchema } from "../soul/mcp-types.js";
import { RecallCandidateSchema } from "../soul/recall-candidate.js";
import {
  ActivationWeightsPatchSchema,
  RecallPolicySchema
} from "../soul/recall-policy.js";

const envelopeBase = {
  runtime_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
  task_surface_ref: null,
  derived_from: null,
  retention_policy: RetentionPolicy.PERSISTENT,
  expires_at: null
} as const;

const recallPolicyBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.RECALL_POLICY,
  coarse_filter: {
    deterministic_match: {
      scope_filter: ["project"],
      dimension_filter: ["preference", "constraint"],
      domain_tag_filter: ["repo", "workflow"]
    },
    precomputed_rank: {
      max_candidates: 20,
      min_activation_score: 0.2
    },
    semantic_supplement: {
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    }
  },
  fine_assessment: {
    budgets: {
      max_total_tokens: 3000,
      max_entries: 25,
      per_dimension_limits: {
        preference: 10,
        constraint: 5
      }
    },
    conflict_awareness: true
  }
} as const;

describe("v0.2 recall protocol contract", () => {
  it("defaults BudgetSnapshot.pressure_ratio for old payloads and bounds explicit values", () => {
    const oldSnapshot = {
      snapshot_at: "2026-05-11T00:00:00.000Z",
      run_id: "run-1",
      current_mode: "lean",
      bankruptcy_kind: "soft",
      trigger_summary: null,
      active_dossier: null,
      pending_proposal: null
    };

    expect(BudgetSnapshotSchema.parse(oldSnapshot).pressure_ratio).toBe(0);
    expect(BudgetSnapshotSchema.parse({ ...oldSnapshot, pressure_ratio: 0.75 }).pressure_ratio).toBe(0.75);
    expect(BudgetSnapshotSchema.safeParse({ ...oldSnapshot, pressure_ratio: -0.1 }).success).toBe(false);
    expect(BudgetSnapshotSchema.safeParse({ ...oldSnapshot, pressure_ratio: 1.1 }).success).toBe(false);
  });

  it("accepts soul.recall host_context hints without requiring them", () => {
    const baseRequest = {
      query: "deployment rules",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5
    };

    expect(SoulMemorySearchRequestSchema.parse(baseRequest).host_context).toBeUndefined();
    expect(
      SoulMemorySearchRequestSchema.parse({
        ...baseRequest,
        host_context: {
          tokenizer_hint: "cl100k",
          host_context_window: 128000
        }
      }).host_context
    ).toEqual({
      tokenizer_hint: "cl100k",
      host_context_window: 128000
    });
    expect(
      SoulMemorySearchRequestSchema.safeParse({
        ...baseRequest,
        host_context: { tokenizer_hint: "unknown" }
      }).success
    ).toBe(false);
  });

  it("accepts domain weight overrides as partial activation-weight patches", () => {
    expect(ActivationWeightsPatchSchema.parse({ relevance: 0.2 })).toEqual({ relevance: 0.2 });

    const parsed = RecallPolicySchema.parse({
      ...recallPolicyBase,
      domain_weight_overrides: {
        docs: {
          scope_match: 0.08,
          relevance: 0.2
        }
      }
    });

    expect(parsed.domain_weight_overrides?.docs).toEqual({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(RecallPolicySchema.parse(recallPolicyBase).domain_weight_overrides).toBeUndefined();
  });

  it("keeps RecallScoreFactors backward-compatible and accepts resolved activation weights", () => {
    const baseCandidate = {
      object_id: "memory-1",
      object_kind: "memory_entry",
      activation_score: 0.7,
      relevance_score: 0.64,
      content_preview: "Use pnpm for workspace commands.",
      token_estimate: 7,
      manifestation: "excerpt",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      score_factors: {
        activation: 0.7,
        relevance: 0.64,
        graph_support: 0,
        path_plasticity: 0,
        budget_penalty: 0
      }
    };

    expect(RecallCandidateSchema.parse(baseCandidate).score_factors?.resolved_activation_weights).toBeUndefined();
    expect(
      RecallCandidateSchema.parse({
        ...baseCandidate,
        score_factors: {
          ...baseCandidate.score_factors,
          resolved_activation_weights: {
            scope_match: 0.18,
            domain_match: 0.18,
            retention: 0.18,
            freshness: 0.16,
            relevance: 0.1,
            graph_support: 0.05,
            budget_penalty: 0.1,
            conflict_penalty: 0.05
          }
        }
      }).score_factors?.resolved_activation_weights?.relevance
    ).toBe(0.1);
  });
});
