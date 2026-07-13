import { describe, expect, it } from "vitest";
import {
  ManifestationState,
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
} from "../../recall/runtime/recall-candidate-builder.js";
import { assignManifestation } from "../../recall/runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate, TokenEstimator } from "../../recall/runtime/recall-service-types.js";

// A body over the 160-char createContentPreview cap so a non-full_eligible
// manifestation truncates the delivered content_preview, proving the cap
// reached delivery. see also: recall-service-helpers.ts createContentPreview.
const LONG_BODY =
  "This memory body is intentionally written to exceed the one hundred and sixty " +
  "character preview cap so that a hint or excerpt manifestation visibly truncates " +
  "the delivered content_preview field.";

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
      scoreFactors: createScoreFactors({ path_plasticity: 0.5, content_relevance: 0.6 }),
      finalRelevanceSource: "fusion",
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
    expect(candidate.selection_reason).toContain("Final fusion evidence score 0.600000");
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

describe("recall-candidate-builder governance ceiling clamp (TRUTH BOUNDARY)", () => {
  function buildWith(params: {
    readonly activationScore: number;
    readonly governanceCeiling?: ManifestationState;
    readonly content?: string;
  }) {
    return buildRecallCandidate({
      candidate: createCoarseCandidate({
        entry: createMemoryEntry({
          activation_score: params.activationScore,
          content: params.content ?? LONG_BODY
        })
      }),
      relevanceScore: 0.6,
      scoreFactors: createScoreFactors(),
      finalRelevanceSource: "fusion",
      tokenEstimator,
      budgets: { max_entries: 5, max_total_tokens: 200, per_dimension_limits: {} },
      index: 0,
      usedTokensBeforeCandidate: 0,
      ...(params.governanceCeiling === undefined
        ? {}
        : { governanceCeiling: params.governanceCeiling })
    });
  }

  it("ceiling caps strength: full_eligible strength + hint ceiling => hint, preview truncated", () => {
    // activation_score 0.95 lands in the full_eligible band; a hint ceiling
    // (from a hint_only inbound governing path) must cap delivery to hint.
    const candidate = buildWith({
      activationScore: 0.95,
      governanceCeiling: ManifestationState.HINT
    });
    expect(candidate.manifestation).toBe(ManifestationState.HINT);
    // The cap reached delivery: a hint preview truncates the over-160-char body
    // rather than delivering it whole the way full_eligible would.
    expect(candidate.content_preview.endsWith("...")).toBe(true);
    expect(candidate.content_preview.length).toBeLessThan(LONG_BODY.length);
    expect(candidate.content_preview).not.toBe(LONG_BODY);
  });

  it("ceiling only LOWERS, never elevates: hidden strength + full ceiling stays hidden", () => {
    // activation_score 0.05 is in the hidden band; a full_eligible ceiling
    // (recall_allowed inbound path) must not elevate it.
    const candidate = buildWith({
      activationScore: 0.05,
      governanceCeiling: ManifestationState.FULL_ELIGIBLE
    });
    expect(candidate.manifestation).toBe(ManifestationState.HIDDEN);
  });

  it("no governing path => unrestricted: manifestation equals the pure strength tier", () => {
    // No governanceCeiling supplied (no inbound governing path). Manifestation
    // must equal assignManifestation(activation_score) with no suppression.
    for (const score of [0.05, 0.15, 0.45, 0.75, 0.95]) {
      const candidate = buildWith({ activationScore: score });
      expect(candidate.manifestation).toBe(assignManifestation(score));
    }
  });

  it("full_eligible explicit ceiling is identical to no ceiling (default)", () => {
    const score = 0.95;
    const withDefault = buildWith({ activationScore: score });
    const withFull = buildWith({
      activationScore: score,
      governanceCeiling: ManifestationState.FULL_ELIGIBLE
    });
    expect(withFull.manifestation).toBe(withDefault.manifestation);
    expect(withDefault.manifestation).toBe(ManifestationState.FULL_ELIGIBLE);
  });
});

describe("assignManifestation threshold regression guard (DESIGN-LOCKED 0.1/0.3/0.6)", () => {
  it("returns the existing bands at the locked threshold sample points", () => {
    expect(assignManifestation(0.05)).toBe(ManifestationState.HIDDEN);
    expect(assignManifestation(0.15)).toBe(ManifestationState.HINT);
    expect(assignManifestation(0.45)).toBe(ManifestationState.EXCERPT);
    expect(assignManifestation(0.75)).toBe(ManifestationState.FULL_ELIGIBLE);
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
