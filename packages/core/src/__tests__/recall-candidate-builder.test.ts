import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  buildRecallCandidate,
  rebuildRecallBudgetStateForDelivery
} from "../recall-candidate-builder.js";
import type { CoarseRecallCandidate, TokenEstimator } from "../recall-service-types.js";

const tokenEstimator: TokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4)
};

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function createCoarseCandidate(overrides: Partial<CoarseRecallCandidate> = {}): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry(),
    ...overrides
  };
}

function createScoreFactors(overrides: Partial<RecallScoreFactors> = {}): RecallScoreFactors {
  return {
    activation: 0.7,
    relevance: 0.6,
    graph_support: 0,
    path_plasticity: 0,
    budget_penalty: 0,
    conflict_penalty: 0,
    ...overrides
  };
}

describe("recall-candidate-builder", () => {
  it("builds stable candidate explainability and budget state", () => {
    const candidate = buildRecallCandidate({
      candidate: createCoarseCandidate({ sourceChannel: "warm_cascade" }),
      relevanceScore: 0.6,
      scoreFactors: createScoreFactors({ path_plasticity: 0.5 }),
      tokenEstimator,
      budgets: {
        max_entries: 5,
        max_total_tokens: 20,
        per_dimension_limits: {}
      },
      index: 1,
      usedTokensBeforeCandidate: 4
    });

    expect(candidate.object_id).toBe("memory-1");
    expect(candidate.source_channels).toEqual([
      "ranked_recall",
      "workspace_local",
      "path_plasticity",
      "warm_cascade"
    ]);
    expect(candidate.budget_state).toEqual({
      token_estimate: 8,
      max_entries: 5,
      max_total_tokens: 20,
      remaining_entries: 3,
      remaining_tokens: 8,
      within_budget: true
    });
  });

  it("rebuilds delivery budget state after candidate ordering changes", () => {
    const first = buildRecallCandidate({
      candidate: createCoarseCandidate({ entry: createMemoryEntry({ object_id: "memory-1", content: "Alpha" }) }),
      relevanceScore: 0.8,
      scoreFactors: createScoreFactors({ relevance: 0.8 }),
      tokenEstimator,
      budgets: { max_entries: 2, max_total_tokens: 4, per_dimension_limits: {} },
      index: 0,
      usedTokensBeforeCandidate: 0
    });
    const second = buildRecallCandidate({
      candidate: createCoarseCandidate({ entry: createMemoryEntry({ object_id: "memory-2", content: "Longer content" }) }),
      relevanceScore: 0.7,
      scoreFactors: createScoreFactors({ relevance: 0.7 }),
      tokenEstimator,
      budgets: { max_entries: 2, max_total_tokens: 4, per_dimension_limits: {} },
      index: 0,
      usedTokensBeforeCandidate: 0
    });

    const rebuilt = rebuildRecallBudgetStateForDelivery(
      [second, first],
      {
        budgets: {
          max_entries: 2,
          max_total_tokens: 4,
          per_dimension_limits: {}
        },
        conflict_awareness: true
      }
    );

    expect(rebuilt.map((candidate) => candidate.object_id)).toEqual(["memory-2", "memory-1"]);
    expect(rebuilt[0]?.budget_state?.within_budget).toBe(true);
    expect(rebuilt[1]?.budget_state?.within_budget).toBe(false);
  });
});
