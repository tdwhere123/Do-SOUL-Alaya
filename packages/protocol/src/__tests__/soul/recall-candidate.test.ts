import { describe, expect, it } from "vitest";
import { DYNAMICS_CONSTANTS, MemoryDimension, ScopeClass } from "../../index.js";
import {
  RecallCandidateSchema,
  RecallOriginPlaneSchema
} from "../../soul/recall-candidate.js";

describe("Recall candidate protocol schema", () => {
  it("defaults origin_plane to workspace_local for landed callers", () => {
    expect(
      RecallCandidateSchema.parse({
        object_id: "memory-1",
        object_kind: "memory_entry",
        activation_score: 0.9,
        relevance_score: 0.8,
        content_preview: "Use pnpm for workspace commands.",
        token_estimate: 8,
        manifestation: "full_eligible",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.PROJECT
      })
    ).toEqual({
      object_id: "memory-1",
      object_kind: "memory_entry",
      activation_score: 0.9,
      relevance_score: 0.8,
      content_preview: "Use pnpm for workspace commands.",
      token_estimate: 8,
      manifestation: "full_eligible",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      origin_plane: "workspace_local"
    });
  });

  it("accepts the explicit global origin plane and rejects invalid values", () => {
    expect(RecallOriginPlaneSchema.parse("workspace_local")).toBe("workspace_local");
    expect(RecallOriginPlaneSchema.parse("global")).toBe("global");

    expect(
      RecallCandidateSchema.parse({
        object_id: "memory-2",
        object_kind: "memory_entry",
        activation_score: 0.6,
        relevance_score: 0.5,
        content_preview: "Prefer deterministic tests.",
        token_estimate: 6,
        manifestation: "excerpt",
        dimension: MemoryDimension.PREFERENCE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        origin_plane: "global",
        is_advisory: true
      }).origin_plane
    ).toBe("global");

    expect(() => RecallOriginPlaneSchema.parse("remote")).toThrow();
  });

  it("accepts optional stable explainability metadata", () => {
    expect(
      RecallCandidateSchema.parse({
        object_id: "memory-3",
        object_kind: "memory_entry",
        activation_score: 0.7,
        relevance_score: 0.64,
        content_preview: "Report recall usage after using memory.",
        token_estimate: 7,
        manifestation: "excerpt",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.PROJECT,
        selection_reason: "Selected by lexical and activation ranking.",
        source_channels: ["workspace_local", "keyword"],
        score_factors: {
          activation: 0.7,
          relevance: 0.64,
          graph_support: 0,
          path_plasticity: 0,
          budget_penalty: 0
        },
        budget_state: {
          token_estimate: 7,
          max_entries: 5,
          max_total_tokens: 2000,
          remaining_entries: 4,
          remaining_tokens: 1993,
          within_budget: true
        }
      })
    ).toMatchObject({
      selection_reason: "Selected by lexical and activation ranking.",
      source_channels: ["workspace_local", "keyword"],
      score_factors: {
        activation: 0.7,
        relevance: 0.64
      },
      budget_state: {
        token_estimate: 7,
        within_budget: true
      }
    });
  });

  it("accepts resolved activation weights in score factors and remains backward-compatible without them", () => {
    const withResolvedWeights = RecallCandidateSchema.parse({
      object_id: "memory-4",
      object_kind: "memory_entry",
      activation_score: 0.7,
      relevance_score: 0.64,
      content_preview: "Prefer deterministic tests.",
      token_estimate: 7,
      manifestation: "excerpt",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      score_factors: {
        activation: 0.7,
        relevance: 0.64,
        resolved_activation_weights: DYNAMICS_CONSTANTS.activation_weights_phase4b
      }
    });

    const withoutResolvedWeights = RecallCandidateSchema.parse({
      object_id: "memory-5",
      object_kind: "memory_entry",
      activation_score: 0.7,
      relevance_score: 0.64,
      content_preview: "Old score factor payloads still parse.",
      token_estimate: 7,
      manifestation: "excerpt",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      score_factors: {
        activation: 0.7,
        relevance: 0.64
      }
    });

    expect(withResolvedWeights.score_factors?.resolved_activation_weights).toEqual(
      DYNAMICS_CONSTANTS.activation_weights_phase4b
    );
    expect(withoutResolvedWeights.score_factors?.resolved_activation_weights).toBeUndefined();
  });
});
