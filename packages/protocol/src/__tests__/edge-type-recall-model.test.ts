import { describe, expect, it } from "vitest";
import {
  EDGE_TYPE_RECALL_MODEL,
  GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES,
  MEMORY_GRAPH_EDGE_RECALL_WEIGHTS,
  MemoryGraphEdgeType
} from "../soul/memory-graph.js";

// Zero-drift lock: EDGE_TYPE_RECALL_MODEL is the single source of truth and
// the legacy tables are derived views. These literals are the pre-refactor
// state of MEMORY_GRAPH_EDGE_RECALL_WEIGHTS and EDGE_TYPE_HOP_DECAY; any
// numeric drift between the model and the views breaks here.
describe("EDGE_TYPE_RECALL_MODEL", () => {
  const EXPECTED_CONTRIBUTION_WEIGHTS = {
    supports: 1.0,
    derives_from: 0.5,
    recalls: 0.3,
    supersedes: -0.5,
    contradicts: -0.4,
    incompatible_with: -0.3,
    exception_to: 0
  } as const;

  const EXPECTED_HOP_DECAY = {
    supports: 0.5,
    derives_from: 0.6,
    recalls: 0.3,
    supersedes: null,
    contradicts: null,
    incompatible_with: null,
    exception_to: null
  } as const;

  const EXPECTED_TRANSITIVE = {
    supports: true,
    derives_from: true,
    recalls: true,
    supersedes: false,
    contradicts: false,
    incompatible_with: false,
    exception_to: false
  } as const;

  it("covers exactly the seven edge_type values", () => {
    expect(Object.keys(EDGE_TYPE_RECALL_MODEL).sort()).toEqual(
      Object.values(MemoryGraphEdgeType).slice().sort()
    );
  });

  it("pins contribution_weight / hop_decay / transitive for every edge_type", () => {
    for (const edgeType of Object.values(MemoryGraphEdgeType)) {
      const entry = EDGE_TYPE_RECALL_MODEL[edgeType];
      expect(entry.contribution_weight).toBe(EXPECTED_CONTRIBUTION_WEIGHTS[edgeType]);
      expect(entry.hop_decay).toBe(EXPECTED_HOP_DECAY[edgeType]);
      expect(entry.transitive).toBe(EXPECTED_TRANSITIVE[edgeType]);
    }
  });

  it("transitive rows have a non-null hop_decay; non-transitive rows are null", () => {
    for (const edgeType of Object.values(MemoryGraphEdgeType)) {
      const entry = EDGE_TYPE_RECALL_MODEL[edgeType];
      expect(entry.hop_decay === null).toBe(!entry.transitive);
    }
  });

  it("MEMORY_GRAPH_EDGE_RECALL_WEIGHTS derives from contribution_weight with zero drift", () => {
    expect(MEMORY_GRAPH_EDGE_RECALL_WEIGHTS).toEqual(EXPECTED_CONTRIBUTION_WEIGHTS);
    for (const edgeType of Object.values(MemoryGraphEdgeType)) {
      expect(MEMORY_GRAPH_EDGE_RECALL_WEIGHTS[edgeType]).toBe(
        EDGE_TYPE_RECALL_MODEL[edgeType].contribution_weight
      );
    }
  });

  it("GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES equals the transitive rows", () => {
    const transitiveByFlag = Object.values(MemoryGraphEdgeType).filter(
      (edgeType) => EDGE_TYPE_RECALL_MODEL[edgeType].transitive
    );
    expect([...GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES].sort()).toEqual(
      transitiveByFlag.slice().sort()
    );
    expect([...GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES].sort()).toEqual(
      ["derives_from", "recalls", "supports"]
    );
  });
});
