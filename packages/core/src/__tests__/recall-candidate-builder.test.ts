import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  SynthesisStatus,
  type MemoryEntry,
  type RecallScoreFactors,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import {
  buildRecallCandidate,
  buildSynthesisRecallCandidate,
  mergeAdditiveCandidatesByRelevanceScore,
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

  it("builds a synthesis_capsule candidate from an L2 synthesis row", () => {
    const candidate = buildSynthesisRecallCandidate({
      synthesis: createSynthesisCapsule(),
      normalizedRank: 0.8,
      tokenEstimator,
      budgets: { max_entries: 5, max_total_tokens: 200, per_dimension_limits: {} }
    });

    expect(candidate.object_kind).toBe("synthesis_capsule");
    expect(candidate.object_id).toBe("synthesis-1");
    // relevance_score is the FTS rank damped by SYNTHESIS_RELEVANCE_DAMPING
    // (0.86); activation_score keeps the undamped FTS rank.
    expect(candidate.relevance_score).toBeCloseTo(0.8 * 0.86, 5);
    expect(candidate.activation_score).toBe(0.8);
    expect(candidate.dimension).toBe("episode");
    expect(candidate.source_channels).toContain("synthesis_fts");
  });

  it("merges a synthesis candidate into the delivery list by relevance_score", () => {
    const budgets = { max_entries: 5, max_total_tokens: 2000, per_dimension_limits: {} };
    const config = { budgets, conflict_awareness: true };
    const base = buildRecallCandidate({
      candidate: createCoarseCandidate(),
      relevanceScore: 0.6,
      scoreFactors: createScoreFactors(),
      tokenEstimator,
      budgets,
      index: 0,
      usedTokensBeforeCandidate: 0
    });
    // damped relevance = normalizedRank * 0.86: 0.5 -> 0.43 (below base 0.6),
    // 0.95 -> 0.817 (above base 0.6).
    const weakSynthesis = buildSynthesisRecallCandidate({
      synthesis: createSynthesisCapsule(),
      normalizedRank: 0.5,
      tokenEstimator,
      budgets
    });
    const strongSynthesis = buildSynthesisRecallCandidate({
      synthesis: createSynthesisCapsule(),
      normalizedRank: 0.95,
      tokenEstimator,
      budgets
    });

    expect(
      mergeAdditiveCandidatesByRelevanceScore([base], [weakSynthesis], config).map(
        (candidate) => candidate.object_kind
      )
    ).toEqual(["memory_entry", "synthesis_capsule"]);
    expect(
      mergeAdditiveCandidatesByRelevanceScore([base], [strongSynthesis], config).map(
        (candidate) => candidate.object_kind
      )
    ).toEqual(["synthesis_capsule", "memory_entry"]);
  });

  // DELIBERATE COUPLING (S4 review): buildSynthesisRecallCandidate stamps
  // dimension "episode", so a synthesis candidate shares the `episode`
  // per-dimension budget with L1 episode memory candidates. In every
  // production recall policy and the bench harness `per_dimension_limits`
  // is null, so the coupling is LATENT — no synthesis is dropped today.
  // This test locks the coupling: if a future policy sets a non-null
  // episode limit, the synthesis candidate IS subject to it. The decision
  // is to document-and-lock rather than exempt synthesis, keeping the
  // additive-join logic (a part 1-2 surface) untouched.
  it("subjects a synthesis candidate to a non-null episode per-dimension limit", () => {
    const episodeMemory = buildRecallCandidate({
      candidate: createCoarseCandidate({
        entry: createMemoryEntry({ object_id: "memory-1", dimension: MemoryDimension.EPISODE })
      }),
      relevanceScore: 0.6,
      scoreFactors: createScoreFactors(),
      tokenEstimator,
      budgets: { max_entries: 5, max_total_tokens: 200, per_dimension_limits: {} },
      index: 0,
      usedTokensBeforeCandidate: 0
    });
    // normalizedRank 0.5 damps to 0.43, below the memory's 0.6 — the memory
    // sorts first and takes the single episode slot.
    const synthesis = buildSynthesisRecallCandidate({
      synthesis: createSynthesisCapsule(),
      normalizedRank: 0.5,
      tokenEstimator,
      budgets: { max_entries: 5, max_total_tokens: 200, per_dimension_limits: {} }
    });

    const merged = mergeAdditiveCandidatesByRelevanceScore(
      [episodeMemory],
      [synthesis],
      {
        budgets: {
          max_entries: 5,
          max_total_tokens: 200,
          per_dimension_limits: { episode: 1 }
        },
        conflict_awareness: true
      }
    );

    // The one episode slot is consumed by the L1 memory; the synthesis
    // candidate (also dimension "episode") is dropped under the limit.
    expect(merged.map((candidate) => candidate.object_id)).toEqual(["memory-1"]);
  });
});

function createSynthesisCapsule(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
  return {
    object_id: "synthesis-1",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "system",
    topic_key: "tooling/pnpm",
    synthesis_type: "cross_evidence",
    summary: "Cross-evidence synthesis of the workspace tooling decisions.",
    evidence_refs: ["evidence-1", "evidence-2"],
    source_memory_refs: ["memory-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: SynthesisStatus.WORKING,
    ...overrides
  };
}
