import { describe, expect, it } from "vitest";
import { MemoryDimension, ScopeClass } from "../index.js";
import {
  RecallCandidateSchema,
  RecallOriginPlaneSchema
} from "../soul/recall-candidate.js";

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
});
