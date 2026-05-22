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
  buildSynthesisCoarseRecallCandidate
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

  it("builds a synthesis_capsule coarse candidate from an L2 synthesis row", () => {
    const candidate = buildSynthesisCoarseRecallCandidate({
      synthesis: createSynthesisCapsule(),
      normalizedRank: 0.8
    });

    expect(candidate.objectKind).toBe("synthesis_capsule");
    expect(candidate.entry.object_id).toBe("synthesis-1");
    expect(candidate.entry.activation_score).toBe(0.8);
    expect(candidate.entry.dimension).toBe("episode");
    expect(candidate.sourceChannels).toContain("synthesis_fts");
  });

  it("clips an over-long synthesis summary to a bounded delivered preview", () => {
    // A raw L2 synthesis digest can run thousands of chars; recall must
    // deliver a bounded preview so a reserved synthesis slot costs a
    // memory-comparable share of max_total_tokens. Without the clip a
    // 4000-char digest blows the delivery token budget.
    const longSummary = `${"A synthesis sentence with real words. ".repeat(200)}`;
    expect(longSummary.length).toBeGreaterThan(4000);
    const candidate = buildSynthesisCoarseRecallCandidate({
      synthesis: createSynthesisCapsule({ summary: longSummary }),
      normalizedRank: 0.5
    });

    expect(candidate.entry.content.length).toBeLessThanOrEqual(601);
    expect(candidate.entry.content.endsWith("…")).toBe(true);

    // A short summary is delivered verbatim — no spurious ellipsis.
    const shortCandidate = buildSynthesisCoarseRecallCandidate({
      synthesis: createSynthesisCapsule({ summary: "Short synthesis." }),
      normalizedRank: 0.5
    });
    expect(shortCandidate.entry.content).toBe("Short synthesis.");
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
