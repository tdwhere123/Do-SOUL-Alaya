import { describe, expect, it } from "vitest";
import {
  MemoryGraphEdgeTypeSchema,
  mapRelationKindToGraphEdgeType
} from "../../soul/memory-graph.js";

// anchor: pins the co_recalled exclusion that the recall earned-fan-in reserve
// exemption depends on. The exemption (packages/core/src/recall/fusion-delivery.ts:
// isStructuralRescueCandidate) is sound ONLY because `co_recalled` is a
// PathRelation relation_kind, never a MemoryGraphEdgeType — so a generic graph
// edge can never masquerade as the earned fan-in carrier. If a future edit adds
// co_recalled to memoryGraphEdgeTypeValues, the first assertion trips here.
// see also: packages/protocol/src/soul/memory-graph.ts:memoryGraphEdgeTypeValues / MemoryGraphEdgeTypeSchema,
//   packages/core/src/recall/graph-expansion.ts:EARNED_CO_RECALLED_FANIN_RELATION_KIND.
describe("co_recalled enum invariant (recall earned-fan-in exemption guard)", () => {
  it("rejects co_recalled as a MemoryGraphEdgeType value", () => {
    expect(MemoryGraphEdgeTypeSchema.safeParse("co_recalled").success).toBe(false);
  });

  it("projects the co_recalled relation_kind to the display edge_type recalls", () => {
    expect(mapRelationKindToGraphEdgeType("co_recalled")).toBe("recalls");
  });
});
