import { describe, expect, it } from "vitest";
import {
  EDGE_TYPE_RECALL_MODEL,
  GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES
} from "@do-soul/alaya-protocol";

// Zero-drift lock for the core-side derived view EDGE_TYPE_HOP_DECAY. The
// production view (recall-service.ts) is built by mapping the transitive
// rows of EDGE_TYPE_RECALL_MODEL to their hop_decay; this re-derives it the
// same way and pins the pre-refactor literal values
// ({ derives_from: 0.6, recalls: 0.3, supports: 0.5 }).
describe("EDGE_TYPE_HOP_DECAY derivation", () => {
  const TRACKED_EDGE_TYPES = ["derives_from", "recalls", "supports"] as const;

  it("tracked edge_types match the protocol transitive set", () => {
    expect([...TRACKED_EDGE_TYPES].sort()).toEqual(
      [...GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES].sort()
    );
  });

  it("hop_decay derived from the model equals the pre-refactor literals", () => {
    const derived = Object.fromEntries(
      TRACKED_EDGE_TYPES.map((edgeType) => {
        const decay = EDGE_TYPE_RECALL_MODEL[edgeType].hop_decay;
        expect(decay).not.toBeNull();
        return [edgeType, decay];
      })
    );
    expect(derived).toEqual({ derives_from: 0.6, recalls: 0.3, supports: 0.5 });
  });

  it("single-edge admission score derives from contribution_weight floored at 0", () => {
    // graphTraversalScoreFromPath = clamp01(max(0, contribution_weight)); pin
    // that negatives floor to 0 in traversal while positives pass through.
    // see also: packages/core/src/recall/graph-expansion.ts:graphTraversalScoreFromPath.
    expect(Math.max(0, EDGE_TYPE_RECALL_MODEL.supports.contribution_weight)).toBe(1.0);
    expect(Math.max(0, EDGE_TYPE_RECALL_MODEL.supersedes.contribution_weight)).toBe(0);
    expect(Math.max(0, EDGE_TYPE_RECALL_MODEL.contradicts.contribution_weight)).toBe(0);
  });
});
